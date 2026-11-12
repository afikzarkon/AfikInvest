// Ported from day-trader-skill (MIT, Jake Schincariol)
//
// The 'scanner.daily' job: once a day after the US close, scan the whole
// US universe for the daily setups (scannerService.js) and store the run
// (scannerStore.js). Heavy for a free host, so it streams batch by batch and
// stops at a hard time budget; a run cut short is stored with partial: true.
//
// payload (all optional):
//   force          run even on a non-trading day / before the close / when
//                  today's full run is already stored
//   symbols        scan only these tickers instead of the universe
//   limit          scan only the first N symbols
//   minPrice, minVolume, timeBudgetMs
const {
  ScanError,
  toEastern,
  isTradingDay,
  sessionCloseMinutes,
  runDailyScan,
  createDefaultFetchers,
  DEFAULT_MIN_PRICE,
  DEFAULT_MIN_VOLUME,
  DEFAULT_TIME_BUDGET_MS,
  PAUSE_MS,
  LONG_TERM_SETUPS
} = require('./scannerService');

// Long-term hits get their latest quarter from SEC (earningsService.js), so
// the page can tell a good company at a lower price from one whose business
// is shrinking. Capped: each company is one SEC companyfacts download.
const ENRICH_MAX = 40;
const ENRICH_BUDGET_MS = 3 * 60 * 1000;

// The latest reported quarter -> { quarter, end, revenueYoy, epsYoy,
// operatingMarginYoyPt, trend: 'growing' | 'mixed' | 'weakening' } or null.
function fundamentalsFromEarnings(result) {
  const q = result && Array.isArray(result.rows) ? result.rows[0] : null;
  if (!q || q.revenueYoy === null || q.revenueYoy === undefined) return null;
  const rev = q.revenueYoy;
  const opm = q.operatingMarginYoyPt;
  let trend = 'mixed';
  if (rev > 0 && (opm === null || opm === undefined || opm >= -1)) trend = 'growing';
  else if (rev < 0 && (opm === null || opm === undefined || opm < 0)) trend = 'weakening';
  return {
    quarter: String(q.fiscal || '').trim() || null,
    end: q.end || null,
    revenueYoy: rev,
    epsYoy: q.epsYoy === undefined ? null : q.epsYoy,
    operatingMarginYoyPt: opm === undefined ? null : opm,
    trend
  };
}

// Adds `fundamentals` to the most-traded long-term hits, one SEC read at a
// time, within a time budget. Never throws: a company SEC has no facts for
// (an ADR, a fund) simply stays without.
async function enrichLongTermHits(hits, { earnings, clock = Date.now, max = ENRICH_MAX, budgetMs = ENRICH_BUDGET_MS, logger = console }) {
  const summary = { attempted: 0, enriched: 0, skipped: null };
  if (!earnings || !earnings.configured) {
    summary.skipped = 'SEC_USER_AGENT not set';
    return summary;
  }
  const started = clock();
  const wanted = hits.filter((h) => (h.setups || []).some((k) => LONG_TERM_SETUPS.includes(k))).slice(0, max);
  for (const hit of wanted) {
    if (clock() - started > budgetMs) {
      summary.skipped = 'time budget';
      break;
    }
    summary.attempted += 1;
    try {
      const f = fundamentalsFromEarnings(await earnings.getEarnings(hit.symbol));
      if (f) {
        hit.fundamentals = f;
        summary.enriched += 1;
      }
    } catch (err) {
      if (err && err.code === 'UPSTREAM' && logger && logger.warn) logger.warn(`[scanner] SEC read failed for ${hit.symbol}: ${err.message}`);
    }
  }
  return summary;
}

const num = (v, fallback) => {
  const n = Number(v);
  return v !== undefined && v !== null && v !== '' && Number.isFinite(n) && n >= 0 ? n : fallback;
};

function createScannerJobHandlers({
  store, // kept for the shared handler-factory signature (unused)
  scanner,
  fetchers = null,
  now = () => Date.now(),
  clock = () => Date.now(),
  sleep,
  pauseMs = PAUSE_MS,
  timeBudgetMs = DEFAULT_TIME_BUDGET_MS,
  logger = console,
  // SEC earnings for the long-term hits; null turns the enrichment off.
  earnings
}) {
  const f = fetchers || createDefaultFetchers(sleep ? { sleep } : {});
  let earningsService = earnings;
  const getEarningsService = () => {
    if (earningsService === undefined) earningsService = require('./earningsService').createEarningsService();
    return earningsService;
  };

  async function runDaily(payload = {}) {
    const p = payload || {};
    const nowMs = now();
    const ny = toEastern(nowMs);
    const runDate = ny.date;
    if (!p.force) {
      if (!isTradingDay(runDate)) return { skipped: 'not a trading day', runDate };
      if (ny.minutes < sessionCloseMinutes(runDate)) return { skipped: 'before the US close', runDate };
      const latest = await scanner.getLatestRun({ withResults: false });
      if (latest && latest.runDate === runDate && !latest.partial) {
        return { skipped: 'already ran today', runDate, runId: latest.id };
      }
    }

    let universe;
    if (Array.isArray(p.symbols) && p.symbols.length) {
      const seen = new Set();
      universe = p.symbols
        .map((s) => String(s || '').trim().toUpperCase())
        .filter((s) => s && !seen.has(s) && seen.add(s))
        .map((symbol) => ({ symbol, name: null }));
    } else {
      const u = await f.fetchUniverse();
      universe = u.symbols;
    }
    const limit = num(p.limit, 0);
    if (limit > 0) universe = universe.slice(0, Math.floor(limit));
    if (!universe.length) throw new ScanError('no symbols to scan');

    const startedAt = new Date(clock()).toISOString();
    const result = await runDailyScan({
      universe,
      fetchSpark: f.fetchSpark,
      now: nowMs,
      minPrice: num(p.minPrice, DEFAULT_MIN_PRICE),
      minVolume: num(p.minVolume, DEFAULT_MIN_VOLUME),
      timeBudgetMs: num(p.timeBudgetMs, timeBudgetMs),
      pauseMs,
      sleep,
      clock
    });
    if (result.counts.fetched === 0) {
      // Nothing came back (Yahoo down or blocking): fail so the queue retries,
      // rather than storing an empty "no setups" run.
      throw new ScanError(`Yahoo returned no charts for ${universe.length} symbols`);
    }
    const enrichment = p.enrich === false ? { skipped: 'off' } : await enrichLongTermHits(result.hits, { earnings: getEarningsService(), clock, logger });
    const finishedAt = new Date(clock()).toISOString();
    const runId = await scanner.insertRun({
      runDate,
      asOf: result.asOf,
      startedAt,
      finishedAt,
      universeSize: universe.length,
      fetched: result.counts.fetched,
      scanned: result.counts.scanned,
      partial: result.partial,
      counts: Object.assign({}, result.counts, { bySetup: result.bySetup, elapsedMs: result.elapsedMs, enrichment }),
      filters: result.filters,
      results: result.hits
    });
    if (result.partial && logger && logger.warn) {
      logger.warn(`[scanner] partial run: ${result.counts.attempted} of ${universe.length} symbols in ${result.elapsedMs} ms`);
    }
    return {
      runId,
      runDate,
      asOf: result.asOf,
      universe: universe.length,
      attempted: result.counts.attempted,
      fetched: result.counts.fetched,
      scanned: result.counts.scanned,
      hits: result.hits.length,
      bySetup: result.bySetup,
      partial: result.partial,
      elapsedMs: result.elapsedMs,
      enrichment
    };
  }

  return { 'scanner.daily': runDaily };
}

module.exports = { createScannerJobHandlers, fundamentalsFromEarnings, enrichLongTermHits };
