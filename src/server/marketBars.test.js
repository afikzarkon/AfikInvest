/**
 * @jest-environment node
 */
// The OHLCV fetchers behind the anomaly engine, against recorded response
// shapes (the sandbox these were written in has no route to Yahoo/TASE).
const mockAxios = { get: jest.fn(), post: jest.fn() };
jest.mock('axios', () => mockAxios);
jest.mock('./yahooCrumb', () => ({
  getYahooCrumbAndCookie: jest.fn().mockResolvedValue({ crumb: 'c', cookie: 'k' }),
  invalidateYahooCrumb: jest.fn()
}));

const { fetchYahooDailyBars, fetchYahooCalendar } = require('./yahooQuotes');
const { getYahooCrumbAndCookie } = require('./yahooCrumb');
const { fetchTaseDailyBars, volumeOfRow } = require('./taseHistoryApi');

const ts = (d) => Date.parse(`${d}T14:30:00Z`) / 1000;

beforeEach(() => {
  mockAxios.get.mockReset();
  mockAxios.post.mockReset();
  // CRA's Jest config resets mocks between tests, factory values included.
  getYahooCrumbAndCookie.mockResolvedValue({ crumb: 'c', cookie: 'k' });
});

test('Yahoo bars prefer split-adjusted closes and carry volume', async () => {
  mockAxios.get.mockResolvedValue({
    data: {
      chart: {
        result: [
          {
            timestamp: [ts('2026-02-12'), ts('2026-02-13'), ts('2026-02-16')],
            indicators: {
              quote: [{ close: [200, null, 102], volume: [1000, 2000, null] }],
              adjclose: [{ adjclose: [100, null, 102] }]
            }
          }
        ]
      }
    }
  });
  const bars = await fetchYahooDailyBars('AAPL');
  expect(bars).toEqual([
    { date: '2026-02-12', close: 100, volume: 1000 },
    { date: '2026-02-16', close: 102, volume: 0 }
  ]);
  expect(mockAxios.get.mock.calls[0][1].params).toEqual({ range: '3mo', interval: '1d' });
});

test('Yahoo bars: a malformed response is an error, not an empty series', async () => {
  mockAxios.get.mockResolvedValue({ data: { chart: { result: [{}] } } });
  await expect(fetchYahooDailyBars('AAPL')).rejects.toThrow(/missing/);
});

test('Yahoo calendar returns calendarEvents and summaryDetail', async () => {
  mockAxios.get.mockResolvedValue({
    data: { quoteSummary: { result: [{ calendarEvents: { exDividendDate: { raw: 1 } }, summaryDetail: { dividendRate: { raw: 2 } } }] } }
  });
  await expect(fetchYahooCalendar('KO')).resolves.toEqual({
    calendarEvents: { exDividendDate: { raw: 1 } },
    summaryDetail: { dividendRate: { raw: 2 } }
  });
});

test('TASE bars: newest-first pages become ascending bars with volume', async () => {
  const page = (rows) => ({ data: { TotalRec: 60, Items: rows } });
  const row = (d, close, vol) => ({ TradeDate: d, CloseRate: close, OverallTurnOverUnits: vol });
  mockAxios.post
    .mockResolvedValueOnce(page(Array.from({ length: 30 }, (_, i) => row(`${String(30 - i).padStart(2, '0')}/01/2026`, 1000 + i, 500))))
    .mockResolvedValueOnce(page([row('31/12/2025', 990, 400)]));
  const bars = await fetchTaseDailyBars('604611', 3);
  expect(bars).toHaveLength(31);
  expect(bars[0]).toEqual({ date: '2025-12-31', close: 990, volume: 400 });
  expect(bars[bars.length - 1].date).toBe('2026-01-30');
  expect(mockAxios.post).toHaveBeenCalledTimes(2); // stopped at the short page
});

test('TASE volume falls back across candidate fields, else 0', () => {
  expect(volumeOfRow({ OverallTurnOverUnits: 10 })).toBe(10);
  expect(volumeOfRow({ TurnOverUnits: 7 })).toBe(7);
  expect(volumeOfRow({ Volume: '5' })).toBe(5);
  expect(volumeOfRow({ CloseRate: 1 })).toBe(0);
});
