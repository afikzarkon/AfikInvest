import { COUNTS_AS_INVESTED, israelDateOf, moneyInBetween, moneyInByMonth, moneyInByYear } from './moneyIn';
import { buildMoneyEvents, buildMonthFacts, buildReviewContext, lastDayOfMonth, monthRange } from './portfolioReviewData';
import { applyTransaction, normalizeTransaction } from '../shared/transactionLedger';

const TODAY = '2026-10-21';

describe('israelDateOf', () => {
  it('keeps a plain date and reads a timestamp on the Israeli calendar', () => {
    expect(israelDateOf('2026-09-30')).toBe('2026-09-30');
    // 22:00 UTC on Sept 30 is already Oct 1 in Israel (UTC+3 in summer).
    expect(israelDateOf('2026-09-30T22:00:00.000Z')).toBe('2026-10-01');
    expect(israelDateOf('2026-09-30T20:00:00.000Z')).toBe('2026-09-30');
    expect(israelDateOf('')).toBeNull();
    expect(israelDateOf('not a date')).toBeNull();
  });
});

// One portfolio carrying each thing that made the review and the analysis
// page disagree (see the commit for the numbers in the screenshots):
//   July      provident-fund deposits only (the review counted "0 trades")
//   August    a lot bought and then sold, and a lot now worth less than it
//             cost (the analysis summed today's value of held lots only)
//   September a lot whose price moved since (current value vs cost)
//   October   money into the current account and a money-market fund, a
//             withdrawal from the current account, and a timestamp at the
//             UTC month edge
function fixture() {
  let portfolio = {
    israeliStocks: [],
    americanStocks: [],
    pensionFunds: [
      { id: 1, fundName: 'גמל להשקעה', currentValue: 40000, deposits: [{ date: '2026-07-05', amount: 18900 }, { date: '2026-07-20', amount: 18900 }] }
    ],
    cashFunds: [{ id: 2, fundName: 'כספית', amount: 0, deposits: [{ date: '2026-10-03', amount: 40000 }] }],
    bankBalances: [
      {
        id: 3,
        amount: 0,
        deposits: [
          { date: '2026-10-02', amount: 28044 },
          { date: '2026-10-09', amount: -16786 }
        ]
      }
    ],
    bankSavingsFunds: []
  };
  const transactions = [];
  const record = (input, id, newLotId) => {
    const tx = { ...normalizeTransaction(input, { today: TODAY }), id };
    const applied = applyTransaction(portfolio, tx, { newLotId });
    portfolio = applied.portfolio;
    transactions.push(applied.transaction);
  };
  record({ type: 'BUY', date: '2026-08-04', assetClass: 'american', assetId: 'NVDA', units: 50, price: 180, fees: 5, fxRate: 3.6 }, 'b1', 101);
  record({ type: 'SELL', date: '2026-08-25', assetClass: 'american', assetId: 'NVDA', units: 50, price: 185, fees: 5, fxRate: 3.6 }, 's1');
  record({ type: 'BUY', date: '2026-08-11', assetClass: 'israeli', assetId: '1159250', units: 100, price: 120, fees: 0 }, 'b2', 102);
  record({ type: 'BUY', date: '2026-09-15', assetClass: 'american', assetId: 'VOO', units: 5, price: 590, fees: 2, fxRate: 3.7 }, 'b3', 103);
  // A lot typed straight into the table (the ledger takes plain dates
  // only), dated by a timestamp that is Oct 1 in Israel: an October purchase.
  portfolio.israeliStocks = [
    ...portfolio.israeliStocks,
    { id: 104, stockName: '1183441', purchaseDate: '2026-09-30T22:30:00.000Z', purchasePrice: 300, quantity: 10, currentPrice: 300 }
  ];
  // Today's prices differ from the purchase prices.
  portfolio.israeliStocks = portfolio.israeliStocks.map((l) => ({ ...l, currentPrice: l.stockName === '1159250' ? 90 : 310 }));
  portfolio.americanStocks = portfolio.americanStocks.map((l) => ({ ...l, currentPrice: 600, currentExchangeRate: 3.75 }));
  return { portfolio, transactions };
}

describe('money in, per month and per year', () => {
  const { portfolio, transactions } = fixture();
  const events = buildMoneyEvents({ holdings: portfolio, transactions });
  const months = moneyInByMonth(events);
  const byMonth = Object.fromEntries(months.map((m) => [m.month, m]));

  it('counts purchases at cost, sold lots included, and investment deposits only', () => {
    expect(byMonth['2026-07']).toMatchObject({ invested: 37800, count: 2, deposits: 2, buys: 0 });
    expect(byMonth['2026-08'].invested).toBeCloseTo((50 * 180 + 5) * 3.6 + 100 * 120, 6);
    expect(byMonth['2026-08'].count).toBe(2);
    expect(byMonth['2026-09'].invested).toBeCloseTo((5 * 590 + 2) * 3.7, 6);
    expect(byMonth['2026-10']).toMatchObject({ invested: 3000, count: 1, parked: 68044, parkedCount: 2 });
  });

  it('keeps the current account and money-market funds out of "invested" by default', () => {
    expect(COUNTS_AS_INVESTED.bank).toBe(false);
    expect(COUNTS_AS_INVESTED.moneyMarket).toBe(false);
  });

  it('adds the months up to the years', () => {
    const [y2026] = moneyInByYear(events);
    expect(y2026.year).toBe('2026');
    expect(y2026.invested).toBeCloseTo(months.reduce((s, m) => s + m.invested, 0), 6);
    expect(y2026.count).toBe(months.reduce((s, m) => s + m.count, 0));
    expect(y2026.parked).toBeCloseTo(68044, 6);
  });

  // The guard against the two pages drifting apart again: the review's
  // month facts and the analysis page's monthly / yearly lists must show
  // the same amount and the same count.
  it('gives the portfolio review the same amount and count as the analysis page, every month', () => {
    const ctx = buildReviewContext({ holdings: portfolio, transactions, today: TODAY });
    monthRange('2026-06', '2026-10').forEach((month) => {
      const facts = buildMonthFacts(month, ctx);
      const listed = byMonth[month] || { invested: 0, count: 0, parked: 0 };
      expect([month, facts.invested]).toEqual([month, expect.closeTo(listed.invested, 6)]);
      expect([month, facts.investCount]).toEqual([month, listed.count]);
      expect([month, facts.parked]).toEqual([month, expect.closeTo(listed.parked, 6)]);
    });
    const yearFromFacts = monthRange('2026-01', '2026-10').reduce((s, m) => s + buildMonthFacts(m, ctx).invested, 0);
    expect(yearFromFacts).toBeCloseTo(moneyInByYear(events)[0].invested, 6);
  });

  it('sums a window by the same rule', () => {
    const aug = moneyInBetween(events, '2026-07-31', lastDayOfMonth('2026-08'));
    expect(aug.invested).toBeCloseTo(byMonth['2026-08'].invested, 6);
    expect(aug.count).toBe(byMonth['2026-08'].count);
  });
});
