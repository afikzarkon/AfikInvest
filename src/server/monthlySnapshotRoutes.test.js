const { resolveAsOfDate, serializeBreakdown, inferAsOfDate, withAsOfDates } = require('./monthlySnapshotRoutes');
const { dateInTimeZone } = require('./marketCalendar');

describe('resolveAsOfDate', () => {
  test('keeps a date inside its own past month', () => {
    expect(resolveAsOfDate('2024-02', '2024-02-10')).toBe('2024-02-10');
  });

  test('keeps a date in the first 10 days of the next month (a month\'s report taken once it has ended)', () => {
    expect(resolveAsOfDate('2024-02', '2024-03-01')).toBe('2024-03-01');
    expect(resolveAsOfDate('2024-02', '2024-03-10')).toBe('2024-03-10');
  });

  test("replaces a date outside the allowed range with the month's last day", () => {
    expect(resolveAsOfDate('2024-02', '2024-03-11')).toBe('2024-02-29');
    expect(resolveAsOfDate('2024-02', '2024-01-31')).toBe('2024-02-29');
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

// A month saved before checkpoints recorded their date: the automatic save
// wrote that day's daily snapshot with the same total at the same moment.
describe('recovering the date of an undated month', () => {
  const daily = [
    { date: '2026-09-30', totalValueILS: 100000 },
    { date: '2026-10-01', totalValueILS: 101234.56 },
    { date: '2026-10-02', totalValueILS: 101500 },
    { date: '2026-10-20', totalValueILS: 111234.56 },
    { date: '2026-11-01', totalValueILS: 101234.56 }
  ];

  test('is the day of the daily snapshot in that month with the same total', () => {
    expect(inferAsOfDate({ month: '2026-10', totalValueILS: 101234.56 }, daily)).toBe('2026-10-01');
  });

  test('looks only inside the month itself', () => {
    expect(inferAsOfDate({ month: '2026-09', totalValueILS: 101234.56 }, daily)).toBeNull();
  });

  test('is none when no total matches (a month filled in later, valued at its end)', () => {
    expect(inferAsOfDate({ month: '2026-10', totalValueILS: 99999 }, daily)).toBeNull();
  });

  test('a recorded date always wins, and only an undated month is marked as inferred', () => {
    const out = withAsOfDates(
      [
        { month: '2026-10', totalValueILS: 101234.56, breakdown: { asOfDate: '2026-10-05' } },
        { month: '2026-10', totalValueILS: 101234.56, breakdown: {} },
        { month: '2026-10', totalValueILS: 5, breakdown: null }
      ],
      daily
    );
    expect(out[0].asOfDate).toBe('2026-10-05');
    expect(out[0].asOfDateInferred).toBeUndefined();
    expect(out[1].asOfDate).toBe('2026-10-01');
    expect(out[1].asOfDateInferred).toBe(true);
    expect(out[2].asOfDate).toBeNull();
  });
});

// POST /api/portfolio-monthly-snapshot: which month it files the save under.
describe('saving a month\'s report', () => {
  const { mountMonthlySnapshotRoutes } = require('./monthlySnapshotRoutes');
  const reporting = require('../shared/reportingMonth');
  const today = dateInTimeZone(new Date(), 'Asia/Jerusalem');

  function postHandler(store) {
    const routes = {};
    const app = { post: (path, ...h) => { routes[`POST ${path}`] = h; }, get() {}, put() {}, delete() {} };
    mountMonthlySnapshotRoutes(app, store);
    const handlers = routes['POST /api/portfolio-monthly-snapshot'];
    return (body) =>
      new Promise((resolve) => {
        const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(b) { resolve({ status: this.statusCode, body: b }); } };
        // Skip the auth middleware - it is not what is under test.
        handlers[handlers.length - 1]({ body, user: { id: 1 } }, res);
      });
  }

  test('files it under the month the client chose, when that month may be saved today', async () => {
    const store = { upsertMonthlySnapshot: jest.fn().mockResolvedValue() };
    const post = postHandler(store);
    const month = reporting.savableMonths(today)[0];
    const out = await post({ month, totalValueILS: 1000, breakdown: { asOfDate: today } });
    expect(out.body).toEqual({ ok: true, month, asOfDate: today });
    expect(store.upsertMonthlySnapshot.mock.calls[0][1]).toBe(month);
  });

  test('refuses a month that may not be saved today', async () => {
    const store = { upsertMonthlySnapshot: jest.fn() };
    const out = await postHandler(store)({ month: '2001-01', totalValueILS: 1000 });
    expect(out.status).toBe(400);
    expect(store.upsertMonthlySnapshot).not.toHaveBeenCalled();
  });

  test('an older client that sends no month saves this month', async () => {
    const store = { upsertMonthlySnapshot: jest.fn().mockResolvedValue() };
    const out = await postHandler(store)({ totalValueILS: 1000 });
    expect(out.body.month).toBe(today.slice(0, 7));
  });
});
