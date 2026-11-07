// Builds the itemized breakdown saved with each daily/monthly checkpoint
// (see hooks/usePortfolioSnapshots.js, hooks/useMonthlySnapshots.js) - one
// line per actual holding/account, grouped under the same 5 categories
// used everywhere else in this app (see monthlySnapshotComparison.js).
//
// Reuses analysis.stockDistribution for israeli/american stocks - it's
// already computed (see utils/portfolioAnalysis.js) and its `value` field
// is a pure current market value with no profit/tax figures mixed in, so
// there's nothing to strip out for the "no tax in this breakdown"
// requirement. Pension/cash-fund/bank items have no existing per-item
// distribution anywhere else, so they're built directly from the raw
// arrays here, using the same "currentValue ?? amount"/"amount" value
// formulas portfolioAnalysis.js uses for its own category totals.
import { toNum } from './formatters';
import { computeBankSavingsFundValue } from './bankSavingsFund';
import { liquidBalanceOn } from '../shared/liquidBalance';
import { israelToday } from './marketSession';

const DATE_RE = /^\d{4}-\d{2}-\d{2}/;

// The statement value (currentValue, or amount on older rows) plus every
// deposit/withdrawal dated after the statement, up to and including `day`.
// A fund whose value carries no date keeps its plain value - there is no
// way to tell which deposits it already includes.
export function providentFundValueOn(fund, day) {
  if (!fund) return 0;
  const base = toNum(fund.currentValue != null ? fund.currentValue : fund.amount);
  const statementDate = typeof fund.currentValueDate === 'string' && DATE_RE.test(fund.currentValueDate)
    ? fund.currentValueDate.slice(0, 10)
    : null;
  if (!statementDate || !day || statementDate > day) return base;
  const since = (Array.isArray(fund.deposits) ? fund.deposits : []).reduce((sum, d) => {
    if (!d || typeof d.date !== 'string' || !DATE_RE.test(d.date)) return sum;
    const date = d.date.slice(0, 10);
    return date > statementDate && date <= day ? sum + toNum(d.amount) : sum;
  }, 0);
  return base + since;
}

export function buildItemizedMonthlyBreakdown(analysis, pensionFunds, cashFunds, bankBalances, bankSavingsFunds = []) {
  const israeli = [];
  const american = [];
  (analysis?.stockDistribution || []).forEach((stock) => {
    // key stays the raw security id / ticker so a month saved today still
    // compares item-for-item against one saved before names were resolved;
    // the label is the readable "name (id)" form.
    const item = { key: stock.name, label: stock.displayName || stock.name, value: stock.value };
    if (stock.exchange === 'israeli') israeli.push(item);
    else if (stock.exchange === 'american') american.push(item);
  });

  const today = israelToday();

  // A provident fund: its last statement value PLUS the deposits made after
  // that statement - the money is in the fund even before the next
  // statement shows it. Valued on the statement alone, a deposit made since
  // was missing from the checkpoint while the comparison (rightly) netted
  // it out as a contribution, so every such month showed a loss the size
  // of the deposit. Same rule the historical reconstruction already uses
  // for earlier dates (ledgerAccountHistory.js's valueOfLedgerAccountAtDate).
  const pension = (pensionFunds || []).map((item) => ({
    key: item.fundName || `pension-${item.id}`,
    label: item.fundName || 'קופת גמל',
    value: providentFundValueOn(item, today)
  }));

  // Liquid accounts: recorded balance + the ledger movements since it.
  const cashFundsItems = (cashFunds || []).map((item) => ({
    key: item.fundName || `cash-${item.id}`,
    label: item.fundName || 'קרן כספית',
    value: liquidBalanceOn(item, today)
  }));

  const bank = (bankBalances || []).map((item, index) => ({
    key: `bank-${index + 1}`,
    label: bankBalances.length > 1 ? `עו"ש #${index + 1}` : 'עו"ש',
    value: liquidBalanceOn(item, today)
  }));

  const bankSavings = (bankSavingsFunds || []).map((item) => ({
    key: item.fundName || `bank-savings-${item.id}`,
    label: item.fundName || 'קופת חיסכון בבנק',
    value: toNum(computeBankSavingsFundValue(item))
  }));

  return { israeli, american, pension, cashFunds: cashFundsItems, bank, bankSavings };
}
