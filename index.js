// Server Pulse
// Records generation outcomes (reply / no reply / how long it took) and periodic API probes,
// asks the user from time to time how the last reply was (no reply / broken / dull / good),
// and predicts how likely a good reply is now and over the next 24 hours.

const MODULE = 'server_pulse';
const STORE_KEY = 'server_pulse_data_v1';
const LOG = '[ServerPulse]';
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const CAP = { gens: 5000, pings: 8000, ratings: 3000, probes: 5000 };
const SKIP_TYPES = new Set(['quiet', 'impersonate']);

// Folder of this extension (e.g. "third-party/ST-Server-Pulse")
const SELF_FOLDER = (() => {
    try {
        const m = new URL(import.meta.url).pathname.match(/\/scripts\/extensions\/(.+)\/[^/]+$/);
        return m ? decodeURIComponent(m[1]) : '';
    } catch {
        return '';
    }
})();

const defaultSettings = Object.freeze({
    enabled: true,
    ratingIntervalMin: 45,
    ratingMinGens: 1,
    hangSeconds: 20,
    autoBroken: true,
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
        migrateRatings(data.ratings);
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
const pct = x => `${Math.round(x * 100)}%`;

function fmtMs(ms) {
    if (!Number.isFinite(ms)) return '-';
    return ms >= 1000 ? `${(ms / 1000).toFixed(1)}초` : `${Math.round(ms)}ms`;
}

/**
 * Connection key: source/model, plus what changes capacity on the same model:
 * Vertex AI region (global, us-central1 ...) and NanoGPT provider (each provider serves the model differently).
 * Exported for testing.
 */
export function makeConnKey({ mainApi, cc = {}, model = '', tcType = '', tcHost = '' }) {
    if (mainApi === 'openai') {
        const src = cc.chat_completion_source || 'cc';
        let suffix = '';
        if (src === 'vertexai') suffix = cc.vertexai_region || '';
        if (src === 'nanogpt') suffix = cc.nanogpt_provider || '';
        return `${src}/${model}${suffix ? `@${suffix}` : ''}`;
    }
    if (mainApi === 'textgenerationwebui') return `${tcType || 'tc'}/${tcHost}`;
    return String(mainApi || 'unknown');
}

function connKey() {
    const c = SillyTavern.getContext();
    try {
        let tcHost = '';
        if (c.mainApi === 'textgenerationwebui') {
            try { tcHost = new URL(c.getTextGenServer?.() || '').host; } catch { /* no server url */ }
        }
        return makeConnKey({
            mainApi: c.mainApi,
            cc: c.chatCompletionSettings || {},
            model: c.mainApi === 'openai' ? (c.getChatCompletionModel?.() || '') : '',
            tcType: c.textCompletionSettings?.type,
            tcHost,
        });
    } catch (err) {
        console.debug(LOG, 'connKey', err);
    }
    return String(c.mainApi || 'unknown');
}

function prettyKey(key) {
    const [base, suffix] = String(key).split('@');
    const [src, ...rest] = base.split('/');
    const name = { vertexai: 'Vertex AI', nanogpt: 'NanoGPT', makersuite: 'Google AI Studio', openrouter: 'OpenRouter' }[src] || src;
    const extra = suffix ? (src === 'nanogpt' ? ` · 프로바이더 ${suffix}` : ` · ${suffix}`) : (src === 'nanogpt' ? ' · 자동 라우팅' : '');
    return `${name} ${rest.join('/')}${extra}`;
}

// ---------------------------------------------------------------- outcome classification

/**
 * Sorts an error message into a failure class. Exported for testing.
 * quota    429 / RESOURCE_EXHAUSTED / rate limit: capacity ran out (Vertex dynamic shared quota, NanoGPT upstream limits)
 * overload 5xx / UNAVAILABLE / overloaded / every provider failed: the server could not serve the request
 * network  could not reach the server
 * empty    the server answered with nothing (Gemini "Candidate text empty", "no candidate" without a block reason)
 * blocked  an explicit safety block: the server worked, this content was refused
 * config   key, permission, balance, bad request: a settings problem, not server health
 * other    anything else
 */
export function classifyError(text) {
    const t = String(text || '');
    if (/insufficient (balance|funds|credits?)|not enough (balance|credits?)|payment required|\b402\b|top ?up|out of credits/i.test(t)) return 'config';
    if (/\b429\b|RESOURCE_EXHAUSTED|resource (has been )?exhausted|too many requests|rate.?limit|quota|concurrency limit/i.test(t)) return 'quota';
    if (/PROHIBITED_CONTENT|blockReason|blocked due to|\bSAFETY\b|RECITATION|BLOCKLIST|SPII|moderation|content (policy|filter)|flagged/i.test(t)) return 'blocked';
    if (/candidate text empty|returned no candidate|no message generated|empty (response|reply|completion)/i.test(t)) return 'empty';
    if (/\b(500|502|503|504|520|522|524|529)\b|UNAVAILABLE|overloaded|INTERNAL|internal (server )?error|DEADLINE_EXCEEDED|timed? ?out|bad gateway|service unavailable|try again later|capacity|all (available )?providers|no (available )?providers?|provider (returned|error|failed|unavailable)|upstream|currently unavailable|temporarily unavailable/i.test(t)) return 'overload';
    if (/failed to fetch|networkerror|network error|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|socket hang up|fetch failed|could not get a reply|terminated/i.test(t)) return 'network';
    if (/\b(400|401|403|404)\b|PERMISSION_DENIED|permission denied|UNAUTHENTICATED|INVALID_ARGUMENT|NOT_FOUND|api key|service account|unauthori[sz]ed|forbidden|billing|not supported|invalid|context (length|size|window)|too long/i.test(t)) return 'config';
    return 'other';
}

export const CLASS_LABEL = {
    ok: '성공', quota: '429 할당량 부족', overload: '서버 과부하(5xx)', network: '연결 끊김',
    blocked: '안전 필터 차단', config: '설정 오류', empty: '빈 답장', hang: '무한 대기', other: '기타 오류',
};

/**
 * How much an outcome means "no reply came". null = says nothing about the server.
 * Empty replies and endless waits count: from the user's side no reply arrived (Vertex and NanoGPT do this a lot under load).
 * An explicit safety block depends on the content far more than on the time, so it counts only a little.
 */
const FAIL_WEIGHT = { ok: 0, blocked: 0.2, quota: 1, overload: 1, network: 1, hang: 1, empty: 0.7, other: 0.6, config: null };

function outcomeOf(rec) {
    if (rec.cls) return rec.cls;
    return rec.ok ? 'ok' : 'other'; // records from older versions
}

/** Old records have no @region/@provider suffix; let them count for every suffix of the same model. */
export function keyMatch(recKey, key) {
    if (recKey === key) return true;
    const base = key.split('@')[0];
    return !String(recKey).includes('@') && recKey === base;
}

// ---------------------------------------------------------------- user ratings

/** What the user tells us about a reply. */
export const RATE = {
    noreply: { emoji: '🚫', label: '안 옴', desc: '답장이 안 오거나 끝없이 기다림' },
    broken: { emoji: '💥', label: '캐붕·고장', desc: '답장은 왔는데 망가짐 (캐붕, 깨진 글, 반복, 엉뚱한 말)' },
    dull: { emoji: '😐', label: '노잼', desc: '멀쩡하게 왔는데 재미없음' },
    good: { emoji: '😊', label: '좋음', desc: '만족' },
};
const QUALITY = ['broken', 'dull', 'good'];
// Starting guess before the user has rated anything
const QUALITY_PRIOR = { broken: 0.12, dull: 0.33, good: 0.55 };

/** Accepts the category id, its Korean label or an old 1-5 number. Exported for testing. */
export function parseRating(input) {
    const s = String(input ?? '').trim().toLowerCase().replace(/\s+/g, '');
    if (!s) return null;
    if (RATE[s]) return s;
    if (/^(안옴|무응답|노답|x|1)$/.test(s)) return 'noreply';
    if (/^(캐붕|고장|캐붕고장|캐붕·고장|망가짐|깨짐|2)$/.test(s)) return 'broken';
    if (/^(노잼|별로|재미없음|3)$/.test(s)) return 'dull';
    if (/^(좋음|굿|ok|4|5)$/.test(s)) return 'good';
    return null;
}

/** Ratings from v1.3 were 1-5 stars: 1 = did not work, 2 = bad, 3 = meh, 4-5 = good. */
export function migrateRatings(list) {
    for (const r of list || []) {
        if (r.cat) continue;
        const n = Number(r.score);
        r.cat = n <= 1 ? 'noreply' : n === 2 ? 'broken' : n === 3 ? 'dull' : 'good';
        r.migrated = true;
    }
    return list;
}

// ---------------------------------------------------------------- automatic "broken reply" hint

/**
 * Cheap signs that a reply came back broken. Only a weak hint; the user's rating always wins.
 * Exported for testing.
 */
export function detectBroken(text, typicalLen) {
    const t = String(text || '');
    const plain = t.replace(/\s+/g, ' ').trim();
    if (!plain) return null;
    if (/�{2,}/.test(t)) return '깨진 글자';
    // the same line or sentence repeated over and over
    const lines = t.split(/\n+|(?<=[.!?。！？])\s+/).map(l => l.trim()).filter(l => l.length >= 8);
    if (lines.length >= 6) {
        const counts = new Map();
        for (const l of lines) counts.set(l, (counts.get(l) || 0) + 1);
        const top = Math.max(...counts.values());
        if (top >= 3 && top / lines.length >= 0.3) return '같은 문장 반복';
    }
    // the same short chunk repeated back to back
    if (/(.{2,12}?)\1{7,}/s.test(plain)) return '같은 말 반복';
    // a Korean chat suddenly in another script
    const hangul = (plain.match(/[가-힣]/g) || []).length;
    const foreign = (plain.match(/[一-鿿぀-ヿЀ-ӿ฀-๿؀-ۿ]/g) || []).length;
    if (hangul >= 20 && foreign >= 12 && foreign / (hangul + foreign) >= 0.12) return '다른 언어 섞임';
    if (typicalLen && typicalLen >= 300 && plain.length < typicalLen * 0.12 && plain.length < 120) return '너무 짧게 끊김';
    return null;
}

// ---------------------------------------------------------------- prediction

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

/** Burst weight 1/sqrt(events within +-5 minutes), so retry spam after one 429 does not dominate. */
function burstWeights(list) {
    let lo = 0;
    let hi = 0;
    for (let i = 0; i < list.length; i++) {
        while (list[lo].t < list[i].t - 5 * MIN) lo++;
        while (hi + 1 < list.length && list[hi + 1].t <= list[i].t + 5 * MIN) hi++;
        list[i].bw = 1 / Math.sqrt(hi - lo + 1);
    }
    return list;
}

/**
 * "Did a reply arrive?" events for one connection: generations, probes and the user's "no reply" ratings.
 * Exported for testing.
 */
export function serverEvents(d, key, now) {
    const raw = [];
    const failedGens = new Set();
    for (const g of d.gens) {
        if (g.stopped || g.t > now || !keyMatch(g.key, key)) continue;
        const cls = outcomeOf(g);
        const fail = FAIL_WEIGHT[cls];
        if (fail == null) continue;
        if (fail > 0) failedGens.add(g.t);
        raw.push({ t: g.t, fail, cls, src: 'gen' });
    }
    for (const p of d.probes || []) {
        if (p.t > now || !keyMatch(p.key, key)) continue;
        const cls = p.cls || (p.ok ? 'ok' : 'other');
        const fail = FAIL_WEIGHT[cls];
        if (fail == null) continue;
        raw.push({ t: p.t, fail, cls, src: 'probe' });
    }
    // "No reply" from the user: counts unless the generation it refers to was already recorded as failed
    for (const r of d.ratings || []) {
        if (r.cat !== 'noreply' || r.t > now || !keyMatch(r.key, key)) continue;
        if (r.genT && failedGens.has(r.genT)) continue;
        raw.push({ t: r.t, fail: 1, cls: 'noreply', src: 'rating' });
    }
    raw.sort((x, y) => x.t - y.t);
    return burstWeights(raw);
}

/**
 * Chance that a request at time `t` gets no reply, learned from past events at similar hours.
 * Beta-smoothed toward this connection's overall failure rate. Exported for testing.
 */
export function hourlyFailure(events, t, now, halfLifeDays) {
    if (!events.length) return { p: null, neff: 0, quota: 0, overload: 0, hang: 0 };
    let all = 0;
    let allW = 0;
    for (const e of events) {
        const w = decay(now - e.t, halfLifeDays) * e.bw;
        all += w * e.fail;
        allW += w;
    }
    // Overall rate for this connection, pulled toward a neutral 15% while there are only a few records
    const base = (all + 2 * 0.15) / (allW + 2);
    let sw = 0, sf = 0, sq = 0, so = 0, sh = 0;
    for (const e of events) {
        const w = decay(now - e.t, halfLifeDays) * hourKernel(e.t, t) * e.bw;
        sw += w;
        sf += w * e.fail;
        if (e.cls === 'quota') sq += w;
        if (e.cls === 'overload' || e.cls === 'network') so += w;
        if (e.cls === 'hang' || e.cls === 'empty' || e.cls === 'noreply') sh += w;
    }
    const k = 2; // prior strength
    return {
        p: (sf + k * base) / (sw + k),
        neff: sw,
        quota: sw ? sq / sw : 0,
        overload: sw ? so / sw : 0,
        hang: sw ? sh / sw : 0,
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

/**
 * How slow the server is now compared with usual. Uses time to first token when streaming
 * (total time depends on how long the reply is), total time otherwise. Exported for testing.
 */
export function latencyRatio(d, key, now) {
    const ok = d.gens.filter(g => keyMatch(g.key, key) && !g.stopped && outcomeOf(g) === 'ok' && g.t <= now);
    const recentList = ok.filter(g => now - g.t <= 30 * MIN).slice(-5);
    if (!recentList.length) return { ratio: null, ms: null, kind: null };
    const useTtft = recentList.filter(g => Number.isFinite(g.ttft)).length >= recentList.length / 2;
    const val = g => useTtft ? g.ttft : g.ms;
    const med = median(recentList.map(val));
    const baseList = ok.filter(g => now - g.t <= 14 * DAY && Number.isFinite(val(g)));
    const base = median(baseList.map(val));
    const kind = useTtft ? 'ttft' : 'ms';
    return baseList.length >= 6 && med && base ? { ratio: med / base, ms: med, kind } : { ratio: null, ms: med, kind };
}

/**
 * Reply-quality events (only for replies that arrived): the user's broken/dull/good ratings,
 * plus a weak "broken" hint from replies that looked broken and were not rated.
 * `anyKeyRatings`: use ratings from every connection (not enough of this connection's own yet).
 * Exported for testing.
 */
export function qualityEvents(d, key, now, { autoBroken = true, anyKeyRatings = false } = {}) {
    const out = [];
    const rated = new Set();
    for (const r of d.ratings || []) {
        if (!QUALITY.includes(r.cat) || r.t > now) continue;
        if (!anyKeyRatings && !keyMatch(r.key, key)) continue;
        out.push({ t: r.t, cat: r.cat, w: r.migrated ? 0.6 : 1, src: 'rating' });
        if (r.genT) rated.add(r.genT);
    }
    if (autoBroken) {
        for (const g of d.gens) {
            if (!g.sus || g.stopped || g.t > now || rated.has(g.t) || !keyMatch(g.key, key)) continue;
            out.push({ t: g.t, cat: 'broken', w: 0.35, src: 'auto', why: g.sus });
        }
    }
    return out.sort((a, b) => a.t - b.t);
}

/**
 * Chance of each reply quality at time `t`: kernel over similar hours, smoothed toward this
 * connection's overall mix, which is smoothed toward a neutral prior. At t = now, ratings from
 * the last hour weigh much more (the user just told us). Exported for testing.
 */
export function qualityAt(events, t, now, halfLifeDays) {
    const overall = { broken: 0, dull: 0, good: 0 };
    let ow = 0;
    for (const e of events) {
        const w = decay(now - e.t, halfLifeDays) * e.w;
        overall[e.cat] += w;
        ow += w;
    }
    const k0 = 5;
    const base = {};
    for (const c of QUALITY) base[c] = (overall[c] + k0 * QUALITY_PRIOR[c]) / (ow + k0);

    const local = { broken: 0, dull: 0, good: 0 };
    let lw = 0;
    const atNow = Math.abs(t - now) < MIN;
    for (const e of events) {
        let w = decay(now - e.t, halfLifeDays) * hourKernel(e.t, t) * e.w;
        if (atNow) w *= 1 + Math.pow(0.5, Math.max(0, now - e.t) / (30 * MIN));
        local[e.cat] += w;
        lw += w;
    }
    const k = 3;
    const dist = {};
    for (const c of QUALITY) dist[c] = (local[c] + k * base[c]) / (lw + k);
    return { dist, neff: lw, rated: ow > 0 };
}

/** 1-5 score: chance a reply arrives, times how good replies tend to be, minus slowness. */
export function scoreFrom(pReply, dist, latRatio) {
    const q = dist ? dist.good + 0.45 * dist.dull : 0.8;
    let sc = 1 + 4 * pReply * q;
    if (latRatio) sc -= 0.6 * clamp(Math.log2(latRatio), 0, 2);
    return clamp(sc, 1, 5);
}

export function labelFor(score) {
    if (score == null) return { text: '데이터 부족', cls: 'sp-none' };
    if (score >= 4.0) return { text: '아주 좋음', cls: 'sp-great' };
    if (score >= 3.3) return { text: '좋음', cls: 'sp-good' };
    if (score >= 2.6) return { text: '보통', cls: 'sp-mid' };
    if (score >= 1.9) return { text: '나쁨', cls: 'sp-bad' };
    return { text: '매우 나쁨', cls: 'sp-awful' };
}

/** The main worry about reply quality, if any. */
export function qualityMood(dist, rated) {
    if (!dist) return null;
    if (dist.broken >= 0.3) return { key: 'broken', ...RATE.broken };
    if (dist.dull >= 0.45) return { key: 'dull', ...RATE.dull };
    if (rated && dist.good >= 0.5) return { key: 'good', ...RATE.good };
    return null;
}

/**
 * Full prediction for connection `key` at time `now`. Exported for testing.
 */
export function predict(d, settings, key, now) {
    const hl = settings.halfLifeDays || 21;
    const ev = serverEvents(d, key, now);
    const live = liveState(ev, now);
    const hour = hourlyFailure(ev, now, now, hl);
    const lat = latencyRatio(d, key, now);
    // Quality: this connection's own ratings once there are a few, everyone's before that
    const ownRatings = d.ratings.filter(r => QUALITY.includes(r.cat) && keyMatch(r.key, key)).length;
    const anyKeyRatings = !settings.perConnection || ownRatings < 5;
    const qev = qualityEvents(d, key, now, { autoBroken: settings.autoBroken !== false, anyKeyRatings });
    const quality = qualityAt(qev, now, now, hl);
    const reasons = [];

    // Chance of no reply now: recent events first, this hour's history as the prior
    let pFail = null;
    if (live.sw) pFail = (live.sf + 1.5 * (hour.p ?? 0.1)) / (live.sw + 1.5);
    else if (hour.p != null) pFail = hour.p;
    const pReply = pFail == null ? null : 1 - pFail;
    const score = pReply == null ? null : scoreFrom(pReply, quality.dist, lat.ratio);
    const pGood = pReply == null ? null : pReply * quality.dist.good;

    if (live.n) {
        const counts = {};
        for (const e of live.recent) counts[e.cls] = (counts[e.cls] || 0) + 1;
        const parts = Object.entries(counts).map(([c, n]) => `${c === 'noreply' ? '내 평가 "안 옴"' : (CLASS_LABEL[c] || c)} ${n}`);
        reasons.push(`최근 20분: ${parts.join(', ')}`);
    }
    if (lat.ms && lat.ratio) reasons.push(`${lat.kind === 'ttft' ? '첫 글자까지' : '응답'} ${fmtMs(lat.ms)} (평소의 ${lat.ratio.toFixed(1)}배)`);
    if (hour.neff >= 0.5) {
        const why = hour.quota >= 0.15 ? ' · 이 시간엔 429가 잦아요' : hour.overload >= 0.15 ? ' · 이 시간엔 과부하가 잦아요' : hour.hang >= 0.15 ? ' · 이 시간엔 빈 답장·무한 대기가 잦아요' : '';
        reasons.push(`이 시간대 평소 답장 올 확률 ${pct(1 - hour.p)} (기록 ${Math.round(hour.neff * 10) / 10}건 분량)${why}`);
    }
    if (quality.rated) {
        const q = quality.dist;
        reasons.push(`답장 질 예상: 좋음 ${pct(q.good)} · 노잼 ${pct(q.dull)} · 캐붕 ${pct(q.broken)}${anyKeyRatings && settings.perConnection ? ' (이 연결 평가가 적어 전체 평가 참고)' : ''}`);
    } else {
        reasons.push('답장 질은 아직 평가가 없어 기본값으로 계산 중이에요');
    }
    const lastAuto = qev.filter(e => e.src === 'auto' && now - e.t < HOUR).at(-1);
    if (lastAuto) reasons.push(`${Math.round((now - lastAuto.t) / MIN)}분 전 답장이 망가져 보였어요 (${lastAuto.why})`);

    let recovery = null;
    if (live.lastFail && now - live.lastFail.t < 15 * MIN && (live.lastFail.cls === 'quota' || live.lastFail.cls === 'overload')) {
        const m = recoveryMinutes(ev, live.lastFail.cls);
        recovery = { cls: live.lastFail.cls, minutes: m };
        reasons.push(m != null ? `${CLASS_LABEL[live.lastFail.cls]}: 보통 ${Math.max(1, Math.round(m))}분 뒤 회복돼요` : `${CLASS_LABEL[live.lastFail.cls]} 발생 중`);
    }

    const evidence = hour.neff + Math.min(live.n, 4) + Math.min(quality.neff, 3);
    const confidence = score == null ? '없음' : evidence >= 8 ? '높음' : evidence >= 3 ? '보통' : '낮음';

    const forecast = [];
    const startHour = new Date(now);
    startHour.setMinutes(0, 0, 0);
    for (let i = 1; i <= 24; i++) {
        const t = startHour.getTime() + i * HOUR;
        const h = hourlyFailure(ev, t, now, hl);
        const q = qualityAt(qev, t, now, hl);
        const known = h.p != null && h.neff >= 0.3;
        const reply = known ? 1 - h.p : null;
        forecast.push({
            t, reply, dist: q.dist, qneff: q.neff, neff: h.neff, quota: h.quota, overload: h.overload, hang: h.hang,
            score: known ? scoreFrom(reply, q.dist, null) : null,
            good: known ? reply * q.dist.good : null,
        });
    }

    return {
        score, pReply, pGood, quality, mood: qualityMood(quality.dist, quality.rated),
        label: labelFor(score), confidence, reasons, forecast, recovery, lat,
        events: ev.length, qualityEvents: qev.length,
    };
}

// ---------------------------------------------------------------- generation tracking

let pending = null;
let finalizeTimer = null;

function onGenStarted(type, _params, dryRun) {
    if (dryRun || SKIP_TYPES.has(type) || !getSettings().enabled) return;
    // A previous generation that never reported its end gets closed here
    if (pending) finalize();
    pending = { t: Date.now(), t0: performance.now(), key: connKey(), type, ttft: null, got: false, empty: false, text: '', error: false, errText: '', apiError: false, stopped: false, stoppedAt: null };
}

function onToken() {
    if (pending && pending.ttft == null) pending.ttft = performance.now() - pending.t0;
}

function onMessageReceived(id) {
    if (!pending) return;
    const msg = SillyTavern.getContext().chat?.[id];
    const text = String(msg?.mes ?? '');
    pending.got = true;
    pending.text = text;
    pending.empty = !text.trim();
}

function onStopped() {
    if (pending && !pending.stopped) {
        pending.stopped = true;
        pending.stoppedAt = performance.now();
    }
}

function onGenEnded() {
    if (!pending) return;
    // Let MESSAGE_RECEIVED / error toasts land first
    clearTimeout(finalizeTimer);
    finalizeTimer = setTimeout(() => finalize(), 400);
}

/**
 * Decides what happened to a generation. Exported for testing.
 * A stop pressed after waiting a long time with nothing arriving is an endless wait (the server never answered);
 * a stop after text started coming, or a quick stop, says nothing about the server.
 */
export function outcomeFor(p, hangMs) {
    if (p.stopped) {
        const waited = (p.stoppedAt ?? p.end) - p.t0;
        const nothing = p.ttft == null && !(p.got && !p.empty);
        return nothing && waited >= hangMs ? 'hang' : 'stopped';
    }
    if (p.error) return p.apiError ? classifyError(p.errText) : 'config';
    if (!p.got || p.empty) return 'empty';
    return 'ok';
}

function finalize() {
    clearTimeout(finalizeTimer);
    const p = pending;
    if (!p) return;
    pending = null;
    const s = getSettings();
    p.end = performance.now();
    const outcome = outcomeFor(p, (s.hangSeconds || 20) * 1000);
    const stopped = outcome === 'stopped';
    const cls = stopped ? 'ok' : outcome;
    const rec = {
        t: p.t, key: p.key, type: p.type, ok: cls === 'ok', cls, stopped,
        err: p.errText ? p.errText.slice(0, 160) : undefined,
        ms: Math.round(p.end - p.t0), ttft: p.ttft != null ? Math.round(p.ttft) : null,
    };
    if (cls === 'ok' && !stopped) {
        rec.len = p.text.replace(/\s+/g, ' ').trim().length;
        const typical = median(data.gens.filter(g => keyMatch(g.key, p.key) && g.len).slice(-30).map(g => g.len));
        const sus = detectBroken(p.text, typical);
        if (sus) rec.sus = sus;
    }
    data.gens.push(rec);
    saveData();
    refreshBadge();
    if (cls === 'ok' && !stopped) setTimeout(maybePrompt, 1500);
}

// Error toasts during a generation count as failures (watch the toast container, do not patch toastr)
let toastObs = null;
let watchedContainer = null;
const seenToasts = new WeakSet();

function noteToast(n) {
    if (!pending || !(n instanceof HTMLElement) || seenToasts.has(n)) return;
    seenToasts.add(n);
    if (!n.classList.contains('toast-error')) return;
    const title = (n.querySelector('.toast-title')?.innerText || '').trim();
    const msg = (n.querySelector('.toast-message')?.innerText || n.innerText || '').replace(/\s+/g, ' ').trim();
    pending.error = true;
    // Toasts from the API path have titles like "Chat Completion API", "API returned an error", "Text generation error".
    // Others (another extension, "Mandatory prompts exceed the context size") are local problems.
    const fromApi = !title || /API|generation|Chat Completion|Vertex|Google|NanoGPT/i.test(title) || classifyError(msg) !== 'other';
    if (fromApi) pending.apiError = true;
    if (!pending.errText) pending.errText = `${title ? `${title}: ` : ''}${msg}`.slice(0, 400);
    // Close the record soon even if the end event is late
    clearTimeout(finalizeTimer);
    finalizeTimer = setTimeout(() => finalize(), 2500);
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
 * Extra request fields a connection profile does not carry by itself (checked against SillyTavern 1.19.1).
 * Vertex AI: without a preset the auth mode is not sent, so the server falls back to Express (API key)
 * mode and Google rejects service-account setups with "API keys are not supported by this API".
 * NanoGPT: the chosen provider is a separate setting; send it only when the profile uses the same model.
 * Only fields that match the profile's own source are added.
 */
function profileOverrides(profileId) {
    const ctx = SillyTavern.getContext();
    const cc = ctx.chatCompletionSettings || {};
    const out = {};
    const profile = ctx.extensionSettings.connectionManager?.profiles?.find(p => p.id === profileId);
    if (!profile) return out;
    const source = ctx.CONNECT_API_MAP?.[profile.api]?.source || profile.api;
    if (source === 'vertexai') {
        if (cc.vertexai_auth_mode) out.vertexai_auth_mode = cc.vertexai_auth_mode;
        if (cc.vertexai_express_project_id) out.vertexai_express_project_id = cc.vertexai_express_project_id;
        // 1.19 sends the profile's "api-url" as the region; fill it from settings when the profile has none
        if (!profile['api-url'] && cc.vertexai_region) out.vertexai_region = cc.vertexai_region;
    }
    if (source === 'nanogpt' && cc.nanogpt_provider && (!profile.model || profile.model === cc.nanogpt_model)) {
        out.nanogpt_provider = cc.nanogpt_provider;
    }
    return out;
}

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
 * Probe result class. A probe asks for a few tokens only, so an empty answer (thinking models
 * spend them all; Gemini then says "Candidate text empty") still proves the server answered.
 * Exported for testing.
 */
export function probeClass(errMsg) {
    if (!errMsg) return 'ok';
    const cls = classifyError(errMsg);
    if (cls === 'empty') return 'ok';
    return cls;
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
        empty = !String(text || '').trim();
    } catch (err) {
        const msg = err?.cause?.message || err?.message || String(err);
        cls = probeClass(msg);
        if (cls === 'ok') empty = true;
        else error = msg.slice(0, 200);
    } finally {
        probeRunning = false;
    }
    // A filtered reply still proves the server is up
    const ok = cls === 'ok' || cls === 'blocked';
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

/** The latest real generation of this connection that the rating will be about. */
function lastGenFor(key) {
    return data.gens.filter(g => g.key === key && !g.stopped).at(-1);
}

function addRating(input, source = 'manual') {
    const cat = parseRating(input);
    if (!cat) return null;
    const key = connKey();
    const now = Date.now();
    const last = lastGenFor(key);
    // Tie the rating to the reply it is about, if that reply was recent
    const genT = last && now - last.t < 2 * HOUR ? last.t : undefined;
    data.ratings.push({ t: now, key, cat, genT, source });
    data.lastPromptAt = now;
    saveData();
    refreshBadge();
    return cat;
}

function rateButtonsHtml() {
    return Object.entries(RATE).map(([id, r]) => `<button class="sp-rate-btn sp-r-${id} menu_button" data-cat="${id}" title="${esc(r.desc)}"><span class="sp-r-emoji">${r.emoji}</span>${esc(r.label)}</button>`).join('');
}

function showRatingPrompt() {
    if (ratingToast) return;
    data.lastPromptAt = Date.now();
    saveData();
    const html = `<div class="sp-prompt">방금 답장 어땠어요? <small>(${esc(prettyKey(connKey()))})</small>
        <div class="sp-rates">${rateButtonsHtml()}</div>
        <div class="sp-legend">안 옴 = 안 오거나 끝없이 기다림 · 캐붕·고장 = 왔는데 망가짐 · 노잼 = 멀쩡한데 재미없음</div>
        <button class="sp-skip menu_button">건너뛰기</button></div>`;
    ratingToast = toastr.info(html, 'Server Pulse', {
        escapeHtml: false, timeOut: 90_000, extendedTimeOut: 30_000, tapToDismiss: false, closeButton: true,
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

/** Asks right after a reply arrived (so the question is about that reply), at most once per interval. */
function maybePrompt() {
    const s = getSettings();
    if (!s.enabled || !s.ratingIntervalMin || ratingToast) return;
    if (document.visibilityState !== 'visible') return;
    const now = Date.now();
    if (now - data.lastPromptAt < s.ratingIntervalMin * MIN) return;
    const gensSince = data.gens.filter(g => g.t > data.lastPromptAt && !g.stopped).length;
    if (gensSince < Math.max(1, s.ratingMinGens)) return;
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
    el.innerHTML = `<span class="sp-dot"></span>${p.pReply == null ? '?' : pct(p.pReply)}${p.mood ? `<span class="sp-mood">${p.mood.emoji}</span>` : ''}`;
    el.title = `지금 보내면 답장이 올 가능성 ${p.pReply == null ? '-' : pct(p.pReply)}`
        + `${p.pGood == null ? '' : ` · 좋은 답장일 가능성 ${pct(p.pGood)}`} · ${p.label.text} (신뢰도 ${p.confidence})\n${p.reasons.join('\n')}\n클릭하면 자세히`;
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
        const ttft = median(ok.map(g => g.ttft));
        return `<tr><td>${esc(prettyKey(k))}</td><td>${gs.length}</td><td>${rate}%</td><td>${c('quota')}</td><td>${c('overload') + c('network')}</td><td>${c('empty') + c('hang')}</td><td>${ttft != null ? fmtMs(ttft) : fmtMs(median(ok.map(g => g.ms)))}</td></tr>`;
    }).join('');
    return `<table class="sp-table"><tr><th>연결</th><th>생성</th><th>답장 옴</th><th>429</th><th>5xx·끊김</th><th>빈 답장·대기</th><th>첫 글자</th></tr>${rows}</table>
        <p class="sp-muted">빈 답장과 무한 대기(오래 기다리다 멈춤)도 "답장 안 옴"으로 쳐요. 안전 필터 차단은 조금만 반영해요.</p>`;
}

function qualityTable(now) {
    const byKey = new Map();
    for (const r of data.ratings.filter(x => now - x.t <= 14 * DAY)) {
        if (!byKey.has(r.key)) byKey.set(r.key, { noreply: 0, broken: 0, dull: 0, good: 0 });
        byKey.get(r.key)[r.cat] = (byKey.get(r.key)[r.cat] || 0) + 1;
    }
    if (!byKey.size) return '<p class="sp-muted">아직 평가가 없어요. 답장이 온 뒤 가끔 물어볼게요. 위 버튼으로 바로 남겨도 돼요.</p>';
    const rows = [...byKey].map(([k, c]) => {
        const total = c.broken + c.dull + c.good;
        const bar = total ? `<div class="sp-qbar">${QUALITY.map(q => `<span class="sp-q-${q}" style="flex:${c[q]}" title="${RATE[q].label} ${c[q]}"></span>`).join('')}</div>` : '';
        return `<tr><td>${esc(prettyKey(k))}${bar}</td><td>${c.noreply}</td><td>${c.broken}</td><td>${c.dull}</td><td>${c.good}</td></tr>`;
    }).join('');
    return `<table class="sp-table"><tr><th>연결 (14일)</th><th>🚫 안 옴</th><th>💥 캐붕</th><th>😐 노잼</th><th>😊 좋음</th></tr>${rows}</table>`;
}

function recentFailures(now) {
    const fails = data.gens.filter(g => now - g.t <= DAY && !g.stopped && (outcomeOf(g) !== 'ok' || g.sus)).slice(-6).reverse();
    if (!fails.length) return '';
    return `<ul class="sp-fails">${fails.map(g => {
        const c = outcomeOf(g);
        const tag = c === 'ok' ? '<span class="sp-fail-tag sp-f-broken">망가져 보임</span>' : `<span class="sp-fail-tag sp-f-${c}">${esc(CLASS_LABEL[c] || c)}</span>`;
        const note = c === 'ok' ? g.sus : g.err;
        return `<li>${tag} ${new Date(g.t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}${note ? ` <small>${esc(note)}</small>` : ''}</li>`;
    }).join('')}</ul>`;
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
        const lastTxt = last.ok ? '<span class="sp-up">성공</span>' : `<span class="sp-down" title="${esc(last.error)}">${esc(CLASS_LABEL[last.cls] || '실패')}</span>`;
        return `<tr><td>${esc(prettyKey(k))}${last.via ? `<br><small>${esc(last.via)} 경유</small>` : ''}</td><td>${ps.length}</td><td>${Math.round(ok.length / ps.length * 100)}%</td><td>${fmtMs(median(ok.map(p => p.ms)))}</td><td>${lastTxt}</td></tr>`;
    }).join('');
    return `<table class="sp-table"><tr><th>연결</th><th>측정</th><th>성공률</th><th>응답(중앙값)</th><th>마지막</th></tr>${rows}</table>`;
}

function forecastHtml(p) {
    const bars = p.forecast.map(f => {
        const h = new Date(f.t).getHours();
        const lab = labelFor(f.score);
        const height = f.reply == null ? 6 : Math.max(4, Math.round(f.reply * 100));
        const why = f.quota >= 0.15 ? ' · 429 잦음' : f.overload >= 0.15 ? ' · 과부하 잦음' : f.hang >= 0.15 ? ' · 빈 답장·대기 잦음' : '';
        const q = ` · 좋음 ${pct(f.dist.good)} / 노잼 ${pct(f.dist.dull)} / 캐붕 ${pct(f.dist.broken)}`;
        const mood = f.qneff >= 2 ? qualityMood(f.dist, true) : null;
        return `<div class="sp-bar-col" title="${h}시: ${f.reply == null ? '기록 없음' : `답장 올 확률 ${pct(f.reply)}${why}${f.qneff >= 2 ? q : ''}`}">
            ${mood && mood.key !== 'good' ? `<div class="sp-bar-mood">${mood.emoji}</div>` : ''}
            <div class="sp-bar ${lab.cls}" style="height:${height}%"></div><div class="sp-bar-h">${h % 3 === 0 ? h : ''}</div></div>`;
    }).join('');
    const known = p.forecast.filter(f => f.reply != null && f.neff >= 1);
    let tip = '생성하거나 API 측정이 쌓이면 시간대별 예측이 나와요. 답장 질(캐붕·노잼)은 평가가 쌓이면 반영돼요.';
    if (known.length >= 3) {
        const best = [...known].sort((a, b) => b.score - a.score).slice(0, 3).map(f => `${new Date(f.t).getHours()}시`);
        const worst = [...known].sort((a, b) => a.score - b.score)[0];
        let worstWhy = '';
        if (worst.reply < 0.8) worstWhy = worst.quota >= 0.15 ? `429 ${pct(1 - worst.reply)}` : worst.overload >= 0.15 ? `과부하 ${pct(1 - worst.reply)}` : `답장 안 옴 ${pct(1 - worst.reply)}`;
        else if (worst.qneff >= 2 && worst.dist.broken >= 0.25) worstWhy = `캐붕 ${pct(worst.dist.broken)}`;
        else if (worst.qneff >= 2 && worst.dist.dull >= 0.45) worstWhy = `노잼 ${pct(worst.dist.dull)}`;
        tip = `잘 될 것 같은 시간: <b>${best.join(', ')}</b>${worstWhy ? ` · 피하면 좋은 시간: <b>${new Date(worst.t).getHours()}시</b> (${worstWhy})` : ''}`;
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
        return `<span class="sp-hm-cell ${labelFor(succ == null ? null : scoreFrom(succ, null, null)).cls}" title="${days[di]} ${h}시: ${succ == null ? '-' : `답장 옴 ${pct(succ)}`}"></span>`;
    }).join('')}</div>`).join('');
    return `<div class="sp-heatmap">${rows}<div class="sp-hm-row"><span class="sp-hm-day"></span>${Array.from({ length: 24 }, (_, h) => `<span class="sp-hm-lab">${h % 6 === 0 ? h : ''}</span>`).join('')}</div></div>`;
}

function qualityNowHtml(p) {
    const d = p.quality.dist;
    const seg = QUALITY.map(q => `<span class="sp-q-${q}" style="flex:${Math.max(0.01, d[q])}">${d[q] >= 0.12 ? `${RATE[q].emoji} ${pct(d[q])}` : ''}</span>`).join('');
    return `<div class="sp-qnow"><div class="sp-qbar sp-qbar-big">${seg}</div>
        <small class="sp-muted">${p.quality.rated ? `답장이 왔을 때 질 예상 (평가·자동 감지 ${p.qualityEvents}건 바탕)` : '아직 평가가 없어 기본값이에요. 평가가 쌓이면 이 시간대 답장 질을 예측해요.'}</small></div>`;
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

function addWandMenuItem(tries = 0) {
    if (document.getElementById('sp_wand_item')) return;
    const menu = document.getElementById('extensionsMenu');
    // The wand menu is built from a template while ST starts up; wait for it if needed
    if (!menu) {
        if (tries < 20) setTimeout(() => addWandMenuItem(tries + 1), 500);
        return;
    }
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
            <div class="sp-now-score">${p.pReply == null ? '?' : Math.round(p.pReply * 100)}<small>%</small></div>
            <div><b>지금 보내면 답장이 올 가능성</b> · ${p.label.text}${p.pGood == null ? '' : ` · 좋은 답장일 가능성 ${pct(p.pGood)}`}${p.mood ? ` ${p.mood.emoji}` : ''}<br><small>신뢰도 ${p.confidence} · ${esc(prettyKey(key))}</small></div>
        </div>
        ${qualityNowHtml(p)}
        <ul class="sp-reasons">${p.reasons.map(r => `<li>${esc(r)}</li>`).join('') || '<li>아직 데이터가 없어요. 몇 번 생성하면 바로 예측이 시작돼요.</li>'}</ul>
        <div class="sp-section">방금 답장 평가하기 <div class="sp-rates">${rateButtonsHtml()}</div></div>
        <h4>앞으로 24시간</h4>
        ${forecastHtml(p)}
        <h4>요일·시간별 답장 올 확률</h4>
        ${heatmapHtml(now, s, key)}
        <h4>내 평가 (연결별)</h4>
        ${qualityTable(now)}
        <h4>최근 24시간 생성</h4>
        ${statsTable(now)}
        ${recentFailures(now)}
        <h4>API 직접 측정 (24시간) <span class="menu_button sp-probe-btn" title="작은 요청을 한 번 보내 응답 시간을 잽니다">지금 측정</span></h4>
        ${probeTable(now)}
        <h4>핑</h4>
        ${pingTable(now)}
        <p class="sp-muted">예측 근거 ${p.events}건 · 답장 질 근거 ${p.qualityEvents}건 · 평가 ${data.ratings.length}개 · 생성 기록 ${data.gens.length}개 · API 측정 ${data.probes.length}개 · 핑 ${data.pings.length}개</p>
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
                <small>Vertex AI 는 리전별, NanoGPT 는 프로바이더별로 따로 기록해요.</small>
                <label for="sp_rate_int">답장 평가 물어보는 간격(분, 0 = 안 물음)</label>
                <input id="sp_rate_int" class="text_pole" type="number" min="0" max="1440" step="5" />
                <small>답장이 온 직후에 "안 옴 / 캐붕·고장 / 노잼 / 좋음" 중 하나를 물어봐요.</small>
                <label for="sp_rate_min">물어보기 전 최소 생성 횟수</label>
                <input id="sp_rate_min" class="text_pole" type="number" min="1" max="50" step="1" />
                <label for="sp_hang">무한 대기로 칠 시간(초)</label>
                <input id="sp_hang" class="text_pole" type="number" min="5" max="600" step="5" />
                <small>아무 글자도 안 온 채로 이만큼 기다리다 멈추면 "답장 안 옴"으로 기록해요.</small>
                <label class="checkbox_label"><input id="sp_auto_broken" type="checkbox" /><span>망가진 답장 자동 감지 (반복, 깨진 글자, 다른 언어 섞임, 너무 짧게 끊김)</span></label>
                <small>약한 단서로만 써요. 직접 평가가 있으면 평가가 우선이에요.</small>
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
                <small>추론(thinking) 모델은 토큰이 적으면 빈 답이 올 수 있어요. 측정에서는 빈 답도 "서버 응답함"으로 기록해요.</small>
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
                <small>슬래시 명령: <code>/pulse</code> (대시보드), <code>/pulse-rate 노잼</code> (안옴 · 캐붕 · 노잼 · 좋음), <code>/pulse-probe</code> (지금 측정)</small>
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
    bindCheck('sp_auto_broken', 'autoBroken', refreshBadge);
    $('sp_badge_pos').value = s.badgePos || 'top-right';
    $('sp_badge_pos').addEventListener('change', () => { s.badgePos = $('sp_badge_pos').value; saveSettingsDebounced(); refreshBadge(); });
    bindCheck('sp_ping_st', 'pingSillyTavern');
    bindNum('sp_rate_int', 'ratingIntervalMin', 0, 1440);
    bindNum('sp_rate_min', 'ratingMinGens', 1, 50);
    bindNum('sp_hang', 'hangSeconds', 5, 600);
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
            migrateRatings(incoming.ratings);
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
            return p.pReply == null ? '' : String(Math.round(p.pReply * 100));
        },
        returns: 'chance (0-100) that a reply arrives now on the current connection',
        helpString: '<div>서버 상태 대시보드를 열고, 지금 답장이 올 가능성(0~100)을 반환합니다.</div>',
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
            const cat = addRating(String(unnamed ?? '').trim());
            if (cat) toastr.success(`${RATE[cat].emoji} ${RATE[cat].label}(으)로 기록했어요.`);
            else toastr.warning('안옴 · 캐붕 · 노잼 · 좋음 중 하나를 넣어 주세요.');
            return cat || '';
        },
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: 'how the last reply was: 안옴 (no reply), 캐붕 (broken), 노잼 (dull), 좋음 (good)',
                typeList: [ARGUMENT_TYPE.STRING],
                isRequired: true,
                enumList: ['안옴', '캐붕', '노잼', '좋음'],
            }),
        ],
        helpString: '<div>방금 답장을 평가합니다. <code>안옴</code> · <code>캐붕</code> · <code>노잼</code> · <code>좋음</code>. 예: <code>/pulse-rate 노잼</code></div>',
    }));
}

// ---------------------------------------------------------------- manifest hooks

/**
 * "clean" hook (SillyTavern 1.19+): called when the user picks "Clean extension data" or deletes the
 * extension with cleanup. Removes every record (stored in the browser) and this extension's settings.
 * ST saves settings and reloads the page afterwards.
 */
export async function onClean() {
    const { extensionSettings } = SillyTavern.getContext();
    delete extensionSettings[MODULE];
    try {
        await SillyTavern.libs.localforage.removeItem(STORE_KEY);
    } catch (err) {
        console.warn(LOG, 'clean failed', err);
    }
    document.getElementById('sp_badge')?.remove();
}

/** True when ST imported this module only to call a hook (e.g. "clean") while the extension is turned off. */
function loadedWhileDisabled() {
    const disabled = SillyTavern.getContext().extensionSettings?.disabledExtensions || [];
    return !!SELF_FOLDER && disabled.includes(SELF_FOLDER);
}

// ---------------------------------------------------------------- init

if (globalThis.SillyTavern?.getContext) {
    const { eventSource, event_types } = SillyTavern.getContext();
    eventSource.on(event_types.APP_READY, async () => {
        if (loadedWhileDisabled()) return;
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
            for (const ev of [event_types.MAIN_API_CHANGED, event_types.CHATCOMPLETION_MODEL_CHANGED, event_types.CHATCOMPLETION_SOURCE_CHANGED, event_types.CONNECTION_PROFILE_LOADED, event_types.SETTINGS_UPDATED]) {
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
                const cat = addRating(btn.dataset.cat, inToast ? 'prompt' : 'manual');
                if (!cat) return;
                const msg = `${RATE[cat].emoji} <b>${esc(RATE[cat].label)}</b>(으)로 기록했어요. 고마워요!`;
                if (inToast) {
                    // Confirm inside the same toast, then close it
                    const box = inToast.querySelector('.sp-prompt');
                    if (box) box.innerHTML = msg;
                    closeRatingToast(1200);
                } else {
                    toastr.success(msg, '', { escapeHtml: false });
                    btn.blur();
                }
            });

            // One timer drives pings, probes and the badge
            setInterval(() => {
                const st = getSettings();
                if (!st.enabled) return;
                if (st.pingIntervalMin > 0 && Date.now() - data.lastPingAt >= st.pingIntervalMin * MIN) runPings();
                if (st.probeIntervalMin > 0 && document.visibilityState === 'visible'
                    && Date.now() - data.lastProbeAt >= st.probeIntervalMin * MIN) runProbe();
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
