/**
 * @jest-environment node
 */
const http = require('http');
const express = require('express');
const { initFeatureStore } = require('./featureStore');
const { mountMonthlySyncRoutes } = require('./monthlySyncRoutes');
const { mountPortfolioRoutes } = require('./portfolioRoutes');
const { createReportService } = require('./report/reportService');
const { createMemoryStorage } = require('./report/reportStorage');
const { request, tokenFor, listen } = require('./testUtils/http');
const { STORE_FACTORIES } = require('./testUtils/stores');

function getRaw(url, token) {
  return new Promise((resolve, reject) => {
    http
      .get(url, { agent: false, headers: { Authorization: `Bearer ${token}` } }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      })
      .on('error', reject);
  });
}

describe.each(STORE_FACTORIES)('monthly sync + reports API (%s)', (_name, makeStore) => {
  let store;
  let features;
  let service;
  let server;
  let baseUrl;
  let token;
  let userId;
  const clock = () => new Date('2026-09-05T08:00:00Z');

  beforeEach(async () => {
    store = await makeStore();
    features = await initFeatureStore(store);
    service = createReportService({
      store,
      features,
      storage: createMemoryStorage(),
      renderer: { render: async () => Buffer.from('%PDF-1.7 test') },
      now: clock,
      logger: { error() {} }
    });
    ({ id: userId } = await store.insertUser('m@x.com', 'h'));
    token = tokenFor(userId);
    const app = express();
    app.use(express.json());
    let resolveSaved;
    app.locals.saved = new Promise((r) => {
      resolveSaved = r;
    });
    mountPortfolioRoutes(app, store, { onSaved: (id) => service.onPortfolioSaved(id).then(resolveSaved) });
    mountMonthlySyncRoutes(app, { reports: service, features, now: clock });
    ({ server, baseUrl } = await listen(app));
    server.app = app;
  });
  afterEach(async () => {
    await new Promise((resolve) => server.close(resolve));
    await store.close();
  });

  test('saving the portfolio drives the sync; complete + render + download', async () => {
    const body = {
      pensionFunds: [{ id: 5, fundName: 'גמל', currentValue: 1000, currentValueDate: '2026-07-01' }],
      bankBalances: [{ id: 6, amount: 500, currentValueDate: '2026-09-01' }]
    };
    expect((await request(baseUrl, 'PUT', '/api/portfolio', { token, body })).status).toBe(200);
    await server.app.locals.saved;

    let status = (await request(baseUrl, 'GET', '/api/monthly-sync', { token })).body;
    expect(status).toMatchObject({ month: '2026-08', state: 'IN_PROGRESS', requiredCount: 2, updatedCount: 1, pendingReport: null });

    const done = await request(baseUrl, 'POST', '/api/monthly-sync/2026-08/complete', { token });
    expect(done.status).toBe(200);
    expect(done.body.status).toMatchObject({ state: 'COMPLETE', completedBy: 'user', pendingReport: { version: 1, status: 'queued' } });
    expect(done.body.snapshot).toBe('created');

    // Run the job directly (the runner/queue is covered elsewhere).
    await service.renderReport({ userId, month: '2026-08', version: 1 });
    const list = (await request(baseUrl, 'GET', '/api/reports', { token })).body.reports;
    expect(list).toEqual([expect.objectContaining({ month: '2026-08', version: 1, status: 'ready' })]);

    const pdf = await getRaw(`${baseUrl}/api/reports/${list[0].id}/download`, token);
    expect(pdf.status).toBe(200);
    expect(pdf.headers['content-type']).toBe('application/pdf');
    expect(pdf.headers['content-disposition']).toContain('stockview-report-2026-08-v1.pdf');
    expect(pdf.body.toString()).toMatch(/^%PDF/);

    const { id: other } = await store.insertUser('o@x.com', 'h');
    expect((await getRaw(`${baseUrl}/api/reports/${list[0].id}/download`, tokenFor(other))).status).toBe(404);
  });

  test('validation: month format, future months, excluded keys, regenerate before complete', async () => {
    expect((await request(baseUrl, 'GET', '/api/monthly-sync?month=2026-13', { token })).status).toBe(400);
    expect((await request(baseUrl, 'POST', '/api/monthly-sync/2027-01/complete', { token })).status).toBe(400);
    expect((await request(baseUrl, 'PUT', '/api/monthly-sync/2026-08/excluded', { token, body: { keys: 'x' } })).status).toBe(400);
    const ex = await request(baseUrl, 'PUT', '/api/monthly-sync/2026-08/excluded', { token, body: { keys: ['pension:5'] } });
    expect(ex.status).toBe(200);
    expect((await request(baseUrl, 'POST', '/api/monthly-sync/2026-08/regenerate', { token })).status).toBe(409);
    expect((await request(baseUrl, 'GET', '/api/reports')).status).toBe(401);
  });
});
