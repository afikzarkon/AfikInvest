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

  const pension = (pensionFunds || []).map((item) => ({
    key: item.fundName || `pension-${item.id}`,
    label: item.fundName || 'קופת גמל',
    value: toNum(item.currentValue != null ? item.currentValue : item.amount)
  }));

  // Liquid accounts: recorded balance + the ledger movements since it.
  const today = israelToday();
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
