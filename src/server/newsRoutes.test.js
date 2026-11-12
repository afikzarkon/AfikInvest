/**
 * @jest-environment node
 */
const fs = require('fs');
const path = require('path');
const express = require('express');
const { initFeatureStore } = require('./featureStore');
const { mountNewsRoutes } = require('./newsRoutes');
const { createNewsJobHandlers } = require('./newsJobs');
const { createNewsService } = require('./newsService');
const { request, tokenFor, listen } = require('./testUtils/http');
const { STORE_FACTORIES } = require('./testUtils/stores');

const DIR = path.join(__dirname, 'fixtures', 'news');
const raw = (name) => fs.readFileSync(path.join(DIR, name));

function makeFetchers() {
  const calls = { yahoo: [], sec: [] };
  return {
    calls,
    fetchers: {
      async yahooRss(symbol) {
        calls.yahoo.push(symbol);
        const file = path.join(DIR, `yahoo-${symbol}.xml`);
        if (!fs.existsSync(file)) throw new Error('HTTP 404');
        return fs.readFileSync(file, 'utf8');
      },
      async secAtom(cik, form) {
        calls.sec.push(cik);
        return raw(`sec-${form}-${cik}.xml`).toString('latin1');
      },
      async companyTickers() {
        return raw('company_tickers.json').toString('utf8');
      }
    }
  };
}

const lot = (stockName, extra = {}) => Object.assign({ id: stockName, stockName, quantity: 10, exchangeRate: 3.6, purchaseDate: '2025-01-01', purchasePrice: 100 }, extra);

describe.each(STORE_FACTORIES)('news API + news.scan job (%s)', (_name, makeStore) => {
  let store;
  let features;
  let server;
  let baseUrl;
  let userId;
  let token;
  let calls;
  let ua;

  const NOW = new Date('2026-10-14T00:00:00Z');

  beforeEach(async () => {
    store = await makeStore();
    features = await initFeatureStore(store);
    ({ id: userId } = await store.insertUser('a@b.com', 'x'));
    token = tokenFor(userId);
    await store.upsertPortfolio(
      userId,
      JSON.stringify({
        americanStocks: [lot('aapl', { officialName: 'Apple Inc.' }), lot('KO', { officialName: 'The Coca-Cola Company' })],
        israeliStocks: [{ id: 't1', stockName: '1081124', officialName: 'אלביט מערכות', quantity: 5, purchasePrice: 1000 }]
      })
    );
    ua = 'Test test@example.org';
    const f = makeFetchers();
    calls = f.calls;
    const newsService = createNewsService({ fetchers: f.fetchers, secUserAgent: () => ua, secGapMs: 0 });
    const app = express();
    app.use(express.json());
    mountNewsRoutes(app, { store, features, newsService, now: () => NOW });
    ({ server, baseUrl } = await listen(app));
  });
  afterEach(async () => {
    await new Promise((resolve) => server.close(resolve));
    await store.close();
  });

  test('needs auth', async () => {
    expect((await request(baseUrl, 'GET', '/api/news')).status).toBe(401);
  });

  test("news for the user's US holdings, TASE listed as unsupported", async () => {
    const res = await request(baseUrl, 'GET', '/api/news?hours=2160', { token });
    expect(res.status).toBe(200);
    expect(res.body.symbols).toEqual(['AAPL', 'KO']);
    expect(res.body.secConfigured).toBe(true);
    expect(res.body.unsupported).toEqual([{ symbol: '1081124', market: 'TASE', name: 'אלביט מערכות' }]);
    const sources = new Set(res.body.items.map((i) => i.source));
    expect(sources).toEqual(new Set(['yahoo', 'sec']));
    const times = res.body.items.map((i) => i.time);
    expect(times).toEqual([...times].sort().reverse());
    const earn = res.body.items.find((i) => i.id === 'sec:0000320193-26-000018');
    expect(earn.tags[0]).toBe('earnings');
    expect(earn.itemLabels).toEqual(['תוצאות כספיות']);
  });

  test('?hours narrows the window; ?symbols limits and validates', async () => {
    let res = await request(baseUrl, 'GET', '/api/news?hours=24', { token });
    expect(res.body.items).toHaveLength(10);
    expect(res.body.hours).toBe(24);
    res = await request(baseUrl, 'GET', '/api/news?symbols=ko&hours=24', { token });
    expect(res.body.symbols).toEqual(['KO']);
    expect(res.body.items).toHaveLength(4);
    expect((await request(baseUrl, 'GET', '/api/news?symbols=;;,!!', { token })).status).toBe(400);
    const many = Array.from({ length: 30 }, (_, i) => `T${String.fromCharCode(65 + (i % 26))}${i}`).join(',');
    res = await request(baseUrl, 'GET', `/api/news?symbols=${many}`, { token });
    expect(res.body.symbols).toHaveLength(25);
    expect(res.body.truncated).toBe(true);
    expect(res.body.errors.every((e) => e.message === undefined)).toBe(true);
  });

  test('without SEC_USER_AGENT: headlines only, secConfigured false', async () => {
    ua = '';
    const res = await request(baseUrl, 'GET', '/api/news?hours=2160', { token });
    expect(res.body.secConfigured).toBe(false);
    expect(res.body.items.every((i) => i.source === 'yahoo')).toBe(true);
    expect(calls.sec).toHaveLength(0);
  });

  test('TASE-only portfolio: no symbols, unsupported listed', async () => {
    const { id: other } = await store.insertUser('t@b.com', 'x');
    await store.upsertPortfolio(other, JSON.stringify({ israeliStocks: [{ id: 1, stockName: '1081124', quantity: 1, purchasePrice: 10 }] }));
    const res = await request(baseUrl, 'GET', '/api/news', { token: tokenFor(other) });
    expect(res.body).toMatchObject({ items: [], symbols: [], secConfigured: true });
    expect(res.body.unsupported).toHaveLength(1);
    expect(calls.yahoo).toHaveLength(0);
  });

  describe('news.scan', () => {
    const scanAt = (iso, extra = {}) => {
      const f = makeFetchers();
      const handlers = createNewsJobHandlers({
        store,
        features,
        newsService: createNewsService({ fetchers: f.fetchers, secUserAgent: () => ua, secGapMs: 0 }),
        now: () => new Date(iso),
        ...extra
      });
      return { run: (payload) => handlers['news.scan'](payload), calls: f.calls };
    };

    test('one alert per holder per material filing, once', async () => {
      const { id: second } = await store.insertUser('c@b.com', 'x');
      await store.upsertPortfolio(second, JSON.stringify({ americanStocks: [lot('AAPL')] }));
      // the day after Apple's earnings 8-K (2026-07-30 20:30 UTC)
      const { run, calls: c } = scanAt('2026-07-31T12:00:00Z');
      const summary = await run({});
      expect(summary).toMatchObject({ securities: 2, scanned: 2, filings: 1, alertsCreated: 2, skipped: null });
      expect(c.sec.sort()).toEqual(['0000021344', '0000320193']);
      const [alert] = await features.listAlerts(userId);
      expect(alert).toMatchObject({
        type: 'NEWS_FILING',
        severity: 'info',
        sessionDate: '2026-07-30',
        instrument: { symbol: 'AAPL', market: 'US' },
        dedupKey: `${userId}:NEWS_FILING:0000320193-26-000018`
      });
      expect(alert.title).toContain('תוצאות כספיות');
      expect(alert.link).toContain('000032019326000018');
      expect(await features.listAlerts(second)).toHaveLength(1);
      // re-run: deduped
      expect((await run({})).alertsCreated).toBe(0);
    });

    test('officer change is a warning; 8.01 does not alert', async () => {
      // AAPL 8-K/A item 5.02 filed 2026-09-01 20:30 UTC
      expect((await scanAt('2026-09-02T10:00:00Z').run({})).alertsCreated).toBe(1);
      const [alert] = await features.listAlerts(userId);
      expect(alert.severity).toBe('warning');
      // KO item 8.01 filed 2026-07-16 20:20 UTC
      expect((await scanAt('2026-07-17T10:00:00Z').run({})).alertsCreated).toBe(0);
    });

    test('skips cleanly without SEC_USER_AGENT; userIds payload limits the scan', async () => {
      ua = '';
      const off = await scanAt('2026-07-31T12:00:00Z').run({});
      expect(off.skipped).toMatch(/SEC_USER_AGENT/);
      ua = 'Test test@example.org';
      const none = await scanAt('2026-07-31T12:00:00Z').run({ userIds: ['nobody'] });
      expect(none).toMatchObject({ securities: 0, alertsCreated: 0 });
    });
  });
});
