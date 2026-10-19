/**
 * @jest-environment node
 */
const {
  fetchFinnhubQuote,
  isFinnhubEnabled,
  isFinnhubSymbol,
  toFinnhubSymbol,
  resetFinnhubBudget,
  CALLS_PER_MINUTE
} = require('./finnhubQuotes');

const quoteResponse = (q) => ({ data: q });

describe('finnhubQuotes', () => {
  const originalKey = process.env.FINNHUB_API_KEY;

  beforeEach(() => {
    process.env.FINNHUB_API_KEY = 'test-key';
    resetFinnhubBudget();
  });

  afterAll(() => {
    if (originalKey === undefined) delete process.env.FINNHUB_API_KEY;
    else process.env.FINNHUB_API_KEY = originalKey;
  });

  test('is off without a key', async () => {
    delete process.env.FINNHUB_API_KEY;
    expect(isFinnhubEnabled()).toBe(false);
    const get = jest.fn();
    await expect(fetchFinnhubQuote('AAPL', { get })).rejects.toThrow('not configured');
    expect(get).not.toHaveBeenCalled();
  });

  test('parses a quote, computing the change from the two prices', async () => {
    const get = jest.fn().mockResolvedValue(
      // 2026-10-19 20:00 UTC = 16:00 in New York
      quoteResponse({ c: 101, d: 1, dp: 1, h: 102, l: 99, o: 100, pc: 100, t: 1792440000 })
    );
    const quote = await fetchFinnhubQuote('AAPL', { get });
    expect(quote.currentPrice).toBe(101);
    expect(quote.changePercent).toBeCloseTo(1, 6);
    expect(quote.tradeDate).toBe('2026-10-19');
  });

  // The key never goes into the URL, where it could end up in a log.
  test('sends the key as a header, not in the query string', async () => {
    const get = jest.fn().mockResolvedValue(quoteResponse({ c: 10, pc: 10, t: 0 }));
    await fetchFinnhubQuote('MSFT', { get });
    const [url, config] = get.mock.calls[0];
    expect(url).not.toContain('test-key');
    expect(config.params).toEqual({ symbol: 'MSFT' });
    expect(config.headers['X-Finnhub-Token']).toBe('test-key');
  });

  // Finnhub answers an unknown symbol with 200 and zeros, not an error.
  test('a zeroed answer is "no quote", so the caller falls back to Yahoo', async () => {
    const get = jest.fn().mockResolvedValue(quoteResponse({ c: 0, d: null, dp: null, h: 0, l: 0, o: 0, pc: 0, t: 0 }));
    await expect(fetchFinnhubQuote('NOPE', { get })).rejects.toThrow('no quote');
  });

  test('stays inside the free plan per-minute budget', async () => {
    const get = jest.fn().mockResolvedValue(quoteResponse({ c: 10, pc: 10, t: 0 }));
    for (let i = 0; i < CALLS_PER_MINUTE; i += 1) await fetchFinnhubQuote('AAPL', { get });
    await expect(fetchFinnhubQuote('AAPL', { get })).rejects.toMatchObject({ code: 'FINNHUB_BUDGET' });
    expect(get).toHaveBeenCalledTimes(CALLS_PER_MINUTE);
  });

  test('only stock tickers go to Finnhub; FX pairs and indices stay on Yahoo', () => {
    expect(isFinnhubSymbol('AAPL')).toBe(true);
    expect(isFinnhubSymbol('BRK-B')).toBe(true);
    expect(isFinnhubSymbol('USDILS=X')).toBe(false);
    expect(isFinnhubSymbol('^GSPC')).toBe(false);
    expect(toFinnhubSymbol('BRK-B')).toBe('BRK.B');
  });
});
