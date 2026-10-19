/**
 * @jest-environment node
 */
const {
  isFrankfurterSymbol,
  fetchFrankfurterQuote,
  fetchFrankfurterRateForDate,
  fetchFrankfurterHistory
} = require('./frankfurterClient');

// Shapes recorded from the live API (api.frankfurter.dev/v1).
const range = {
  amount: 1.0,
  base: 'USD',
  start_date: '2026-10-14',
  end_date: '2026-10-16',
  rates: { '2026-10-14': { ILS: 3.0766 }, '2026-10-16': { ILS: 3.1082 }, '2026-10-15': { ILS: 3.1022 } }
};

describe('frankfurterClient', () => {
  test('only Yahoo-style FX pairs are exchange-rate symbols', () => {
    expect(isFrankfurterSymbol('USDILS=X')).toBe(true);
    expect(isFrankfurterSymbol('EURILS=X')).toBe(true);
    expect(isFrankfurterSymbol('AAPL')).toBe(false);
    expect(isFrankfurterSymbol('^GSPC')).toBe(false);
  });

  test('the latest rate, with the change from the working day before', async () => {
    const get = jest.fn().mockResolvedValue({ data: range });
    const q = await fetchFrankfurterQuote('USDILS=X', { get });
    expect(q.currentPrice).toBe(3.1082);
    expect(q.tradeDate).toBe('2026-10-16');
    expect(q.changePercent).toBeCloseTo(((3.1082 - 3.1022) / 3.1022) * 100, 6);
    expect(get.mock.calls[0][1].params).toEqual({ base: 'USD', symbols: 'ILS' });
  });

  // A Saturday asks for Saturday and gets Friday's rate, dated Friday.
  test('the rate on a date is the one the API dates it to', async () => {
    const get = jest.fn().mockResolvedValue({ data: { amount: 1, base: 'USD', date: '2023-06-16', rates: { ILS: 3.5586 } } });
    await expect(fetchFrankfurterRateForDate('USDILS=X', '2023-06-17', { get })).resolves.toEqual({ date: '2023-06-16', rate: 3.5586 });
    expect(get.mock.calls[0][0]).toContain('/v1/2023-06-17');
  });

  test('a history comes back ascending, in the Yahoo closes shape', async () => {
    const get = jest.fn().mockResolvedValue({ data: range });
    const points = await fetchFrankfurterHistory('USDILS=X', '2026-10-14', { get });
    expect(points).toEqual([
      { date: '2026-10-14', close: 3.0766 },
      { date: '2026-10-15', close: 3.1022 },
      { date: '2026-10-16', close: 3.1082 }
    ]);
    expect(get.mock.calls[0][0]).toContain('/v1/2026-10-14..');
  });

  test('a stock symbol is refused rather than sent', async () => {
    const get = jest.fn();
    await expect(fetchFrankfurterQuote('AAPL', { get })).rejects.toThrow('not an exchange-rate symbol');
    expect(get).not.toHaveBeenCalled();
  });
});
