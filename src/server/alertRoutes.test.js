/**
 * @jest-environment node
 */
const express = require('express');
const { initFeatureStore } = require('./featureStore');
const { mountAlertRoutes } = require('./alertRoutes');
const { mountInternalJobRoutes } = require('./internalJobRoutes');
const { createJobRunner } = require('./jobRunner');
const { createJobHandlers } = require('./jobs');
const { request, tokenFor, listen } = require('./testUtils/http');
const { STORE_FACTORIES } = require('./testUtils/stores');

const marketData = {
  async getBars() {
    return [];
  },
  supportsCalendar: () => false,
  async getCalendar() {
    return null;
  },
  async getDividendHistory() {
    return [];
  }
};

describe.each(STORE_FACTORIES)('alerts + internal jobs API (%s)', (_name, makeStore) => {
  let store;
  let features;
  let server;
  let baseUrl;
  let userId;
  let token;
  let secret;

  beforeEach(async () => {
    store = await makeStore();
    features = await initFeatureStore(store);
    ({ id: userId } = await store.insertUser('a@b.com', 'x'));
    token = tokenFor(userId);
    await store.upsertPortfolio(userId, JSON.stringify({ americanStocks: [{ id: 1, stockName: 'KO', quantity: 100, exchangeRate: 3.5, purchaseDate: '2025-01-01', purchasePrice: 60 }] }));
    secret = 's3cret';
    const app = express();
    app.use(express.json());
    const runner = createJobRunner({ features, handlers: createJobHandlers({ store, features, marketData }), logger: { error() {} } });
    mountAlertRoutes(app, { store, features, marketData, now: () => new Date('2026-03-01T12:00:00Z') });
    mountInternalJobRoutes(app, { features, runner, getSecret: () => secret, now: () => new Date('2026-03-01T12:00:00Z') });
    ({ server, baseUrl } = await listen(app));
  });
  afterEach(async () => {
    await new Promise((resolve) => server.close(resolve));
    await store.close();
  });

  test('alerts need auth; list, unread count and read state', async () => {
    expect((await request(baseUrl, 'GET', '/api/alerts')).status).toBe(401);
    await features.insertAlert({ userId, type: 'PRICE_ANOMALY', severity: 'warning', instrument: { symbol: 'KO', market: 'US' }, title: 'KO', message: 'm', dedupKey: 'k1' });
    await features.insertAlert({ userId, type: 'VOLUME_ANOMALY', severity: 'info', instrument: { symbol: 'KO', market: 'US' }, title: 'KO2', message: 'm', dedupKey: 'k2' });
    let res = await request(baseUrl, 'GET', '/api/alerts', { token });
    expect(res.body.unreadCount).toBe(2);
    expect(res.body.alerts).toHaveLength(2);
    expect((await request(baseUrl, 'POST', `/api/alerts/${res.body.alerts[0].id}/read`, { token })).status).toBe(200);
    expect((await request(baseUrl, 'POST', '/api/alerts/nope/read', { token })).status).toBe(404);
    res = await request(baseUrl, 'GET', '/api/alerts?unread=1', { token });
    expect(res.body.alerts).toHaveLength(1);
    await request(baseUrl, 'POST', '/api/alerts/read-all', { token });
    expect((await request(baseUrl, 'GET', '/api/alerts', { token })).body.unreadCount).toBe(0);
    // another user sees nothing
    const { id: other } = await store.insertUser('o@b.com', 'x');
    expect((await request(baseUrl, 'GET', '/api/alerts', { token: tokenFor(other) })).body.alerts).toEqual([]);
  });

  test('settings: defaults, validated update', async () => {
    const res = await request(baseUrl, 'GET', '/api/alert-settings', { token });
    expect(res.body.settings).toMatchObject({ enabled: true, pctMove: 5, volWarn: 2, volCritical: 3 });
    expect((await request(baseUrl, 'PUT', '/api/alert-settings', { token, body: { pctMove: 99 } })).status).toBe(400);
    const ok = await request(baseUrl, 'PUT', '/api/alert-settings', { token, body: { pctMove: 3.5, eventReminders: false } });
    expect(ok.body.settings).toMatchObject({ pctMove: 3.5, eventReminders: false, enabled: true });
    expect((await request(baseUrl, 'GET', '/api/alert-settings', { token })).body.settings.pctMove).toBe(3.5);
  });

  test('calendar lists only the user holdings with expected payout', async () => {
    await features.upsertMarketEvents([
      { symbol: 'KO', market: 'US', eventType: 'EX_DIVIDEND', eventDate: '2026-03-10', amountPerShare: 0.5, currency: 'USD', status: 'confirmed', source: 'yahoo' },
      { symbol: 'PEP', market: 'US', eventType: 'EX_DIVIDEND', eventDate: '2026-03-10', amountPerShare: 1, currency: 'USD', status: 'confirmed', source: 'yahoo' }
    ]);
    const res = await request(baseUrl, 'GET', '/api/calendar?from=2026-03-01&to=2026-04-01', { token });
    expect(res.body.events).toHaveLength(1);
    expect(res.body.events[0]).toMatchObject({ symbol: 'KO', units: 100, expectedGross: 50, expectedGrossILS: 175 });
    expect((await request(baseUrl, 'GET', '/api/calendar?from=2026-05-01&to=2026-04-01', { token })).status).toBe(400);
  });

  test('refresh is rate limited per user', async () => {
    expect((await request(baseUrl, 'POST', '/api/alerts/refresh', { token })).status).toBe(200);
    expect((await request(baseUrl, 'POST', '/api/alerts/refresh', { token })).status).toBe(429);
  });

  test('internal jobs: secret required, daily idempotency, runs handlers', async () => {
    expect((await request(baseUrl, 'POST', '/api/internal/jobs/anomaly.scan')).status).toBe(401);
    expect((await request(baseUrl, 'POST', '/api/internal/jobs/nope', { body: {} })).status).toBe(401);
    const call = (name, query = '') =>
      new Promise((resolve, reject) => {
        const http = require('http');
        const req = http.request(`${baseUrl}/api/internal/jobs/${name}${query}`, { method: 'POST', agent: false, headers: { 'X-Cron-Secret': secret, 'Content-Type': 'application/json' } }, (res) => {
          let raw = '';
          res.on('data', (c) => {
            raw += c;
          });
          res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(raw) }));
        });
        req.on('error', reject);
        req.end('{}');
      });
    const first = await call('anomaly.scan');
    expect(first.status).toBe(200);
    expect(first.body.results).toEqual([expect.objectContaining({ name: 'anomaly.scan', status: 'done' })]);
    expect(first.body.results[0].result).toMatchObject({ securities: 1 });
    const second = await call('anomaly.scan');
    expect(second.body.enqueued.id).toBe(first.body.enqueued.id); // same day -> same job, not re-run
    expect(second.body.results).toEqual([]);
    const forced = await call('anomaly.scan', '?force=1');
    expect(forced.body.results).toHaveLength(1);
    expect((await call('unknown')).status).toBe(404);
    secret = '';
    expect((await call('drain')).status).toBe(503);
  });
});
