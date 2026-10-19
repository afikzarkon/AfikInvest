/**
 * @jest-environment node
 */
// The forward-looking summary comes from the per-symbol profile shared
// with the sector and analyst routes (symbolProfile.js) - one Yahoo
// request for all three.
jest.mock('./yahooQuotes', () => ({
  fetchYahooSymbolProfile: jest.fn(),
  fetchYahooDividendHistory: jest.fn()
}));

const http = require('http');
const express = require('express');
const { mountDividendRoutes } = require('./dividendRoutes');
const yahooQuotes = require('./yahooQuotes');

const mockDividendSummary = (summary) => yahooQuotes.fetchYahooSymbolProfile.mockResolvedValue({ dividendSummary: summary });

// Jest's node test environment doesn't expose global fetch, so use Node's
// built-in http module for these requests instead of adding a dependency.
function post(url, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body || {});
    const req = http.request(
      url,
      {
        method: 'POST',
        agent: false,
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
      },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => { raw += chunk; });
        res.on('end', () => {
          let parsedBody = null;
          try {
            parsedBody = JSON.parse(raw);
          } catch {
            parsedBody = null;
          }
          resolve({ status: res.statusCode, body: parsedBody });
        });
      }
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

describe('dividendRoutes', () => {
  let app;
  let server;
  let baseUrl;

  beforeAll((done) => {
    app = express();
    app.use(express.json());
    mountDividendRoutes(app);
    server = app.listen(0, () => {
      baseUrl = `http://localhost:${server.address().port}`;
      done();
    });
  });

  afterAll((done) => {
    server.close(done);
  });

  beforeEach(() => {
    yahooQuotes.fetchYahooSymbolProfile.mockReset();
    yahooQuotes.fetchYahooDividendHistory.mockReset();
  });

  test('POST /api/dividend-data returns {} for an empty symbol list', async () => {
    const res = await post(`${baseUrl}/api/dividend-data`, { symbols: [] });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ dividends: {} });
    expect(yahooQuotes.fetchYahooSymbolProfile).not.toHaveBeenCalled();
    expect(yahooQuotes.fetchYahooDividendHistory).not.toHaveBeenCalled();
  });

  test('POST /api/dividend-data combines summary and history for each symbol', async () => {
    mockDividendSummary({
      dividendRate: 2.12,
      dividendYieldPercent: 2.36,
      payoutRatio: 0.62,
      exDividendDateEpoch: 1700000000,
      nextDividendDateEpoch: 1701000000
    });
    yahooQuotes.fetchYahooDividendHistory.mockResolvedValue([{ date: '2024-06-01', amountPerShare: 0.51 }]);

    const res = await post(`${baseUrl}/api/dividend-data`, { symbols: ['ko'] });
    expect(res.status).toBe(200);
    expect(res.body.dividends.KO).toEqual({
      dividendRate: 2.12,
      dividendYieldPercent: 2.36,
      payoutRatio: 0.62,
      exDividendDateEpoch: 1700000000,
      nextDividendDateEpoch: 1701000000,
      history: [{ date: '2024-06-01', amountPerShare: 0.51 }]
    });
  });

  test('POST /api/dividend-data falls back to nulls/empty history when both fetches fail, without erroring the batch', async () => {
    yahooQuotes.fetchYahooSymbolProfile.mockRejectedValue(new Error('quoteSummary down'));
    yahooQuotes.fetchYahooDividendHistory.mockRejectedValue(new Error('chart down'));

    const res = await post(`${baseUrl}/api/dividend-data`, { symbols: ['BADTICKER'] });
    expect(res.status).toBe(200);
    expect(res.body.dividends.BADTICKER).toEqual({
      dividendRate: null,
      dividendYieldPercent: null,
      payoutRatio: null,
      exDividendDateEpoch: null,
      nextDividendDateEpoch: null,
      history: []
    });
  });

  test('POST /api/dividend-data dedupes/uppercases symbols and caches per symbol', async () => {
    mockDividendSummary({
      dividendRate: 1,
      dividendYieldPercent: 1,
      payoutRatio: 1,
      exDividendDateEpoch: null,
      nextDividendDateEpoch: null
    });
    yahooQuotes.fetchYahooDividendHistory.mockResolvedValue([]);

    await post(`${baseUrl}/api/dividend-data`, { symbols: ['nvda', 'NVDA'] });
    await post(`${baseUrl}/api/dividend-data`, { symbols: ['NVDA'] });

    expect(yahooQuotes.fetchYahooSymbolProfile).toHaveBeenCalledTimes(1);
    expect(yahooQuotes.fetchYahooDividendHistory).toHaveBeenCalledTimes(1);
  });

  test('POST /api/dividend-data passes a valid "from" date through, but ignores an invalid one', async () => {
    mockDividendSummary({});
    yahooQuotes.fetchYahooDividendHistory.mockResolvedValue([]);

    await post(`${baseUrl}/api/dividend-data`, { symbols: ['GOOG'], from: '2023-05-01' });
    expect(yahooQuotes.fetchYahooDividendHistory).toHaveBeenLastCalledWith('GOOG', '2023-05-01');

    await post(`${baseUrl}/api/dividend-data`, { symbols: ['GOOGL'], from: 'not-a-date' });
    expect(yahooQuotes.fetchYahooDividendHistory).toHaveBeenLastCalledWith('GOOGL', undefined);
  });

  test('POST /api/dividend-data caps the batch at 30 symbols', async () => {
    mockDividendSummary({});
    yahooQuotes.fetchYahooDividendHistory.mockResolvedValue([]);
    const symbols = Array.from({ length: 40 }, (_, i) => `SYM${i}`);

    const res = await post(`${baseUrl}/api/dividend-data`, { symbols });
    expect(Object.keys(res.body.dividends)).toHaveLength(30);
  });
});
