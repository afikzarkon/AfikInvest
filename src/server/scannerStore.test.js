/** @jest-environment node */
const { initScannerStore, KEEP_RUNS } = require('./scannerStore');
const { STORE_FACTORIES } = require('./testUtils/stores');

describe.each(STORE_FACTORIES)('scanner store (%s)', (_name, makeStore) => {
  let store;
  let scanner;
  beforeEach(async () => {
    store = await makeStore();
    scanner = await initScannerStore(store);
    await initScannerStore(store); // idempotent schema
  });
  afterEach(async () => {
    await store.close();
  });

  const run = (i, extra = {}) => Object.assign({
    runDate: `2026-10-${String(i).padStart(2, '0')}`,
    asOf: `2026-10-${String(i).padStart(2, '0')}`,
    startedAt: `2026-10-${String(i).padStart(2, '0')}T21:40:00.000Z`,
    finishedAt: `2026-10-${String(i).padStart(2, '0')}T21:43:00.000Z`,
    universeSize: 5900,
    fetched: 5812,
    scanned: 1500,
    partial: false,
    counts: { bySetup: { breakout_20d: 1 } },
    filters: { minPrice: 5, minVolume: 1000000 },
    results: [{ symbol: 'KO', setups: ['breakout_20d'], close: 93.9 }]
  }, extra);

  test('empty, insert, latest with and without results', async () => {
    expect(await scanner.getLatestRun()).toBeNull();
    const id1 = await scanner.insertRun(run(1));
    const id2 = await scanner.insertRun(run(2, { partial: true, results: [] }));
    const latest = await scanner.getLatestRun();
    expect(latest).toMatchObject({ id: id2, runDate: '2026-10-02', partial: true, universeSize: 5900, fetched: 5812, scanned: 1500, results: [] });
    expect(latest.filters).toEqual({ minPrice: 5, minVolume: 1000000 });
    const meta = await scanner.getLatestRun({ withResults: false });
    expect(meta.results).toBeUndefined();
    const first = await scanner.getRun(id1);
    expect(first.results[0]).toEqual({ symbol: 'KO', setups: ['breakout_20d'], close: 93.9 });
    expect(first.partial).toBe(false);
  });

  test(`keeps only the last ${KEEP_RUNS} runs`, async () => {
    for (let i = 1; i <= KEEP_RUNS + 3; i += 1) await scanner.insertRun(run(i));
    const runs = await scanner.listRuns(50);
    expect(runs).toHaveLength(KEEP_RUNS);
    expect(runs[0].runDate).toBe(`2026-10-${KEEP_RUNS + 3}`);
    expect(runs[runs.length - 1].runDate).toBe('2026-10-04');
  });
});
