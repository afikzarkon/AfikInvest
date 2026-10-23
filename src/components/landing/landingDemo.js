// The figures the landing page shows, computed by the app's own engine from
// its demo portfolio (utils/samplePortfolio.js) - the same summary, the same
// "yesterday" calculation and the same money-weighted return a signed-in
// user sees. Nothing here is typed in by hand; the holdings are made up, and
// the page says so.
//
// Two made-up sessions give the demo something to show for "today" and for
// "yesterday": each lot gets a move for today's session and another for the
// session before it.
import { buildSamplePortfolio } from '../../utils/samplePortfolio';
import { calculatePortfolioSummary } from '../../utils/portfolioSummary';
import { computeLastSessionChange } from '../../utils/lastSessionChange';
import { buildPortfolioCashFlows } from '../../utils/portfolioCashFlows';
import { computeMoneyWeightedReturn } from '../../utils/performanceReturns';
import { liquidBalanceOn } from '../../shared/liquidBalance';
import { changeFromPercent, israelToday } from '../../utils/marketSession';

// Percent moves per symbol: today's session, and the one before it.
const MOVES = {
  604611: [0.84, 1.42],
  629014: [-1.12, 2.35],
  1081124: [0.47, -0.61],
  AAPL: [0.62, -0.38],
  MSFT: [-0.21, 1.07],
  NVDA: [1.35, -1.94],
  SPY: [0.18, 0.41]
};

const shiftDays = (iso, days) => new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);

// The weekday before `iso` - the demo's "previous session".
function previousWeekday(iso) {
  let d = shiftDays(iso, -1);
  while ([0, 6].includes(new Date(`${d}T00:00:00Z`).getUTCDay())) d = shiftDays(d, -1);
  return d;
}

export function buildLandingDemo(now = new Date()) {
  const today = israelToday(now);
  const base = buildSamplePortfolio(now);
  const stamp = (lots, index, date) =>
    lots.map((lot) => ({ ...lot, dailyChangePercent: (MOVES[lot.stockName] || [0, 0])[index], dailyChangeTradeDate: date }));

  const todays = { ...base, israeliStocks: stamp(base.israeliStocks, 0, today), americanStocks: stamp(base.americanStocks, 0, today) };
  const summary = calculatePortfolioSummary(
    todays.israeliStocks,
    todays.americanStocks,
    todays.pensionFunds,
    todays.cashFunds,
    todays.bankBalances,
    {},
    todays.bankSavingsFunds,
    { today }
  );

  // "Yesterday": the previous session's quotes, read the day after it.
  const session = previousWeekday(today);
  const yesterdays = { israeliStocks: stamp(base.israeliStocks, 1, session), americanStocks: stamp(base.americanStocks, 1, session) };
  const lastSession = computeLastSessionChange({ holdings: yesterdays, now: new Date(`${shiftDays(session, 1)}T12:00:00Z`) });

  // Money-weighted annual return: every purchase and deposit as dated money
  // in, today's value as money out.
  const flows = buildPortfolioCashFlows({ ...todays, includeLedgerOpeningBalances: true });
  const firstFlow = flows.length ? flows[0].date : today;
  const mwr = computeMoneyWeightedReturn({
    fromDate: shiftDays(firstFlow, -1),
    toDate: today,
    startValue: 0,
    endValue: summary.capitalTotalILS,
    cashFlows: flows
  });

  const totalProfitPercent = summary.totalPurchaseILS > 0 ? (summary.totalProfitILS / summary.totalPurchaseILS) * 100 : null;
  const allocation = [
    { key: 'israeli', label: 'בורסת ת"א', value: summary.capitalIsraeliILS },
    { key: 'american', label: 'בורסות ארה"ב', value: summary.capitalAmericanILS },
    { key: 'pension', label: 'קופות גמל', value: summary.capitalPensionILS },
    { key: 'cash', label: 'קרן כספית', value: summary.capitalCashFundsILS },
    { key: 'savings', label: 'חיסכון בבנק', value: summary.capitalBankSavingsILS },
    { key: 'bank', label: 'עו"ש', value: (todays.bankBalances || []).reduce((s, a) => s + liquidBalanceOn(a, today), 0) }
  ]
    .filter((a) => a.value > 0)
    .map((a) => ({ ...a, share: summary.capitalTotalILS > 0 ? a.value / summary.capitalTotalILS : 0 }));

  // A few holdings for the phone cards: value, profit, today and yesterday.
  const holdings = [
    { market: 'american', symbol: 'NVDA', name: 'NVDA', currency: '$' },
    { market: 'israeli', symbol: '604611', name: 'לאומי', currency: '₪' },
    { market: 'american', symbol: 'MSFT', name: 'MSFT', currency: '$' }
  ].map((h) => {
    const lots = (h.market === 'american' ? todays.americanStocks : todays.israeliStocks).filter((l) => l.stockName === h.symbol);
    const qty = lots.reduce((s, l) => s + l.quantity, 0);
    const value = lots.reduce((s, l) => s + l.currentPrice * l.quantity, 0);
    const cost = lots.reduce((s, l) => s + l.purchasePrice * l.quantity, 0);
    const pct = lots[0] ? lots[0].dailyChangePercent : 0;
    return {
      ...h,
      quantity: qty,
      lots: lots.length,
      value,
      profit: value - cost,
      profitPercent: cost > 0 ? ((value - cost) / cost) * 100 : null,
      dailyPercent: pct,
      dailyChange: changeFromPercent(value, pct),
      yesterday: lastSession.bySymbol[`${h.market}:${h.symbol}`] || null
    };
  });

  return { today, session, summary, totalProfitPercent, lastSession: lastSession.total, mwr, allocation, holdings };
}
