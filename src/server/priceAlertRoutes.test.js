/**
 * @jest-environment node
 */
const express = require('express');
const { initFeatureStore } = require('./featureStore');
const { mountAlertRoutes } = require('./alertRoutes');
const { request, tokenFor, listen } = require('./testUtils/http');
const { STORE_FACTORIES } = require('./testUtils/stores');

const marketData = {
  async getBars() {
    return [];
  },
  supportsCalendar: () => false
};

const priceQuotes = {
  async getQuote(market, symbol) {
    if (symbol === 'ZZZZ') return { price: null };
    if (symbol === 'DOWN') throw new Error('HTTP 503');
    if (market === 'TASE') return { price: 119.6, prevClose: 118, tradeDate: '2026-10-19' };
    return { price: 366.475, prevClose: 354.72, tradeDate: '2026-10-19' };
  }
};

describe.each(STORE_FACTORIES)('price alerts API (%s)', (_name, makeStore) => {
  let store;
  let features;
  let server;
  let baseUrl;
  let userId;
  let token;

  beforeEach(async () => {
    store = await makeStore();
    features = await initFeatureStore(store);
    ({ id: userId } = await store.insertUser('a@b.com', 'x'));
    token = tokenFor(userId);
    const app = express();
    app.use(express.json());
    mountAlertRoutes(app, { store, features, marketData, priceQuotes, now: () => new Date('2026-10-19T14:53:00Z') });
    ({ server, baseUrl } = await listen(app));
  });
  afterEach(async () => {
    await new Promise((resolve) => server.close(resolve));
    await store.close();
  });

  test('needs auth', async () => {
    expect((await request(baseUrl, 'GET', '/api/price-alerts')).status).toBe(401);
    expect((await request(baseUrl, 'POST', '/api/price-alerts', { body: {} })).status).toBe(401);
    expect((await request(baseUrl, 'DELETE', '/api/price-alerts/x')).status).toBe(401);
  });

  test('create, list, edit, re-arm, delete', async () => {
    let res = await request(baseUrl, 'POST', '/api/price-alerts', {
      token,
      body: { market: 'US', symbol: 'tsla', ruleType: 'pct_up', value: 3, note: 'מומנטום', name: 'Tesla' }
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ currentPrice: 366.475, alreadyMet: true });
    expect(res.body.rule).toMatchObject({ symbol: 'TSLA', market: 'US', ruleType: 'pct_up', value: 3, status: 'active', lastPrice: 366.475 });
    const id = res.body.rule.id;

    res = await request(baseUrl, 'POST', '/api/price-alerts', { token, body: { market: 'TASE', symbol: '629014', ruleType: 'below', value: 110 } });
    expect(res.status).toBe(201);
    expect(res.body.alreadyMet).toBe(false);

    // A failing source does not block the rule; it is priced by the job.
    res = await request(baseUrl, 'POST', '/api/price-alerts', { token, body: { market: 'US', symbol: 'DOWN', ruleType: 'above', value: 5 } });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ currentPrice: null, alreadyMet: null });

    res = await request(baseUrl, 'GET', '/api/price-alerts', { token });
    expect(res.body.max).toBe(50);
    expect(res.body.rules).toHaveLength(3);

    res = await request(baseUrl, 'PATCH', `/api/price-alerts/${id}`, { token, body: { value: 4, note: '' } });
    expect(res.status).toBe(200);
    expect(res.body.rule).toMatchObject({ value: 4, note: '', symbol: 'TSLA' });
    expect((await request(baseUrl, 'PATCH', `/api/price-alerts/${id}`, { token, body: { value: 400 } })).status).toBe(400);
    expect((await request(baseUrl, 'PATCH', `/api/price-alerts/${id}`, { token, body: { status: 'triggered' } })).status).toBe(400);

    await features.markPriceAlertTriggered(id, { price: 380 });
    res = await request(baseUrl, 'PATCH', `/api/price-alerts/${id}`, { token, body: { status: 'active' } });
    expect(res.body.rule).toMatchObject({ status: 'active', triggeredAt: null, armedAt: '2026-10-19T14:53:00.000Z' });

    const other = tokenFor((await store.insertUser('o@b.com', 'x')).id);
    expect((await request(baseUrl, 'PATCH', `/api/price-alerts/${id}`, { token: other, body: { value: 5 } })).status).toBe(404);
    expect((await request(baseUrl, 'DELETE', `/api/price-alerts/${id}`, { token: other })).status).toBe(404);
    expect((await request(baseUrl, 'GET', '/api/price-alerts', { token: other })).body.rules).toEqual([]);

    expect((await request(baseUrl, 'DELETE', `/api/price-alerts/${id}`, { token })).status).toBe(200);
    expect((await request(baseUrl, 'GET', '/api/price-alerts', { token })).body.rules).toHaveLength(2);
  });

  test('validation and limits, with Hebrew errors', async () => {
    let res = await request(baseUrl, 'POST', '/api/price-alerts', { token, body: { market: 'US', symbol: 'KO', ruleType: 'below', value: -1 } });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('יש להזין מחיר חיובי');
    res = await request(baseUrl, 'POST', '/api/price-alerts', { token, body: { market: 'US', symbol: 'ZZZZ', ruleType: 'above', value: 1 } });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/לא נמצא מחיר/);

    for (let i = 0; i < 50; i += 1) {
      await features.createPriceAlert({ userId, market: 'US', symbol: 'KO', ruleType: 'above', value: 100 + i });
    }
    res = await request(baseUrl, 'POST', '/api/price-alerts', { token, body: { market: 'US', symbol: 'KO', ruleType: 'above', value: 1 } });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/עד 50 התראות מחיר/);
  });
});
