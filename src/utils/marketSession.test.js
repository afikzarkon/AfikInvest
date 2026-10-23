import { changeFromPercent, israelToday, tradedToday, effectiveDailyChangePercent, marketSessionState } from './marketSession';
import { calculatePortfolioSummary } from './portfolioSummary';

describe('israelToday', () => {
  test("is Israel's calendar date, not UTC's", () => {
    // 01:30 on Oct 1 in Israel
    expect(israelToday(new Date('2026-09-30T22:30:00Z'))).toBe('2026-10-01');
  });
});

describe('effectiveDailyChangePercent', () => {
  const today = '2026-10-12';

  test("counts a change from today's session", () => {
    expect(effectiveDailyChangePercent({ dailyChangePercent: 1.5, dailyChangeTradeDate: today }, today)).toBe(1.5);
  });

  test("zeroes a change left over from an earlier session", () => {
    expect(effectiveDailyChangePercent({ dailyChangePercent: 1.5, dailyChangeTradeDate: '2026-10-09' }, today)).toBe(0);
  });

  test('keeps a change it has no session date to judge by', () => {
    expect(effectiveDailyChangePercent({ dailyChangePercent: 1.5 }, today)).toBe(1.5);
    expect(tradedToday({ dailyChangePercent: 1.5 }, today)).toBeNull();
  });

  test('treats a missing/garbage change as 0', () => {
    expect(effectiveDailyChangePercent({ dailyChangeTradeDate: today }, today)).toBe(0);
    expect(effectiveDailyChangePercent({ dailyChangePercent: 'x', dailyChangeTradeDate: today }, today)).toBe(0);
  });
});

describe('marketSessionState', () => {
  test("'today' if any lot traded today, 'closed' if none did, null with nothing to judge", () => {
    const today = '2026-10-12';
    expect(marketSessionState([{ dailyChangeTradeDate: today }, { dailyChangeTradeDate: '2026-10-09' }], today)).toBe('today');
    expect(marketSessionState([{ dailyChangeTradeDate: '2026-10-09' }], today)).toBe('closed');
    expect(marketSessionState([{}], today)).toBeNull();
    expect(marketSessionState([], today)).toBeNull();
  });
});

// The three situations the dashboard's daily change has to get right.
describe('portfolio daily change across TASE and US sessions', () => {
  // ₪10,000 of TASE stock and $1,000 (₪3,700) of US stock.
  const israeli = (change, tradeDate) => [
    { stockName: '629014', quantity: 100, purchasePrice: 90, currentPrice: 100, dailyChangePercent: change, dailyChangeTradeDate: tradeDate }
  ];
  const american = (change, tradeDate) => [
    {
      stockName: 'AAPL',
      quantity: 10,
      purchasePrice: 90,
      currentPrice: 100,
      exchangeRate: 3.7,
      currentExchangeRate: 3.7,
      dailyChangePercent: change,
      dailyChangeTradeDate: tradeDate
    }
  ];
  const summarize = (il, us, today) => calculatePortfolioSummary(il, us, [], [], [], {}, [], { today });
  // A day's change on a holding worth v now that moved p%: against the
  // previous close, v / (1 + p).
  const ch = (v, p) => (v * p) / (100 + p);
  // The portfolio's percent: the changes over the previous closes.
  const pct = (...changes) => (changes.reduce((s, c) => s + c, 0) / (13700 - changes.reduce((s, c) => s + c, 0))) * 100;

  test('TASE open, US not yet open: only the Israeli movement counts', () => {
    // Monday morning: TASE trading today, Yahoo still reports Friday's session.
    const s = summarize(israeli(2, '2026-10-12'), american(5, '2026-10-09'), '2026-10-12');
    expect(s.israeliDailyProfitILS).toBeCloseTo(ch(10000, 2), 6);
    expect(s.americanDailyProfitUSD).toBe(0);
    expect(s.weightedDailyChange).toBeCloseTo(pct(ch(10000, 2)), 6);
    expect(s.dailyChangeSessions).toEqual({ israeli: 'today', american: 'closed' });
  });

  test("US open after TASE closed: TASE's closing change for today stays in, alongside US trading", () => {
    const s = summarize(israeli(2, '2026-10-12'), american(-1, '2026-10-12'), '2026-10-12');
    expect(s.weightedDailyChange).toBeCloseTo(pct(ch(10000, 2), ch(3700, -1)), 6);
    expect(s.dailyChangeSessions).toEqual({ israeli: 'today', american: 'today' });
  });

  test('no TASE session today: nothing until the US opens, then US movement only', () => {
    // A TASE holiday: its last session was Friday.
    const beforeUsOpen = summarize(israeli(2, '2026-10-09'), american(5, '2026-10-09'), '2026-10-12');
    expect(beforeUsOpen.weightedDailyChange).toBe(0);
    expect(beforeUsOpen.dailyProfitILS).toBe(0);
    expect(beforeUsOpen.dailyChangeSessions).toEqual({ israeli: 'closed', american: 'closed' });

    const afterUsOpen = summarize(israeli(2, '2026-10-09'), american(-1, '2026-10-12'), '2026-10-12');
    expect(afterUsOpen.israeliDailyProfitILS).toBe(0);
    expect(afterUsOpen.weightedDailyChange).toBeCloseTo(pct(ch(3700, -1)), 6);
  });
});

describe('changeFromPercent', () => {
  test("is the change against the previous close, not the percent of today's value", () => {
    // +10% to 110: it was 100, so the day made 10, not 11.
    expect(changeFromPercent(110, 10)).toBeCloseTo(10, 9);
    expect(changeFromPercent(90, -10)).toBeCloseTo(-10, 9);
    expect(changeFromPercent(1000, 0)).toBe(0);
  });

  test('has no change to report for nonsense input', () => {
    expect(changeFromPercent(100, -100)).toBe(0);
    expect(changeFromPercent(100, NaN)).toBe(0);
    expect(changeFromPercent(undefined, 5)).toBe(0);
  });
});
