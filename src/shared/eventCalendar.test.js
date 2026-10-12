const {
  dividendRhythm,
  projectDividendEvents,
  mergeEvents,
  eventsFromYahooCalendar,
  buildHoldingEvents,
  remindersDue,
  buildEventReminderAlert
} = require('./eventCalendar');

const quarterly = [
  { date: '2025-02-10', amountPerShare: 0.25 },
  { date: '2025-05-12', amountPerShare: 0.25 },
  { date: '2025-08-11', amountPerShare: 0.26 },
  { date: '2025-11-10', amountPerShare: 0.26 },
  { date: '2026-02-09', amountPerShare: 0.26 }
];
const epoch = (d) => Date.parse(`${d}T00:00:00Z`) / 1000;

describe('dividendRhythm', () => {
  test('recognizes a quarterly payer with high confidence', () => {
    const r = dividendRhythm(quarterly, { today: '2026-03-01' });
    expect(r).toMatchObject({ intervalDays: 91, cadence: 91, lastExDate: '2026-02-09' });
    expect(r.confidence).toBeGreaterThan(0.8);
  });
  test('irregular history gets low confidence; a suspended dividend none', () => {
    const irregular = [
      { date: '2024-01-01', amountPerShare: 1 },
      { date: '2024-02-15', amountPerShare: 1 },
      { date: '2024-09-01', amountPerShare: 1 },
      { date: '2024-11-01', amountPerShare: 1 }
    ];
    expect(dividendRhythm(irregular, { today: '2024-12-01' }).confidence).toBeLessThan(0.3);
    expect(dividendRhythm(quarterly, { today: '2027-06-01' })).toBeNull();
    expect(dividendRhythm(quarterly.slice(0, 1))).toBeNull();
  });
});

test('projects future ex-dates and payment dates at the observed rhythm', () => {
  const events = projectDividendEvents({ symbol: 'KO', market: 'US', currency: 'USD', history: quarterly, today: '2026-03-01', horizonDays: 200, payLagDays: 20 });
  expect(events.filter((e) => e.eventType === 'EX_DIVIDEND').map((e) => e.eventDate)).toEqual(['2026-05-11', '2026-08-10']);
  expect(events.filter((e) => e.eventType === 'DIVIDEND_PAYMENT').map((e) => e.eventDate)).toEqual(['2026-05-31', '2026-08-30']);
  expect(events[0]).toMatchObject({ status: 'projected', source: 'projection', amountPerShare: 0.26 });
});

test('an announced event supersedes a projection within 10 days', () => {
  const projected = [
    { eventType: 'EX_DIVIDEND', eventDate: '2026-05-11', status: 'projected' },
    { eventType: 'EX_DIVIDEND', eventDate: '2026-08-10', status: 'projected' }
  ];
  const merged = mergeEvents([{ eventType: 'EX_DIVIDEND', eventDate: '2026-05-14', status: 'confirmed' }], projected);
  expect(merged.map((e) => [e.eventDate, e.status])).toEqual([
    ['2026-05-14', 'confirmed'],
    ['2026-08-10', 'projected']
  ]);
});

test('reads Yahoo calendarEvents (raw or wrapped numbers)', () => {
  const events = eventsFromYahooCalendar({
    symbol: 'AAPL',
    calendarEvents: {
      earnings: { earningsDate: [{ raw: epoch('2026-10-29') }, epoch('2026-11-02')], isEarningsDateEstimate: true },
      exDividendDate: { raw: epoch('2026-11-09') },
      dividendDate: epoch('2026-11-13')
    }
  });
  expect(events.map((e) => [e.eventType, e.eventDate, e.status])).toEqual([
    ['EARNINGS', '2026-10-29', 'estimated'],
    ['EX_DIVIDEND', '2026-11-09', 'confirmed'],
    ['DIVIDEND_PAYMENT', '2026-11-13', 'confirmed']
  ]);
  expect(events[0].eventDateEnd).toBe('2026-11-02');
});

test('buildHoldingEvents uses the announced ex->pay lag and last amount', () => {
  const calendar = { calendarEvents: { exDividendDate: epoch('2026-05-12'), dividendDate: epoch('2026-06-01') } };
  const events = buildHoldingEvents({ symbol: 'KO', market: 'US', currency: 'USD', calendar, history: quarterly, today: '2026-03-01', horizonDays: 200 });
  const ex = events.filter((e) => e.eventType === 'EX_DIVIDEND');
  expect(ex.map((e) => [e.eventDate, e.status])).toEqual([
    ['2026-05-12', 'confirmed'],
    ['2026-08-10', 'projected']
  ]);
  expect(ex[0].amountPerShare).toBe(0.26);
  const pay = events.filter((e) => e.eventType === 'DIVIDEND_PAYMENT');
  expect(pay.map((e) => e.eventDate)).toEqual(['2026-06-01', '2026-08-30']);
});

test('reminders: earnings T-7 and T-1, ex-dividend T-2', () => {
  const events = [
    { eventType: 'EARNINGS', eventDate: '2026-03-08' },
    { eventType: 'EARNINGS', eventDate: '2026-03-02' },
    { eventType: 'EX_DIVIDEND', eventDate: '2026-03-03' },
    { eventType: 'EX_DIVIDEND', eventDate: '2026-03-04' },
    { eventType: 'DIVIDEND_PAYMENT', eventDate: '2026-03-02' }
  ];
  expect(remindersDue(events, '2026-03-01').map((r) => [r.event.eventType, r.event.eventDate, r.daysBefore])).toEqual([
    ['EARNINGS', '2026-03-08', 7],
    ['EARNINGS', '2026-03-02', 1],
    ['EX_DIVIDEND', '2026-03-03', 2]
  ]);
});

test('ex-dividend reminder states the expected payout for the units held', () => {
  const alert = buildEventReminderAlert({
    userId: 3,
    instrument: { symbol: 'KO', market: 'US', name: 'Coca-Cola' },
    event: { eventType: 'EX_DIVIDEND', eventDate: '2026-03-03', amountPerShare: 0.5, currency: 'USD', status: 'projected' },
    daysBefore: 2,
    units: 100,
    fxRate: 3.6
  });
  expect(alert).toMatchObject({ type: 'EVENT_UPCOMING', severity: 'info', dedupKey: '3:KO:EVENT_UPCOMING:EX_DIVIDEND:2026-03-03:T-2' });
  expect(alert.message).toMatch(/50\.00 USD/);
  expect(alert.message).toMatch(/₪180/);
  expect(alert.message).toMatch(/משוער/);
});
