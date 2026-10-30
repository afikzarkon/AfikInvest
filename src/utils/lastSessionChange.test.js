import { computeLastSessionChange, lastCompletedCloses, marketToday, symbolsNeedingHistory } from './lastSessionChange';

// Sunday 2026-10-18, 10:00 in Israel (03:00 in New York): no market has
// traded today; both last sessions were Friday the 16th.
const SUNDAY = new Date('2026-10-18T07:00:00Z');
// Tuesday 2026-10-20, 12:00 in Israel: TASE is trading today.
const TUESDAY_NOON = new Date('2026-10-20T09:00:00Z');

const il = (id, extra = {}) => ({ id, stockName: '1159250', purchaseDate: '2026-01-05', purchasePrice: 80, quantity: 10, currentPrice: 110, dailyChangePercent: 10, dailyChangeTradeDate: '2026-10-16', ...extra });
const us = (id, extra = {}) => ({ id, stockName: 'voo', purchaseDate: '2026-01-05', purchasePrice: 500, exchangeRate: 3.6, quantity: 2, currentPrice: 110, currentExchangeRate: 3.9, dailyChangePercent: 10, dailyChangeTradeDate: '2026-10-16', ...extra });

describe('marketToday', () => {
  it('reads each market on its own calendar', () => {
    // 01:00 in Israel on the 19th is still the 18th in New York.
    const late = new Date('2026-10-18T22:00:00Z');
    expect(marketToday('israeli', late)).toBe('2026-10-19');
    expect(marketToday('american', late)).toBe('2026-10-18');
  });
});

describe('lastCompletedCloses', () => {
  it('takes a session before today from the quote itself', () => {
    expect(lastCompletedCloses({ quote: { tradeDate: '2026-10-16', price: 110, changePercent: 10 }, today: '2026-10-18' })).toEqual({ date: '2026-10-16', close: 110, prevDate: null, prevClose: expect.closeTo(100, 9) });
  });

  it("takes a past session from the closes, not from the quote's change", () => {
    // Before the open the quote already reads the session as nearly flat.
    const quote = { tradeDate: '2026-10-16', price: 110, changePercent: 0.1 };
    const closes = [
      { date: '2026-10-15', close: 100 },
      { date: '2026-10-16', close: 110 }
    ];
    expect(lastCompletedCloses({ quote, closes, today: '2026-10-18' })).toEqual({ date: '2026-10-16', close: 110, prevDate: '2026-10-15', prevClose: 100 });
  });

  it("falls back to the quote when the closes do not reach its session yet", () => {
    const quote = { tradeDate: '2026-10-16', price: 110, changePercent: 10 };
    const closes = [
      { date: '2026-10-14', close: 90 },
      { date: '2026-10-15', close: 100 }
    ];
    expect(lastCompletedCloses({ quote, closes, today: '2026-10-18' })).toEqual({ date: '2026-10-16', close: 110, prevDate: null, prevClose: expect.closeTo(100, 9) });
  });

  it("takes today's market's previous two sessions from the closes", () => {
    const closes = [
      { date: '2026-10-15', close: 95 },
      { date: '2026-10-19', close: 105 },
      { date: '2026-10-16', close: 100 },
      { date: '2026-10-20', close: 999 }
    ];
    expect(lastCompletedCloses({ quote: { tradeDate: '2026-10-20' }, closes, today: '2026-10-20' })).toEqual({ date: '2026-10-19', close: 105, prevDate: '2026-10-16', prevClose: 100 });
  });

  it('has nothing to say without a session date or enough closes', () => {
    expect(lastCompletedCloses({ quote: { price: 1, changePercent: 1 }, today: '2026-10-18' })).toBeNull();
    expect(lastCompletedCloses({ quote: { tradeDate: '2026-10-20' }, closes: [{ date: '2026-10-19', close: 1 }], today: '2026-10-20' })).toBeNull();
  });
});

describe('computeLastSessionChange', () => {
  it("shows Friday's move on a Sunday, from the quote alone", () => {
    const r = computeLastSessionChange({ holdings: { israeliStocks: [il(1)] }, now: SUNDAY });
    expect(r.bySymbol['israeli:1159250']).toMatchObject({ date: '2026-10-16', fxApprox: false });
    expect(r.bySymbol['israeli:1159250'].changeILS).toBeCloseTo(100, 6);
    expect(r.bySymbol['israeli:1159250'].pct).toBeCloseTo(10, 6);
    expect(r.byLot[1].changeILS).toBeCloseTo(100, 6);
    expect(r.total.dates).toEqual({ israeli: '2026-10-16', american: null });
  });

  it("values a US holding at each session's own dollar rate", () => {
    const fx = [
      { date: '2026-10-15', close: 3.7 },
      { date: '2026-10-16', close: 3.8 }
    ];
    const r = computeLastSessionChange({ holdings: { americanStocks: [us(2)] }, history: { fx }, now: SUNDAY });
    // 2 x (110 x 3.8 - 100 x 3.7)
    expect(r.bySymbol['american:VOO'].changeILS).toBeCloseTo(2 * (110 * 3.8 - 100 * 3.7), 6);
    expect(r.bySymbol['american:VOO'].fxApprox).toBe(false);
    // Without the rate history, today's rate stands in - and says so.
    const approx = computeLastSessionChange({ holdings: { americanStocks: [us(2)] }, now: SUNDAY });
    expect(approx.bySymbol['american:VOO'].changeILS).toBeCloseTo(2 * 10 * 3.9, 6);
    expect(approx.bySymbol['american:VOO'].fxApprox).toBe(true);
  });

  it("totals a US holding's own move at today's rate, as the daily change does", () => {
    // The dollar "jumped" 3.7 -> 3.8 between the closes: the holding's
    // shekel figure has it, the total does not.
    const fx = [
      { date: '2026-10-15', close: 3.7 },
      { date: '2026-10-16', close: 3.8 }
    ];
    const r = computeLastSessionChange({ holdings: { israeliStocks: [il(1)], americanStocks: [us(2)] }, history: { fx }, now: SUNDAY });
    // Israeli 10 x (110 - 100), US 2 x (110 - 100) x 3.9.
    expect(r.total.changeILS).toBeCloseTo(100 + 2 * 10 * 3.9, 6);
    expect(r.total.pct).toBeCloseTo(((100 + 78) / (1000 + 2 * 100 * 3.9)) * 100, 6);
  });

  it("gives a US holding's own move in dollars, with no exchange rate in it", () => {
    const fx = [
      { date: '2026-10-15', close: 3.7 },
      { date: '2026-10-16', close: 3.8 }
    ];
    const r = computeLastSessionChange({ holdings: { americanStocks: [us(2)] }, history: { fx }, now: SUNDAY });
    // 2 x (110 - 100), +10% - the quote's own change, whatever the dollar did.
    expect(r.bySymbol['american:VOO'].changeUSD).toBeCloseTo(20, 6);
    expect(r.bySymbol['american:VOO'].pctUSD).toBeCloseTo(10, 6);
    expect(r.byLot[2].pctUSD).toBeCloseTo(10, 6);
    // The shekel percent has the dollar's move in it.
    expect(r.bySymbol['american:VOO'].pct).toBeCloseTo(((110 * 3.8) / (100 * 3.7) - 1) * 100, 6);
    // A lot bought that day moves from its cost.
    const boughtFriday = computeLastSessionChange({ holdings: { americanStocks: [us(3, { purchaseDate: '2026-10-16', purchasePrice: 105 })] }, history: { fx }, now: SUNDAY });
    expect(boughtFriday.byLot[3].changeUSD).toBeCloseTo(2 * 5, 6);
    expect(boughtFriday.byLot[3].pctUSD).toBeCloseTo((5 / 105) * 100, 6);
    // A TASE holding has no dollar figures.
    expect(computeLastSessionChange({ holdings: { israeliStocks: [il(1)] }, now: SUNDAY }).bySymbol['israeli:1159250'].changeUSD).toBeUndefined();
  });

  it("uses the history while the market trades today, TASE's closes being in agorot", () => {
    const lot = il(1, { currentPrice: 120, dailyChangePercent: 3, dailyChangeTradeDate: '2026-10-20' });
    const history = { israeli: { 1159250: [{ date: '2026-10-16', close: 10000 }, { date: '2026-10-19', close: 10500 }, { date: '2026-10-20', close: 12000 }] } };
    const r = computeLastSessionChange({ holdings: { israeliStocks: [lot] }, history, now: TUESDAY_NOON });
    expect(r.bySymbol['israeli:1159250'].date).toBe('2026-10-19');
    expect(r.bySymbol['israeli:1159250'].changeILS).toBeCloseTo(10 * (105 - 100), 6);
    // Not yet fetched: unknown, not zero.
    expect(computeLastSessionChange({ holdings: { israeliStocks: [lot] }, now: TUESDAY_NOON }).total).toBeNull();
    // Beside a holding that is known, it is left out of the total and counted.
    const mixed = computeLastSessionChange({ holdings: { israeliStocks: [lot], americanStocks: [us(2)] }, now: TUESDAY_NOON });
    expect(mixed.total.missing).toBe(1);
    expect(mixed.total.dates.israeli).toBeNull();
  });

  it('counts a lot bought that day from its cost, and one bought after it not at all', () => {
    const r = computeLastSessionChange({
      holdings: { israeliStocks: [il(1), il(2, { purchaseDate: '2026-10-16', purchasePrice: 105 }), il(3, { purchaseDate: '2026-10-18' })] },
      now: SUNDAY
    });
    expect(r.byLot[2].changeILS).toBeCloseTo(10 * (110 - 105), 6);
    expect(r.byLot[3]).toBeUndefined();
    expect(r.bySymbol['israeli:1159250'].changeILS).toBeCloseTo(100 + 50, 6);
    expect(r.bySymbol['israeli:1159250'].pct).toBeCloseTo((150 / (1000 + 1050)) * 100, 6);
  });

  it('counts a slice sold that day up to its sale price', () => {
    const slice = { ...il('1:sold:s1'), quantity: 5, isClosedSlice: true, soldDate: '2026-10-16', soldTxId: 's1' };
    const r = computeLastSessionChange({
      holdings: { israeliStocks: [il(1)] },
      lots: { israeliStocks: [il(1), slice] },
      transactions: [{ id: 's1', type: 'SELL', price: 104 }],
      now: SUNDAY
    });
    expect(r.bySymbol['israeli:1159250'].changeILS).toBeCloseTo(100 + 5 * (104 - 100), 6);
    expect(r.byLot[1].changeILS).toBeCloseTo(100, 6);
  });

  it('is null, not zero, for a holding with no session date', () => {
    const r = computeLastSessionChange({ holdings: { israeliStocks: [il(1, { dailyChangeTradeDate: null })] }, now: SUNDAY });
    expect(r.bySymbol).toEqual({});
    expect(r.total).toBeNull();
  });
});

describe('symbolsNeedingHistory', () => {
  it('asks for every open symbol, and one sold out this week', () => {
    const holdings = { israeliStocks: [il(1, { dailyChangeTradeDate: '2026-10-20' })], americanStocks: [us(2)] };
    const lots = {
      ...holdings,
      americanStocks: [
        us(2),
        { ...us('9:sold:s'), stockName: 'NVDA', isClosedSlice: true, soldDate: '2026-10-19' },
        { ...us('8:sold:s'), stockName: 'AMD', isClosedSlice: true, soldDate: '2026-09-01' }
      ]
    };
    expect(symbolsNeedingHistory({ holdings, lots, now: TUESDAY_NOON })).toEqual({ israeli: ['1159250'], american: ['NVDA', 'VOO'] });
  });
});
