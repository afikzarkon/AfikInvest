/**
 * @jest-environment node
 */
const express = require('express');
const { initFeatureStore } = require('./featureStore');
const { initCongressStore } = require('./congressStore');
const { mountCongressRoutes } = require('./congressRoutes');
const { PTR_URL } = require('./congressService');
const { request, tokenFor, listen } = require('./testUtils/http');
const { STORE_FACTORIES } = require('./testUtils/stores');

const filing = (docId, last, filed) => ({ docId, year: 2026, name: `Hon. ${last}`, first: 'X', last, district: 'CA11', filed, url: PTR_URL(2026, docId) });
const row = (ticker, date) => ({ owner: 'SP', ownerName: 'spouse', asset: `${ticker} Inc`, ticker, assetType: 'ST', type: 'P', typeName: 'purchase', date, amount: '$1,001 - $15,000', amountLow: 1001, amountHigh: 15000, daysToDisclose: 20, late: false });

describe.each(STORE_FACTORIES)('congress API (%s)', (_name, makeStore) => {
  let store;
  let congress;
  let server;
  let baseUrl;
  let token;
  let userId;
  let fetchers;

  beforeEach(async () => {
    store = await makeStore();
    const features = await initFeatureStore(store);
    congress = await initCongressStore(store);
    ({ id: userId } = await store.insertUser('a@b.com', 'x'));
    token = tokenFor(userId);
    await store.upsertPortfolio(userId, JSON.stringify({ americanStocks: [{ stockName: 'nvda', quantity: 3, purchasePrice: 100, exchangeRate: 3.7, purchaseDate: '2026-01-01' }] }));
    await congress.insertFilings([filing('1', 'Pelosi', '2026-10-02'), filing('2', 'Gottheimer', '2026-10-07'), filing('3', 'Old', '2026-03-01'), filing('4', 'Scan', '2026-10-05')]);
    await congress.saveParseResult('1', { status: 'parsed', rows: [row('NVDA', '2026-09-20'), row('AAPL', '2026-09-21')] });
    await congress.saveParseResult('2', { status: 'parsed', rows: [row('MSFT', '2026-09-15')] });
    await congress.saveParseResult('3', { status: 'parsed', rows: [row('NVDA', '2026-02-01')] });
    await congress.saveParseResult('4', { status: 'no_text', rows: [] });
    await congress.setMeta('last-scan-at', '2026-10-13T10:00:00.000Z');

    fetchers = {
      fetchIndexZip: jest.fn(async () => ({ notModified: true })),
      fetchPdf: jest.fn(async () => {
        throw new Error('unused');
      })
    };
    const app = express();
    app.use(express.json());
    mountCongressRoutes(app, { store, features, congress, fetchers, now: () => new Date('2026-10-13T12:00:00Z'), scanOptions: { sleep: async () => {} } });
    ({ server, baseUrl } = await listen(app));
  });
  afterEach(async () => {
    await new Promise((resolve) => server.close(resolve));
    await store.close();
  });

  test('needs auth; newest first within the window, with held tickers', async () => {
    expect((await request(baseUrl, 'GET', '/api/congress')).status).toBe(401);
    const res = await request(baseUrl, 'GET', '/api/congress', { token });
    expect(res.status).toBe(200);
    expect(res.body.days).toBe(90);
    expect(res.body.filings.map((f) => f.docId)).toEqual(['2', '4', '1']);
    expect(res.body.filings[1]).toMatchObject({ parseStatus: 'no_text', needsManualRead: true, rows: [], pdfUrl: PTR_URL(2026, '4') });
    expect(res.body.filings[2].rows).toHaveLength(2);
    expect(res.body.heldTickers).toEqual([{ ticker: 'NVDA', name: 'NVDA Inc', trades: 1, lastTradeDate: '2026-09-20', members: ['Hon. Pelosi'] }]);
    expect(res.body.lastScanAt).toBe('2026-10-13T10:00:00.000Z');
  });

  test('filters: member, ticker, days', async () => {
    let res = await request(baseUrl, 'GET', '/api/congress?member=pelosi', { token });
    expect(res.body.filings.map((f) => f.docId)).toEqual(['1']);
    res = await request(baseUrl, 'GET', '/api/congress?ticker=msft', { token });
    expect(res.body.filings.map((f) => f.docId)).toEqual(['2']);
    res = await request(baseUrl, 'GET', '/api/congress?days=365&ticker=NVDA', { token });
    expect(res.body.filings.map((f) => f.docId)).toEqual(['1', '3']);
    expect(res.body.heldTickers[0].trades).toBe(2);
    res = await request(baseUrl, 'GET', '/api/congress?days=bogus', { token });
    expect(res.body.days).toBe(90);
  });

  test('manual refresh runs a scan, then is rate limited', async () => {
    const first = await request(baseUrl, 'POST', '/api/congress/refresh', { token });
    expect(first.status).toBe(200);
    expect(first.body.scan).toMatchObject({ notModified: [2026], parsed: 0 });
    expect(fetchers.fetchIndexZip).toHaveBeenCalledTimes(1);
    const second = await request(baseUrl, 'POST', '/api/congress/refresh', { token });
    expect(second.status).toBe(429);
    expect(second.body.error).toMatch(/30/);
  });
});
