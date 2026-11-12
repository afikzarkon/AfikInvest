// Ported from day-trader-skill (MIT, Jake Schincariol)
//
// Market scanner, daily setups: the DAILY part of trader-scanner/scan.py.
// (The intraday opening-range scan is deliberately not ported: this is a
// portfolio app and the API host sleeps when idle.)
//
//   1. The universe: Nasdaq Trader's symbol directories (nasdaqlisted.txt and
//      otherlisted.txt), filtered to US-listed common stocks, ordinary shares
//      and ADRs (classifySymbolRow - the same rule, in the same order, as
//      scan.py's classify()).
//   2. Daily closes: Yahoo's spark endpoint, 20 symbols a request (it answers
//      400 above 20), 3 months of 1-day bars, a polite 0.3 s pause between
//      requests; query2 first, query1 on a 429 or 5xx, one more round after
//      a 5 s wait if a 429 was seen.
//   3. The setups, from closes only (spark has no highs or lows):
//        breakout_20d     the last close is above every close of the 20 before it
//        bull_flag        up more than 10% over the 10 sessions before the
//                         last 5, then the last 5 closes inside a 5% range
//        reclaim_ma20     closed under the 20-day average, then closed above it
//        oversold         RSI 14 (Wilder) under 30
//        oversold_bounce  RSI 14 was under 30 yesterday and today closed up
//      Liquidity from the spark meta: price >= minPrice ($5) and the last
//      session's volume >= minVolume (1,000,000). At least 30 daily closes.
//      Today's daily bar is dropped until the session's close.
//
// The scan streams: one batch of 20 is fetched, scored and dropped before
// the next, so only the hits stay in memory (a free 512 MB host). It stops
// at a hard time budget and reports itself as partial.
//
// A scan is a list of charts that match a rule, not a list of stocks to buy.
const axios = require('axios');

const NASDAQ_FILES = ['nasdaqlisted.txt', 'otherlisted.txt'];
const NASDAQ_URL = 'https://www.nasdaqtrader.com/dynamic/SymDir/';
const YAHOO_HOSTS = ['https://query2.finance.yahoo.com', 'https://query1.finance.yahoo.com'];
const SPARK_MAX = 20; // Yahoo's spark answers 400 above 20 symbols
const PAUSE_MS = 300; // between requests: be polite to free endpoints
const BACKOFF_MS = 5000; // before the one retry after a 429
const MIN_DAILY_BARS = 30;
const DEFAULT_MIN_PRICE = 5;
const DEFAULT_MIN_VOLUME = 1000000;
const DEFAULT_TIME_BUDGET_MS = 8 * 60 * 1000;
const HTTP_TIMEOUT_MS = 20000;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const SETUP_KEYS = ['breakout_20d', 'bull_flag', 'reclaim_ma20', 'oversold', 'oversold_bounce'];

class ScanError extends Error {}

const sleepMs = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------- time (New York)
// The same DST rule as scan.py (US rule since 2007), so a bar's New York date
// never depends on the machine's time zone, and it is pure arithmetic (the
// full scan dates ~400k bars; Intl would be needlessly slow).

const NYSE_HOLIDAYS = new Set([
  '2026-01-01', '2026-01-19', '2026-02-16', '2026-04-03', '2026-05-25', '2026-06-19', '2026-07-03',
  '2026-09-07', '2026-11-26', '2026-12-25',
  '2027-01-01', '2027-01-18', '2027-02-15', '2027-03-26', '2027-05-31', '2027-06-18', '2027-07-05',
  '2027-09-06', '2027-11-25', '2027-12-24'
]);
const NYSE_EARLY_CLOSE = new Set(['2026-11-27', '2026-12-24', '2027-11-26']); // 1:00 p.m. ET
const CLOSE_MIN = 16 * 60;
const EARLY_MIN = 13 * 60;

function nthSundayUtc(year, month, n) {
  const first = new Date(Date.UTC(year, month - 1, 1));
  const toSunday = (7 - first.getUTCDay()) % 7;
  return Date.UTC(year, month - 1, 1 + toSunday + 7 * (n - 1));
}

// Hours from UTC for New York at a UTC instant (ms): -4 in daylight time, -5 otherwise.
function easternOffset(utcMs) {
  const y = new Date(utcMs).getUTCFullYear();
  const start = nthSundayUtc(y, 3, 2) + 7 * 3600000; // 2:00 EST
  const end = nthSundayUtc(y, 11, 1) + 6 * 3600000; // 2:00 EDT
  return utcMs >= start && utcMs < end ? -4 : -5;
}

// UTC ms -> { date: 'YYYY-MM-DD', minutes, weekday } in New York.
function toEastern(utcMs) {
  const local = new Date(utcMs + easternOffset(utcMs) * 3600000);
  return {
    date: local.toISOString().slice(0, 10),
    minutes: local.getUTCHours() * 60 + local.getUTCMinutes(),
    weekday: local.getUTCDay()
  };
}

// New York wall clock 'YYYY-MM-DD HH:MM' -> UTC ms (for tests and callers).
function easternToUtc(text) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(String(text).trim());
  if (!m) throw new ScanError(`not a New York time: ${text}`);
  const naive = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0));
  for (const off of [-4, -5]) {
    const utc = naive - off * 3600000;
    if (easternOffset(utc) === off) return utc;
  }
  return naive + 5 * 3600000;
}

function weekdayOf(isoDate) {
  const [y, m, d] = isoDate.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

function isTradingDay(isoDate) {
  const wd = weekdayOf(isoDate);
  return wd !== 0 && wd !== 6 && !NYSE_HOLIDAYS.has(isoDate);
}

// Minutes after midnight the session closes, or null when closed all day.
function sessionCloseMinutes(isoDate) {
  if (!isTradingDay(isoDate)) return null;
  return NYSE_EARLY_CLOSE.has(isoDate) ? EARLY_MIN : CLOSE_MIN;
}

// ---------------------------------------------------------------- universe

const TICKER = /^[A-Z]{1,5}$|^[A-Z]{1,4}\.[A-Z]$/;
const ALWAYS_OUT = [
  ['warrant', /\bwarrants?\b/],
  ['unit or right', /\b(units?|rights?),? (each|that|entitling)\b|(?<!the )\brights? to\b/],
  ['note', /\b(notes?|etns?|debentures?)\b/],
  ['coupon', /%/],
  ['depositary', /(?<!american )(?<!global )\bdepositary shares?\b/]
];
const COMMON = new RegExp(
  '\\bcommon (stock|shares?|units?)\\b|\\bord(inary)? shares?\\b|\\bshares? of beneficial interest\\b' +
    '|\\b(american|global) deposit[ao]ry\\b|\\bads[s]?\\b|\\badrs?\\b' +
    '|\\b(limited partnership|partnership|trust) units?\\b|\\bl\\.?p\\.? units?\\b' +
    '|\\bunits? (of|representing)\\b.*\\b(limited partner|partnership|beneficial interest|limited liability)'
);
const SOFT_OUT = [
  ['unit', /\bunits?\b/],
  ['right', /\brights?\b/],
  ['bond', /\bbonds?\b/],
  ['preferred', /\bpreferred\b|\bpreference\b/]
];

const collapse = (s) => String(s || '').split(/\s+/).filter(Boolean).join(' ');

// One symbol-directory row -> 'keep' or the rule that drops it.
function classifySymbolRow(row) {
  const sym = String(row.Symbol || row['ACT Symbol'] || '').trim();
  if (String(row['Test Issue'] || '').trim() !== 'N') return 'test issue';
  if (String(row.ETF || '').trim() !== 'N') return 'ETF';
  if (String(row.NextShares || 'N').trim() !== 'N') return 'NextShares';
  if (!TICKER.test(sym)) return 'not a plain ticker';
  if (/\.[UWR]$/.test(sym)) return 'unit / warrant / right suffix';
  const name = collapse(row['Security Name']).toLowerCase();
  for (const [tag, rx] of ALWAYS_OUT) if (rx.test(name)) return tag;
  if (COMMON.test(name)) return 'keep';
  for (const [tag, rx] of SOFT_OUT) if (rx.test(name)) return tag;
  return 'keep';
}

// Nasdaq Trader pipe file -> { rows, created }. The last line is 'File Creation Time: ...'.
function parseSymbolDirectory(text) {
  const lines = String(text || '').replace(/\r/g, '').split('\n').filter((ln) => ln.trim());
  if (!lines.length || !lines[0].includes('|')) throw new ScanError('not a Nasdaq Trader symbol directory');
  const hdr = lines[0].split('|').map((h) => h.trim());
  if (!hdr.includes('Security Name') || !(hdr.includes('Symbol') || hdr.includes('ACT Symbol'))) {
    throw new ScanError('not a Nasdaq Trader symbol directory');
  }
  const rows = [];
  let created = null;
  for (const ln of lines.slice(1)) {
    if (ln.startsWith('File Creation Time')) {
      const m = /(\d{2})(\d{2})(\d{4})(\d{2}):(\d{2})/.exec(ln);
      if (m) created = `${m[3]}-${m[1]}-${m[2]} ${m[4]}:${m[5]}`;
      continue;
    }
    const cells = ln.split('|');
    const row = {};
    hdr.forEach((h, i) => {
      if (i < cells.length) row[h] = cells[i];
    });
    rows.push(row);
  }
  return { rows, created };
}

// 'Tesla, Inc. - Common Stock' -> 'Tesla, Inc.'
function displayName(securityName) {
  return collapse(securityName).split(' - ')[0];
}

// { 'nasdaqlisted.txt': text, 'otherlisted.txt': text } ->
//   { symbols: [{ symbol, name, securityName }] sorted, counts, created }
function buildUniverse(texts) {
  const kept = new Map();
  const counts = { rows: 0 };
  let created = null;
  for (const fname of NASDAQ_FILES) {
    if (!(fname in texts)) throw new ScanError(`missing ${fname}`);
    const parsed = parseSymbolDirectory(texts[fname]);
    created = created || parsed.created;
    counts.rows += parsed.rows.length;
    for (const r of parsed.rows) {
      const why = classifySymbolRow(r);
      counts[why] = (counts[why] || 0) + 1;
      if (why === 'keep') {
        const symbol = String(r.Symbol || r['ACT Symbol']).trim();
        kept.set(symbol, collapse(r['Security Name']));
      }
    }
  }
  const symbols = [...kept.keys()]
    .sort()
    .map((symbol) => ({ symbol, name: displayName(kept.get(symbol)), securityName: kept.get(symbol) }));
  return { symbols, counts, created };
}

// ---------------------------------------------------------------- spark parsing

const toYahoo = (sym) => String(sym).toUpperCase().replace(/\./g, '-');

function sparkPath(symbols, range = '3mo', interval = '1d') {
  return `/v7/finance/spark?symbols=${symbols.map(toYahoo).join(',')}&range=${range}&interval=${interval}`;
}

function seriesFromResult(res) {
  const q = ((res.indicators || {}).quote || [{}])[0] || {};
  const t = Array.isArray(res.timestamp) ? res.timestamp : [];
  const col = (k) => (Array.isArray(q[k]) ? t.map((_, i) => (i < q[k].length ? q[k][i] : null)) : null);
  return { t: t.slice(), c: col('close') || t.map(() => null), v: col('volume'), meta: res.meta || {} };
}

// Spark JSON (text or object) -> { SYM: series }. Symbols Yahoo does not know
// are simply missing. `wanted` maps Yahoo symbols back to ours (BRK-B -> BRK.B).
function parseSpark(textOrDoc, wanted = null) {
  let doc = textOrDoc;
  if (typeof textOrDoc === 'string') {
    try {
      doc = JSON.parse(textOrDoc);
    } catch {
      throw new ScanError("Yahoo's spark answer is not JSON");
    }
  }
  const sp = doc && typeof doc === 'object' ? doc.spark : null;
  if (!sp || typeof sp !== 'object') throw new ScanError("Yahoo's spark answer is not the shape this tool knows");
  const out = {};
  for (const item of sp.result || []) {
    const resp = (item && item.response) || [];
    if (!resp.length) continue;
    const ysym = String(item.symbol || (resp[0].meta || {}).symbol || '').toUpperCase();
    const sym = (wanted && wanted[ysym]) || ysym.replace(/-/g, '.');
    out[sym] = seriesFromResult(resp[0]);
  }
  if (sp.error && !Object.keys(out).length) {
    throw new ScanError(`Yahoo spark: ${sp.error.description || sp.error.code || JSON.stringify(sp.error)}`);
  }
  return out;
}

// ---------------------------------------------------------------- daily setups

// Wilder's RSI on closes (the same math as scan.py / the reel's refs/scan.py).
function rsi(closes, n = 14) {
  if (closes.length < n + 1) return null;
  const g = [];
  const lo = [];
  for (let i = 1; i < closes.length; i += 1) {
    g.push(Math.max(0, closes[i] - closes[i - 1]));
    lo.push(Math.max(0, closes[i - 1] - closes[i]));
  }
  let ag = 0;
  let al = 0;
  for (let i = 0; i < n; i += 1) {
    ag += g[i];
    al += lo[i];
  }
  ag /= n;
  al /= n;
  for (let i = n; i < g.length; i += 1) {
    ag = (ag * (n - 1) + g[i]) / n;
    al = (al * (n - 1) + lo[i]) / n;
  }
  return al ? 100 - 100 / (1 + ag / al) : 100.0;
}

// [{ date, close, volume }] of COMPLETE daily bars: null closes dropped,
// today's bar dropped until the session closes, anything dated after the
// clock dropped; one bar a day (a late duplicate, the live tick, wins).
function dailyCloses(series, nowMs) {
  const now = toEastern(nowMs);
  const closeMin = sessionCloseMinutes(now.date);
  const todayDone = closeMin === null || now.minutes >= closeMin;
  const byDate = new Map();
  const t = series.t || [];
  for (let i = 0; i < t.length; i += 1) {
    const c = series.c[i];
    if (c === null || c === undefined) continue;
    const d = toEastern(Number(t[i]) * 1000).date;
    if (d > now.date || (d === now.date && !todayDone)) continue;
    const v = series.v ? series.v[i] : null;
    byDate.set(d, { date: d, close: Number(c), volume: v === null || v === undefined ? null : Number(v) });
  }
  return [...byDate.values()].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

const sumOf = (arr) => arr.reduce((s, x) => s + x, 0);

// closes (oldest first, >= 30) -> { setups, numbers }. Pure; mirrors find_setups().
function findSetups(c) {
  const n = c.length;
  const last = c[n - 1];
  const high20 = Math.max(...c.slice(n - 21, n - 1));
  const ma20 = sumOf(c.slice(n - 20)) / 20.0;
  const ma20Prev = sumOf(c.slice(n - 21, n - 1)) / 20.0;
  const run = c[n - 6] / c[n - 16] - 1;
  const last5 = c.slice(n - 5);
  const range5 = (Math.max(...last5) - Math.min(...last5)) / last;
  const r = rsi(c);
  const rPrev = rsi(c.slice(0, n - 1));
  const setups = [];
  if (last > high20) setups.push('breakout_20d');
  if (run > 0.1 && range5 < 0.05) setups.push('bull_flag');
  if (c[n - 2] < ma20Prev && last > ma20) setups.push('reclaim_ma20');
  if (r !== null && r < 30) setups.push('oversold');
  if (rPrev !== null && rPrev < 30 && last > c[n - 2]) setups.push('oversold_bounce');
  return { setups, numbers: { rsi: r, rsiPrev: rPrev, high20, ma20, runPct: run * 100, range5Pct: range5 * 100 } };
}

const round = (x, d) => (x === null || x === undefined || !Number.isFinite(x) ? null : Math.round(x * 10 ** d) / 10 ** d);

// One symbol's series -> { status: 'illiquid'|'short'|'scanned', hit?, closeDate? }.
function evaluateSymbol(series, nowMs, { minPrice = DEFAULT_MIN_PRICE, minVolume = DEFAULT_MIN_VOLUME } = {}) {
  const bars = dailyCloses(series, nowMs);
  const meta = series.meta || {};
  let price = meta.regularMarketPrice;
  if ((price === null || price === undefined) && bars.length) price = bars[bars.length - 1].close;
  const vol = meta.regularMarketVolume;
  if (price === null || price === undefined || price < minPrice || (minVolume > 0 && (vol === null || vol === undefined || vol < minVolume))) {
    return { status: 'illiquid' };
  }
  if (bars.length < MIN_DAILY_BARS) return { status: 'short' };
  const closes = bars.map((b) => b.close);
  const closeDate = bars[bars.length - 1].date;
  const { setups, numbers } = findSetups(closes);
  if (!setups.length) return { status: 'scanned', closeDate };
  const last = closes[closes.length - 1];
  const prev = closes[closes.length - 2];
  // Volume vs its 20-day average only when the series carries volumes
  // (spark's 1-day bars are closes only, so usually null).
  const vols = bars.slice(-21, -1).map((b) => b.volume).filter((v) => Number.isFinite(v));
  const avgVolume = vols.length >= 10 ? sumOf(vols) / vols.length : null;
  const volume = vol === null || vol === undefined ? null : Math.trunc(vol);
  return {
    status: 'scanned',
    closeDate,
    hit: {
      setups,
      close: round(last, 2),
      closeDate,
      changePct: round((last / prev - 1) * 100, 2),
      volume,
      avgVolume: avgVolume === null ? null : Math.round(avgVolume),
      volumeRatio: avgVolume && volume !== null ? round(volume / avgVolume, 2) : null,
      high20: round(numbers.high20, 2),
      distHigh20Pct: round((last / numbers.high20 - 1) * 100, 2),
      ma20: round(numbers.ma20, 2),
      distMa20Pct: round((last / numbers.ma20 - 1) * 100, 2),
      rsi: round(numbers.rsi, 1),
      rsiPrev: round(numbers.rsiPrev, 1),
      runPct: round(numbers.runPct, 1),
      range5Pct: round(numbers.range5Pct, 1)
    }
  };
}

const dollarVolume = (h) => (h.close || 0) * (h.volume || 0);
const byMostTraded = (a, b) => dollarVolume(b) - dollarVolume(a) || (a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0);

// Pure, whole-batch version of scan_daily(): data = { SYM: series }.
function scanDaily(data, symbols, nowMs, opts = {}) {
  const acc = newAccumulator(symbols.length);
  for (const sym of symbols) accumulate(acc, sym, data[sym], nowMs, opts, null);
  return finishAccumulator(acc);
}

function newAccumulator(requested) {
  return { hits: [], dates: new Map(), counts: { requested, fetched: 0, illiquid: 0, short: 0, scanned: 0 } };
}

function accumulate(acc, sym, series, nowMs, opts, name) {
  if (!series) return;
  acc.counts.fetched += 1;
  const r = evaluateSymbol(series, nowMs, opts);
  if (r.status === 'illiquid' || r.status === 'short') {
    acc.counts[r.status] += 1;
    return;
  }
  acc.counts.scanned += 1;
  acc.dates.set(r.closeDate, (acc.dates.get(r.closeDate) || 0) + 1);
  if (r.hit) acc.hits.push(Object.assign({ symbol: sym, name: name || null }, r.hit));
}

function finishAccumulator(acc) {
  acc.hits.sort(byMostTraded);
  let lastDate = null;
  let best = -1;
  acc.dates.forEach((n, d) => {
    if (n > best || (n === best && d > lastDate)) {
      best = n;
      lastDate = d;
    }
  });
  const counts = Object.assign({}, acc.counts, { hits: acc.hits.length });
  return { hits: acc.hits, counts, lastDate };
}

function countBySetup(hits) {
  const out = {};
  SETUP_KEYS.forEach((k) => {
    out[k] = 0;
  });
  hits.forEach((h) => (h.setups || []).forEach((k) => {
    if (k in out) out[k] += 1;
  }));
  return out;
}

// ---------------------------------------------------------------- network


// Default GET: text body, a timeout on every request. Resolves { status, body }.
async function axiosGetText(url, { timeout = HTTP_TIMEOUT_MS } = {}) {
  const r = await axios.get(url, {
    timeout,
    headers: { 'User-Agent': UA, Accept: '*/*' },
    responseType: 'text',
    transformResponse: [(d) => d],
    validateStatus: () => true,
    maxContentLength: 8 * 1024 * 1024
  });
  return { status: r.status, body: typeof r.data === 'string' ? r.data : String(r.data || '') };
}

// GET a Yahoo path: query2 first, query1 on a 429 or 5xx, and one more round
// after BACKOFF if a 429 was seen. A 4xx other than 429 is final (Yahoo's JSON
// error body is handed back for the caller to parse).
async function yahooGet(path, { httpGet = axiosGetText, sleep = sleepMs, backoffMs = BACKOFF_MS } = {}) {
  let last = 'no answer';
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let saw429 = false;
    for (const host of YAHOO_HOSTS) {
      let res;
      try {
        res = await httpGet(host + path);
      } catch (err) {
        last = String((err && err.message) || err);
        continue;
      }
      if (res.status >= 200 && res.status < 300) return res.body;
      last = `HTTP ${res.status}`;
      if (res.status === 429) {
        saw429 = true;
        continue;
      }
      if (res.status >= 500) continue;
      if (String(res.body || '').trim().startsWith('{')) return res.body;
      throw new ScanError(`Yahoo answered ${last} for ${path.split('?')[0]}`);
    }
    if (attempt === 0 && saw429) {
      await sleep(backoffMs);
      continue;
    }
    break;
  }
  throw new ScanError(`Yahoo answered ${last} for ${path.split('?')[0]}`);
}

// One spark batch (<= 20 symbols) -> { data: { SYM: series }, failed: { SYM: why } }.
async function fetchSparkBatch(symbols, opts = {}) {
  const wanted = {};
  symbols.forEach((s) => {
    wanted[toYahoo(s)] = s;
  });
  const failed = {};
  const data = {};
  try {
    const got = parseSpark(await yahooGet(sparkPath(symbols, '3mo', '1d'), opts), wanted);
    symbols.forEach((s) => {
      if (got[s]) data[s] = got[s];
      else failed[s] = 'no data from Yahoo';
    });
  } catch (err) {
    symbols.forEach((s) => {
      failed[s] = String(err.message || err);
    });
  }
  return { data, failed };
}

// Both symbol directories -> buildUniverse() result.
async function fetchUniverse({ httpGet = axiosGetText, sleep = sleepMs, pauseMs = PAUSE_MS } = {}) {
  const texts = {};
  for (let k = 0; k < NASDAQ_FILES.length; k += 1) {
    const fname = NASDAQ_FILES[k];
    if (k && pauseMs) await sleep(pauseMs);
    let res;
    try {
      res = await httpGet(NASDAQ_URL + fname, { timeout: 60000 });
    } catch (err) {
      throw new ScanError(`could not reach nasdaqtrader.com: ${err.message || err}`);
    }
    if (res.status !== 200) throw new ScanError(`nasdaqtrader.com answered HTTP ${res.status} for ${fname}`);
    texts[fname] = res.body;
  }
  return buildUniverse(texts);
}

function createDefaultFetchers({ httpGet = axiosGetText, sleep = sleepMs } = {}) {
  return {
    fetchUniverse: () => fetchUniverse({ httpGet, sleep }),
    fetchSpark: (symbols) => fetchSparkBatch(symbols, { httpGet, sleep })
  };
}

// ---------------------------------------------------------------- the streaming scan

// universe: [{ symbol, name }]. fetchSpark(batch) -> { data, failed }.
// Fetches batch by batch, scores each and drops it, pauses between requests,
// and stops at the time budget (partial: true, with how far it got).
async function runDailyScan({
  universe,
  fetchSpark,
  now = Date.now(),
  minPrice = DEFAULT_MIN_PRICE,
  minVolume = DEFAULT_MIN_VOLUME,
  timeBudgetMs = DEFAULT_TIME_BUDGET_MS,
  pauseMs = PAUSE_MS,
  sleep = sleepMs,
  clock = Date.now
}) {
  const startedAt = clock();
  const symbols = universe.map((u) => u.symbol);
  const names = new Map(universe.map((u) => [u.symbol, u.name || null]));
  const acc = newAccumulator(symbols.length);
  let failed = 0;
  let attempted = 0;
  let partial = false;
  let requests = 0;
  const opts = { minPrice, minVolume };
  for (let i = 0; i < symbols.length; i += SPARK_MAX) {
    if (clock() - startedAt >= timeBudgetMs) {
      partial = true;
      break;
    }
    if (i && pauseMs) await sleep(pauseMs);
    const batch = symbols.slice(i, i + SPARK_MAX);
    let got;
    try {
      got = await fetchSpark(batch);
    } catch (err) {
      got = { data: {}, failed: Object.fromEntries(batch.map((s) => [s, String(err.message || err)])) };
    }
    requests += 1;
    attempted += batch.length;
    for (const sym of batch) {
      const series = got.data ? got.data[sym] : null;
      if (series) accumulate(acc, sym, series, now, opts, names.get(sym));
      else failed += 1;
    }
  }
  const { hits, counts, lastDate } = finishAccumulator(acc);
  return {
    hits,
    counts: Object.assign(counts, { attempted, failed, requests }),
    bySetup: countBySetup(hits),
    asOf: lastDate,
    partial,
    elapsedMs: clock() - startedAt,
    filters: { minPrice, minVolume }
  };
}

module.exports = {
  NASDAQ_FILES,
  SETUP_KEYS,
  SPARK_MAX,
  PAUSE_MS,
  BACKOFF_MS,
  MIN_DAILY_BARS,
  DEFAULT_MIN_PRICE,
  DEFAULT_MIN_VOLUME,
  DEFAULT_TIME_BUDGET_MS,
  ScanError,
  easternOffset,
  toEastern,
  easternToUtc,
  isTradingDay,
  sessionCloseMinutes,
  classifySymbolRow,
  parseSymbolDirectory,
  buildUniverse,
  displayName,
  toYahoo,
  sparkPath,
  parseSpark,
  rsi,
  dailyCloses,
  findSetups,
  evaluateSymbol,
  scanDaily,
  countBySetup,
  yahooGet,
  fetchSparkBatch,
  fetchUniverse,
  createDefaultFetchers,
  runDailyScan
};
