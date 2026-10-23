// Month-by-month listing of the money in, on a real portfolio: every event
// utils/moneyIn.js counts, next to what the analysis page's old breakdown
// (today's value of the lots still held, every account deposit and
// withdrawal, and an account without a ledger as one lump at its update
// date) counted for the same month. Skipped unless pointed at a file:
//
//   MONEY_IN_FILE=path/to/data.json npm run diag:money-in
//
// data.json is { "portfolio": <GET /api/portfolio>, "transactions": <GET
// /api/transactions>.transactions }, saved from the browser while signed in.
import fs from 'fs';
import { buildMoneyEvents, buildMonthFacts, buildReviewContext, monthRange } from './portfolioReviewData';
import { israelDateOf, isInvestedEvent, isParkedEvent, moneyInByMonth, moneyInByYear } from './moneyIn';
import { calculateAmericanStockMetrics } from './portfolioMath';
import { normalizeIsraeliPrice, toNum } from './formatters';
import { computeBankSavingsFundValue } from './bankSavingsFund';

const FILE = process.env.MONEY_IN_FILE;
const run = FILE ? describe : describe.skip;

// The breakdown PortfolioAnalysisView showed before moneyIn.js, as rows.
function legacyAnalysisRows(h) {
  const rows = [];
  const monthOf = (raw) => {
    const d = new Date(raw);
    return Number.isNaN(d.getTime()) ? null : `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  };
  const push = (raw, value, what) => {
    const month = monthOf(raw);
    if (month) rows.push({ month, value: toNum(value), what });
  };
  (h.israeliStocks || []).forEach((s) => push(s.purchaseDate, toNum(normalizeIsraeliPrice(s.currentPrice)) * toNum(s.quantity), `IL ${s.stockName} x${s.quantity} at today's price`));
  (h.americanStocks || []).forEach((s) => push(s.purchaseDate, calculateAmericanStockMetrics(s).totalCurrentValueILS, `US ${s.stockName} x${s.quantity} at today's price`));
  const ledger = (kind, a, fallbackValue, fallbackDate) => {
    const dated = (a.deposits || []).filter((d) => d && d.date);
    if (!dated.length) push(fallbackDate, fallbackValue, `${kind} ${a.fundName || a.id}: whole balance, no ledger`);
    dated.forEach((d) => push(d.date, d.amount, `${kind} ${a.fundName || a.id} ${toNum(d.amount) < 0 ? 'withdrawal' : 'deposit'}`));
  };
  (h.pensionFunds || []).forEach((a) => ledger('pension', a, a.currentValue != null ? a.currentValue : a.amount, a.currentValueDate || a.updateDate));
  (h.cashFunds || []).forEach((a) => ledger('moneyMarket', a, a.amount, a.currentValueDate || a.updateDate));
  (h.bankBalances || []).forEach((a) => ledger('bank', a, a.amount, a.currentValueDate || a.updateDate));
  (h.bankSavingsFunds || []).forEach((a) => ledger('bankSavings', a, computeBankSavingsFundValue(a), null));
  return rows;
}

const ils = (n) => n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

run('money in on a real portfolio', () => {
  it('lists every month', () => {
    const data = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    const holdings = data.portfolio || data;
    const transactions = data.transactions || [];
    const today = israelDateOf(new Date().toISOString());
    const events = buildMoneyEvents({ holdings, transactions });
    const ctx = buildReviewContext({ holdings, transactions, today });
    const legacy = legacyAnalysisRows(holdings);
    const months = moneyInByMonth(events);
    const out = [];
    const timestamped = [];
    ['israeliStocks', 'americanStocks'].forEach((k) => (holdings[k] || []).forEach((l) => /T/.test(String(l.purchaseDate || '')) && timestamped.push(`${k} ${l.stockName} ${l.purchaseDate}`)));
    if (timestamped.length) out.push(`Lots dated by a timestamp (month read on the Israeli calendar now):\n  ${timestamped.join('\n  ')}`);

    monthRange(months.length ? months[0].month : today.slice(0, 7), today.slice(0, 7)).forEach((month) => {
      const m = months.find((x) => x.month === month) || { invested: 0, count: 0, parked: 0 };
      const facts = buildMonthFacts(month, ctx);
      const old = legacy.filter((r) => r.month === month);
      const oldSum = old.reduce((s, r) => s + r.value, 0);
      out.push(`\n=== ${month} ===`);
      out.push(`now, both pages: invested ${ils(m.invested)} (${m.count} purchases/deposits), parked ${ils(m.parked)}; review facts ${ils(facts.invested)} / ${facts.investCount}; review trades (old count) ${facts.trades}`);
      events
        .filter((e) => e.date.slice(0, 7) === month && (isInvestedEvent(e) || isParkedEvent(e) || e.kind === 'withdrawal' || e.kind === 'sell'))
        .forEach((e) => out.push(`  ${isInvestedEvent(e) ? 'INVESTED' : isParkedEvent(e) ? 'parked  ' : e.kind.padEnd(8)} ${e.date} ${ils(e.amountILS).padStart(14)}  ${(e.security && e.security.label) || ''}${e.fromLedger === false ? ' (table lot)' : ''}`));
      out.push(`old analysis page: ${ils(oldSum)} (${old.length} rows), difference from now ${ils(oldSum - m.invested)}`);
      old.forEach((r) => out.push(`  ${ils(r.value).padStart(14)}  ${r.what}`));
      out.push(`month-end value: ${facts.valuePartial ? `UNKNOWN - no close for ${facts.missingSymbols.join(', ') || '?'}` : ils(facts.endValue || 0)}`);
    });
    moneyInByYear(events).forEach((y) => out.push(`\nyear ${y.year}: invested ${ils(y.invested)} (${y.count}), parked ${ils(y.parked)}`));
    // eslint-disable-next-line no-console
    console.log(out.join('\n'));
    expect(true).toBe(true);
  });
});
