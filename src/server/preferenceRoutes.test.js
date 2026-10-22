/**
 * @jest-environment node
 */
const express = require('express');
const { initFeatureStore } = require('./featureStore');
const { mountPreferenceRoutes } = require('./preferenceRoutes');
const { request, tokenFor, listen } = require('./testUtils/http');
const { STORE_FACTORIES } = require('./testUtils/stores');

describe.each(STORE_FACTORIES)('preferences API (%s)', (_name, makeStore) => {
  let store;
  let server;
  let baseUrl;
  let token;

  beforeEach(async () => {
    store = await makeStore();
    const features = await initFeatureStore(store);
    const { id } = await store.insertUser('p@x.com', 'h');
    token = tokenFor(id);
    const app = express();
    app.use(express.json());
    mountPreferenceRoutes(app, { features });
    ({ server, baseUrl } = await listen(app));
  });
  afterEach(async () => {
    await new Promise((resolve) => server.close(resolve));
    await store.close();
  });

  test('round-trips validated recommendation prefs', async () => {
    expect((await request(baseUrl, 'GET', '/api/preferences/recommendations', { token })).body).toEqual({ value: null });
    const put = await request(baseUrl, 'PUT', '/api/preferences/recommendations', {
      token,
      body: { positionCapPct: 20, lotMethod: 'HIFO', usTaxResident: 1, enabledRules: ['drift', 'drift'], junk: 'x' }
    });
    expect(put.body.value).toEqual({ positionCapPct: 20, lotMethod: 'HIFO', usTaxResident: true, enabledRules: ['drift'] });
    expect((await request(baseUrl, 'GET', '/api/preferences/recommendations', { token })).body.value).toEqual(put.body.value);
  });

  test('round-trips and clears the review goal', async () => {
    const put = await request(baseUrl, 'PUT', '/api/preferences/goals', {
      token,
      body: { targetAmount: '500000', targetDate: '2030-01-01', label: 'דירה', junk: 1 }
    });
    expect(put.body.value).toEqual({ targetAmount: 500000, targetDate: '2030-01-01', label: 'דירה' });
    expect((await request(baseUrl, 'PUT', '/api/preferences/goals', { token, body: {} })).body.value).toEqual({});
    expect((await request(baseUrl, 'PUT', '/api/preferences/goals', { token, body: { targetAmount: 0, targetDate: '2030-01-01' } })).status).toBe(400);
    expect((await request(baseUrl, 'PUT', '/api/preferences/goals', { token, body: { targetAmount: 100, targetDate: '2030-13-45' } })).status).toBe(400);
  });

  test('keeps horizon and risk tolerance without a goal amount', async () => {
    const put = await request(baseUrl, 'PUT', '/api/preferences/goals', { token, body: { horizonYears: '10', riskTolerance: 'medium' } });
    expect(put.body.value).toEqual({ horizonYears: 10, riskTolerance: 'medium' });
    expect((await request(baseUrl, 'PUT', '/api/preferences/goals', { token, body: { riskTolerance: 'wild' } })).status).toBe(400);
  });

  test('round-trips holding details and rejects unknown values', async () => {
    const put = await request(baseUrl, 'PUT', '/api/preferences/holdingDetails', {
      token,
      body: {
        providentTracks: { 'pension:1': 'sp500' },
        fees: { 'pension:1': { annualPct: '0.5', depositPct: '' } },
        brokers: { 'american:VOO': ' IBI ' },
        assetClasses: { 'israeli:1159250': 'bond' },
        junk: 1
      }
    });
    expect(put.body.value).toEqual({
      providentTracks: { 'pension:1': 'sp500' },
      fees: { 'pension:1': { annualPct: 0.5 } },
      brokers: { 'american:VOO': 'IBI' },
      assetClasses: { 'israeli:1159250': 'bond' }
    });
    expect((await request(baseUrl, 'PUT', '/api/preferences/holdingDetails', { token, body: { assetClasses: { 'israeli:1': 'nope' } } })).status).toBe(400);
    expect((await request(baseUrl, 'PUT', '/api/preferences/holdingDetails', { token, body: { brokers: { 'bad key': 'x' } } })).status).toBe(400);
  });

  test('rejects bad values, unknown namespaces and anonymous users', async () => {
    expect((await request(baseUrl, 'PUT', '/api/preferences/recommendations', { token, body: { lotMethod: 'RANDOM' } })).status).toBe(400);
    expect((await request(baseUrl, 'PUT', '/api/preferences/recommendations', { token, body: { enabledRules: ['nope'] } })).status).toBe(400);
    expect((await request(baseUrl, 'PUT', '/api/preferences/recommendations', { token, body: { positionCapPct: 0 } })).status).toBe(400);
    expect((await request(baseUrl, 'GET', '/api/preferences/other', { token })).status).toBe(404);
    expect((await request(baseUrl, 'GET', '/api/preferences/recommendations')).status).toBe(401);
  });
});
