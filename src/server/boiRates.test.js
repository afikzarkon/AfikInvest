/**
 * @jest-environment node
 */
const { isBoiSymbol, fetchBoiHistory, parseBoiCsv } = require('./boiRates');

const csv = [
  'SERIES_CODE,FREQ,BASE_CURRENCY,COUNTER_CURRENCY,TIME_PERIOD,OBS_VALUE,RELEASE_STATUS',
  'RER_USD_ILS,D,USD,ILS,2026-10-29,3.114,',
  'RER_USD_ILS,D,USD,ILS,2026-10-28,3.128,',
  'RER_USD_ILS,D,USD,ILS,2026-10-27,3.078,',
  ''
].join('\n');

describe('boiRates', () => {
  test('knows the shekel pairs the Bank publishes', () => {
    expect(isBoiSymbol('USDILS=X')).toBe(true);
    expect(isBoiSymbol('EURILS=X')).toBe(true);
    expect(isBoiSymbol('USDEUR=X')).toBe(false);
    expect(isBoiSymbol('AAPL')).toBe(false);
  });

  test('reads the rates by column name, ascending', () => {
    expect(parseBoiCsv(csv)).toEqual([
      { date: '2026-10-27', close: 3.078 },
      { date: '2026-10-28', close: 3.128 },
      { date: '2026-10-29', close: 3.114 }
    ]);
    expect(parseBoiCsv('"TIME_PERIOD","OBS_VALUE"\n"2026-10-29","3.114"')).toEqual([{ date: '2026-10-29', close: 3.114 }]);
    expect(parseBoiCsv('<html>error</html>')).toEqual([]);
  });

  test('asks for the series from the date, and throws on nothing', async () => {
    const get = jest.fn().mockResolvedValue({ data: csv });
    await expect(fetchBoiHistory('USDILS=X', '2026-10-10', { get })).resolves.toHaveLength(3);
    expect(get.mock.calls[0][0]).toMatch(/\/RER_USD_ILS$/);
    expect(get.mock.calls[0][1].params).toEqual({ startperiod: '2026-10-10', format: 'csv' });
    const empty = jest.fn().mockResolvedValue({ data: '' });
    await expect(fetchBoiHistory('USDILS=X', '2026-10-10', { get: empty })).rejects.toThrow();
  });
});
