const { reportingMonthFor, savableMonths, asOfRange, defaultAsOfDate, isValidAsOfDate, GRACE_DAYS } = require('./reportingMonth');

// A month's report is taken once the next month has begun - provident funds
// publish their month-end figures in its first days.
describe('which month a save is for', () => {
  test('the first 10 days of a month report the month that just ended', () => {
    expect(GRACE_DAYS).toBe(10);
    expect(reportingMonthFor('2026-11-07')).toBe('2026-10');
    expect(savableMonths('2026-11-07')).toEqual(['2026-10', '2026-11']);
  });

  test('after that, only the month in progress', () => {
    expect(reportingMonthFor('2026-11-11')).toBe('2026-11');
    expect(savableMonths('2026-11-11')).toEqual(['2026-11']);
  });

  test('across a year end', () => {
    expect(reportingMonthFor('2027-01-03')).toBe('2026-12');
  });
});

describe('the dates a month\'s report may carry', () => {
  test('October may be dated as late as November 10th, never in the future', () => {
    expect(asOfRange('2026-10', '2026-11-07')).toEqual({ min: '2026-10-01', max: '2026-11-07' });
    expect(asOfRange('2026-10', '2026-12-01')).toEqual({ min: '2026-10-01', max: '2026-11-10' });
    expect(isValidAsOfDate('2026-10', '2026-11-01', '2026-11-07')).toBe(true);
    expect(isValidAsOfDate('2026-10', '2026-11-08', '2026-11-07')).toBe(false);
    expect(isValidAsOfDate('2026-10', '2026-09-30', '2026-11-07')).toBe(false);
  });

  test('February in a leap year runs to March 10th', () => {
    expect(asOfRange('2028-02', '2028-06-01').max).toBe('2028-03-10');
  });

  test('a save made now defaults to today; a month filled in long after, to its last day', () => {
    expect(defaultAsOfDate('2026-10', '2026-11-07')).toBe('2026-11-07');
    expect(defaultAsOfDate('2026-08', '2026-11-07')).toBe('2026-08-31');
  });
});
