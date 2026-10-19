/**
 * @jest-environment node
 */
// Regression test for a real bug: Yahoo's quoteSummary endpoint returns
// numeric fields either as a plain number (when formatted=false is
// respected) or as a { raw, fmt, longFmt } display-ready object. Treating
// the second shape as a plain number silently produced `null` for every
// analyst price target while recommendationKey (a plain string field)
// worked fine — exactly what showed up in production before this fix.
const mockAxios = { get: jest.fn() };
jest.mock('axios', () => mockAxios);
jest.mock('./yahooCrumb', () => ({
  getYahooCrumbAndCookie: jest.fn().mockResolvedValue({ crumb: 'test-crumb', cookie: 'test-cookie' }),
  invalidateYahooCrumb: jest.fn()
}));

const {
  unwrapYahooNumber,
  fetchYahooAssetProfile,
  fetchYahooSymbolSearch,
  getYahooPayload,
  fetchYahooHistoricalRateForDate
} = require('./yahooQuotes');

describe('unwrapYahooNumber', () => {
  test('passes through a plain finite number', () => {
    expect(unwrapYahooNumber(150.5)).toBe(150.5);
    expect(unwrapYahooNumber(0)).toBe(0);
  });

  test('unwraps the { raw, fmt } shape Yahoo uses when formatted=false is not honored', () => {
    expect(unwrapYahooNumber({ raw: 150.5, fmt: '150.50' })).toBe(150.5);
    expect(unwrapYahooNumber({ raw: 12, fmt: '12', longFmt: '12' })).toBe(12);
  });

  test('null/undefined input returns null', () => {
    expect(unwrapYahooNumber(null)).toBeNull();
    expect(unwrapYahooNumber(undefined)).toBeNull();
  });

  test('non-finite plain number returns null', () => {
    expect(unwrapYahooNumber(NaN)).toBeNull();
  });

  test('object without a finite raw value returns null rather than throwing', () => {
    expect(unwrapYahooNumber({})).toBeNull();
    expect(unwrapYahooNumber({ raw: null })).toBeNull();
    expect(unwrapYahooNumber({ fmt: '150.50' })).toBeNull(); // raw missing
  });

  test('string input (unexpected shape) returns null rather than a bogus value', () => {
    expect(unwrapYahooNumber('150.5')).toBeNull();
  });
});

// Regression test for a second real production bug: sectorRoutes.js and
// analystRoutes.js each resolve every US ticker in a portfolio via
// Promise.all, so a portfolio with several holdings fires many
// near-simultaneous quoteSummary requests and gets rate-limited by Yahoo
// (429) - seen in production logs as
// "[sectors] failed to resolve symbol ... status code 429" for every
// symbol at once.
describe('fetchYahooQuoteSummary 429 handling (via fetchYahooAssetProfile)', () => {
  const validQuoteSummaryResponse = {
    data: { quoteSummary: { result: [{ assetProfile: { sector: 'Technology', industry: 'Software' } }] } }
  };

  let fetchYahooAssetProfileFresh;

  beforeEach(() => {
    // The request-throttling queue in yahooQuotes.js is module-level
    // state (by design - it needs to serialize requests across every
    // caller, not just within one test). Re-requiring the module after
    // resetModules() gives each test a clean queue instead of chaining
    // onto whatever the previous test's queue was doing.
    jest.resetModules();
    mockAxios.get.mockReset();
    // eslint-disable-next-line global-require
    fetchYahooAssetProfileFresh = require('./yahooQuotes').fetchYahooAssetProfile;
  });

  test('retries once after a 429 and succeeds on the second attempt', async () => {
    const rateLimitError = { response: { status: 429 } };
    mockAxios.get.mockRejectedValueOnce(rateLimitError).mockResolvedValueOnce(validQuoteSummaryResponse);

    const result = await fetchYahooAssetProfileFresh('NVDA');

    expect(result).toEqual({ sector: 'Technology', industry: 'Software' });
    expect(mockAxios.get).toHaveBeenCalledTimes(2);
  }, 10000);

  test('a persistent 429 gives up after a bounded number of retries rather than looping', async () => {
    const rateLimitError = { response: { status: 429 } };
    mockAxios.get.mockRejectedValue(rateLimitError);

    await expect(fetchYahooAssetProfileFresh('NVDA')).rejects.toBeTruthy();
    // One initial attempt plus one retry per entry in the backoff
    // schedule, and then it stops - the caller falls back to the last
    // known value instead of waiting indefinitely (see symbolCache.js).
    expect(mockAxios.get).toHaveBeenCalledTimes(3);
  }, 20000);

  test('a non-429/401/403 error propagates immediately without the 429 backoff delay', async () => {
    mockAxios.get.mockRejectedValue({ response: { status: 500 } });

    const start = Date.now();
    await expect(fetchYahooAssetProfileFresh('NVDA')).rejects.toBeTruthy();
    const elapsed = Date.now() - start;

    expect(mockAxios.get).toHaveBeenCalledTimes(1); // no retry attempted
    expect(elapsed).toBeLessThan(1000); // well under the 1500ms 429 backoff
  });

  test('two concurrent requests are paced through the shared queue even when both fail (not fired back-to-back)', async () => {
    // Regression test for a real bug in the queue itself: the spacing
    // delay was originally only applied after a *successful* request, so
    // a burst of failures (exactly what 429s look like) went through the
    // queue with no pacing at all - defeating the point of the queue for
    // the one case it exists to help with.
    mockAxios.get.mockRejectedValue({ response: { status: 500 } });

    const start = Date.now();
    await Promise.allSettled([fetchYahooAssetProfileFresh('NVDA'), fetchYahooAssetProfileFresh('PLTR')]);
    const elapsed = Date.now() - start;

    // Two requests through the queue = at least one spacing gap between
    // them (~350ms), so two near-instant local mock failures should still
    // take noticeably longer than either one alone.
    expect(elapsed).toBeGreaterThanOrEqual(300);
  }, 10000);
});

// fetchYahooSymbolSearch's response shape below is trimmed from a real
// Yahoo search response for 'apple' captured during development - includes
// a non-EQUITY-shaped entry-adjacent field set (REIT, foreign listing) to
// verify the EQUITY-only filter and the shortname/longname fallback.
describe('fetchYahooSymbolSearch', () => {
  beforeEach(() => {
    mockAxios.get.mockReset();
  });

  test('parses EQUITY quotes, preferring longname over shortname', async () => {
    mockAxios.get.mockResolvedValueOnce({
      data: {
        quotes: [
          { symbol: 'AAPL', shortname: 'Apple Inc.', longname: 'Apple Inc.', exchDisp: 'NASDAQ', quoteType: 'EQUITY' },
          { symbol: 'APLE', shortname: 'Apple Hospitality REIT, Inc.', exchDisp: 'NYSE', quoteType: 'EQUITY' },
          // Not EQUITY - should be filtered out (e.g. a fund/ETF/crypto match)
          { symbol: 'AAPL.SOME-INDEX', shortname: 'Some Index', exchDisp: 'INDX', quoteType: 'INDEX' }
        ]
      }
    });

    const result = await fetchYahooSymbolSearch('apple', 8);
    expect(result).toEqual([
      { symbol: 'AAPL', name: 'Apple Inc.', exchange: 'NASDAQ' },
      { symbol: 'APLE', name: 'Apple Hospitality REIT, Inc.', exchange: 'NYSE' }
    ]);
  });

  test('passes q/quotesCount params through, with newsCount 0', async () => {
    mockAxios.get.mockResolvedValueOnce({ data: { quotes: [] } });
    await fetchYahooSymbolSearch('tesla', 5);
    expect(mockAxios.get).toHaveBeenCalledWith(
      'https://query1.finance.yahoo.com/v1/finance/search',
      expect.objectContaining({ params: { q: 'tesla', newsCount: 0, quotesCount: 5 } })
    );
  });

  test('returns an empty array (not throwing) when the quotes field is missing', async () => {
    mockAxios.get.mockResolvedValueOnce({ data: {} });
    expect(await fetchYahooSymbolSearch('xyz')).toEqual([]);
  });
});

// fetchYahooDividendSummary parses both dividend AND earnings-date fields
// out of one quoteSummary response (see the "why" comment on the function
// itself in yahooQuotes.js). The response shape below is captured from a
// real KO (Coca-Cola) quoteSummary call made during development, not
// invented - real Yahoo responses nest fields in ways that are easy to get
// wrong from memory (e.g. dividendYield is a fraction, but
// fiveYearAvgDividendYield in the same module is already a percent).
describe('fetchYahooDividendSummary', () => {
  let fetchYahooDividendSummaryFresh;

  beforeEach(() => {
    // Same reasoning as the 429-handling describe block above: resetModules
    // gives a clean module graph (and re-runs the './yahooCrumb' mock
    // factory, restoring its .mockResolvedValue) instead of reusing
    // whichever stale instance an earlier describe block's resetModules()
    // call left cached.
    jest.resetModules();
    mockAxios.get.mockReset();
    // eslint-disable-next-line global-require
    fetchYahooDividendSummaryFresh = require('./yahooQuotes').fetchYahooDividendSummary;
  });

  const realKoQuoteSummaryResponse = {
    data: {
      quoteSummary: {
        result: [
          {
            summaryDetail: {
              dividendRate: 2.12,
              dividendYield: 0.023599999,
              exDividendDate: 1789430400,
              payoutRatio: 0.6246,
              fiveYearAvgDividendYield: 2.87 // deliberately not used - already a percent, unlike dividendYield above
            },
            calendarEvents: {
              // Yahoo really does return this earnings sub-object; it is
              // kept in the fixture precisely so the assertion below can
              // show it is IGNORED rather than passed through.
              earnings: {
                earningsDate: [1792499400],
                earningsAverage: 0.87893,
                revenueAverage: 12901487840
              },
              exDividendDate: 1789430400,
              dividendDate: 1790812800
            }
          }
        ]
      }
    }
  };

  test('parses dividend fields, converting dividendYield from a fraction to a percent', async () => {
    mockAxios.get.mockResolvedValueOnce(realKoQuoteSummaryResponse);
    const result = await fetchYahooDividendSummaryFresh('KO');
    expect(result.dividendRate).toBe(2.12);
    expect(result.dividendYieldPercent).toBeCloseTo(2.36, 2); // 0.0236 -> 2.36, not 0.0236
    expect(result.payoutRatio).toBe(0.6246);
    expect(result.exDividendDateEpoch).toBe(1789430400);
    expect(result.nextDividendDateEpoch).toBe(1790812800);
  });

  // The board these fed ("לוח רבעונים") was removed, so they are no longer
  // carried on the response - the payload stays limited to what something
  // actually reads.
  test('drops the earnings fields Yahoo returns alongside the dividend ones', async () => {
    mockAxios.get.mockResolvedValueOnce(realKoQuoteSummaryResponse);
    const result = await fetchYahooDividendSummaryFresh('KO');
    expect(result).not.toHaveProperty('earningsDateEpoch');
    expect(result).not.toHaveProperty('isEarningsDateEstimate');
    expect(result).not.toHaveProperty('epsEstimateAverage');
    expect(result).not.toHaveProperty('revenueEstimateAverage');
  });

  test('returns nulls (not throwing) when summaryDetail/calendarEvents are missing', async () => {
    mockAxios.get.mockResolvedValueOnce({ data: { quoteSummary: { result: [{}] } } });
    const result = await fetchYahooDividendSummaryFresh('NODATA');
    expect(result).toEqual({
      dividendRate: null,
      dividendYieldPercent: null,
      payoutRatio: null,
      exDividendDateEpoch: null,
      nextDividendDateEpoch: null
    });
  });
});

// regularMarketChange / change when present, blindly multiplying whatever
// it found by 100. regularMarketChange/change are absolute currency
// amounts (not percentages), and even the *ChangePercent fields' scale
// wasn't consistent - so when Yahoo's v8 chart response happened to
// include one of these (they're often absent entirely, per real sample
// responses), the computed "change %" had no real relationship to the
// actual daily move. Fixed by always computing the % change directly from
// two unambiguous prices (regularMarketPrice vs previousClose).
describe('getYahooPayload change-percent calculation', () => {
  beforeEach(() => {
    mockAxios.get.mockReset();
  });

  const chartResponse = (meta) => ({ data: { chart: { result: [{ meta }] } } });

  test('computes change % directly from regularMarketPrice vs previousClose when no change fields are present (the common real-world case)', async () => {
    mockAxios.get.mockResolvedValueOnce(
      chartResponse({ regularMarketPrice: 114.28, previousClose: 115.26 })
    );
    const result = await getYahooPayload('TEST_SYMBOL_1');
    expect(result.currentPrice).toBe(114.28);
    expect(result.changePercent).toBeCloseTo(((114.28 - 115.26) / 115.26) * 100, 5);
  });

  test('ignores a misleading regularMarketChange field (an absolute currency amount, not a percent) - the exact bug that was in production', async () => {
    // regularMarketChange here is -3.42 (dollars), which the old buggy
    // code would have multiplied by 100 to get a nonsensical -342%.
    mockAxios.get.mockResolvedValueOnce(
      chartResponse({
        regularMarketPrice: 100,
        previousClose: 103.42,
        regularMarketChange: -3.42
      })
    );
    const result = await getYahooPayload('TEST_SYMBOL_2');
    // Correct answer, computed only from the two prices:
    expect(result.changePercent).toBeCloseTo(((100 - 103.42) / 103.42) * 100, 5);
    expect(result.changePercent).not.toBeCloseTo(-342, 0); // the old bug's output
  });

  test('ignores a misleading regularMarketChangePercent field of ambiguous scale - same fix covers this shape too', async () => {
    mockAxios.get.mockResolvedValueOnce(
      chartResponse({
        regularMarketPrice: 100,
        previousClose: 101.42,
        regularMarketChangePercent: -1.42 // could be a fraction or already a percent - ambiguous either way
      })
    );
    const result = await getYahooPayload('TEST_SYMBOL_3');
    expect(result.changePercent).toBeCloseTo(((100 - 101.42) / 101.42) * 100, 5);
  });

  test('falls back to chartPreviousClose when previousClose is missing', async () => {
    mockAxios.get.mockResolvedValueOnce(
      chartResponse({ regularMarketPrice: 50, chartPreviousClose: 49 })
    );
    const result = await getYahooPayload('TEST_SYMBOL_4');
    expect(result.changePercent).toBeCloseTo(((50 - 49) / 49) * 100, 5);
  });

  test('missing both previousClose fields yields changePercent 0, not NaN/undefined', async () => {
    mockAxios.get.mockResolvedValueOnce(chartResponse({ regularMarketPrice: 50 }));
    const result = await getYahooPayload('TEST_SYMBOL_5');
    expect(result.currentPrice).toBe(50);
    expect(result.changePercent).toBe(0);
  });
});

// The historical USD/ILS-on-a-specific-date lookup that auto-fills the
// exchange-rate field on the "add stock" form (see quotesRoutes.js's
// GET /api/exchange-rate/:date).
describe('fetchYahooHistoricalRateForDate', () => {
  beforeEach(() => {
    mockAxios.get.mockReset();
  });

  const dailyBarsResponse = (dates, closes) => ({
    data: {
      chart: {
        result: [
          {
            timestamp: dates.map((d) => Math.floor(new Date(`${d}T12:00:00Z`).getTime() / 1000)),
            indicators: { quote: [{ close: closes }] }
          }
        ]
      }
    }
  });

  test('picks the latest trading day on or before the requested date (a Saturday purchase date lands on the prior Friday)', async () => {
    // 2023-06-17 is a Saturday - no FX bar that day
    mockAxios.get.mockResolvedValueOnce(
      dailyBarsResponse(['2023-06-14', '2023-06-15', '2023-06-16'], [3.65, 3.66, 3.68])
    );
    const result = await fetchYahooHistoricalRateForDate('USDILS=X', '2023-06-17');
    expect(result).toEqual({ date: '2023-06-16', rate: 3.68 });
  });

  test('returns exactly the requested day when it is itself a trading day', async () => {
    mockAxios.get.mockResolvedValueOnce(dailyBarsResponse(['2023-06-14', '2023-06-15'], [3.65, 3.66]));
    const result = await fetchYahooHistoricalRateForDate('USDILS=X', '2023-06-15');
    expect(result).toEqual({ date: '2023-06-15', rate: 3.66 });
  });

  test('ignores a trading day that falls after the requested date, even though it is inside the fetched window', async () => {
    mockAxios.get.mockResolvedValueOnce(dailyBarsResponse(['2023-06-14', '2023-06-16'], [3.65, 3.7]));
    const result = await fetchYahooHistoricalRateForDate('USDILS=X', '2023-06-15');
    expect(result).toEqual({ date: '2023-06-14', rate: 3.65 });
  });

  test('returns null (not a guessed/fabricated rate) when nothing on or before the date falls within the window', async () => {
    mockAxios.get.mockResolvedValueOnce(dailyBarsResponse(['2023-06-20', '2023-06-21'], [3.7, 3.71]));
    const result = await fetchYahooHistoricalRateForDate('USDILS=X', '2023-06-15');
    expect(result).toBeNull();
  });

  test('filters out null closes (a period with no reported bar) rather than treating them as a rate of null/0', async () => {
    mockAxios.get.mockResolvedValueOnce(dailyBarsResponse(['2023-06-14', '2023-06-15'], [3.65, null]));
    const result = await fetchYahooHistoricalRateForDate('USDILS=X', '2023-06-15');
    expect(result).toEqual({ date: '2023-06-14', rate: 3.65 });
  });

  test('returns null for an invalid date string, without making a request', async () => {
    const result = await fetchYahooHistoricalRateForDate('USDILS=X', 'not-a-date');
    expect(result).toBeNull();
    expect(mockAxios.get).not.toHaveBeenCalled();
  });

  test('requests a narrow window (~1 week before to 1 day after the target date), not the huge fromDate-to-today range fetchYahooHistoricalCloses uses', async () => {
    mockAxios.get.mockResolvedValueOnce(dailyBarsResponse(['2023-06-14'], [3.65]));
    await fetchYahooHistoricalRateForDate('USDILS=X', '2023-06-15');
    const params = mockAxios.get.mock.calls[0][1].params;
    const target = Math.floor(new Date('2023-06-15T00:00:00Z').getTime() / 1000);
    expect(params.period1).toBeCloseTo(target - 7 * 24 * 60 * 60, -1);
    expect(params.period2).toBeCloseTo(target + 24 * 60 * 60, -1);
  });
});

// The shared cooldown. Production logs showed every symbol across four
// features failing with 429 one after another, each making its own three
// attempts plus a crumb request - more traffic exactly when Yahoo wanted
// less. Once one request has used up its retries on a 429, the others now
// fail without a request until the cooldown ends.
describe('crumb-authenticated cooldown after a sustained 429', () => {
  let fresh;

  beforeEach(() => {
    jest.resetModules();
    mockAxios.get.mockReset();
    // eslint-disable-next-line global-require
    fresh = require('./yahooQuotes');
  });

  test('after one request exhausts its retries, the next fails at once without a request', async () => {
    mockAxios.get.mockRejectedValue({ response: { status: 429 } });

    await expect(fresh.fetchYahooAssetProfile('NVDA')).rejects.toBeTruthy();
    expect(mockAxios.get).toHaveBeenCalledTimes(3);
    expect(fresh.yahooCooldownState().cooldownUntil).toEqual(expect.any(String));

    await expect(fresh.fetchYahooAssetProfile('PLTR')).rejects.toMatchObject({ code: 'YAHOO_COOLDOWN' });
    expect(mockAxios.get).toHaveBeenCalledTimes(3); // nothing more went out

    fresh.resetYahooCooldown();
    mockAxios.get.mockResolvedValueOnce({
      data: { quoteSummary: { result: [{ assetProfile: { sector: 'Technology', industry: 'Software' } }] } }
    });
    await expect(fresh.fetchYahooAssetProfile('PLTR')).resolves.toEqual({ sector: 'Technology', industry: 'Software' });
  }, 20000);

  test('a non-429 failure does not start a cooldown', async () => {
    mockAxios.get.mockRejectedValue({ response: { status: 500 } });
    await expect(fresh.fetchYahooAssetProfile('NVDA')).rejects.toBeTruthy();
    expect(fresh.yahooCooldownState().cooldownUntil).toBeNull();
  });
});

// Sectors, analyst coverage and the dividend summary in one request - a
// third of the traffic the three separate calls made.
describe('fetchYahooSymbolProfile', () => {
  let fresh;

  beforeEach(() => {
    jest.resetModules();
    mockAxios.get.mockReset();
    // eslint-disable-next-line global-require
    fresh = require('./yahooQuotes');
  });

  test('asks for every module in ONE request and parses each part', async () => {
    mockAxios.get.mockResolvedValueOnce({
      data: {
        quoteSummary: {
          result: [
            {
              assetProfile: { sector: 'Technology', industry: 'Semiconductors' },
              financialData: { recommendationKey: 'buy', targetMeanPrice: 200, numberOfAnalystOpinions: 40 },
              recommendationTrend: { trend: [{ period: '0m', strongBuy: 10, buy: 20, hold: 5, sell: 1, strongSell: 0 }] },
              summaryDetail: { dividendRate: 0.04, dividendYield: 0.0002 },
              calendarEvents: {}
            }
          ]
        }
      }
    });

    const profile = await fresh.fetchYahooSymbolProfile('NVDA');

    expect(mockAxios.get).toHaveBeenCalledTimes(1);
    const modules = mockAxios.get.mock.calls[0][1].params.modules.split(',');
    expect(modules).toEqual(
      expect.arrayContaining(['assetProfile', 'financialData', 'recommendationTrend', 'upgradeDowngradeHistory', 'summaryDetail', 'calendarEvents'])
    );
    expect(profile.sector).toEqual({ sector: 'Technology', industry: 'Semiconductors' });
    expect(profile.analyst).toMatchObject({ recommendationKey: 'buy', targetMeanPrice: 200, numberOfAnalystOpinions: 40 });
    expect(profile.analyst.currentTrend).toMatchObject({ strongBuy: 10, buy: 20 });
    expect(profile.dividendSummary.dividendRate).toBe(0.04);
    expect(profile.dividendSummary.dividendYieldPercent).toBeCloseTo(0.02, 6);
  });

  // An ETF has no sector; that must not cost it its dividend data.
  test('a missing module parses to nulls rather than failing the others', async () => {
    mockAxios.get.mockResolvedValueOnce({ data: { quoteSummary: { result: [{ summaryDetail: { dividendRate: 1.5 } }] } } });
    const profile = await fresh.fetchYahooSymbolProfile('IBIT');
    expect(profile.sector).toEqual({ sector: null, industry: null });
    expect(profile.analyst.recommendationKey).toBeNull();
    expect(profile.dividendSummary.dividendRate).toBe(1.5);
  });
});

// A failed US quote used to come back as null and was swallowed without a
// log line. It now falls back to the last good price, marked stale.
describe('getYahooPayload fallback to the last good price', () => {
  let fresh;

  beforeEach(() => {
    jest.resetModules();
    mockAxios.get.mockReset();
    // eslint-disable-next-line global-require
    fresh = require('./yahooQuotes');
  });

  test('serves the last good quote, marked stale, when a refresh fails', async () => {
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(1_000_000);
    mockAxios.get.mockResolvedValueOnce({ data: { chart: { result: [{ meta: { regularMarketPrice: 100, previousClose: 99 } }] } } });
    const good = await fresh.getYahooPayload('MSFT');
    expect(good.fetchedAt).toEqual(expect.any(String));

    nowSpy.mockReturnValue(1_000_000 + 60_000); // past the 15s cache
    mockAxios.get.mockRejectedValueOnce({ response: { status: 429 }, message: 'Request failed with status code 429' });
    const fallback = await fresh.getYahooPayload('MSFT');
    nowSpy.mockRestore();

    expect(fallback).toEqual({ ...good, stale: true });
  });

  test('still throws when there has never been a good quote', async () => {
    mockAxios.get.mockRejectedValueOnce(new Error('down'));
    await expect(fresh.getYahooPayload('NEVER')).rejects.toThrow('down');
  });
});

// Finnhub is the primary source for US quotes once a key is set; Yahoo is
// the fallback for whatever Finnhub cannot answer.
describe('getYahooPayload with Finnhub configured', () => {
  let fresh;
  const originalKey = process.env.FINNHUB_API_KEY;
  const yahooChart = (price, prev) => ({ data: { chart: { result: [{ meta: { regularMarketPrice: price, previousClose: prev } }] } } });

  beforeEach(() => {
    jest.resetModules();
    mockAxios.get.mockReset();
    process.env.FINNHUB_API_KEY = 'test-key';
    // eslint-disable-next-line global-require
    fresh = require('./yahooQuotes');
  });

  afterAll(() => {
    if (originalKey === undefined) delete process.env.FINNHUB_API_KEY;
    else process.env.FINNHUB_API_KEY = originalKey;
  });

  test('a stock is priced by Finnhub, without asking Yahoo', async () => {
    mockAxios.get.mockResolvedValueOnce({ data: { c: 200, pc: 196, t: 1792440000 } });
    const payload = await fresh.getYahooPayload('NVDA');
    expect(payload).toMatchObject({ currentPrice: 200, source: 'finnhub', tradeDate: '2026-10-19' });
    expect(mockAxios.get).toHaveBeenCalledTimes(1);
    expect(mockAxios.get.mock.calls[0][0]).toContain('finnhub.io');
  });

  test('falls back to Yahoo when Finnhub fails', async () => {
    mockAxios.get
      .mockRejectedValueOnce({ response: { status: 429 }, message: 'Request failed with status code 429' })
      .mockResolvedValueOnce(yahooChart(150, 150));
    const payload = await fresh.getYahooPayload('MSFT');
    expect(payload).toMatchObject({ currentPrice: 150, source: 'yahoo' });
    expect(mockAxios.get.mock.calls[1][0]).toContain('finance.yahoo.com');
  });

  test('an exchange rate never goes to Finnhub', async () => {
    mockAxios.get.mockResolvedValueOnce(yahooChart(3.1, 3.05));
    const payload = await fresh.getYahooPayload('USDILS=X');
    expect(payload).toMatchObject({ currentPrice: 3.1, source: 'yahoo' });
    expect(mockAxios.get.mock.calls[0][0]).toContain('finance.yahoo.com');
  });
});
