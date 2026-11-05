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
            return `${src}/${model}`;
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

function hourOf(t) {
    const d = new Date(t);
    return d.getHours() + d.getMinutes() / 60;
}

function isWeekend(t) {
    const day = new Date(t).getDay();
    return day === 0 || day === 6;
}

// ---------------------------------------------------------------- metrics

/**
 * Live metrics for one connection around time `now`. Exported for testing.
 */
export function metricsSnapshot(d, key, now) {
    let gens = d.gens.filter(g => g.key === key && !g.stopped && now - g.t <= 30 * MIN && g.t <= now);
    if (gens.length < 2) {
        gens = d.gens.filter(g => g.key === key && !g.stopped && now - g.t <= 3 * HOUR && g.t <= now).slice(-5);
    }
    const n = gens.length;
    const fails = gens.filter(g => !g.ok).length;
    const medMs = median(gens.filter(g => g.ok).map(g => g.ms));
    const medTtft = median(gens.filter(g => g.ok).map(g => g.ttft));
    const baseline = median(d.gens.filter(g => g.key === key && g.ok && now - g.t <= 14 * DAY && g.t <= now).map(g => g.ms));
    const baseCount = d.gens.filter(g => g.key === key && g.ok && now - g.t <= 14 * DAY).length;
    const latRatio = medMs && baseline && baseCount >= 5 ? medMs / baseline : null;

    const pings = d.pings.filter(p => now - p.t <= 30 * MIN && p.t <= now);
    const pingFail = pings.length ? pings.filter(p => !p.ok).length / pings.length : null;

    // API probes (tiny real requests) for this connection
    const allProbes = (d.probes || []).filter(p => p.key === key && p.t <= now);
    let probes = allProbes.filter(p => now - p.t <= 30 * MIN);
    if (!probes.length) probes = allProbes.filter(p => now - p.t <= 2 * HOUR).slice(-2);
    const probeN = probes.length;
    const probeFail = probeN ? probes.filter(p => !p.ok).length / probeN : null;
    const probeMs = median(probes.filter(p => p.ok).map(p => p.ms));
    const probeBase = allProbes.filter(p => p.ok && now - p.t <= 14 * DAY);
    const probeLat = probeMs && probeBase.length >= 5 ? probeMs / median(probeBase.map(p => p.ms)) : null;

    return {
        n, failRate: n ? fails / n : null, medMs, medTtft,
        latRatio: latRatio ?? probeLat, pingFail, probeN, probeFail, probeMs,
    };
}

function features(s) {
    return [
        1,
        s.failRate ?? 0,
        s.latRatio ? clamp(Math.log2(s.latRatio), -2, 3) : 0,
        s.pingFail ?? 0,
        s.probeFail ?? 0,
    ];
}

function heuristicScore(s) {
    let score = 4.3;
    if (s.failRate != null) score -= 3.2 * s.failRate;
    if (s.latRatio) score -= 0.9 * Math.max(0, Math.log2(s.latRatio)) - 0.3 * Math.max(0, -Math.log2(s.latRatio));
    if (s.pingFail != null) score -= 2 * s.pingFail;
    if (s.probeFail != null) score -= 2.8 * s.probeFail;
    return clamp(score, 1, 5);
}

// Weighted ridge regression: rating ~ features(snapshot)
function fitRidge(rows, lambda = 1) {
    const k = rows[0].x.length;
    const A = Array.from({ length: k }, () => new Array(k).fill(0));
    const b = new Array(k).fill(0);
    for (const { x, y, w } of rows) {
        for (let i = 0; i < k; i++) {
            b[i] += w * x[i] * y;
            for (let j = 0; j < k; j++) A[i][j] += w * x[i] * x[j];
        }
    }
    for (let i = 1; i < k; i++) A[i][i] += lambda;
    A[0][0] += 1e-6;
    // Gaussian elimination
    const M = A.map((row, i) => [...row, b[i]]);
    for (let c = 0; c < k; c++) {
        let p = c;
        for (let r = c + 1; r < k; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
        [M[c], M[p]] = [M[p], M[c]];
        if (Math.abs(M[c][c]) < 1e-12) return null;
        for (let r = 0; r < k; r++) {
            if (r === c) continue;
            const f = M[r][c] / M[c][c];
            for (let j = c; j <= k; j++) M[r][j] -= f * M[c][j];
        }
    }
    return M.map((row, i) => row[k] / row[i]);
}

function decay(age, halfLifeDays) {
    return Math.pow(0.5, Math.max(0, age) / (halfLifeDays * DAY));
}

/**
 * Rating expected at time `t` from past ratings at similar hours. Exported for testing.
 */
export function timePrior(ratings, t, now, halfLifeDays) {
    if (!ratings.length) return { mean: null, neff: 0 };
    const h = hourOf(t);
    const we = isWeekend(t);
    const global = ratings.reduce((s, r) => s + r.score, 0) / ratings.length;
    let sw = 0;
    let sws = 0;
    for (const r of ratings) {
        let dh = Math.abs(hourOf(r.t) - h);
        dh = Math.min(dh, 24 - dh);
        const w = decay(now - r.t, halfLifeDays) * Math.exp(-(dh * dh) / (2 * 1.5 * 1.5)) * (isWeekend(r.t) === we ? 1 : 0.5);
        sw += w;
        sws += w * r.score;
    }
    const k = 1.5; // shrink toward the overall average when data is thin
    return { mean: (sws + k * global) / (sw + k), neff: sw };
}

function scopedRatings(d, key, settings) {
    if (settings.perConnection) {
        const own = d.ratings.filter(r => r.key === key);
        if (own.length >= 5) return { list: own, scoped: true };
    }
    return { list: d.ratings, scoped: false };
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
 */
export function predict(d, settings, key, now) {
    const { list: ratings, scoped } = scopedRatings(d, key, settings);
    const snap = metricsSnapshot(d, key, now);
    const prior = timePrior(ratings, now, now, settings.halfLifeDays);
    const reasons = [];

    // Metric model: learned from the user's ratings once there are enough, else a heuristic
    const rows = ratings
        .filter(r => r.snap && r.snap.n > 0)
        .map(r => ({ x: features(r.snap), y: r.score, w: decay(now - r.t, settings.halfLifeDays) }));
    const beta = rows.length >= 6 ? fitRidge(rows) : null;
    const hasLive = snap.n > 0 || snap.pingFail != null || snap.probeFail != null;
    let metricScore = null;
    if (hasLive) {
        const x = features(snap);
        const heur = heuristicScore(snap);
        if (beta) {
            // Trust the learned model more as ratings accumulate, but never fully (it can extrapolate badly)
            const reg = clamp(x.reduce((s, xi, i) => s + xi * beta[i], 0), 1, 5);
            const wReg = Math.min(0.7, rows.length / 40);
            metricScore = wReg * reg + (1 - wReg) * heur;
        } else {
            metricScore = heur;
        }
        // Many failures right now: never report better than the rule-based score
        if ((snap.failRate ?? 0) >= 0.5 || (snap.probeFail ?? 0) >= 0.5) metricScore = Math.min(metricScore, heur);
    }

    let score = null;
    if (metricScore != null && prior.mean != null) {
        const wPrior = clamp(prior.neff / (prior.neff + 3), 0.15, 0.5);
        score = (1 - wPrior) * metricScore + wPrior * prior.mean;
    } else {
        score = metricScore ?? prior.mean;
    }

    // A rating the user just gave outweighs everything for a while
    const last = ratings.filter(r => r.t <= now).at(-1);
    if (last && now - last.t < HOUR) {
        const w = 0.7 * (1 - (now - last.t) / HOUR);
        score = score == null ? last.score : w * last.score + (1 - w) * score;
        reasons.push(`${Math.round((now - last.t) / MIN)}분 전 내 평가 ${last.score}점 반영`);
    }

    if (snap.n) {
        reasons.push(`최근 생성 ${snap.n}회 중 실패 ${Math.round((snap.failRate || 0) * snap.n)}회`);
        if (snap.medMs) reasons.push(`응답 ${fmtMs(snap.medMs)}${snap.latRatio ? ` (평소의 ${snap.latRatio.toFixed(1)}배)` : ''}`);
    }
    if (snap.probeN) reasons.push(`API 측정 ${snap.probeN}회 중 실패 ${Math.round((snap.probeFail || 0) * snap.probeN)}회${snap.probeMs ? `, 응답 ${fmtMs(snap.probeMs)}` : ''}${!snap.n && snap.latRatio ? ` (평소의 ${snap.latRatio.toFixed(1)}배)` : ''}`);
    if (snap.pingFail != null) reasons.push(`핑 실패율 ${Math.round(snap.pingFail * 100)}%`);
    if (prior.mean != null && prior.neff >= 0.5) reasons.push(`이 시간대 평소 평가 ${prior.mean.toFixed(1)}점`);
    if (beta) reasons.push(`내 평가 ${rows.length}개로 학습된 모델 사용`);

    const neff = prior.neff + (snap.n ? Math.min(snap.n, 5) : 0) + (snap.probeN ? Math.min(snap.probeN, 2) : 0) + (beta ? 2 : 0);
    const confidence = score == null ? '없음' : neff >= 8 ? '높음' : neff >= 3 ? '보통' : '낮음';

    const forecast = [];
    const startHour = new Date(now);
    startHour.setMinutes(0, 0, 0);
    for (let i = 1; i <= 24; i++) {
        const t = startHour.getTime() + i * HOUR;
        const p = timePrior(ratings, t, now, settings.halfLifeDays);
        forecast.push({ t, score: p.neff >= 0.3 ? p.mean : null, neff: p.neff });
    }

    return { score, label: labelFor(score), confidence, reasons, forecast, snap, scoped, ratingsUsed: ratings.length };
}

// ---------------------------------------------------------------- generation tracking

let pending = null;

function onGenStarted(type, _params, dryRun) {
    if (dryRun || SKIP_TYPES.has(type) || !getSettings().enabled) return;
    // A previous generation that never reported its end gets closed here
    if (pending) finalize();
    pending = { t: Date.now(), t0: performance.now(), key: connKey(), type, ttft: null, got: false, empty: false, error: false, stopped: false };
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

function finalize(forceOk) {
    const p = pending;
    if (!p) return;
    pending = null;
    const ok = forceOk ?? (p.got && !p.empty && !p.error);
    data.gens.push({
        t: p.t, key: p.key, type: p.type, ok: p.stopped ? true : ok, stopped: p.stopped,
        ms: Math.round(performance.now() - p.t0), ttft: p.ttft != null ? Math.round(p.ttft) : null,
    });
    saveData();
    refreshBadge();
}

// Error toasts during a generation count as failures (watch the toast container, do not patch toastr)
let toastObs = null;
let watchedContainer = null;
function watchToasts() {
    const attach = () => {
        const c = document.getElementById('toast-container');
        if (!c || c === watchedContainer) return;
        watchedContainer = c;
        toastObs?.disconnect();
        toastObs = new MutationObserver(muts => {
            if (!pending) return;
            for (const m of muts) {
                for (const n of m.addedNodes) {
                    if (n instanceof HTMLElement && n.classList.contains('toast-error')) pending.error = true;
                }
            }
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
async function callLLM(system, user, maxTokens, profileId, usePreset = false) {
    const ctx = SillyTavern.getContext();
    if (profileId && ctx.ConnectionManagerRequestService) {
        const res = await ctx.ConnectionManagerRequestService.sendRequest(
            profileId,
            [{ role: 'system', content: system }, { role: 'user', content: user }],
            maxTokens,
            { stream: false, extractData: true, includePreset: !!usePreset, includeInstruct: !!usePreset },
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
        }
    } finally {
        probeRunning = false;
    }
    const rec = { t: now, key, ok, ms: Math.round(performance.now() - t0), empty, via, error };
    data.probes.push(rec);
    saveData();
    refreshBadge();
    if (manual) {
        if (ok) toastr.success(`API 응답 ${fmtMs(rec.ms)}${via ? ` (${via} 경유)` : ''}`, 'Server Pulse');
        else toastr.error(error || '응답 없음', 'API 측정 실패');
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
    ratingToast?.find?.('.sp-skip').on('click', () => toastr.clear(ratingToast));
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
        el.addEventListener('click', openDashboard);
        document.body.appendChild(el);
    }
    const p = predict(data, s, connKey(), Date.now());
    el.className = `sp-badge ${p.label.cls}`;
    el.innerHTML = `<span class="sp-dot"></span>${p.score == null ? '?' : p.score.toFixed(1)}`;
    el.title = `서버 상태: ${p.label.text} (신뢰도 ${p.confidence})\n${p.reasons.join('\n')}\n클릭하면 자세히`;
}

function statsTable(now) {
    const byKey = new Map();
    for (const g of data.gens.filter(x => now - x.t <= DAY && !x.stopped)) {
        if (!byKey.has(g.key)) byKey.set(g.key, []);
        byKey.get(g.key).push(g);
    }
    if (!byKey.size) return '<p class="sp-muted">최근 24시간 생성 기록이 없어요.</p>';
    const rows = [...byKey].map(([k, gs]) => {
        const ok = gs.filter(g => g.ok);
        return `<tr><td>${esc(k)}</td><td>${gs.length}</td><td>${Math.round(ok.length / gs.length * 100)}%</td><td>${fmtMs(median(ok.map(g => g.ms)))}</td><td>${fmtMs(median(ok.map(g => g.ttft)))}</td></tr>`;
    }).join('');
    return `<table class="sp-table"><tr><th>연결</th><th>생성</th><th>성공률</th><th>응답(중앙값)</th><th>첫 토큰</th></tr>${rows}</table>`;
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
        const height = f.score == null ? 6 : Math.round((f.score / 5) * 100);
        return `<div class="sp-bar-col" title="${h}시: ${f.score == null ? '데이터 없음' : `${f.score.toFixed(1)}점 ${lab.text}`}">
            <div class="sp-bar ${lab.cls}" style="height:${height}%"></div><div class="sp-bar-h">${h % 3 === 0 ? h : ''}</div></div>`;
    }).join('');
    const known = p.forecast.filter(f => f.score != null && f.neff >= 1);
    let tip = '평가가 더 쌓이면 시간대별 예측이 나와요.';
    if (known.length >= 3) {
        const best = [...known].sort((a, b) => b.score - a.score).slice(0, 3).map(f => `${new Date(f.t).getHours()}시`);
        const worst = [...known].sort((a, b) => a.score - b.score)[0];
        tip = `좋을 것 같은 시간: <b>${best.join(', ')}</b>${worst.score < 2.8 ? ` · 피하면 좋은 시간: <b>${new Date(worst.t).getHours()}시</b>` : ''}`;
    }
    return `<div class="sp-forecast">${bars}</div><div class="sp-tip">${tip}</div>`;
}

function heatmapHtml(now, s) {
    const cells = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => ({ sw: 0, sws: 0 })));
    for (const r of data.ratings) {
        const d = new Date(r.t);
        const w = decay(now - r.t, s.halfLifeDays);
        const c = cells[d.getDay()][d.getHours()];
        c.sw += w;
        c.sws += w * r.score;
    }
    const days = ['일', '월', '화', '수', '목', '금', '토'];
    const rows = cells.map((row, di) => `<div class="sp-hm-row"><span class="sp-hm-day">${days[di]}</span>${row.map((c, h) => {
        const v = c.sw ? c.sws / c.sw : null;
        return `<span class="sp-hm-cell ${labelFor(v).cls}" title="${days[di]} ${h}시: ${v == null ? '-' : v.toFixed(1)}"></span>`;
    }).join('')}</div>`).join('');
    return `<div class="sp-heatmap">${rows}<div class="sp-hm-row"><span class="sp-hm-day"></span>${Array.from({ length: 24 }, (_, h) => `<span class="sp-hm-lab">${h % 6 === 0 ? h : ''}</span>`).join('')}</div></div>`;
}

async function openDashboard() {
    const s = getSettings();
    const now = Date.now();
    const key = connKey();
    const p = predict(data, s, key, now);
    const html = `
    <div class="sp-dash">
        <h3>서버 상태 예측</h3>
        <div class="sp-now ${p.label.cls}">
            <div class="sp-now-score">${p.score == null ? '?' : p.score.toFixed(1)}<small>/5</small></div>
            <div><b>${p.label.text}</b><br><small>신뢰도 ${p.confidence} · ${esc(key)}</small></div>
        </div>
        <ul class="sp-reasons">${p.reasons.map(r => `<li>${esc(r)}</li>`).join('') || '<li>아직 데이터가 없어요. 몇 번 생성하고 평가해 주세요.</li>'}</ul>
        <div class="sp-section">지금 평가하기 <div class="sp-stars">${starsHtml()}</div></div>
        <h4>앞으로 24시간 예측</h4>
        ${forecastHtml(p)}
        <h4>요일·시간별 내 평가</h4>
        ${heatmapHtml(now, s)}
        <h4>최근 24시간 생성</h4>
        ${statsTable(now)}
        <h4>API 직접 측정 (24시간) <span class="menu_button sp-probe-btn" title="작은 요청을 한 번 보내 응답 시간을 잽니다">지금 측정</span></h4>
        ${probeTable(now)}
        <h4>핑</h4>
        ${pingTable(now)}
        <p class="sp-muted">평가 ${data.ratings.length}개 · 생성 기록 ${data.gens.length}개 · API 측정 ${data.probes.length}개 · 핑 ${data.pings.length}개${p.scoped ? ' · 이 연결의 평가만 사용 중' : ''}</p>
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
                if (addRating(btn.dataset.score, btn.closest('.toast') ? 'prompt' : 'manual')) {
                    toastr.success(`${btn.dataset.score}점으로 기록했어요.`);
                    if (ratingToast) toastr.clear(ratingToast);
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
