/**
 * @jest-environment node
 */
// The trade simulator API with an injected bar fetcher (the recorded TSLA
// fixture from day-trader-skill) - never the network. The route has no store.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const express = require('express');
const { mountTradeSimRoutes } = require('./tradeSimRoutes');
const { fetchYahooIntraday5m, createBarCache } = require('./tradeSimData');
const { request, tokenFor, listen } = require('./testUtils/http');

const FIXTURE = path.join(__dirname, 'fixtures', 'trade-sim', 'TSLA-60d5m.json.gz');
const RESULT = JSON.parse(zlib.gunzipSync(fs.readFileSync(FIXTURE)).toString('utf8')).chart.result[0];
const AT_1015 = Date.UTC(2026, 9, 19, 14, 15); // 10:15 ET, right after the reel's entry bar closed

const BODY = {
  symbol: 'tsla',
  entry: 364.18,
  stop: { type: 'or_mid' },
  target: { type: 'r', value: 1 },
  account: 5000,
  maxLossPerTrade: 50,
  positionCapPct: 75,
  cashBufferPct: 10
};

describe('trade simulator API', () => {
  let server;
  let baseUrl;
  let fetchBars;
  let token;
  let clock;

  async function start(fetcher) {
    fetchBars = jest.fn(fetcher || (async () => RESULT));
    clock = AT_1015;
    const app = express();
    app.use(express.json());
    mountTradeSimRoutes(app, { fetchBars, now: () => clock });
    ({ server, baseUrl } = await listen(app));
  }

  beforeEach(async () => {
    token = tokenFor(`u-${Math.random().toString(36).slice(2)}`);
    await start();
  });
  afterEach(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  test('needs auth', async () => {
    expect((await request(baseUrl, 'POST', '/api/trade-sim', { body: BODY })).status).toBe(401);
    expect(fetchBars).not.toHaveBeenCalled();
  });

  test('the reel: plan, odds, history, sizing and coverage (same numbers as the Python tool), under the CPU budget', async () => {
    const t0 = Date.now();
    const res = await request(baseUrl, 'POST', '/api/trade-sim', { token, body: BODY });
    const wallMs = Date.now() - t0;
    expect(res.status).toBe(200);
    const b = res.body;
    expect(b.symbol).toBe('TSLA');
    expect(b.mode).toBe('live');
    expect(b.entryTime).toBe('10:15 AM');
    expect(b.plan).toMatchObject({ entry: 364.18, stop: 358.32, target: 370.04, risk: 5.86, rewardRisk: 1 });
    expect([b.sims, b.seed, b.barsLeft]).toEqual([10000, 19, 69]);
    expect(b.odds).toEqual({ target: 0.2938, stop: 0.2548, open: 0.4514, green: 0.5168 });
    expect(b.closeDistribution).toMatchObject({ median: 364.36, p5: 355.54, p95: 373.54 });
    expect(b.closeDistribution.hist.bins).toHaveLength(24);
    expect(b.avgR).toBe(0.034);
    expect(b.history).toMatchObject({ rule: 'orb', sessions: 59, triggered: 33, target: 13, stop: 15, open: 5, avgR: -0.062 });
    expect(b.sizing).toMatchObject({ qty: 8, boundBy: 'maxLoss', cost: 2913.44, maxLossAtStop: 46.88, refusal: null });
    expect(b.verdictCode).toBe('coin_flip');
    expect(b.coverage).toMatchObject({ sessions: 59, from: '2026-07-27', to: '2026-10-16', cached: false });
    expect(b.disclaimer).toMatch(/לא תחזית/);
    expect(fetchBars).toHaveBeenCalledWith('TSLA');
    // The CPU part (10,000 replays + history + sizing), measured by the route itself.
    expect(b.computeMs).toBeLessThan(2000);
    expect(wallMs).toBeLessThan(5000);
  });

  test('bars are cached per symbol for 5 minutes', async () => {
    await request(baseUrl, 'POST', '/api/trade-sim', { token, body: Object.assign({}, BODY, { sims: 500 }) });
    const second = await request(baseUrl, 'POST', '/api/trade-sim', { token, body: Object.assign({}, BODY, { sims: 500 }) });
    expect(second.body.coverage.cached).toBe(true);
    expect(fetchBars).toHaveBeenCalledTimes(1);
    clock += 6 * 60 * 1000;
    await request(baseUrl, 'POST', '/api/trade-sim', { token, body: Object.assign({}, BODY, { sims: 500 }) });
    expect(fetchBars).toHaveBeenCalledTimes(2);
  });

  test('refused plans come back as 400 with a Hebrew reason and a code', async () => {
    let res = await request(baseUrl, 'POST', '/api/trade-sim', { token, body: Object.assign({}, BODY, { stop: { type: 'price', value: 365 } }) });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('stop_above_entry');
    res = await request(baseUrl, 'POST', '/api/trade-sim', { token, body: Object.assign({}, BODY, { target: { type: 'price', value: 364 } }) });
    expect(res.body.code).toBe('target_below_entry');
    res = await request(baseUrl, 'POST', '/api/trade-sim', { token, body: Object.assign({}, BODY, { stop: { type: 'price', value: 364.1 } }) });
    expect(res.body.code).toBe('stop_too_tight');
    expect(res.body.error).toMatch(/spread/);
  });

  test('a stop too far for the max loss: the simulation runs, the sizing refuses', async () => {
    const res = await request(baseUrl, 'POST', '/api/trade-sim', { token, body: Object.assign({}, BODY, { stop: { type: 'pct', value: 20 }, sims: 500, maxLossPerTrade: 20 }) });
    expect(res.status).toBe(200);
    expect(res.body.sizing.qty).toBe(0);
    expect(res.body.sizing.refusalCode).toBe('stop_too_far');
  });

  test('shape validation', async () => {
    const bad = [
      { symbol: 'TEVA.TA!' },
      { symbol: '' },
      { stop: { type: 'nope' } },
      { stop: { type: 'pct' } },
      { target: { type: 'r' } },
      { account: 0 },
      { maxLossPerTrade: 'x' },
      { entry: -5 },
      { sims: 'many' }
    ];
    for (const over of bad) {
      const res = await request(baseUrl, 'POST', '/api/trade-sim', { token, body: Object.assign({}, BODY, over) });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/[֐-׿]/);
    }
    expect(fetchBars).not.toHaveBeenCalled();
    // sims above the cap are clamped to 10,000
    const res = await request(baseUrl, 'POST', '/api/trade-sim', { token, body: Object.assign({}, BODY, { sims: 50000 }) });
    expect(res.body.sims).toBe(10000);
  });

  test('rate limited to 10 a minute per user', async () => {
    const body = Object.assign({}, BODY, { symbol: '' }); // cheap: rejected after the limiter
    for (let i = 0; i < 10; i++) expect((await request(baseUrl, 'POST', '/api/trade-sim', { token, body })).status).toBe(400);
    const limited = await request(baseUrl, 'POST', '/api/trade-sim', { token, body });
    expect(limited.status).toBe(429);
    expect((await request(baseUrl, 'POST', '/api/trade-sim', { token: tokenFor('someone-else'), body })).status).toBe(400);
  });

  test('data errors: unknown ticker 404, Yahoo down 502', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    await new Promise((resolve) => server.close(resolve));
    await start(async (symbol) => {
      const err = new Error('x');
      err.code = symbol === 'ZZZZ' ? 'not_found' : 'upstream';
      throw err;
    });
    expect((await request(baseUrl, 'POST', '/api/trade-sim', { token, body: Object.assign({}, BODY, { symbol: 'ZZZZ' }) })).status).toBe(404);
    expect((await request(baseUrl, 'POST', '/api/trade-sim', { token, body: Object.assign({}, BODY, { symbol: 'AAPL' }) })).status).toBe(502);
    console.error.mockRestore();
  });
});

describe('Yahoo 5-minute fetcher (fake HTTP client)', () => {
  const ok = { data: { chart: { result: [RESULT], error: null } } };
  const httpError = (status) => Object.assign(new Error(`HTTP ${status}`), { response: { status } });

  test('one request: range=60d interval=5m on query2, with a timeout', async () => {
    const http = { get: jest.fn(async () => ok) };
    expect(await fetchYahooIntraday5m('brk.b', { http })).toBe(RESULT);
    const [url, opts] = http.get.mock.calls[0];
    expect(url).toBe('https://query2.finance.yahoo.com/v8/finance/chart/BRK-B');
    expect(opts.params).toMatchObject({ range: '60d', interval: '5m' });
    expect(opts.timeout).toBeGreaterThan(0);
  });

  test('429 / 5xx falls back to query1; 404 is not_found; both down is upstream', async () => {
    let http = { get: jest.fn().mockRejectedValueOnce(httpError(429)).mockResolvedValueOnce(ok) };
    expect(await fetchYahooIntraday5m('TSLA', { http })).toBe(RESULT);
    expect(http.get.mock.calls[1][0]).toContain('query1');
    http = { get: jest.fn().mockRejectedValue(httpError(404)) };
    await expect(fetchYahooIntraday5m('ZZZZ', { http })).rejects.toMatchObject({ code: 'not_found' });
    http = { get: jest.fn().mockRejectedValue(httpError(503)) };
    await expect(fetchYahooIntraday5m('TSLA', { http })).rejects.toMatchObject({ code: 'upstream' });
    expect(http.get).toHaveBeenCalledTimes(2);
    http = { get: jest.fn(async () => ({ data: { chart: { result: null, error: { description: 'No data found' } } } })) };
    await expect(fetchYahooIntraday5m('GONE', { http })).rejects.toMatchObject({ code: 'not_found' });
  });

  test('the cache shares one in-flight fetch', async () => {
    let release;
    const fetcher = jest.fn(() => new Promise((resolve) => (release = () => resolve(RESULT))));
    const cache = createBarCache({ fetcher });
    const a = cache.get('tsla');
    const b = cache.get('TSLA');
    release();
    expect((await a).data).toBe(RESULT);
    expect((await b).data).toBe(RESULT);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
