/**
 * @jest-environment node
 */
jest.mock('./sourceHealth', () => ({ sourceHealth: { success: jest.fn(), failure: jest.fn() } }));
jest.mock('./finnhubClient', () => ({
  isFinnhubEnabled: jest.fn(),
  fetchFinnhubProfile: jest.fn(),
  fetchFinnhubMetrics: jest.fn(),
  fetchFinnhubRecommendation: jest.fn(),
  fetchFinnhubPeers: jest.fn()
}));
jest.mock('./finnhubQuotes', () => ({ fetchFinnhubQuote: jest.fn() }));
jest.mock('./fmpClient', () => ({ isFmpEnabled: jest.fn(), fetchFmpProfile: jest.fn(), fetchFmpRatiosTtm: jest.fn() }));
jest.mock('./tiingoClient', () => ({
  isTiingoEnabled: jest.fn(),
  fetchTiingoDividendHistory: jest.fn(),
  fetchTiingoDividendSummary: jest.fn(),
  fetchTiingoDailyRows: jest.fn()
}));

const finnhub = require('./finnhubClient');
const finnhubQuotes = require('./finnhubQuotes');
const fmp = require('./fmpClient');
const tiingo = require('./tiingoClient');
const m = require('./marketDataFallbacks');

const logger = { warn: jest.fn() };
const enable = ({ finnhubOn = true, fmpOn = true, tiingoOn = true } = {}) => {
  finnhub.isFinnhubEnabled.mockReturnValue(finnhubOn);
  fmp.isFmpEnabled.mockReturnValue(fmpOn);
  tiingo.isTiingoEnabled.mockReturnValue(tiingoOn);
};

beforeEach(() => {
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  console.warn.mockRestore();
});

describe('sector', () => {
  test('Finnhub industries map onto the sectors the app groups by', () => {
    expect(m.sectorFromFinnhubIndustry('Semiconductors')).toBe('Technology');
    expect(m.sectorFromFinnhubIndustry('Banking')).toBe('Financial Services');
    expect(m.sectorFromFinnhubIndustry('Something new')).toBeNull();
  });

  test('an industry Finnhub has but cannot be mapped is asked of FMP', async () => {
    enable();
    finnhub.fetchFinnhubProfile.mockResolvedValue({ industry: 'Something new' });
    fmp.fetchFmpProfile.mockResolvedValue({ sector: 'Industrials', industry: 'Specialty' });
    await expect(m.fetchSectorFallback('XYZ')).resolves.toEqual({ sector: 'Industrials', industry: 'Specialty' });
  });
});

describe('analyst ratings from Finnhub', () => {
  test('the consensus key follows the rating counts', () => {
    expect(m.recommendationKeyFromTrend({ strongBuy: 20, buy: 10, hold: 2, sell: 0, strongSell: 0 })).toBe('strong_buy');
    expect(m.recommendationKeyFromTrend({ strongBuy: 2, buy: 10, hold: 5, sell: 0, strongSell: 0 })).toBe('buy');
    expect(m.recommendationKeyFromTrend({ strongBuy: 0, buy: 1, hold: 10, sell: 2, strongSell: 0 })).toBe('hold');
    expect(m.recommendationKeyFromTrend({})).toBeNull();
  });

  test('price targets are not invented: Finnhub free has none', async () => {
    finnhub.fetchFinnhubRecommendation.mockResolvedValue([{ period: '2026-10-01', strongBuy: 10, buy: 20, hold: 5, sell: 1, strongSell: 0 }]);
    const a = await m.fetchAnalystFallback('NVDA');
    expect(a.numberOfAnalystOpinions).toBe(36);
    expect(a.currentTrend).toMatchObject({ strongBuy: 10, buy: 20 });
    expect(a.targetMeanPrice).toBeNull();
  });
});

describe('fetchProfileWithFallbacks', () => {
  test('Yahoo answers: its profile is used as it is', async () => {
    enable();
    const yahoo = { sector: { sector: 'Technology', industry: 'Software' }, analyst: {}, dividendSummary: {} };
    const p = await m.fetchProfileWithFallbacks('MSFT', { fetchYahooProfile: async () => yahoo, logger });
    expect(p).toEqual({ ...yahoo, source: 'yahoo' });
    expect(finnhub.fetchFinnhubProfile).not.toHaveBeenCalled();
  });

  test('Yahoo answers without a sector: only the sector is asked of the fallbacks', async () => {
    enable();
    finnhub.fetchFinnhubProfile.mockResolvedValue({ industry: 'Semiconductors' });
    const yahoo = { sector: { sector: null, industry: null }, analyst: { recommendationKey: 'buy' }, dividendSummary: {} };
    const p = await m.fetchProfileWithFallbacks('MU', { fetchYahooProfile: async () => yahoo, logger });
    expect(p.sector).toEqual({ sector: 'Technology', industry: 'Semiconductors' });
    expect(p.analyst).toEqual({ recommendationKey: 'buy' });
  });

  test('Yahoo fails: each part comes from its own fallback', async () => {
    enable();
    finnhub.fetchFinnhubProfile.mockResolvedValue({ industry: 'Technology' });
    // Mean (2*1 + 8*2) / 10 = 1.8 on the 1-5 scale: "buy".
    finnhub.fetchFinnhubRecommendation.mockResolvedValue([{ strongBuy: 2, buy: 8, hold: 0, sell: 0, strongSell: 0 }]);
    tiingo.fetchTiingoDividendSummary.mockResolvedValue({ dividendRate: 3.2 });
    const p = await m.fetchProfileWithFallbacks('AAPL', {
      fetchYahooProfile: async () => { throw new Error('429'); },
      logger
    });
    expect(p.source).toBe('fallback');
    expect(p.sector.sector).toBe('Technology');
    expect(p.analyst.recommendationKey).toBe('buy');
    expect(p.dividendSummary.dividendRate).toBe(3.2);
  });

  test('Yahoo fails and no fallback has a key: it fails, so the last known profile is served (symbolCache)', async () => {
    enable({ finnhubOn: false, fmpOn: false, tiingoOn: false });
    await expect(
      m.fetchProfileWithFallbacks('AAPL', { fetchYahooProfile: async () => { throw new Error('429'); }, logger })
    ).rejects.toThrow('every fallback failed');
  });
});

describe('dividend history', () => {
  test('Yahoo failing goes to Tiingo', async () => {
    enable();
    tiingo.fetchTiingoDividendHistory.mockResolvedValue([{ date: '2026-08-10', amountPerShare: 0.26 }]);
    const rows = await m.fetchDividendHistoryWithFallbacks('AAPL', '2026-01-01', {
      fetchYahooHistory: async () => { throw new Error('down'); }
    });
    expect(rows).toEqual([{ date: '2026-08-10', amountPerShare: 0.26 }]);
  });

  // A company that pays nothing is empty everywhere - an answer, not an error.
  test('empty at Yahoo and at Tiingo is an empty history, not a failure', async () => {
    enable();
    tiingo.fetchTiingoDividendHistory.mockResolvedValue([]);
    await expect(
      m.fetchDividendHistoryWithFallbacks('TSLA', null, { fetchYahooHistory: async () => [] })
    ).resolves.toEqual([]);
  });
});

describe('valuation summary: Finnhub -> FMP -> Yahoo', () => {
  test('Finnhub first, with its own P/FCF and a mapped sector', async () => {
    enable();
    finnhub.fetchFinnhubProfile.mockResolvedValue({ name: 'NVIDIA', currency: 'USD', industry: 'Semiconductors', marketCap: 4e12, sharesOutstanding: 2.4e10 });
    finnhub.fetchFinnhubMetrics.mockResolvedValue({ trailingPE: 50, priceToSales: 25, priceToFreeCashFlow: 60, beta: 1.7 });
    finnhubQuotes.fetchFinnhubQuote.mockResolvedValue({ currentPrice: 180 });
    const yahoo = jest.fn();
    const s = await m.fetchValuationSummaryWithFallbacks('NVDA', { fetchYahooSummary: yahoo });
    expect(s).toMatchObject({ source: 'finnhub', price: 180, trailingPE: 50, priceToFreeCashFlow: 60, sector: 'Technology' });
    expect(yahoo).not.toHaveBeenCalled();
  });

  test('Finnhub failing goes to FMP, and both failing to Yahoo', async () => {
    enable();
    finnhub.fetchFinnhubProfile.mockRejectedValue(new Error('429'));
    fmp.fetchFmpProfile.mockRejectedValue(new Error('402'));
    const yahoo = jest.fn().mockResolvedValue({ price: 100, trailingPE: 20 });
    const s = await m.fetchValuationSummaryWithFallbacks('AAPL', { fetchYahooSummary: yahoo });
    expect(s).toMatchObject({ source: 'yahoo-summary', price: 100 });
  });
});

describe('monthly prices from Tiingo', () => {
  // Tiingo's close is the raw price; Yahoo's is split-adjusted. A 4:1 split
  // must not read as the price falling by three quarters.
  test('closes are adjusted for later splits, and the splits are listed', () => {
    const rows = [
      { date: '2024-05-31T00:00:00.000Z', close: 400, splitFactor: 1 },
      { date: '2024-06-10T00:00:00.000Z', close: 100, splitFactor: 4 },
      { date: '2024-06-28T00:00:00.000Z', close: 110, splitFactor: 1 }
    ];
    const r = m.monthlyFromTiingoRows(rows);
    expect(r.splits).toEqual([{ date: '2024-06-10', ratio: 4 }]);
    expect(r.closes).toEqual([
      { date: '2024-05-31', close: 100 },
      { date: '2024-06-30', close: 110 }
    ]);
    expect(r.meta.price).toBe(110);
  });
});
