/**
 * @jest-environment node
 */
// taseScraper.js pulls in puppeteer, which (via undici) needs Web Streams
// globals Jest doesn't provide by default. Since these tests are about
// route wiring and the order of the quote source chain, not any one
// source's internals (each has its own test file), every source module is
// mocked rather than fighting the dependency chain.
jest.mock('./taseScraper', () => ({
  readCachedTaseQuote: jest.fn(),
  readStaleTaseQuote: jest.fn(),
  writeCachedTaseQuote: jest.fn(),
  isUsableTasePayload: jest.fn(),
  scrapeTaseQuote: jest.fn()
}));
jest.mock('./taseQuoteApi', () => ({
  fetchTaseQuoteFromApi: jest.fn()
}));
jest.mock('./taseHistoryApi', () => ({
  fetchTaseQuoteFromEod: jest.fn()
}));
jest.mock('./yahooQuotes', () => ({
  getYahooPayload: jest.fn(),
  fetchYahooHistoricalRateForDate: jest.fn()
}));
jest.mock('./bizportalSearch', () => ({
  searchIsraeliSecuritiesByName: jest.fn()
}));
jest.mock('./taseSecurityLookup', () => ({
  fetchTaseSecurityMeta: jest.fn(),
  // Not mocked away - the real predicate is what decides whether a query
  // is a security number, and that decision is the behavior under test.
  isSecurityIdQuery: (q) => /^\d{3,9}$/.test(String(q || '').trim())
}));

const http = require('http');
const express = require('express');
const { mountQuotesRoutes, resetPuppeteerBreaker, resetSecurityMetaCache } = require('./quotesRoutes');
const taseScraper = require('./taseScraper');
const taseQuoteApi = require('./taseQuoteApi');
const taseHistoryApi = require('./taseHistoryApi');
const yahooQuotes = require('./yahooQuotes');
const { marketMemory } = require('./marketMemory');

// A stand-in for the market_reference table: rows keyed like the real one.
function fakeSql(rows = {}) {
  return {
    get: jest.fn(async (text, [key]) => (rows[key] ? { value: JSON.stringify(rows[key].value), updated_at: rows[key].updatedAt } : null)),
    run: jest.fn(async () => ({ changes: 1, rows: [] }))
  };
}
const bizportalSearch = require('./bizportalSearch');
const taseSecurityLookup = require('./taseSecurityLookup');

// Jest's node test environment doesn't expose global fetch, so use Node's
// built-in http module for these requests instead of adding a dependency.
function get(url) {
  return new Promise((resolve, reject) => {
    http.get(url, { agent: false }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        let body = null;
        try {
          body = JSON.parse(data);
        } catch {
          body = null;
        }
        resolve({ status: res.statusCode, body });
      });
    }).on('error', reject);
  });
}

function post(url, payload) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload);
    const req = http.request(
      url,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
      },
      (res) => {
        let body = '';
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => {
          let parsed = null;
          try { parsed = JSON.parse(body); } catch { parsed = null; }
          resolve({ status: res.statusCode, body: parsed });
        });
      }
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

// A source that reports no session date gets one from the weekday calendar
// (see marketCalendar.js) - which date depends on when the test runs.
const ANY_ISO_DATE = expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/);

describe('quotesRoutes', () => {
  let app;
  let server;
  let baseUrl;

  beforeAll((done) => {
    app = express();
    app.use(express.json());
    mountQuotesRoutes(app);
    server = app.listen(0, () => {
      baseUrl = `http://localhost:${server.address().port}`;
      done();
    });
  });

  afterAll((done) => {
    server.close(done);
  });

  // CRA's default Jest config sets resetMocks: true, which wipes mock
  // implementations before every test (including the ones from jest.mock()
  // factories). Re-establish the "everything fails, nothing is cached"
  // baseline before each test so each test only has to override what it
  // specifically cares about.
  beforeEach(() => {
    taseScraper.readCachedTaseQuote.mockReturnValue(null);
    taseScraper.readStaleTaseQuote.mockReturnValue(null);
    taseScraper.writeCachedTaseQuote.mockReturnValue(undefined);
    taseScraper.isUsableTasePayload.mockImplementation(
      (p) => p && typeof p.currentPrice === 'number' && typeof p.changePercent === 'number'
    );
    taseQuoteApi.fetchTaseQuoteFromApi.mockRejectedValue(new Error('network unavailable in test'));
    taseHistoryApi.fetchTaseQuoteFromEod.mockRejectedValue(new Error('network unavailable in test'));
    taseScraper.scrapeTaseQuote.mockRejectedValue(new Error('puppeteer unavailable in test'));
    yahooQuotes.getYahooPayload.mockRejectedValue(new Error('network unavailable in test'));
    yahooQuotes.fetchYahooHistoricalRateForDate.mockRejectedValue(new Error('network unavailable in test'));
    bizportalSearch.searchIsraeliSecuritiesByName.mockRejectedValue(new Error('network unavailable in test'));
    taseSecurityLookup.fetchTaseSecurityMeta.mockRejectedValue(new Error('network unavailable in test'));
    // The Puppeteer source's circuit breaker is module-level state that
    // survives between tests, and most tests here deliberately make every
    // source fail - without this, the accumulated failures would trip the
    // breaker and the later tests would find the scraper skipped rather
    // than called.
    resetPuppeteerBreaker();
    resetSecurityMetaCache();
    marketMemory._reset();
  });

  test('GET /api/israeli-stock/:id rejects a non-numeric id with 400', async () => {
    const res = await get(`${baseUrl}/api/israeli-stock/not-a-number`);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid stock id');
  });

  test('GET /api/israeli-stock/:id tries all three sources, and degrades gracefully when every one fails', async () => {
    const res = await get(`${baseUrl}/api/israeli-stock/1234`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ currentPrice: null, changePercent: null });
    expect(taseQuoteApi.fetchTaseQuoteFromApi).toHaveBeenCalled();
    expect(taseHistoryApi.fetchTaseQuoteFromEod).toHaveBeenCalled();
    expect(taseScraper.scrapeTaseQuote).toHaveBeenCalled();
  });

  // Every source is addressed by security id alone - the scraper builds its
  // own page URL. A source accidentally receiving something else (the URL
  // the route used to construct, say) would request the wrong security.
  test('GET /api/israeli-stock/:id passes the security id to each source', async () => {
    await get(`${baseUrl}/api/israeli-stock/629014`);
    expect(taseQuoteApi.fetchTaseQuoteFromApi).toHaveBeenCalledWith('629014');
    expect(taseHistoryApi.fetchTaseQuoteFromEod).toHaveBeenCalledWith('629014');
    expect(taseScraper.scrapeTaseQuote).toHaveBeenCalledWith('629014');
  });

  // Stale-while-revalidate: an expired cache entry is served IMMEDIATELY,
  // and the refresh happens behind the response. This is what stops a
  // portfolio's first paint from waiting on the source chain per holding -
  // previously a cache miss blocked the response on a TASE API call, then
  // an EOD call, then a Puppeteer launch and a retry of it.
  test('GET /api/israeli-stock/:id serves a stale cached quote right away and refreshes in the background', async () => {
    taseScraper.readStaleTaseQuote.mockReturnValue({ currentPrice: 3500, changePercent: 1.1 });
    taseQuoteApi.fetchTaseQuoteFromApi.mockResolvedValue({ currentPrice: 3600, changePercent: 1.4 });

    const res = await get(`${baseUrl}/api/israeli-stock/5678`);

    // The response is the stale value, not the fresh one - it did not wait.
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ currentPrice: 3500, changePercent: 1.1 });
    // ...but a refresh was kicked off, so the next poll gets the new price.
    expect(taseQuoteApi.fetchTaseQuoteFromApi).toHaveBeenCalledWith('5678');
  });

  test('GET /api/israeli-stock/:id still falls back to the stale value when every source fails', async () => {
    taseScraper.readStaleTaseQuote.mockReturnValue({ currentPrice: 3500, changePercent: 1.1 });
    const res = await get(`${baseUrl}/api/israeli-stock/5678`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ currentPrice: 3500, changePercent: 1.1 });
  });

  // After a restart the in-memory cache is empty. A quote saved to the
  // database before it is served at once, exactly like an expired
  // in-memory one, instead of the first visitor waiting on the whole chain.
  test('GET /api/israeli-stock/:id serves the quote saved before a restart, and refreshes behind it', async () => {
    const saved = { currentPrice: 3500, changePercent: 1.1, fetchedAt: '2026-10-19T08:00:00.000Z' };
    marketMemory.attach(fakeSql({ 'quote:tase:4321': { value: saved, updatedAt: '2026-10-19T08:00:00.000Z' } }));
    taseQuoteApi.fetchTaseQuoteFromApi.mockResolvedValue({ currentPrice: 3600, changePercent: 1.4 });

    const res = await get(`${baseUrl}/api/israeli-stock/4321`);

    expect(res.body).toEqual(saved);
    // Seeded into the memory cache with its saved time, so it counts as stale.
    expect(taseScraper.writeCachedTaseQuote).toHaveBeenCalledWith('4321', saved, Date.parse('2026-10-19T08:00:00.000Z'));
    expect(taseQuoteApi.fetchTaseQuoteFromApi).toHaveBeenCalledWith('4321');
  });

  test('GET /api/israeli-stock/:id with nothing cached anywhere and every source down returns nulls', async () => {
    marketMemory.attach(fakeSql());
    const res = await get(`${baseUrl}/api/israeli-stock/4322`);
    expect(res.body).toEqual({ currentPrice: null, changePercent: null });
  });

  test('a successful quote is saved to the database for the next restart', async () => {
    const sql = fakeSql();
    marketMemory.attach(sql);
    taseQuoteApi.fetchTaseQuoteFromApi.mockResolvedValue({ currentPrice: 3600, changePercent: 1.4, tradeDate: '2026-10-19' });

    await get(`${baseUrl}/api/israeli-stock/4323`);

    const [, params] = sql.run.mock.calls[0];
    expect(params[0]).toBe('quote:tase:4323');
    expect(JSON.parse(params[1])).toMatchObject({ currentPrice: 3600, changePercent: 1.4 });
  });

  test('GET /api/israeli-stock/:id returns a cached quote immediately without calling the scraper', async () => {
    taseScraper.readCachedTaseQuote.mockReturnValue({ currentPrice: 4000, changePercent: 0.5 });
    const res = await get(`${baseUrl}/api/israeli-stock/9999`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ currentPrice: 4000, changePercent: 0.5 });
    expect(taseQuoteApi.fetchTaseQuoteFromApi).not.toHaveBeenCalled();
  });

  // The whole point of the reordering: the cheap JSON API answers first and
  // the headless browser is never launched. Puppeteer on the hot path (the
  // client polls every 10s) was both the slow and the failure-prone part.
  test('GET /api/israeli-stock/:id succeeds via the TASE API without touching the later sources', async () => {
    taseQuoteApi.fetchTaseQuoteFromApi.mockResolvedValue({ currentPrice: 11960, changePercent: 1.36, tradeDate: '2026-09-17' });
    const res = await get(`${baseUrl}/api/israeli-stock/629014`);
    expect(res.status).toBe(200);
    // The exchange's own session date is passed through untouched.
    expect(res.body).toEqual({ currentPrice: 11960, changePercent: 1.36, tradeDate: '2026-09-17', fetchedAt: expect.any(String) });
    expect(taseHistoryApi.fetchTaseQuoteFromEod).not.toHaveBeenCalled();
    expect(taseScraper.scrapeTaseQuote).not.toHaveBeenCalled();
  });

  // The API entry deliberately has no retryOnce - the chain itself is the
  // retry, with a different source, rather than hitting a failing endpoint
  // twice in a row.
  test('GET /api/israeli-stock/:id does not retry the TASE API, it moves straight to the EOD source', async () => {
    taseHistoryApi.fetchTaseQuoteFromEod.mockResolvedValue({ currentPrice: 7811, changePercent: -1.72 });
    const res = await get(`${baseUrl}/api/israeli-stock/604611`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ currentPrice: 7811, changePercent: -1.72, tradeDate: ANY_ISO_DATE, fetchedAt: expect.any(String) });
    expect(taseQuoteApi.fetchTaseQuoteFromApi).toHaveBeenCalledTimes(1);
    expect(taseScraper.scrapeTaseQuote).not.toHaveBeenCalled();
  });

  // A source that resolves with nulls (e.g. the TASE API's HTTP-200-with-a-
  // null-body answer for an unknown id) must be treated as a failure and
  // fall through, not returned as if it were a real quote.
  test('GET /api/israeli-stock/:id falls through a source that resolves with an unusable null payload', async () => {
    taseQuoteApi.fetchTaseQuoteFromApi.mockResolvedValue({ currentPrice: null, changePercent: null });
    taseHistoryApi.fetchTaseQuoteFromEod.mockResolvedValue({ currentPrice: 6000, changePercent: 1.1 });
    const res = await get(`${baseUrl}/api/israeli-stock/1111`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ currentPrice: 6000, changePercent: 1.1, tradeDate: ANY_ISO_DATE, fetchedAt: expect.any(String) });
  });

  test('GET /api/israeli-stock/:id reaches the scraper only after both APIs fail', async () => {
    taseScraper.scrapeTaseQuote.mockResolvedValue({ currentPrice: 5000, changePercent: 2.3 });
    const res = await get(`${baseUrl}/api/israeli-stock/1111`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ currentPrice: 5000, changePercent: 2.3, tradeDate: ANY_ISO_DATE, fetchedAt: expect.any(String) });
    expect(taseQuoteApi.fetchTaseQuoteFromApi).toHaveBeenCalled();
    expect(taseHistoryApi.fetchTaseQuoteFromEod).toHaveBeenCalled();
  });

  test('GET /api/israeli-stock/:id still retries the scraper once on a transient failure', async () => {
    taseScraper.scrapeTaseQuote
      .mockRejectedValueOnce(new Error('transient timeout'))
      .mockResolvedValueOnce({ currentPrice: 5000, changePercent: 2.3 });
    const res = await get(`${baseUrl}/api/israeli-stock/1111`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ currentPrice: 5000, changePercent: 2.3, tradeDate: ANY_ISO_DATE, fetchedAt: expect.any(String) });
    expect(taseScraper.scrapeTaseQuote).toHaveBeenCalledTimes(2);
  });

  test('GET /api/american-stock/:symbol rejects a blank symbol with 400', async () => {
    const res = await get(`${baseUrl}/api/american-stock/${encodeURIComponent(' ')}`);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid symbol');
  });

  test('GET /api/american-stock/:symbol degrades gracefully to nulls when Yahoo fails', async () => {
    const res = await get(`${baseUrl}/api/american-stock/AAPL`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ currentPrice: null, changePercent: 0 });
  });

  test('GET /api/american-stock/:symbol returns real data when Yahoo succeeds', async () => {
    yahooQuotes.getYahooPayload.mockResolvedValue({ currentPrice: 190.5, changePercent: 0.8 });
    const res = await get(`${baseUrl}/api/american-stock/AAPL`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ currentPrice: 190.5, changePercent: 0.8 });
  });

  test('GET /api/exchange-rate degrades gracefully to a null rate when Yahoo fails', async () => {
    const res = await get(`${baseUrl}/api/exchange-rate`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ rate: null });
  });

  test('GET /api/exchange-rate returns the real rate when Yahoo succeeds', async () => {
    yahooQuotes.getYahooPayload.mockResolvedValue({ currentPrice: 3.71, changePercent: -0.1 });
    const res = await get(`${baseUrl}/api/exchange-rate`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ rate: 3.71 });
  });

  test('GET /api/exchange-rate/:date rejects a non-YYYY-MM-DD date with 400', async () => {
    const res = await get(`${baseUrl}/api/exchange-rate/not-a-date`);
    expect(res.status).toBe(400);
    expect(res.body.error).toBeTruthy();
  });

  test('GET /api/exchange-rate/:date degrades gracefully to a null rate/date when Yahoo fails', async () => {
    const res = await get(`${baseUrl}/api/exchange-rate/2023-06-15`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ rate: null, date: null });
  });

  test('GET /api/exchange-rate/:date returns the real historical rate (and the actual trading day used) when Yahoo succeeds', async () => {
    yahooQuotes.fetchYahooHistoricalRateForDate.mockResolvedValue({ date: '2023-06-14', rate: 3.65 });
    const res = await get(`${baseUrl}/api/exchange-rate/2023-06-15`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ rate: 3.65, date: '2023-06-14' });
    expect(yahooQuotes.fetchYahooHistoricalRateForDate).toHaveBeenCalledWith('USDILS=X', '2023-06-15');
  });

  test('GET /api/exchange-rate/:date returns a null rate/date when no trading day is found on or before the requested date', async () => {
    yahooQuotes.fetchYahooHistoricalRateForDate.mockResolvedValue(null);
    const res = await get(`${baseUrl}/api/exchange-rate/2023-06-15`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ rate: null, date: null });
  });

  test('GET /api/israeli-stock-search returns an empty result list without calling the search module for a blank query', async () => {
    const res = await get(`${baseUrl}/api/israeli-stock-search?q=`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ results: [] });
    expect(bizportalSearch.searchIsraeliSecuritiesByName).not.toHaveBeenCalled();
  });

  test('GET /api/israeli-stock-search degrades gracefully to an empty result list when the search module fails', async () => {
    const res = await get(`${baseUrl}/api/israeli-stock-search?q=${encodeURIComponent('טבע')}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ results: [] });
  });

  test('GET /api/israeli-stock-search returns the resolved securities on success', async () => {
    bizportalSearch.searchIsraeliSecuritiesByName.mockResolvedValue([
      { securityId: '629014', officialName: 'טבע', symbol: 'TEVA' }
    ]);
    const res = await get(`${baseUrl}/api/israeli-stock-search?q=${encodeURIComponent('טבע')}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ results: [{ securityId: '629014', officialName: 'טבע', symbol: 'TEVA' }] });
    expect(bizportalSearch.searchIsraeliSecuritiesByName).toHaveBeenCalledWith('טבע');
  });

  // THE ETF SEARCH BUG. Bizportal's name-autocomplete returns an empty
  // array for a numeric query (verified live against 1159250), so searching
  // by security number could never find anything - and foreign-listed
  // tracking funds like 1159250 aren't in its name index either, making
  // them unreachable by any query text at all. Resolving a numeric query
  // directly against the exchange's own securitydata API is what fixes both.
  test('GET /api/israeli-stock-search resolves a security NUMBER directly, even when the name search finds nothing', async () => {
    bizportalSearch.searchIsraeliSecuritiesByName.mockResolvedValue([]);
    taseSecurityLookup.fetchTaseSecurityMeta.mockResolvedValue({
      securityId: '1159250',
      officialName: 'איישרס.חוץ P 500&S',
      symbol: 'אש.סז702',
      securityType: 'קרן חוץ נסחרת',
      securitySubType: 'קרן חוץ נסחרת מניות',
      branch: 'מכשירים פיננסים-קרן חוץ נסחרת-קרן חוץ נסחרת',
      isFund: true,
      isForeignETF: true,
      underlyingAsset: 'S&P 500 - NTR'
    });

    const res = await get(`${baseUrl}/api/israeli-stock-search?q=1159250`);

    expect(res.status).toBe(200);
    expect(res.body.results).toHaveLength(1);
    expect(res.body.results[0]).toMatchObject({
      securityId: '1159250',
      officialName: 'איישרס.חוץ P 500&S',
      isFund: true,
      isForeignETF: true
    });
    expect(taseSecurityLookup.fetchTaseSecurityMeta).toHaveBeenCalledWith('1159250');
  });

  test('GET /api/israeli-stock-search puts the direct security-number hit first and drops its duplicate from the name results', async () => {
    taseSecurityLookup.fetchTaseSecurityMeta.mockResolvedValue({
      securityId: '629014',
      officialName: 'טבע',
      symbol: 'טבע',
      securityType: ' מניות',
      isFund: false,
      isForeignETF: false
    });
    bizportalSearch.searchIsraeliSecuritiesByName.mockResolvedValue([
      { securityId: '629014', officialName: 'טבע (מ-Bizportal)', symbol: 'TEVA', isFund: false },
      { securityId: '1145713', officialName: 'קסם Russell 2000 ETF', symbol: 'KSM', isFund: true }
    ]);

    const res = await get(`${baseUrl}/api/israeli-stock-search?q=629014`);

    expect(res.body.results.map((r) => r.securityId)).toEqual(['629014', '1145713']);
    expect(res.body.results[0].officialName).toBe('טבע');
  });

  test('GET /api/israeli-stock-search does not attempt a security-id lookup for a name query', async () => {
    bizportalSearch.searchIsraeliSecuritiesByName.mockResolvedValue([]);
    await get(`${baseUrl}/api/israeli-stock-search?q=${encodeURIComponent('טבע')}`);
    expect(taseSecurityLookup.fetchTaseSecurityMeta).not.toHaveBeenCalled();
  });

  test('GET /api/israeli-stock-search still returns name results when the id lookup fails', async () => {
    taseSecurityLookup.fetchTaseSecurityMeta.mockRejectedValue(new Error('tase down'));
    bizportalSearch.searchIsraeliSecuritiesByName.mockResolvedValue([
      { securityId: '1145713', officialName: 'קסם Russell 2000 ETF', symbol: 'KSM', isFund: true }
    ]);

    const res = await get(`${baseUrl}/api/israeli-stock-search?q=1145713`);
    expect(res.status).toBe(200);
    expect(res.body.results.map((r) => r.securityId)).toEqual(['1145713']);
  });

  test('GET /api/israeli-security/:id returns the security metadata used for automatic classification', async () => {
    taseSecurityLookup.fetchTaseSecurityMeta.mockResolvedValue({
      securityId: '629014',
      officialName: 'טבע',
      branch: 'הייטק-ביומד-פארמה',
      isFund: false,
      isForeignETF: false
    });
    const res = await get(`${baseUrl}/api/israeli-security/629014`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ officialName: 'טבע', branch: 'הייטק-ביומד-פארמה' });
  });

  test('GET /api/israeli-security/:id rejects a non-numeric id with 400 and 404s an unknown one', async () => {
    const bad = await get(`${baseUrl}/api/israeli-security/abc`);
    expect(bad.status).toBe(400);

    taseSecurityLookup.fetchTaseSecurityMeta.mockResolvedValue(null);
    const missing = await get(`${baseUrl}/api/israeli-security/1`);
    expect(missing.status).toBe(404);
  });

  // Batched quotes: one request for the whole portfolio instead of one per
  // holding. Browsers only open ~6 connections per origin, so 20 holdings
  // previously meant four serialized rounds of requests.
  test('POST /api/israeli-stocks returns a quote per id in a single request', async () => {
    taseScraper.readCachedTaseQuote.mockImplementation((id) =>
      id === '629014' ? { currentPrice: 11960, changePercent: 1.36 } : { currentPrice: 249160, changePercent: 0.14 }
    );

    const res = await post(`${baseUrl}/api/israeli-stocks`, { ids: ['629014', '1159250'] });

    expect(res.status).toBe(200);
    expect(res.body.quotes).toEqual({
      629014: { currentPrice: 11960, changePercent: 1.36 },
      1159250: { currentPrice: 249160, changePercent: 0.14 }
    });
  });

  test('POST /api/israeli-stocks ignores non-numeric ids, dedupes, and returns {} for an empty list', async () => {
    taseScraper.readCachedTaseQuote.mockReturnValue({ currentPrice: 100, changePercent: 0 });

    const res = await post(`${baseUrl}/api/israeli-stocks`, { ids: ['629014', '629014', 'nope', ''] });
    expect(Object.keys(res.body.quotes)).toEqual(['629014']);

    const empty = await post(`${baseUrl}/api/israeli-stocks`, { ids: [] });
    expect(empty.body).toEqual({ quotes: {} });
  });

  test('POST /api/american-stocks returns every symbol plus the USD/ILS rate on one response', async () => {
    yahooQuotes.getYahooPayload.mockImplementation((symbol) => {
      if (symbol === 'USDILS=X') return Promise.resolve({ currentPrice: 3.71, changePercent: -0.1 });
      if (symbol === 'AAPL') return Promise.resolve({ currentPrice: 190.5, changePercent: 0.8 });
      return Promise.reject(new Error('unknown symbol'));
    });

    const res = await post(`${baseUrl}/api/american-stocks`, { symbols: ['AAPL', 'BADTICKER'] });

    expect(res.status).toBe(200);
    expect(res.body.exchangeRate).toBe(3.71);
    expect(res.body.quotes.AAPL).toEqual({ currentPrice: 190.5, changePercent: 0.8 });
    // One failing ticker must not blank out the rest of the portfolio.
    expect(res.body.quotes.BADTICKER).toEqual({ currentPrice: null, changePercent: 0 });
  });

  // The Puppeteer source is the expensive one - a browser launch per symbol
  // per poll, tried twice. When it's broken it's usually broken for every
  // symbol at once, so it gets skipped for a while instead of being paid
  // for repeatedly.
  test('the Puppeteer source is skipped after repeated failures, while the JSON APIs keep being tried', async () => {
    await get(`${baseUrl}/api/israeli-stock/1001`);
    await get(`${baseUrl}/api/israeli-stock/1002`);
    await get(`${baseUrl}/api/israeli-stock/1003`);

    const callsBefore = taseScraper.scrapeTaseQuote.mock.calls.length;
    const apiCallsBefore = taseQuoteApi.fetchTaseQuoteFromApi.mock.calls.length;

    await get(`${baseUrl}/api/israeli-stock/1004`);

    expect(taseScraper.scrapeTaseQuote.mock.calls.length).toBe(callsBefore);
    expect(taseQuoteApi.fetchTaseQuoteFromApi.mock.calls.length).toBe(apiCallsBefore + 1);
  });
});
