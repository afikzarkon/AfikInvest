/**
 * @jest-environment node
 */
const express = require('express');
const { request, tokenFor, listen } = require('./testUtils/http');
const { mountMarketDataGate, MARKET_DATA_PATHS } = require('./marketDataAccess');

describe('market data gate', () => {
  let server;
  let baseUrl;

  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    mountMarketDataGate(app, { max: 3 });
    // Stand-ins for the real routes: the gate is what is under test.
    app.get('/api/israeli-stock/:id', (req, res) => res.json({ ok: true }));
    app.post('/api/israeli-stocks', (req, res) => res.json({ ok: true }));
    app.get('/api/cpi/latest', (req, res) => res.json({ ok: true }));
    app.get('/api/health', (req, res) => res.json({ ok: true }));
    ({ server, baseUrl } = await listen(app));
  });

  afterAll(() => new Promise((resolve) => server.close(resolve)));

  test('refuses market data without a session', async () => {
    expect((await request(baseUrl, 'GET', '/api/israeli-stock/629014')).status).toBe(401);
    expect((await request(baseUrl, 'POST', '/api/israeli-stocks', { body: { ids: ['629014'] } })).status).toBe(401);
    expect((await request(baseUrl, 'GET', '/api/cpi/latest')).status).toBe(401);
  });

  test('leaves routes outside the list alone', async () => {
    expect((await request(baseUrl, 'GET', '/api/health')).status).toBe(200);
  });

  test('serves a signed-in user, up to the per-user rate', async () => {
    const token = tokenFor(41);
    for (let i = 0; i < 3; i += 1) {
      expect((await request(baseUrl, 'GET', '/api/israeli-stock/629014', { token })).status).toBe(200);
    }
    const limited = await request(baseUrl, 'GET', '/api/israeli-stock/629014', { token });
    expect(limited.status).toBe(429);
    expect(limited.headers['retry-after']).toBeDefined();
    // Counted per user: another user is unaffected.
    expect((await request(baseUrl, 'GET', '/api/israeli-stock/629014', { token: tokenFor(42) })).status).toBe(200);
  });

  test('every market route the server mounts is covered', () => {
    // A path below a listed one is covered by app.use(); a longer name is not.
    const covered = (p) => MARKET_DATA_PATHS.some((base) => p === base || p.startsWith(`${base}/`));
    [
      '/api/israeli-stock/1',
      '/api/israeli-stocks',
      '/api/israeli-security/1',
      '/api/israeli-stock-search',
      '/api/israeli-stocks-history',
      '/api/american-stock/AAPL',
      '/api/american-stocks',
      '/api/american-stocks-history',
      '/api/stock-search',
      '/api/exchange-rate',
      '/api/exchange-rate/2026-01-01',
      '/api/exchange-rate-history',
      '/api/benchmark-history/sp500',
      '/api/stock-sectors',
      '/api/analyst-recommendations',
      '/api/dividend-data',
      '/api/cpi/months',
      '/api/valuation/AAPL/dcf'
    ].forEach((p) => expect([p, covered(p)]).toEqual([p, true]));
  });
});
