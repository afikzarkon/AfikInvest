const { lastSessionDate, tradeDateFromYahooMeta, dateInTimeZone } = require('./marketCalendar');

// 2026-10-09 is a Friday, 2026-10-12 a Monday. Israel is UTC+3 and New
// York UTC-4 on all of these dates.
describe('lastSessionDate', () => {
  test('US: before the 09:30 open, the latest session is the previous trading day', () => {
    // Monday 08:00 New York
    expect(lastSessionDate('us', new Date('2026-10-12T12:00:00Z'))).toBe('2026-10-09');
  });

  test('US: once open, the session is today', () => {
    // Monday 10:00 New York
    expect(lastSessionDate('us', new Date('2026-10-12T14:00:00Z'))).toBe('2026-10-12');
  });

  test('US: a weekend reads as Friday', () => {
    expect(lastSessionDate('us', new Date('2026-10-10T18:00:00Z'))).toBe('2026-10-09');
    expect(lastSessionDate('us', new Date('2026-10-11T18:00:00Z'))).toBe('2026-10-09');
  });

  test('TASE trades Monday-Friday since 2026: a Sunday reads as Friday', () => {
    // Sunday 11:00 Israel
    expect(lastSessionDate('tase', new Date('2026-10-11T08:00:00Z'))).toBe('2026-10-09');
    // Monday 11:00 Israel
    expect(lastSessionDate('tase', new Date('2026-10-12T08:00:00Z'))).toBe('2026-10-12');
    // Monday 08:00 Israel, before the open
    expect(lastSessionDate('tase', new Date('2026-10-12T05:00:00Z'))).toBe('2026-10-09');
  });

  test('TASE before the switch traded Sunday-Thursday', () => {
    // Sunday 2025-06-01, 11:00 Israel
    expect(lastSessionDate('tase', new Date('2025-06-01T08:00:00Z'))).toBe('2025-06-01');
    // Saturday 2025-05-31 reads as Thursday 2025-05-29
    expect(lastSessionDate('tase', new Date('2025-05-31T08:00:00Z'))).toBe('2025-05-29');
  });
});

describe('tradeDateFromYahooMeta', () => {
  test("reads regularMarketTime in the exchange's own time zone", () => {
    // 16:00 New York on Friday the 9th
    const close = Date.UTC(2026, 9, 9, 20, 0) / 1000;
    expect(tradeDateFromYahooMeta({ regularMarketTime: close, exchangeTimezoneName: 'America/New_York' })).toBe(
      '2026-10-09'
    );
    // 01:00 UTC on the 10th is still the 9th in New York
    const lateUtc = Date.UTC(2026, 9, 10, 1, 0) / 1000;
    expect(tradeDateFromYahooMeta({ regularMarketTime: lateUtc, exchangeTimezoneName: 'America/New_York' })).toBe(
      '2026-10-09'
    );
  });

  test('returns null when the meta has no usable timestamp', () => {
    expect(tradeDateFromYahooMeta({})).toBeNull();
    expect(tradeDateFromYahooMeta(null)).toBeNull();
  });
});

test('dateInTimeZone uses the zone, not UTC', () => {
  // 22:30 UTC on Sept 30 is already Oct 1 in Israel
  expect(dateInTimeZone(new Date('2026-09-30T22:30:00Z'), 'Asia/Jerusalem')).toBe('2026-10-01');
});
