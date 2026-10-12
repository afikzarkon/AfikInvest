const { resolveAsOfDate, serializeBreakdown } = require('./monthlySnapshotRoutes');
const { dateInTimeZone } = require('./marketCalendar');

describe('resolveAsOfDate', () => {
  test('keeps a date inside its own past month', () => {
    expect(resolveAsOfDate('2024-02', '2024-02-10')).toBe('2024-02-10');
  });

  test("replaces a date outside the month with the month's last day", () => {
    expect(resolveAsOfDate('2024-02', '2024-03-01')).toBe('2024-02-29');
    expect(resolveAsOfDate('2024-02', 'garbage')).toBe('2024-02-29');
    expect(resolveAsOfDate('2024-02', undefined)).toBe('2024-02-29');
  });

  test('never dates the current month into the future', () => {
    const today = dateInTimeZone(new Date(), 'Asia/Jerusalem');
    const month = today.slice(0, 7);
    expect(resolveAsOfDate(month, `${month}-31`) <= today).toBe(true);
    expect(resolveAsOfDate(month, undefined) <= today).toBe(true);
  });
});

describe('serializeBreakdown', () => {
  test('stores the date next to the rest of the breakdown', () => {
    expect(JSON.parse(serializeBreakdown({ bank: [], cashFlows: { bank: 5 } }, '2024-02-10'))).toEqual({
      bank: [],
      cashFlows: { bank: 5 },
      asOfDate: '2024-02-10'
    });
  });

  test("drops a client-sent date when the server resolved none", () => {
    expect(JSON.parse(serializeBreakdown({ asOfDate: '2099-01-01' }, null))).toEqual({});
  });
});
