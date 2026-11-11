// Server Pulse
// Records generation success/latency and periodic pings, asks the user for a 1-5 rating
// from time to time, and predicts how the server is doing now and over the next 24 hours.

const MODULE = 'server_pulse';
const STORE_KEY = 'server_pulse_data_v1';
const LOG = '[ServerPulse]';
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const CAP = { gens: 5000, pings: 8000, ratings: 3000, probes: 5000 };
const SKIP_TYPES = new Set(['quiet', 'impersonate']);

const defaultSettings = Object.freeze({
    enabled: true,
    ratingIntervalMin: 60,
    ratingMinGens: 1,
    pingIntervalMin: 5,
    pingSillyTavern: true,
    pingTargets: '',
    probeIntervalMin: 30,
    probeProfileId: '',
    probeUsePreset: false,
    probeSystem: '',
    probeUser: '',
    probeMaxTokens: 16,
    showBadge: true,
    badgePos: 'top-right',
    perConnection: true,
    halfLifeDays: 21,
});

// ---------------------------------------------------------------- settings & data

function getSettings() {
    const { extensionSettings } = SillyTavern.getContext();
    if (!extensionSettings[MODULE]) {
        extensionSettings[MODULE] = structuredClone(defaultSettings);
    }
    for (const key of Object.keys(defaultSettings)) {
        if (!Object.hasOwn(extensionSettings[MODULE], key)) {
            extensionSettings[MODULE][key] = defaultSettings[key];
        }
    }
    return extensionSettings[MODULE];
}

let data = { gens: [], pings: [], ratings: [], probes: [], lastPromptAt: 0, lastPingAt: 0, lastProbeAt: 0 };
let saveTimer = null;

async function loadData() {
    try {
        const stored = await SillyTavern.libs.localforage.getItem(STORE_KEY);
        if (stored && typeof stored === 'object') data = { ...data, ...stored };
        if (!Array.isArray(data.probes)) data.probes = [];
    } catch (err) {
        console.warn(LOG, 'load failed', err);
    }
}

function saveData() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
        for (const k of Object.keys(CAP)) {
            if (data[k].length > CAP[k]) data[k] = data[k].slice(-CAP[k]);
        }
        try {
            await SillyTavern.libs.localforage.setItem(STORE_KEY, data);
        } catch (err) {
            console.warn(LOG, 'save failed', err);
        }
    }, 1500);
}

// ---------------------------------------------------------------- helpers

function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function median(arr) {
    const a = arr.filter(x => Number.isFinite(x)).sort((x, y) => x - y);
    if (!a.length) return null;
    const m = Math.floor(a.length / 2);
    return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

function fmtMs(ms) {
    if (!Number.isFinite(ms)) return '-';
    return ms >= 1000 ? `${(ms / 1000).toFixed(1)}초` : `${Math.round(ms)}ms`;
}

function connKey() {
    const c = SillyTavern.getContext();
    try {
        if (c.mainApi === 'openai') {
            const src = c.chatCompletionSettings?.chat_completion_source || 'cc';
            const model = c.getChatCompletionModel?.() || '';
            // Vertex capacity differs by region (global vs us-central1 ...)
            const region = src === 'vertexai' ? c.chatCompletionSettings?.vertexai_region : '';
            return `${src}/${model}${region ? `@${region}` : ''}`;
        }
        if (c.mainApi === 'textgenerationwebui') {
            const type = c.textCompletionSettings?.type || 'tc';
            let host = '';
            try { host = new URL(c.getTextGenServer?.() || '').host; } catch { /* no server url */ }
            return `${type}/${host}`;
        }
    } catch (err) {
        console.debug(LOG, 'connKey', err);
    }
    return String(c.mainApi || 'unknown');
}

// ---------------------------------------------------------------- outcome classification

/**
 * Sorts an error message into a failure class. Exported for testing.
 * quota    429 / RESOURCE_EXHAUSTED: shared capacity or quota ran out (Vertex dynamic shared quota)
 * overload 5xx / UNAVAILABLE / overloaded / deadline: the server could not serve the request
 * network  could not reach the server
 * blocked  safety filter or empty candidate: the server worked, the content was refused
 * config   key, permission, bad request: a settings problem, not server health
 * other    anything else
 */
export function classifyError(text) {
    const t = String(text || '');
    if (/\b429\b|RESOURCE_EXHAUSTED|resource (has been )?exhausted|too many requests|rate.?limit|quota/i.test(t)) return 'quota';
    if (/PROHIBITED_CONTENT|blockReason|blocked due to|\bSAFETY\b|RECITATION|BLOCKLIST|SPII|candidate text empty|returned no candidate|moderation|content (policy|filter)/i.test(t)) return 'blocked';
    if (/\b(500|502|503|504)\b|UNAVAILABLE|overloaded|INTERNAL|internal (server )?error|DEADLINE_EXCEEDED|timed? ?out|bad gateway|service unavailable|try again later/i.test(t)) return 'overload';
    if (/failed to fetch|networkerror|network error|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|socket hang up|fetch failed|could not get a reply/i.test(t)) return 'network';
    if (/\b(400|401|403|404)\b|PERMISSION_DENIED|permission denied|UNAUTHENTICATED|INVALID_ARGUMENT|NOT_FOUND|api key|service account|unauthori[sz]ed|forbidden|billing|not supported|invalid/i.test(t)) return 'config';
    return 'other';
}

export const CLASS_LABEL = {
    ok: '성공', quota: '429 할당량 부족', overload: '서버 과부하(5xx)', network: '연결 끊김',
    blocked: '안전 필터 차단', config: '설정 오류', empty: '빈 응답', other: '기타 오류',
};

// How much an outcome says "the server is down". null = says nothing about the server.
const FAIL_WEIGHT = { ok: 0, blocked: 0, quota: 1, overload: 1, network: 1, other: 0.6, empty: 0.5, config: null };

function outcomeOf(rec) {
    if (rec.cls) return rec.cls;
    return rec.ok ? 'ok' : 'other'; // records from older versions
}

/** Old records have no region suffix; let them count for every region of the same model. */
export function keyMatch(recKey, key) {
    if (recKey === key) return true;
    const base = key.split('@')[0];
    return !String(recKey).includes('@') && recKey === base;
}

function hourOf(t) {
    const d = new Date(t);
    return d.getHours() + d.getMinutes() / 60;
}

function isWeekend(t) {
    const day = new Date(t).getDay();
    return day === 0 || day === 6;
}

function decay(age, halfLifeDays) {
    return Math.pow(0.5, Math.max(0, age) / (halfLifeDays * DAY));
}

function hourKernel(t1, t2) {
    let dh = Math.abs(hourOf(t1) - hourOf(t2));
    dh = Math.min(dh, 24 - dh);
    return Math.exp(-(dh * dh) / (2 * 1.5 * 1.5)) * (isWeekend(t1) === isWeekend(t2) ? 1 : 0.5);
}

/**
 * Generations and probes for one connection as server-health events.
 * Bursts (retry spam after a 429) are down-weighted so one bad minute does not dominate.
 * Exported for testing.
 */
export function serverEvents(d, key, now) {
    const raw = [];
    for (const g of d.gens) {
        if (g.stopped || g.t > now || !keyMatch(g.key, key)) continue;
        const cls = outcomeOf(g);
        const fail = FAIL_WEIGHT[cls];
        if (fail == null) continue;
        raw.push({ t: g.t, fail, cls, ms: cls === 'ok' ? g.ms : null, src: 'gen' });
    }
    for (const p of d.probes || []) {
        if (p.t > now || !keyMatch(p.key, key)) continue;
        const cls = p.cls || (p.ok ? 'ok' : 'other');
        const fail = FAIL_WEIGHT[cls];
        if (fail == null) continue;
        raw.push({ t: p.t, fail, cls, ms: null, src: 'probe' });
    }
    raw.sort((x, y) => x.t - y.t);
    // burst weight: 1 / sqrt(events within +-5 minutes)
    let lo = 0;
    let hi = 0;
    for (let i = 0; i < raw.length; i++) {
        while (raw[lo].t < raw[i].t - 5 * MIN) lo++;
        while (hi + 1 < raw.length && raw[hi + 1].t <= raw[i].t + 5 * MIN) hi++;
        raw[i].bw = 1 / Math.sqrt(hi - lo + 1);
    }
    return raw;
}

/**
 * Chance that a request at time `t` fails, learned from past events at similar hours.
 * Beta-smoothed toward this connection's overall failure rate. Exported for testing.
 */
export function hourlyFailure(events, t, now, halfLifeDays) {
    if (!events.length) return { p: null, neff: 0, quota: 0, overload: 0 };
    let all = 0;
    let allW = 0;
    for (const e of events) {
        const w = decay(now - e.t, halfLifeDays) * e.bw;
        all += w * e.fail;
        allW += w;
    }
    const base = allW ? all / allW : 0.1;
    let sw = 0;
    let sf = 0;
    let sq = 0;
    let so = 0;
    for (const e of events) {
        const w = decay(now - e.t, halfLifeDays) * hourKernel(e.t, t) * e.bw;
        sw += w;
        sf += w * e.fail;
        if (e.cls === 'quota') sq += w;
        if (e.cls === 'overload' || e.cls === 'network') so += w;
    }
    const k = 2; // prior strength
    return {
        p: (sf + k * base) / (sw + k),
        neff: sw,
        quota: sw ? sq / sw : 0,
        overload: sw ? so / sw : 0,
    };
}

/** What is happening right now: events of the last ~20 minutes, newest weigh most. */
export function liveState(events, now) {
    let sw = 0;
    let sf = 0;
    let n = 0;
    let lastFail = null;
    const recent = [];
    for (const e of events) {
        const age = now - e.t;
        if (age < 0 || age > 20 * MIN) continue;
        const w = Math.pow(0.5, age / (8 * MIN));
        sw += w;
        sf += w * e.fail;
        n++;
        recent.push(e);
        if (e.fail >= 1) lastFail = e;
    }
    return { sw, sf, n, recent, lastFail };
}

/** Typical minutes from a quota/overload failure until the next success. */
export function recoveryMinutes(events, cls) {
    const gaps = [];
    for (let i = 0; i < events.length; i++) {
        if (events[i].cls !== cls) continue;
        if (i > 0 && events[i - 1].cls === cls && events[i].t - events[i - 1].t < 10 * MIN) continue; // count each streak once
        const next = events.slice(i + 1).find(e => e.cls === 'ok');
        if (next && next.t - events[i].t < 3 * HOUR) gaps.push((next.t - events[i].t) / MIN);
    }
    return gaps.length >= 3 ? median(gaps) : null;
}

function latencyRatio(d, key, now) {
    const ok = d.gens.filter(g => keyMatch(g.key, key) && !g.stopped && outcomeOf(g) === 'ok' && g.t <= now);
    const base = median(ok.filter(g => now - g.t <= 14 * DAY).map(g => g.ms));
    const recent = ok.filter(g => now - g.t <= 30 * MIN).slice(-5);
    const med = median(recent.map(g => g.ms));
    return ok.length >= 6 && med && base ? { ratio: med / base, ms: med } : { ratio: null, ms: med };
}

/** 1-5 score from success chance and slowness. */
export function scoreFrom(success, latRatio) {
    let sc = 1 + 4 * success;
    if (latRatio) sc -= 0.8 * clamp(Math.log2(latRatio), 0, 2);
    return clamp(sc, 1, 5);
}

/**
 * Live metrics snapshot stored with each rating (kept for the dashboard and calibration).
 * Exported for testing.
 */
export function metricsSnapshot(d, key, now) {
    const ev = serverEvents(d, key, now);
    const live = liveState(ev, now);
    const hour = hourlyFailure(ev, now, now, 21);
    const lat = latencyRatio(d, key, now);
    const pFail = live.sw ? (live.sf + 1.5 * (hour.p ?? 0.1)) / (live.sw + 1.5) : hour.p;
    return {
        n: live.n,
        failRate: live.sw ? live.sf / live.sw : null,
        latRatio: lat.ratio,
        auto: pFail == null ? null : scoreFrom(1 - pFail, lat.ratio),
    };
}

function scopedRatings(d, key, settings) {
    if (settings.perConnection) {
        const own = d.ratings.filter(r => keyMatch(r.key, key));
        if (own.length >= 5) return { list: own, scoped: true };
    }
    return { list: d.ratings, scoped: false };
}

/** Learns how the user's ratings relate to the automatic score: rating ~ a + b * auto. */
export function fitCalibration(ratings, now, halfLifeDays) {
    const rows = ratings
        .map(r => ({ x: r.snap?.auto ?? (r.snap?.failRate != null ? scoreFrom(1 - r.snap.failRate, r.snap.latRatio) : null), y: r.score, w: decay(now - r.t, halfLifeDays) }))
        .filter(r => r.x != null);
    if (rows.length < 6) return null;
    let sw = 0, sx = 0, sy = 0;
    for (const r of rows) { sw += r.w; sx += r.w * r.x; sy += r.w * r.y; }
    const mx = sx / sw;
    const my = sy / sw;
    let sxx = 0, sxy = 0;
    for (const r of rows) { sxx += r.w * (r.x - mx) ** 2; sxy += r.w * (r.x - mx) * (r.y - my); }
    const b = clamp(sxx > 1e-6 ? sxy / sxx : 1, 0.3, 1.5);
    return { a: my - b * mx, b, n: rows.length };
}

export function labelFor(score) {
    if (score == null) return { text: '데이터 부족', cls: 'sp-none' };
    if (score >= 4.2) return { text: '아주 좋음', cls: 'sp-great' };
    if (score >= 3.4) return { text: '좋음', cls: 'sp-good' };
    if (score >= 2.6) return { text: '보통', cls: 'sp-mid' };
    if (score >= 1.8) return { text: '나쁨', cls: 'sp-bad' };
    return { text: '매우 나쁨', cls: 'sp-awful' };
}

/**
 * Full prediction for connection `key` at time `now`. Exported for testing.
 * Works from generation/probe outcomes alone; the user's ratings only calibrate it.
 */
export function predict(d, settings, key, now) {
    const hl = settings.halfLifeDays || 21;
    const ev = serverEvents(d, key, now);
    const live = liveState(ev, now);
    const hour = hourlyFailure(ev, now, now, hl);
    const lat = latencyRatio(d, key, now);
    const reasons = [];

    // Chance of failure now: recent events first, this hour's history as the prior
    let pFail = null;
    if (live.sw) pFail = (live.sf + 1.5 * (hour.p ?? 0.1)) / (live.sw + 1.5);
    else if (hour.p != null) pFail = hour.p;
    const success = pFail == null ? null : 1 - pFail;

    let score = success == null ? null : scoreFrom(success, lat.ratio);
    const { list: ratings, scoped } = scopedRatings(d, key, settings);
    const cal = fitCalibration(ratings, now, hl);
    if (score != null && cal) score = clamp(cal.a + cal.b * score, 1, 5);

    // A rating the user just gave outweighs everything for a while
    const last = ratings.filter(r => r.t <= now).at(-1);
    if (last && now - last.t < HOUR) {
        const w = 0.7 * (1 - (now - last.t) / HOUR);
        score = score == null ? last.score : w * last.score + (1 - w) * score;
        reasons.push(`${Math.round((now - last.t) / MIN)}분 전 내 평가 ${last.score}점 반영`);
    }

    if (live.n) {
        const counts = {};
        for (const e of live.recent) counts[e.cls] = (counts[e.cls] || 0) + 1;
        const parts = Object.entries(counts).map(([c, n]) => `${CLASS_LABEL[c] || c} ${n}`);
        reasons.push(`최근 20분: ${parts.join(', ')}`);
    }
    if (lat.ms && lat.ratio) reasons.push(`응답 ${fmtMs(lat.ms)} (평소의 ${lat.ratio.toFixed(1)}배)`);
    if (hour.neff >= 0.5) {
        const why = hour.quota >= 0.15 ? ' · 이 시간엔 429가 잦아요' : hour.overload >= 0.15 ? ' · 이 시간엔 과부하가 잦아요' : '';
        reasons.push(`이 시간대 평소 성공률 ${Math.round((1 - hour.p) * 100)}% (기록 ${Math.round(hour.neff * 10) / 10}건 분량)${why}`);
    }
    if (cal) reasons.push(`내 평가 ${cal.n}개로 점수 보정 중`);

    let recovery = null;
    if (live.lastFail && now - live.lastFail.t < 15 * MIN && (live.lastFail.cls === 'quota' || live.lastFail.cls === 'overload')) {
        const m = recoveryMinutes(ev, live.lastFail.cls);
        recovery = { cls: live.lastFail.cls, minutes: m };
        reasons.push(m != null ? `${CLASS_LABEL[live.lastFail.cls]}: 보통 ${Math.max(1, Math.round(m))}분 뒤 회복돼요` : `${CLASS_LABEL[live.lastFail.cls]} 발생 중`);
    }

    const evidence = hour.neff + Math.min(live.n, 4) + (cal ? 2 : 0);
    const confidence = score == null ? '없음' : evidence >= 8 ? '높음' : evidence >= 3 ? '보통' : '낮음';

    const forecast = [];
    const startHour = new Date(now);
    startHour.setMinutes(0, 0, 0);
    for (let i = 1; i <= 24; i++) {
        const t = startHour.getTime() + i * HOUR;
        const h = hourlyFailure(ev, t, now, hl);
        let sc = h.p == null || h.neff < 0.3 ? null : scoreFrom(1 - h.p, null);
        if (sc != null && cal) sc = clamp(cal.a + cal.b * sc, 1, 5);
        forecast.push({ t, success: h.p == null || h.neff < 0.3 ? null : 1 - h.p, score: sc, neff: h.neff, quota: h.quota, overload: h.overload });
    }

    return {
        score, success, label: labelFor(score), confidence, reasons, forecast, recovery,
        scoped, ratingsUsed: ratings.length, events: ev.length,
    };
}

// ---------------------------------------------------------------- generation tracking

let pending = null;

function onGenStarted(type, _params, dryRun) {
    if (dryRun || SKIP_TYPES.has(type) || !getSettings().enabled) return;
    // A previous generation that never reported its end gets closed here
    if (pending) finalize();
    pending = { t: Date.now(), t0: performance.now(), key: connKey(), type, ttft: null, got: false, empty: false, error: false, errText: '', stopped: false };
}

function onToken() {
    if (pending && pending.ttft == null) pending.ttft = performance.now() - pending.t0;
}

function onMessageReceived(id) {
    if (!pending) return;
    pending.got = true;
    const msg = SillyTavern.getContext().chat?.[id];
    pending.empty = !msg || !String(msg.mes ?? '').trim();
}

function onStopped() {
    if (pending) pending.stopped = true;
}

function onGenEnded() {
    if (!pending) return;
    // Let MESSAGE_RECEIVED / error toasts land first
    setTimeout(() => finalize(), 400);
}

function finalize() {
    const p = pending;
    if (!p) return;
    pending = null;
    let cls;
    if (p.stopped) cls = 'ok';
    else if (p.error) cls = classifyError(p.errText);
    else if (!p.got || p.empty) cls = isGeminiKey(p.key) ? 'blocked' : 'empty'; // Gemini returns silent empty replies when its filter cuts in
    else cls = 'ok';
    data.gens.push({
        t: p.t, key: p.key, type: p.type, ok: cls === 'ok', cls, stopped: p.stopped,
        err: p.errText ? p.errText.slice(0, 160) : undefined,
        ms: Math.round(performance.now() - p.t0), ttft: p.ttft != null ? Math.round(p.ttft) : null,
    });
    saveData();
    refreshBadge();
}

function isGeminiKey(key) {
    return /^(vertexai|makersuite)\//.test(String(key)) || /gemini/i.test(String(key));
}

// Error toasts during a generation count as failures (watch the toast container, do not patch toastr)
let toastObs = null;
let watchedContainer = null;
const seenToasts = new WeakSet();

function noteToast(n) {
    if (!pending || !(n instanceof HTMLElement) || seenToasts.has(n)) return;
    seenToasts.add(n);
    if (!n.classList.contains('toast-error')) return;
    pending.error = true;
    if (!pending.errText) pending.errText = (n.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 400);
}

function watchToasts() {
    const attach = () => {
        const c = document.getElementById('toast-container');
        if (!c || c === watchedContainer) return;
        watchedContainer = c;
        toastObs?.disconnect();
        // toastr creates the container together with its first toast, so read what is already inside
        for (const n of c.children) noteToast(n);
        toastObs = new MutationObserver(muts => {
            for (const m of muts) for (const n of m.addedNodes) noteToast(n);
        });
        toastObs.observe(c, { childList: true });
    };
    new MutationObserver(attach).observe(document.body, { childList: true });
    attach();
}

// ---------------------------------------------------------------- pings

export function parseTargets(text) {
    return String(text || '').split('\n').map(l => l.trim()).filter(Boolean).map(line => {
        const [a, b] = line.includes('|') ? line.split('|').map(x => x.trim()) : [null, line];
        try {
            const u = new URL(b);
            return { name: a || u.host, url: u.href };
        } catch {
            return null;
        }
    }).filter(Boolean);
}

async function pingOnce(name, url, sameOrigin) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10_000);
    const t0 = performance.now();
    let ok = false;
    try {
        const res = await fetch(url, { cache: 'no-store', signal: ctrl.signal, ...(sameOrigin ? {} : { mode: 'no-cors' }) });
        ok = sameOrigin ? res.ok : true; // no-cors: an opaque reply still means the host answered
    } catch {
        ok = false;
    } finally {
        clearTimeout(timer);
    }
    data.pings.push({ t: Date.now(), target: name, ok, ms: Math.round(performance.now() - t0) });
}

async function runPings() {
    const s = getSettings();
    data.lastPingAt = Date.now();
    const jobs = [];
    if (s.pingSillyTavern) jobs.push(pingOnce('SillyTavern 서버', '/version', true));
    for (const t of parseTargets(s.pingTargets)) jobs.push(pingOnce(t.name, t.url, false));
    if (!jobs.length) return;
    await Promise.all(jobs);
    saveData();
    refreshBadge();
}

// ---------------------------------------------------------------- API probe

let probeRunning = false;
const DEFAULT_PROBE_SYSTEM = 'This is an automated server health check. Reply with exactly: OK';
const DEFAULT_PROBE_USER = 'ping';

/**
 * Sends ONLY the given system + user messages.
 * With a profile: the profile's API, model, key and proxy are used; the profile's preset
 * (prompt order, samplers) and instruct template are skipped unless usePreset is on.
 * Without a profile: falls back to the current connection via generateRaw (no chat, no character card).
 */
/**
 * Without a preset, SillyTavern does not send Vertex AI's auth mode with profile requests, so the
 * server falls back to Express (API key) mode and Google rejects service-account setups with
 * "API keys are not supported by this API". Fill those fields from the current settings.
 */
function profileOverrides(profileId) {
    const ctx = SillyTavern.getContext();
    const cc = ctx.chatCompletionSettings || {};
    const out = {};
    if (cc.vertexai_auth_mode) out.vertexai_auth_mode = cc.vertexai_auth_mode;
    if (cc.vertexai_express_project_id) out.vertexai_express_project_id = cc.vertexai_express_project_id;
    const profile = ctx.extensionSettings.connectionManager?.profiles?.find(p => p.id === profileId);
    if (profile && !profile['api-url'] && cc.vertexai_region) out.vertexai_region = cc.vertexai_region;
    return out;
}

async function callLLM(system, user, maxTokens, profileId, usePreset = false) {
    const ctx = SillyTavern.getContext();
    if (profileId && ctx.ConnectionManagerRequestService) {
        const res = await ctx.ConnectionManagerRequestService.sendRequest(
            profileId,
            [{ role: 'system', content: system }, { role: 'user', content: user }],
            maxTokens,
            { stream: false, extractData: true, includePreset: !!usePreset, includeInstruct: !!usePreset },
            profileOverrides(profileId),
        );
        return typeof res === 'string' ? res : (res?.content ?? '');
    }
    return await ctx.generateRaw({ systemPrompt: system, prompt: user, responseLength: maxTokens });
}

function profileName(id) {
    if (!id) return '';
    const p = SillyTavern.getContext().extensionSettings.connectionManager?.profiles?.find(x => x.id === id);
    return p?.name || '';
}

/**
 * Sends a tiny real request to the API and records success and latency.
 * Results are stored under the current main connection, so the prediction for it improves
 * even when the probe goes through a cheaper profile on the same server.
 */
async function runProbe({ manual = false } = {}) {
    const s = getSettings();
    if (probeRunning || pending) {
        if (manual) toastr.info('생성 중이라 나중에 측정할게요.');
        return null;
    }
    const key = connKey();
    const now = Date.now();
    data.lastProbeAt = now;
    if (!manual) {
        // A real generation recently? That already tells us how the server is doing: save the request
        const recent = data.gens.some(g => g.key === key && !g.stopped && now - g.t < s.probeIntervalMin * MIN);
        if (recent) return null;
    }
    probeRunning = true;
    const via = profileName(s.probeProfileId);
    const t0 = performance.now();
    let ok = false;
    let empty = false;
    let error = '';
    let cls = 'ok';
    try {
        const text = await callLLM(
            String(s.probeSystem || '').trim() || DEFAULT_PROBE_SYSTEM,
            String(s.probeUser || '').trim() || DEFAULT_PROBE_USER,
            s.probeMaxTokens || 16,
            via ? s.probeProfileId : '',
            s.probeUsePreset,
        );
        ok = true;
        empty = !String(text || '').trim();
    } catch (err) {
        const msg = err?.cause?.message || err?.message || String(err);
        // The server answered but the text was empty (e.g. reasoning used every token): it is alive
        if (/No message generated/i.test(msg)) {
            ok = true;
            empty = true;
        } else {
            error = msg.slice(0, 200);
            cls = classifyError(msg);
            // A filtered reply still proves the server is up
            if (cls === 'blocked') ok = true;
        }
    } finally {
        probeRunning = false;
    }
    const rec = { t: now, key, ok, cls, ms: Math.round(performance.now() - t0), empty, via, error };
    data.probes.push(rec);
    saveData();
    refreshBadge();
    if (manual) {
        if (ok) toastr.success(`API 응답 ${fmtMs(rec.ms)}${via ? ` (${via} 경유)` : ''}`, 'Server Pulse');
        else toastr.error(`${CLASS_LABEL[cls] || ''}: ${error || '응답 없음'}`, 'API 측정 실패');
    }
    return rec;
}

// ---------------------------------------------------------------- rating

let ratingToast = null;

function addRating(score, source = 'manual') {
    const key = connKey();
    const s = clamp(Math.round(Number(score)), 1, 5);
    if (!Number.isFinite(s)) return false;
    data.ratings.push({ t: Date.now(), key, score: s, source, snap: metricsSnapshot(data, key, Date.now()) });
    data.lastPromptAt = Date.now();
    saveData();
    refreshBadge();
    return true;
}

function starsHtml() {
    return [1, 2, 3, 4, 5].map(n => `<button class="sp-rate-btn menu_button" data-score="${n}" title="${n}점">${n}</button>`).join('');
}

function showRatingPrompt() {
    if (ratingToast) return;
    data.lastPromptAt = Date.now();
    saveData();
    const html = `<div class="sp-prompt">지금 서버 상태 어때요? <small>(${esc(connKey())})</small>
        <div class="sp-stars">${starsHtml()}</div>
        <div class="sp-legend">1 = 안 됨 · 3 = 보통 · 5 = 쾌적</div>
        <button class="sp-skip menu_button">건너뛰기</button></div>`;
    ratingToast = toastr.info(html, 'Server Pulse', {
        escapeHtml: false, timeOut: 120_000, extendedTimeOut: 30_000, tapToDismiss: false, closeButton: true,
        onHidden: () => { ratingToast = null; },
    });
    ratingToast?.find?.('.sp-skip').on('click', (e) => { e.stopPropagation(); closeRatingToast(); });
}

/**
 * Closes the rating toast for sure. toastr.clear() refuses to hide a toast that contains the
 * focused element, and the clicked button is focused, so blur first and remove it directly.
 */
function closeRatingToast(delay = 0) {
    const t = ratingToast;
    ratingToast = null;
    if (!t) return;
    if (t[0]?.contains(document.activeElement)) document.activeElement.blur();
    setTimeout(() => {
        try {
            t.fadeOut(200, () => t.remove());
        } catch {
            t.remove?.();
        }
    }, delay);
}

function maybePrompt() {
    const s = getSettings();
    if (!s.enabled || !s.ratingIntervalMin || ratingToast) return;
    if (document.visibilityState !== 'visible') return;
    const now = Date.now();
    if (now - data.lastPromptAt < s.ratingIntervalMin * MIN) return;
    const gensSince = data.gens.filter(g => g.t > data.lastPromptAt).length;
    if (gensSince < s.ratingMinGens) return;
    showRatingPrompt();
}

// ---------------------------------------------------------------- UI: badge & dashboard

function refreshBadge() {
    const s = getSettings();
    let el = document.getElementById('sp_badge');
    if (!s.enabled || !s.showBadge) {
        el?.remove();
        return;
    }
    if (!el) {
        el = document.createElement('div');
        el.id = 'sp_badge';
        el.setAttribute('role', 'button');
        el.tabIndex = 0;
        bindTap(el, openDashboard);
        el.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDashboard(); } });
    }
    // Keep it the last child of body so later overlays from themes do not end up on top of it
    if (el.parentElement !== document.body || document.body.lastElementChild !== el) document.body.appendChild(el);
    const p = predict(data, s, connKey(), Date.now());
    el.className = `sp-badge sp-pos-${s.badgePos || 'top-right'} ${p.label.cls}`;
    el.innerHTML = `<span class="sp-dot"></span>${p.success == null ? (p.score == null ? '?' : p.score.toFixed(1)) : `${Math.round(p.success * 100)}%`}`;
    el.title = `지금 보내면 성공할 가능성 ${p.success == null ? '-' : `${Math.round(p.success * 100)}%`} · ${p.label.text} (신뢰도 ${p.confidence})\n${p.reasons.join('\n')}\n클릭하면 자세히`;
}

function statsTable(now) {
    const byKey = new Map();
    for (const g of data.gens.filter(x => now - x.t <= DAY && !x.stopped)) {
        if (!byKey.has(g.key)) byKey.set(g.key, []);
        byKey.get(g.key).push(g);
    }
    if (!byKey.size) return '<p class="sp-muted">최근 24시간 생성 기록이 없어요.</p>';
    const rows = [...byKey].map(([k, gs]) => {
        const c = cls => gs.filter(g => outcomeOf(g) === cls).length;
        const ok = gs.filter(g => outcomeOf(g) === 'ok');
        const counted = gs.filter(g => FAIL_WEIGHT[outcomeOf(g)] != null);
        const rate = counted.length ? Math.round((1 - counted.reduce((x, g) => x + FAIL_WEIGHT[outcomeOf(g)], 0) / counted.length) * 100) : '-';
        return `<tr><td>${esc(k)}</td><td>${gs.length}</td><td>${rate}%</td><td>${c('quota')}</td><td>${c('overload') + c('network')}</td><td>${c('blocked')}</td><td>${fmtMs(median(ok.map(g => g.ms)))}</td></tr>`;
    }).join('');
    return `<table class="sp-table"><tr><th>연결</th><th>생성</th><th>서버 성공률</th><th>429</th><th>5xx·끊김</th><th>차단</th><th>응답</th></tr>${rows}</table>
        <p class="sp-muted">안전 필터 차단은 서버는 정상 응답한 것이라 성공률 계산에서 실패로 치지 않아요.</p>`;
}

function recentFailures(now) {
    const fails = data.gens.filter(g => now - g.t <= DAY && !g.stopped && !['ok'].includes(outcomeOf(g))).slice(-6).reverse();
    if (!fails.length) return '';
    return `<ul class="sp-fails">${fails.map(g => `<li><span class="sp-fail-tag sp-f-${outcomeOf(g)}">${esc(CLASS_LABEL[outcomeOf(g)] || outcomeOf(g))}</span> ${new Date(g.t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}${g.err ? ` <small>${esc(g.err)}</small>` : ''}</li>`).join('')}</ul>`;
}

function pingTable(now) {
    const byT = new Map();
    for (const p of data.pings.filter(x => now - x.t <= DAY)) {
        if (!byT.has(p.target)) byT.set(p.target, []);
        byT.get(p.target).push(p);
    }
    if (!byT.size) return '<p class="sp-muted">핑 기록이 없어요. 설정에서 핑 대상을 추가할 수 있어요.</p>';
    const rows = [...byT].map(([name, ps]) => {
        const last = ps.at(-1);
        const up = ps.filter(p => p.ok).length / ps.length;
        return `<tr><td>${esc(name)}</td><td>${last.ok ? '<span class="sp-up">응답</span>' : '<span class="sp-down">무응답</span>'}</td><td>${Math.round(up * 100)}%</td><td>${fmtMs(median(ps.filter(p => p.ok).map(p => p.ms)))}</td></tr>`;
    }).join('');
    return `<table class="sp-table"><tr><th>대상</th><th>마지막</th><th>24시간 가동률</th><th>지연(중앙값)</th></tr>${rows}</table>`;
}

function probeTable(now) {
    const byKey = new Map();
    for (const p of (data.probes || []).filter(x => now - x.t <= DAY)) {
        if (!byKey.has(p.key)) byKey.set(p.key, []);
        byKey.get(p.key).push(p);
    }
    if (!byKey.size) return '<p class="sp-muted">API 측정 기록이 없어요. 최근에 실제 생성이 있었으면 측정을 건너뛰어요.</p>';
    const rows = [...byKey].map(([k, ps]) => {
        const last = ps.at(-1);
        const ok = ps.filter(p => p.ok);
        const lastTxt = last.ok ? '<span class="sp-up">성공</span>' : `<span class="sp-down" title="${esc(last.error)}">실패</span>`;
        return `<tr><td>${esc(k)}${last.via ? `<br><small>${esc(last.via)} 경유</small>` : ''}</td><td>${ps.length}</td><td>${Math.round(ok.length / ps.length * 100)}%</td><td>${fmtMs(median(ok.map(p => p.ms)))}</td><td>${lastTxt}</td></tr>`;
    }).join('');
    return `<table class="sp-table"><tr><th>연결</th><th>측정</th><th>성공률</th><th>응답(중앙값)</th><th>마지막</th></tr>${rows}</table>`;
}

function forecastHtml(p) {
    const bars = p.forecast.map(f => {
        const h = new Date(f.t).getHours();
        const lab = labelFor(f.score);
        const height = f.success == null ? 6 : Math.max(4, Math.round(f.success * 100));
        const why = f.quota >= 0.15 ? ' · 429 잦음' : f.overload >= 0.15 ? ' · 과부하 잦음' : '';
        return `<div class="sp-bar-col" title="${h}시: ${f.success == null ? '기록 없음' : `성공 ${Math.round(f.success * 100)}%${why}`}">
            <div class="sp-bar ${lab.cls}" style="height:${height}%"></div><div class="sp-bar-h">${h % 3 === 0 ? h : ''}</div></div>`;
    }).join('');
    const known = p.forecast.filter(f => f.success != null && f.neff >= 1);
    let tip = '생성하거나 API 측정이 쌓이면 시간대별 예측이 나와요. 별점은 없어도 돼요.';
    if (known.length >= 3) {
        const best = [...known].sort((a, b) => b.success - a.success).slice(0, 3).map(f => `${new Date(f.t).getHours()}시`);
        const worst = [...known].sort((a, b) => a.success - b.success)[0];
        const worstWhy = worst.quota >= 0.15 ? '429' : worst.overload >= 0.15 ? '과부하' : '실패';
        tip = `잘 될 것 같은 시간: <b>${best.join(', ')}</b>${worst.success < 0.8 ? ` · 피하면 좋은 시간: <b>${new Date(worst.t).getHours()}시</b> (${worstWhy} ${Math.round((1 - worst.success) * 100)}%)` : ''}`;
    }
    return `<div class="sp-forecast">${bars}</div><div class="sp-tip">${tip}</div>`;
}

function heatmapHtml(now, s, key) {
    const cells = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => ({ sw: 0, sf: 0 })));
    for (const e of serverEvents(data, key, now)) {
        const d = new Date(e.t);
        const w = decay(now - e.t, s.halfLifeDays || 21) * e.bw;
        const c = cells[d.getDay()][d.getHours()];
        c.sw += w;
        c.sf += w * e.fail;
    }
    const days = ['일', '월', '화', '수', '목', '금', '토'];
    const rows = cells.map((row, di) => `<div class="sp-hm-row"><span class="sp-hm-day">${days[di]}</span>${row.map((c, h) => {
        const succ = c.sw ? 1 - c.sf / c.sw : null;
        return `<span class="sp-hm-cell ${labelFor(succ == null ? null : scoreFrom(succ, null)).cls}" title="${days[di]} ${h}시: ${succ == null ? '-' : `성공 ${Math.round(succ * 100)}%`}"></span>`;
    }).join('')}</div>`).join('');
    return `<div class="sp-heatmap">${rows}<div class="sp-hm-row"><span class="sp-hm-day"></span>${Array.from({ length: 24 }, (_, h) => `<span class="sp-hm-lab">${h % 6 === 0 ? h : ''}</span>`).join('')}</div></div>`;
}

/**
 * Fires on a real tap/click even when another script cancels the synthetic click on touch screens:
 * listens to pointerup (no drag) and click, and ignores the click that follows a handled pointerup.
 */
function bindTap(el, fn) {
    let down = null;
    let handledAt = 0;
    const fire = (e) => {
        handledAt = Date.now();
        e.stopPropagation();
        fn();
    };
    el.addEventListener('pointerdown', (e) => { down = { x: e.clientX, y: e.clientY, t: Date.now() }; }, true);
    el.addEventListener('pointerup', (e) => {
        if (!down) return;
        const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
        const quick = Date.now() - down.t < 800;
        down = null;
        if (moved < 10 && quick) fire(e);
    }, true);
    el.addEventListener('click', (e) => {
        if (Date.now() - handledAt < 700) return;
        fire(e);
    }, true);
}

let dashboardOpen = false;

async function openDashboard() {
    if (dashboardOpen) return;
    dashboardOpen = true;
    try {
        await renderDashboard();
    } catch (err) {
        console.error(LOG, 'dashboard failed', err);
        toastr.error(String(err?.message || err), 'Server Pulse');
    } finally {
        dashboardOpen = false;
    }
}

function addWandMenuItem() {
    const menu = document.getElementById('extensionsMenu');
    if (!menu || document.getElementById('sp_wand_item')) return;
    const item = document.createElement('div');
    item.id = 'sp_wand_item';
    item.className = 'list-group-item flex-container flexGap5';
    item.innerHTML = '<div class="fa-solid fa-heart-pulse extensionsMenuExtensionButton"></div><span>서버 상태 (Server Pulse)</span>';
    item.addEventListener('click', () => openDashboard());
    menu.appendChild(item);
}

async function renderDashboard() {
    const s = getSettings();
    const now = Date.now();
    const key = connKey();
    const p = predict(data, s, key, now);
    const html = `
    <div class="sp-dash">
        <h3>서버 상태 예측</h3>
        <div class="sp-now ${p.label.cls}">
            <div class="sp-now-score">${p.success == null ? '?' : Math.round(p.success * 100)}<small>%</small></div>
            <div><b>지금 보내면 성공할 가능성</b> · ${p.label.text}${p.score == null ? '' : ` (${p.score.toFixed(1)}/5)`}<br><small>신뢰도 ${p.confidence} · ${esc(key)}</small></div>
        </div>
        <ul class="sp-reasons">${p.reasons.map(r => `<li>${esc(r)}</li>`).join('') || '<li>아직 데이터가 없어요. 몇 번 생성하면 바로 예측이 시작돼요.</li>'}</ul>
        <div class="sp-section">지금 평가하기 <div class="sp-stars">${starsHtml()}</div></div>
        <h4>앞으로 24시간 성공 가능성</h4>
        ${forecastHtml(p)}
        <h4>요일·시간별 성공률</h4>
        ${heatmapHtml(now, s, key)}
        <h4>최근 24시간 생성</h4>
        ${statsTable(now)}
        ${recentFailures(now)}
        <h4>API 직접 측정 (24시간) <span class="menu_button sp-probe-btn" title="작은 요청을 한 번 보내 응답 시간을 잽니다">지금 측정</span></h4>
        ${probeTable(now)}
        <h4>핑</h4>
        ${pingTable(now)}
        <p class="sp-muted">예측 근거 ${p.events}건 · 평가 ${data.ratings.length}개 · 생성 기록 ${data.gens.length}개 · API 측정 ${data.probes.length}개 · 핑 ${data.pings.length}개${p.scoped ? ' · 이 연결의 평가만 사용 중' : ''}</p>
    </div>`;
    const { Popup, POPUP_TYPE } = SillyTavern.getContext();
    await new Popup(html, POPUP_TYPE.TEXT, '', { wide: true, allowVerticalScrolling: true, okButton: '닫기' }).show();
}

// ---------------------------------------------------------------- settings panel

function createSettingsUI() {
    const s = getSettings();
    const html = `
    <div id="sp_settings" class="extension_settings">
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>Server Pulse (서버 상태 예측)</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <label class="checkbox_label"><input id="sp_enabled" type="checkbox" /><span>켜기</span></label>
                <label class="checkbox_label"><input id="sp_badge_toggle" type="checkbox" /><span>화면에 상태 배지 표시</span></label>
                <label for="sp_badge_pos">배지 위치</label>
                <select id="sp_badge_pos" class="text_pole">
                    <option value="top-right">오른쪽 위</option>
                    <option value="top-left">왼쪽 위</option>
                    <option value="bottom-right">오른쪽 아래</option>
                    <option value="bottom-left">왼쪽 아래</option>
                </select>
                <small>배지가 눌리지 않거나 다른 버튼과 겹치면 위치를 바꿔 보세요. 마술봉(확장) 메뉴의 "서버 상태"로도 열 수 있어요.</small>
                <label class="checkbox_label"><input id="sp_per_conn" type="checkbox" /><span>연결(모델)별로 따로 예측</span></label>
                <label for="sp_rate_int">평가 물어보는 간격(분, 0 = 안 물음)</label>
                <input id="sp_rate_int" class="text_pole" type="number" min="0" max="1440" step="5" />
                <label for="sp_rate_min">물어보기 전 최소 생성 횟수</label>
                <input id="sp_rate_min" class="text_pole" type="number" min="0" max="50" step="1" />
                <label for="sp_probe_int">API 직접 측정 간격(분, 0 = 끔)</label>
                <input id="sp_probe_int" class="text_pole" type="number" min="0" max="1440" step="5" />
                <label for="sp_probe_profile">측정에 쓸 연결</label>
                <select id="sp_probe_profile" class="text_pole"></select>
                <small>프로필을 고르면 그 프로필의 API·모델·키·프록시로, 아래 프롬프트만 보내요(프리셋·캐릭터·채팅은 안 들어감). 그 사이 실제 생성이 있었으면 측정을 건너뛰어요.</small>
                <label class="checkbox_label"><input id="sp_probe_preset" type="checkbox" /><span>프로필에 묶인 프리셋 설정(온도 등)도 적용</span></label>
                <label for="sp_probe_sys">측정용 시스템 프롬프트 (비우면 기본값)</label>
                <textarea id="sp_probe_sys" class="text_pole" rows="2"></textarea>
                <label for="sp_probe_user">측정용 유저 메시지 (비우면 기본값)</label>
                <input id="sp_probe_user" class="text_pole" type="text" />
                <label for="sp_probe_max">측정 최대 응답 토큰</label>
                <input id="sp_probe_max" class="text_pole" type="number" min="1" max="4096" step="1" />
                <small>추론(thinking) 모델은 토큰이 적으면 빈 답이 올 수 있어요. 빈 답도 "서버 응답함"으로 기록돼요.</small>
                <label for="sp_ping_int">핑 간격(분, 0 = 끔)</label>
                <input id="sp_ping_int" class="text_pole" type="number" min="0" max="120" step="1" />
                <label class="checkbox_label"><input id="sp_ping_st" type="checkbox" /><span>SillyTavern 서버 자체도 핑</span></label>
                <label for="sp_targets">추가 핑 대상 (한 줄에 하나, <code>이름 | 주소</code>)</label>
                <textarea id="sp_targets" class="text_pole" rows="3" placeholder="내 프록시 | https://example.com/"></textarea>
                <small>API 키를 주소에 넣지 마세요. 핑은 "응답이 오는지"만 확인해요.</small>
                <div class="flex-container">
                    <div id="sp_open" class="menu_button menu_button_icon"><i class="fa-solid fa-heart-pulse"></i><span>대시보드</span></div>
                    <div id="sp_rate_now" class="menu_button menu_button_icon"><i class="fa-solid fa-star"></i><span>지금 평가</span></div>
                    <div id="sp_probe_now" class="menu_button menu_button_icon"><i class="fa-solid fa-satellite-dish"></i><span>지금 측정</span></div>
                    <div id="sp_export" class="menu_button menu_button_icon"><i class="fa-solid fa-download"></i><span>내보내기</span></div>
                    <div id="sp_import" class="menu_button menu_button_icon"><i class="fa-solid fa-upload"></i><span>가져오기</span></div>
                    <div id="sp_reset" class="menu_button menu_button_icon redWarningBG"><i class="fa-solid fa-trash"></i><span>기록 초기화</span></div>
                </div>
                <input id="sp_import_file" type="file" accept=".json,application/json" hidden />
                <small>슬래시 명령: <code>/pulse</code> (대시보드), <code>/pulse-rate 4</code> (평가 기록)</small>
            </div>
        </div>
    </div>`;
    document.getElementById('extensions_settings2')?.insertAdjacentHTML('beforeend', html);
    const { saveSettingsDebounced } = SillyTavern.getContext();
    const $ = id => document.getElementById(id);

    const bindCheck = (id, key, after) => {
        $(id).checked = !!s[key];
        $(id).addEventListener('change', () => { s[key] = $(id).checked; saveSettingsDebounced(); after?.(); });
    };
    const bindNum = (id, key, lo, hi) => {
        $(id).value = s[key];
        $(id).addEventListener('change', () => {
            s[key] = clamp(parseInt($(id).value) || 0, lo, hi);
            $(id).value = s[key];
            saveSettingsDebounced();
        });
    };
    bindCheck('sp_enabled', 'enabled', refreshBadge);
    bindCheck('sp_badge_toggle', 'showBadge', refreshBadge);
    bindCheck('sp_per_conn', 'perConnection', refreshBadge);
    $('sp_badge_pos').value = s.badgePos || 'top-right';
    $('sp_badge_pos').addEventListener('change', () => { s.badgePos = $('sp_badge_pos').value; saveSettingsDebounced(); refreshBadge(); });
    bindCheck('sp_ping_st', 'pingSillyTavern');
    bindNum('sp_rate_int', 'ratingIntervalMin', 0, 1440);
    bindNum('sp_rate_min', 'ratingMinGens', 0, 50);
    bindNum('sp_ping_int', 'pingIntervalMin', 0, 120);
    bindNum('sp_probe_int', 'probeIntervalMin', 0, 1440);
    bindNum('sp_probe_max', 'probeMaxTokens', 1, 4096);
    bindCheck('sp_probe_preset', 'probeUsePreset');
    $('sp_probe_sys').placeholder = DEFAULT_PROBE_SYSTEM;
    $('sp_probe_sys').value = s.probeSystem;
    $('sp_probe_sys').addEventListener('input', () => { s.probeSystem = $('sp_probe_sys').value; saveSettingsDebounced(); });
    $('sp_probe_user').placeholder = DEFAULT_PROBE_USER;
    $('sp_probe_user').value = s.probeUser;
    $('sp_probe_user').addEventListener('input', () => { s.probeUser = $('sp_probe_user').value; saveSettingsDebounced(); });
    const sel = $('sp_probe_profile');
    fillProfileSelect(sel, s.probeProfileId);
    sel.addEventListener('focus', () => fillProfileSelect(sel, s.probeProfileId));
    sel.addEventListener('change', () => { s.probeProfileId = sel.value; saveSettingsDebounced(); });
    $('sp_probe_now').addEventListener('click', () => runProbe({ manual: true }));
    $('sp_targets').value = s.pingTargets;
    $('sp_targets').addEventListener('change', () => { s.pingTargets = $('sp_targets').value; saveSettingsDebounced(); });

    $('sp_open').addEventListener('click', openDashboard);
    $('sp_rate_now').addEventListener('click', showRatingPrompt);
    $('sp_export').addEventListener('click', () => {
        const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `server-pulse-${new Date().toISOString().slice(0, 10)}.json`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    });
    $('sp_import').addEventListener('click', () => $('sp_import_file').click());
    $('sp_import_file').addEventListener('change', async (e) => {
        const file = e.target.files?.[0];
        if (!file) return;
        try {
            const incoming = JSON.parse(await file.text());
            for (const k of ['gens', 'pings', 'ratings', 'probes']) {
                if (!Array.isArray(incoming[k])) continue;
                const seen = new Set(data[k].map(x => `${x.t}|${x.key ?? x.target}`));
                data[k].push(...incoming[k].filter(x => x && Number.isFinite(x.t) && !seen.has(`${x.t}|${x.key ?? x.target}`)));
                data[k].sort((a, b) => a.t - b.t);
            }
            saveData();
            refreshBadge();
            toastr.success('기록을 합쳤어요.');
        } catch (err) {
            toastr.error(`가져오기 실패: ${err.message}`);
        }
        e.target.value = '';
    });
    $('sp_reset').addEventListener('click', async () => {
        const { Popup, POPUP_RESULT } = SillyTavern.getContext();
        const ok = await Popup.show.confirm('기록 초기화', '평가·생성·API 측정·핑 기록을 모두 지울까요? 되돌릴 수 없어요.');
        if (ok !== POPUP_RESULT.AFFIRMATIVE) return;
        data = { gens: [], pings: [], ratings: [], probes: [], lastPromptAt: Date.now(), lastPingAt: 0, lastProbeAt: 0 };
        saveData();
        refreshBadge();
        toastr.success('초기화했어요.');
    });
}

function fillProfileSelect(select, currentId) {
    const ctx = SillyTavern.getContext();
    let profiles = [];
    try {
        profiles = ctx.ConnectionManagerRequestService?.getSupportedProfiles?.() ?? [];
    } catch {
        profiles = []; // Connection Manager disabled
    }
    select.innerHTML = '<option value="">현재 연결로 측정 (프로필 없음)</option>'
        + profiles.map(p => `<option value="${esc(p.id)}">${esc(p.name)} (프로필)</option>`).join('');
    select.value = profiles.some(p => p.id === currentId) ? currentId : '';
}

function registerCommands() {
    const { SlashCommandParser, SlashCommand, SlashCommandArgument, ARGUMENT_TYPE } = SillyTavern.getContext();
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'pulse',
        callback: async () => {
            openDashboard();
            const p = predict(data, getSettings(), connKey(), Date.now());
            return p.score == null ? '' : p.score.toFixed(2);
        },
        returns: 'predicted server score (1-5) for the current connection',
        helpString: '<div>서버 상태 대시보드를 열고 현재 예측 점수(1~5)를 반환합니다.</div>',
    }));
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'pulse-probe',
        callback: async () => {
            const rec = await runProbe({ manual: true });
            return rec ? (rec.ok ? String(rec.ms) : 'fail') : '';
        },
        returns: 'probe latency in ms, or "fail"',
        helpString: '<div>API에 아주 짧은 요청을 보내 응답 시간(ms)을 재고 기록합니다.</div>',
    }));
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'pulse-rate',
        callback: (_named, unnamed) => {
            const ok = addRating(String(unnamed ?? '').trim());
            if (ok) toastr.success('평가를 기록했어요.');
            else toastr.warning('1~5 사이 숫자를 넣어 주세요.');
            return '';
        },
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: 'rating from 1 (unusable) to 5 (smooth)',
                typeList: [ARGUMENT_TYPE.NUMBER],
                isRequired: true,
                enumList: ['1', '2', '3', '4', '5'],
            }),
        ],
        helpString: '<div>지금 서버 상태를 1~5점으로 기록합니다. 예: <code>/pulse-rate 4</code></div>',
    }));
}

// ---------------------------------------------------------------- init

if (globalThis.SillyTavern?.getContext) {
    const { eventSource, event_types } = SillyTavern.getContext();
    eventSource.on(event_types.APP_READY, async () => {
        try {
            getSettings();
            await loadData();
            createSettingsUI();
            registerCommands();
            addWandMenuItem();
            watchToasts();

            eventSource.on(event_types.GENERATION_STARTED, onGenStarted);
            eventSource.on(event_types.STREAM_TOKEN_RECEIVED, onToken);
            eventSource.on(event_types.MESSAGE_RECEIVED, onMessageReceived);
            eventSource.on(event_types.GENERATION_STOPPED, onStopped);
            eventSource.on(event_types.GENERATION_ENDED, onGenEnded);
            for (const ev of [event_types.MAIN_API_CHANGED, event_types.CHATCOMPLETION_MODEL_CHANGED, event_types.CHATCOMPLETION_SOURCE_CHANGED, event_types.CONNECTION_PROFILE_LOADED]) {
                if (ev) eventSource.on(ev, () => setTimeout(refreshBadge, 200));
            }
            for (const ev of [event_types.CONNECTION_PROFILE_CREATED, event_types.CONNECTION_PROFILE_DELETED, event_types.CONNECTION_PROFILE_UPDATED]) {
                if (ev) eventSource.on(ev, () => {
                    const sel = document.getElementById('sp_probe_profile');
                    if (sel) fillProfileSelect(sel, getSettings().probeProfileId);
                });
            }

            // Rating buttons live in toasts and popups: one delegated handler
            document.addEventListener('click', (e) => {
                if (e.target instanceof Element && e.target.closest('.sp-probe-btn')) {
                    runProbe({ manual: true });
                    return;
                }
                const btn = e.target instanceof Element ? e.target.closest('.sp-rate-btn') : null;
                if (!btn) return;
                e.stopPropagation();
                const inToast = btn.closest('.toast');
                if (!addRating(btn.dataset.score, inToast ? 'prompt' : 'manual')) return;
                if (inToast) {
                    // Confirm inside the same toast, then close it
                    const box = inToast.querySelector('.sp-prompt');
                    if (box) box.innerHTML = `<b>${esc(btn.dataset.score)}점</b>으로 기록했어요. 고마워요!`;
                    closeRatingToast(1200);
                } else {
                    toastr.success(`${btn.dataset.score}점으로 기록했어요.`);
                    btn.blur();
                }
            });

            // One timer drives pings, rating prompts and the badge
            setInterval(() => {
                const st = getSettings();
                if (!st.enabled) return;
                if (st.pingIntervalMin > 0 && Date.now() - data.lastPingAt >= st.pingIntervalMin * MIN) runPings();
                if (st.probeIntervalMin > 0 && document.visibilityState === 'visible'
                    && Date.now() - data.lastProbeAt >= st.probeIntervalMin * MIN) runProbe();
                maybePrompt();
                refreshBadge();
            }, MIN);
            if (getSettings().enabled && getSettings().pingIntervalMin > 0) runPings();
            refreshBadge();
            console.log(LOG, 'ready');
        } catch (err) {
            console.error(LOG, 'init failed', err);
        }
    });
}
