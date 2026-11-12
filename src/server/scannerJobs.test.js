/** @jest-environment node */
const fs = require('fs');
const path = require('path');
const { initScannerStore } = require('./scannerStore');
const { createScannerJobHandlers } = require('./scannerJobs');
const { parseSpark, buildUniverse, easternToUtc } = require('./scannerService');
const { STORE_FACTORIES } = require('./testUtils/stores');

const FIX = path.join(__dirname, 'fixtures', 'scanner');
const DAILY = parseSpark(fs.readFileSync(path.join(FIX, 'daily-spark-2026-10-19.json'), 'utf8'));
const UNIVERSE = buildUniverse({
  'nasdaqlisted.txt': fs.readFileSync(path.join(FIX, 'symdir', 'nasdaqlisted.txt'), 'utf8'),
  'otherlisted.txt': fs.readFileSync(path.join(FIX, 'symdir', 'otherlisted.txt'), 'utf8')
});

function fakeFetchers({ onBatch } = {}) {
  const calls = { universe: 0, batches: [] };
  return {
    calls,
    fetchUniverse: async () => {
      calls.universe += 1;
      return UNIVERSE;
    },
    fetchSpark: async (batch) => {
      calls.batches.push(batch);
      if (onBatch) onBatch(batch);
      const out = { data: {}, failed: {} };
      batch.forEach((s) => {
        if (DAILY[s]) out.data[s] = DAILY[s];
        else out.failed[s] = 'no data from Yahoo';
      });
      return out;
    }
  };
}

describe.each(STORE_FACTORIES)('scanner.daily job (%s)', (_name, makeStore) => {
  let store;
  let scanner;
  beforeEach(async () => {
    store = await makeStore();
    scanner = await initScannerStore(store);
  });
  afterEach(async () => {
    await store.close();
  });

  const afterClose = () => easternToUtc('2026-10-19 17:30'); // a Monday, after the close
  const quiet = { warn() {} };

  test('scans the universe after the close and stores the run', async () => {
    const fetchers = fakeFetchers();
    const handlers = createScannerJobHandlers({ store, scanner, fetchers, now: afterClose, pauseMs: 0, logger: quiet });
    const summary = await handlers['scanner.daily']({ minVolume: 0 });
    expect(fetchers.calls.universe).toBe(1);
    // only KO and TSLA of the 17-symbol fixture universe have charts
    expect(summary).toMatchObject({ runDate: '2026-10-19', universe: 17, fetched: 2, scanned: 2, partial: false, asOf: '2026-10-19' });
    const latest = await scanner.getLatestRun();
    expect(latest.universeSize).toBe(17);
    expect(latest.counts.failed).toBe(15);
    expect(latest.filters).toEqual({ minPrice: 5, minVolume: 0 });
    // a second call the same day is skipped
    expect(await handlers['scanner.daily']({})).toMatchObject({ skipped: 'already ran today' });
  });

  test('explicit symbols, scan.py liquidity defaults, before-the-open run with force', async () => {
    const fetchers = fakeFetchers();
    const handlers = createScannerJobHandlers({ store, scanner, fetchers, now: () => easternToUtc('2026-10-19 10:50'), pauseMs: 0, logger: quiet });
    expect(await handlers['scanner.daily']({ symbols: Object.keys(DAILY) })).toMatchObject({ skipped: 'before the US close' });
    const s = await handlers['scanner.daily']({ symbols: Object.keys(DAILY), force: true });
    expect(fetchers.calls.universe).toBe(0);
    expect(s).toMatchObject({ universe: 19, fetched: 19, scanned: 11, hits: 7, asOf: '2026-10-16' });
    const run = await scanner.getLatestRun();
    expect(run.results.map((h) => h.symbol).sort()).toEqual(['BAC', 'CCL', 'F', 'JPM', 'KO', 'RIVN', 'XOM']);
  });

  test('skips weekends and holidays', async () => {
    const handlers = createScannerJobHandlers({ store, scanner, fetchers: fakeFetchers(), now: () => easternToUtc('2026-11-26 18:00'), logger: quiet });
    expect(await handlers['scanner.daily']({})).toMatchObject({ skipped: 'not a trading day' });
  });

  test('time budget: stores a partial run with the flag', async () => {
    let t = 0;
    const fetchers = fakeFetchers({ onBatch: () => { t += 60000; } });
    const many = [...Object.keys(DAILY), ...Array.from({ length: 81 }, (_, i) => `Z${i}`)]; // 100 symbols, 5 batches
    const handlers = createScannerJobHandlers({ store, scanner, fetchers, now: afterClose, clock: () => t, pauseMs: 0, timeBudgetMs: 120000, logger: quiet });
    const s = await handlers['scanner.daily']({ symbols: many, minVolume: 0, minPrice: 0 });
    expect(s).toMatchObject({ partial: true, attempted: 40, universe: 100, fetched: 19 });
    expect(fetchers.calls.batches).toHaveLength(2);
    const run = await scanner.getLatestRun();
    expect(run.partial).toBe(true);
    expect(run.counts.attempted).toBe(40);
    // a partial run does not block a re-run the same day
    const again = await handlers['scanner.daily']({ symbols: ['KO'], minVolume: 0 });
    expect(again.partial).toBe(false);
  });

  test('nothing fetched -> throws (so the queue retries) and stores nothing', async () => {
    const fetchers = { fetchUniverse: async () => UNIVERSE, fetchSpark: async (b) => ({ data: {}, failed: Object.fromEntries(b.map((s) => [s, 'HTTP 429'])) }) };
    const handlers = createScannerJobHandlers({ store, scanner, fetchers, now: afterClose, pauseMs: 0, logger: quiet });
    await expect(handlers['scanner.daily']({})).rejects.toThrow(/no charts/);
    expect(await scanner.getLatestRun()).toBeNull();
  });
});
