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
  PAUSE_MS
} = require('./scannerService');

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
  logger = console
}) {
  const f = fetchers || createDefaultFetchers(sleep ? { sleep } : {});

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
      counts: Object.assign({}, result.counts, { bySetup: result.bySetup, elapsedMs: result.elapsedMs }),
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
      elapsedMs: result.elapsedMs
    };
  }

  return { 'scanner.daily': runDaily };
}

module.exports = { createScannerJobHandlers };
