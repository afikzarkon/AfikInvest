/** @jest-environment node */
const express = require('express');
const { initScannerStore } = require('./scannerStore');
const { mountScannerRoutes } = require('./scannerRoutes');
const { request, tokenFor, listen } = require('./testUtils/http');
const { STORE_FACTORIES } = require('./testUtils/stores');

const RESULTS = [
  { symbol: 'KO', name: 'Coca-Cola', setups: ['breakout_20d'], close: 93.9, volume: 3680307, rsi: 75.3 },
  { symbol: 'BRK.B', name: 'Berkshire', setups: ['reclaim_ma20'], close: 480, volume: 4000000, rsi: 55 },
  { symbol: 'PLUG', name: 'Plug Power', setups: ['oversold', 'oversold_bounce'], close: 2.5, volume: 50000000, rsi: 21 },
  { symbol: 'CCL', name: 'Carnival', setups: ['bull_flag'], close: 30, volume: 900000, rsi: 60 }
];

describe.each(STORE_FACTORIES)('GET /api/scanner (%s)', (_name, makeStore) => {
  let store;
  let scanner;
  let server;
  let baseUrl;
  let token;

  beforeEach(async () => {
    store = await makeStore();
    scanner = await initScannerStore(store);
    const { id } = await store.insertUser('a@b.com', 'x');
    token = tokenFor(id);
    await store.upsertPortfolio(id, JSON.stringify({
      americanStocks: [
        { id: 1, stockName: 'ko', quantity: 10, exchangeRate: 3.5, purchasePrice: 60 },
        { id: 2, stockName: 'BRK-B', quantity: 1, exchangeRate: 3.5, purchasePrice: 400 }
      ]
    }));
    const app = express();
    app.use(express.json());
    mountScannerRoutes(app, { store, scanner });
    ({ server, baseUrl } = await listen(app));
  });
  afterEach(async () => {
    await new Promise((resolve) => server.close(resolve));
    await store.close();
  });

  test('needs auth; empty state before the first run', async () => {
    expect((await request(baseUrl, 'GET', '/api/scanner')).status).toBe(401);
    const res = await request(baseUrl, 'GET', '/api/scanner', { token });
    expect(res.status).toBe(200);
    expect(res.body.run).toBeNull();
    expect(res.body.results).toEqual([]);
    expect(res.body.counts.breakout_20d).toBe(0);
  });

  test('latest run with held flags, filters and per-setup counts', async () => {
    await scanner.insertRun({ runDate: '2026-10-16', startedAt: '2026-10-16T21:40:00Z', universeSize: 10, fetched: 9, scanned: 5, results: [] });
    await scanner.insertRun({ runDate: '2026-10-19', asOf: '2026-10-19', startedAt: '2026-10-19T21:40:00Z', universeSize: 5900, fetched: 5812, scanned: 1500, partial: true, filters: { minPrice: 5, minVolume: 1000000 }, results: RESULTS });
    let res = await request(baseUrl, 'GET', '/api/scanner', { token });
    expect(res.body.run).toMatchObject({ runDate: '2026-10-19', universeSize: 5900, fetched: 5812, partial: true });
    expect(res.body.run.results).toBeUndefined();
    expect(res.body.total).toBe(4);
    const held = Object.fromEntries(res.body.results.map((h) => [h.symbol, h.held]));
    expect(held).toEqual({ KO: true, 'BRK.B': true, PLUG: false, CCL: false });
    expect(res.body.counts).toEqual({ breakout_20d: 1, bull_flag: 1, reclaim_ma20: 1, oversold: 1, oversold_bounce: 1 });

    res = await request(baseUrl, 'GET', '/api/scanner?setup=oversold', { token });
    expect(res.body.results.map((h) => h.symbol)).toEqual(['PLUG']);
    expect(res.body.counts.breakout_20d).toBe(1); // tab counts ignore the setup filter

    res = await request(baseUrl, 'GET', '/api/scanner?minPrice=5&minVolume=1000000', { token });
    expect(res.body.results.map((h) => h.symbol)).toEqual(['KO', 'BRK.B']);
    expect(res.body.counts).toMatchObject({ oversold: 0, bull_flag: 0, breakout_20d: 1 });
    expect(res.body.filters).toEqual({ setup: null, minPrice: 5, minVolume: 1000000 });
  });

  test('rejects a bad setup or floor', async () => {
    expect((await request(baseUrl, 'GET', '/api/scanner?setup=moon', { token })).status).toBe(400);
    expect((await request(baseUrl, 'GET', '/api/scanner?minPrice=-1', { token })).status).toBe(400);
    expect((await request(baseUrl, 'GET', '/api/scanner?minVolume=abc', { token })).status).toBe(400);
  });
});
