// Comparison logic for two monthly portfolio checkpoints (see
// hooks/useMonthlySnapshots.js) - kept separate from the component so it's
// directly unit-testable, matching every other calculation in this app
// (utils/*.js, not inline in a component). Category keys/labels match
// analysis.exchangeDistribution's own shape (see snapshotBreakdown in
// App.js) - the same 6 categories used throughout PortfolioAnalysisView.js.
//
// Each category's breakdown value can be either the itemized shape (an
// array of { key, label, value } - one entry per actual holding/account,
// see utils/monthlySnapshotBreakdown.js) or, for snapshots saved before
// itemized breakdowns existed, a single flat number for the whole
// category. normalizeCategoryItems() treats both the same way so old and
// new snapshots compare correctly without a data migration.
//
// Contribution adjustment: a naive (compareValue/baseValue-1) % is
// distorted by any deposit/purchase/withdrawal/sale that happened partway
// through the period - it gets counted as investment growth (or loss) even
// though it's just money moving in or out. Fixed via Modified Dietz
// (utils/modifiedDietz.js), fed from two sources:
//
// 1. Auto-detected flows (buildLiveCashFlows) - for the categories that
//    have a real dated ledger (stock purchase lots, pension/bank-savings
//    deposits), drawn straight from the live portfolio, no user input
//    needed. This only ever sees money going IN (there's no sell/
//    withdrawal ledger anywhere in this app).
// 2. Manually-declared flows (buildManualCashFlows) - a user-entered net
//    amount per category, saved on the monthly snapshot itself as
//    breakdown.cashFlows (see PortfolioAnalysisView.js's save/edit/manual-
//    add forms). This is the *only* source for עו"ש/קרנות כספיות, which
//    have no ledger at all (just a single overwritten amount each time),
//    and the only way to capture a sale/withdrawal in any category, since
//    the auto-detected side can't see those.
//
// The two are additive per category - a period can both have an
// auto-detected purchase AND a manually-declared withdrawal.

import { ledgerCashFlows } from '../shared/transactionLedger';
import { calculateModifiedDietzReturn } from './modifiedDietz';

export const MONTHLY_CATEGORY_KEYS = ['israeli', 'american', 'pension', 'cashFunds', 'bank', 'bankSavings'];

// Which categories the monthly tracker DERIVES, and which it still asks the
// user about.
//
// Derived: stocks are priced from the historical closes for the lots held
// on the date, and provident funds are reconstructed from their recorded
// values plus their dated deposit ledger. The app already holds everything
// needed to work these out, so asking the user to type them in as well was
// pure duplication - two sources for one number, free to disagree, with
// nothing to say which was right.
//
// Manual: current accounts, money-market funds and bank savings carry no
// traded price to look up. A current account in particular is a single
// overwritten balance whose movements can't be told apart from spending,
// so its flows can only come from the user.
export const AUTO_DERIVED_CATEGORIES = ['israeli', 'american', 'pension'];
export const MANUAL_ENTRY_CATEGORIES = ['cashFunds', 'bank', 'bankSavings'];

// Categories with a real dated ledger (stock purchase lots, or a
// deposits: [{date,amount}] array) that lets us know exactly how much
// money entered and when - the only categories a Modified Dietz
// contribution-adjustment can be computed for.
//
// Money-market funds and current accounts belong here too: the add form
// records every deposit/withdrawal into them as a dated, signed ledger row
// (negative = withdrawal), exactly like a provident-fund deposit. They used
// to be treated as ledger-less, so those recorded flows were ignored and
// the only way to net them out was to type the same amount again by hand.
export const CONTRIBUTION_ADJUSTABLE_CATEGORIES = ['israeli', 'american', 'pension', 'cashFunds', 'bank', 'bankSavings'];

export const MONTHLY_CATEGORY_LABELS_HE = {
  israeli: 'בורסה ישראלית',
  american: 'בורסה אמריקאית',
  pension: 'קופות גמל',
  cashFunds: 'קרנות כספיות',
  bank: 'עו"ש',
  bankSavings: 'קופת חיסכון בבנק'
};

const isFiniteNumber = (n) => typeof n === 'number' && Number.isFinite(n);

// null (not 0 or Infinity) when there's nothing meaningful to divide by -
// same "don't fake a number" principle used throughout this app's other
// scoring/analysis utils.
function percentChange(base, compare) {
  if (!isFiniteNumber(base) || !isFiniteNumber(compare) || base === 0) return null;
  return ((compare - base) / Math.abs(base)) * 100;
}

// Always returns an array of { key, label, value }, regardless of which of
// the two saved shapes this category used.
export function normalizeCategoryItems(categoryValue, categoryKey) {
  if (Array.isArray(categoryValue)) {
    return categoryValue.filter((it) => it && typeof it === 'object' && isFiniteNumber(it.value));
  }
  if (isFiniteNumber(categoryValue)) {
    return [{ key: categoryKey, label: MONTHLY_CATEGORY_LABELS_HE[categoryKey], value: categoryValue }];
  }
  return [];
}

// Draws, for each contribution-adjustable category, a Map of item key
// (stock name / fund name - the same key used in the itemized breakdown)
// -> [{ date, amount }] cash flows, from the *live* portfolio state (not
// from anything stored in the snapshots, which never recorded a history of
// flows - only point-in-time values). This means the adjustment is only as
// good as the live data still being around: a deposit row the user has
// since deleted, or a fund/stock removed entirely, can no longer be netted
// out of an old comparison. Sales and dividends recorded in the
// transactions ledger ARE netted out: pass `liveHoldings.transactions`
// together with lots expanded by expandHoldingsWithClosedLots, so a sold
// position still has its purchase and its sale proceeds.
export function buildLiveCashFlows(liveHoldings) {
  const flows = {
    israeli: new Map(),
    american: new Map(),
    pension: new Map(),
    cashFunds: new Map(),
    bank: new Map(),
    bankSavings: new Map()
  };
  const push = (map, key, date, amount) => {
    if (!key || !date) return;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push({ date, amount });
  };

  (liveHoldings?.israeliStocks || []).forEach((s) => {
    push(flows.israeli, s.stockName, s.purchaseDate, (s.purchasePrice || 0) * (s.quantity || 0));
  });
  (liveHoldings?.americanStocks || []).forEach((s) => {
    // ILS cost at the time of purchase (purchase price * quantity * the
    // exchange rate paid) - matches totalPurchaseILS everywhere else in
    // this app, so it's on the same footing as the category's ILS values.
    push(flows.american, s.stockName, s.purchaseDate, (s.purchasePrice || 0) * (s.quantity || 0) * (s.exchangeRate || 0));
  });
  (liveHoldings?.pensionFunds || []).forEach((fund) => {
    (Array.isArray(fund.deposits) ? fund.deposits : []).forEach((d) => {
      push(flows.pension, fund.fundName, d.date, d.amount || 0);
    });
  });
  (liveHoldings?.bankSavingsFunds || []).forEach((fund) => {
    (Array.isArray(fund.deposits) ? fund.deposits : []).forEach((d) => {
      push(flows.bankSavings, fund.fundName, d.date, d.amount || 0);
    });
  });
  // Keyed exactly as monthlySnapshotBreakdown.js keys these items, so a
  // flow lands on the same row it is netted out of.
  (liveHoldings?.cashFunds || []).forEach((fund) => {
    (Array.isArray(fund.deposits) ? fund.deposits : []).forEach((d) => {
      push(flows.cashFunds, fund.fundName || `cash-${fund.id}`, d.date, d.amount || 0);
    });
  });
  (liveHoldings?.bankBalances || []).forEach((account, index) => {
    (Array.isArray(account.deposits) ? account.deposits : []).forEach((d) => {
      push(flows.bank, `bank-${index + 1}`, d.date, d.amount || 0);
    });
  });
  (liveHoldings?.transactions || []).forEach((tx) => {
    if (!tx || (tx.assetClass !== 'israeli' && tx.assetClass !== 'american')) return;
    const [flow] = ledgerCashFlows([tx]);
    if (flow) push(flows[tx.assetClass], tx.assetId, flow.date, flow.amount);
  });
  return flows;
}

// THE DATE A CHECKPOINT IS VALID FOR - the day its figures were taken.
//
// Recorded on every save since checkpoints started carrying it (see
// server/monthlySnapshotRoutes.js): today for a live save, the valuation
// date for an auto-filled month. A month saved before then has only its
// month key, and is read as valid at that month's last day - the date an
// auto-filled month is valued at, and the closest a month key alone can get.
export function snapshotAsOfDate(snapshot) {
  if (!snapshot) return null;
  const recorded = snapshot.asOfDate || (snapshot.breakdown && snapshot.breakdown.asOfDate);
  if (typeof recorded === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(recorded)) return recorded;
  return typeof snapshot.month === 'string' ? monthEndDateString(snapshot.month) : null;
}

// The calendar day halfway between two YYYY-MM-DD dates.
function midpointDate(fromDate, toDate) {
  const from = Date.parse(`${fromDate}T00:00:00Z`);
  const to = Date.parse(`${toDate}T00:00:00Z`);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return toDate;
  return new Date(from + Math.round((to - from) / 2 / 86400000) * 86400000).toISOString().slice(0, 10);
}

// (periodStart, periodEnd] - a flow dated exactly on periodStart is
// treated as already reflected in the beginning value, not as "new" money
// during this period.
function flowsInPeriod(flowList, periodStart, periodEnd) {
  return (flowList || []).filter((f) => f.date && f.date > periodStart && f.date <= periodEnd);
}

// Last calendar day of a "YYYY-MM" month, as "YYYY-MM-DD" (day 0 of the
// following month = the last day of this one). Built via Date.UTC, not the
// local-time Date constructor - constructing in local time and then
// reading it back with toISOString() (which is always UTC) can silently
// shift the date by a day depending on the machine's timezone offset (e.g.
// local midnight Feb 29 in a UTC+2/+3 zone is Feb 28 in UTC) - confirmed
// this really happened during testing, not a theoretical concern.
function monthEndDateString(monthKey) {
  const [year, month] = monthKey.split('-').map(Number);
  const lastDay = new Date(Date.UTC(year, month, 0));
  return lastDay.toISOString().slice(0, 10);
}

// Draws user-declared net cash flows (positive = net deposited/bought,
// negative = net withdrawn/sold) from every saved month strictly after
// baseMonth and up to/including compareMonth - not just the two endpoints
// being compared, so a multi-month comparison (e.g. January vs. June)
// still picks up whatever was separately declared on March's, April's and
// May's own saves.
//
// A declared amount says how much moved during the period a snapshot
// closes - from the checkpoint before it to its own date - but not when.
// It is dated to the MIDDLE of that period, the standard Modified Dietz
// assumption for a flow of unknown timing (half-weighted). It used to be
// dated to the snapshot's month end, which gave it no weight at all - a
// withdrawal declared on a checkpoint read as if it had left on the last
// day - and, with checkpoints taken mid-month, could even land after the
// checkpoint that declared it. allSnapshots is the full list (any order).
// Reads EVERY category, not just the manual-entry ones. Nothing writes a
// declared flow for stocks or provident funds any more (see
// MANUAL_ENTRY_CATEGORIES above), but months saved while that was possible
// still carry them - and a comparison against one of those months has to
// keep producing the number it always produced. Reading them costs nothing
// and stops previously-correct history from silently changing.
export function buildManualCashFlows(allSnapshots, baseMonth, compareMonth) {
  const flows = MONTHLY_CATEGORY_KEYS.reduce((acc, key) => ({ ...acc, [key]: [] }), {});
  const ordered = (allSnapshots || [])
    .filter((snap) => snap && typeof snap.month === 'string')
    .sort((a, b) => (a.month < b.month ? -1 : a.month > b.month ? 1 : 0));
  ordered.forEach((snap, index) => {
    if (!(snap.month > baseMonth && snap.month <= compareMonth)) return;
    const cashFlows = snap.breakdown && typeof snap.breakdown === 'object' ? snap.breakdown.cashFlows : null;
    if (!cashFlows || typeof cashFlows !== 'object') return;
    const closesAt = snapshotAsOfDate(snap);
    const opensAt = index > 0 ? snapshotAsOfDate(ordered[index - 1]) : `${snap.month}-01`;
    const date = opensAt < closesAt ? midpointDate(opensAt, closesAt) : closesAt;
    MONTHLY_CATEGORY_KEYS.forEach((key) => {
      const amount = cashFlows[key];
      if (isFiniteNumber(amount) && amount !== 0) {
        flows[key].push({ date, amount });
      }
    });
  });
  return flows;
}

// True when a category's "items" is really just normalizeCategoryItems()'s
// synthetic stand-in for a legacy flat-number save (before itemized
// breakdowns existed) - i.e. there's no real per-stock/per-fund detail to
// show, just the category's own old total wearing an item's shape. Lets
// the UI show an honest "no detail available" note instead of a confusing
// item row that just repeats the category name/value.
export function isLegacyRollup(items, categoryKey) {
  return items.length === 1 && items[0].key === categoryKey && items[0].label === MONTHLY_CATEGORY_LABELS_HE[categoryKey];
}

// Applies a Modified Dietz contribution adjustment on top of a plain
// { baseValue, compareValue } pair, given the cash flows that fell inside
// this period for that specific item/category. Falls back to the naive
// percentChange whenever either side is missing (nothing changed there -
// an item that didn't exist yet isn't a "return" to adjust) or a period
// couldn't be determined (no periodStart/periodEnd, e.g. same-month
// comparison). With zero relevant cash flows, Modified Dietz reduces to
// exactly the same number as the naive calculation, so this is safe to
// apply unconditionally whenever a period+cash flows are available.
function adjustedChangePercent({ baseValue, compareValue, cashFlows, periodStart, periodEnd }) {
  const naive = percentChange(baseValue, compareValue);
  if (naive === null || !periodStart || !periodEnd || !cashFlows || cashFlows.length === 0) {
    return { changePercent: naive, rawChangePercent: naive, netCashFlow: 0, contributionAdjusted: false };
  }
  const { percent, netCashFlow } = calculateModifiedDietzReturn({
    beginningValue: baseValue,
    endingValue: compareValue,
    cashFlows,
    periodStart,
    periodEnd
  });
  // With flows in the period the naive figure counts them as growth, so it
  // is no fallback: no measurable return (a base the flows drove to zero or
  // below) is shown as none.
  return {
    changePercent: percent,
    rawChangePercent: naive,
    netCashFlow,
    contributionAdjusted: percent !== null
  };
}

// baseSnapshot/compareSnapshot: { month: 'YYYY-MM', totalValueILS, breakdown }
// (the shape useMonthlySnapshots' list returns). liveHoldings (optional):
// { israeliStocks, americanStocks, pensionFunds, bankSavingsFunds } - the
// *current* portfolio arrays, used to look up deposits/purchases that fell
// within the compared period so they can be netted out of the % change
// (see buildLiveCashFlows above). allSnapshots (optional): the full list of
// saved monthly snapshots (usually just `monthlySnapshots` as-is), used to
// pick up user-declared cash flows saved on any month in between (see
// buildManualCashFlows above) - needed for עו"ש/קרנות כספיות (no ledger at
// all) and for sales/withdrawals in any category (auto-detection only ever
// sees money going in). Omit both to get the old plain-percent behavior for
// every row. Returns one row per category plus a trailing "total" row. Each
// category row is { key, label, baseValue, compareValue, changePercent,
// rawChangePercent, netCashFlow, contributionAdjusted, items } where items
// is one row per actual holding/account (matched across the two snapshots
// by key, e.g. stock name) - items present in only one snapshot (bought/
// sold since) get null for the missing side rather than 0. A category with
// no items in a snapshot has baseValue/compareValue null for that side
// (never fabricated as 0), matching every other row. Manually-declared
// flows only ever apply at the category/total level (there's no per-item
// UI for them), so item rows only ever reflect auto-detected flows.
export function compareMonthlySnapshots(baseSnapshot, compareSnapshot, liveHoldings = null, allSnapshots = []) {
  if (!baseSnapshot || !compareSnapshot) return [];
  const baseBreakdown = baseSnapshot.breakdown || {};
  const compareBreakdown = compareSnapshot.breakdown || {};

  // THE PERIOD IS BETWEEN THE TWO CHECKPOINTS' OWN DATES: (base, compare].
  //
  // A flow dated on or before the base checkpoint is already inside
  // baseValue; one dated after the compare checkpoint is not yet inside
  // compareValue. Only what falls strictly between the two is new money to
  // net out. This used to be approximated from month keys alone - from the
  // 1st of the month after the base to the last day of the compare month -
  // so with a checkpoint taken on the 10th, a deposit on the 20th of the
  // base month was treated as already counted (and read as growth), and a
  // deposit after the compare checkpoint was netted out of a value it was
  // never in (and read as a loss). See snapshotAsOfDate for months saved
  // before checkpoints recorded their date.
  const periodStart = snapshotAsOfDate(baseSnapshot);
  const periodEnd = snapshotAsOfDate(compareSnapshot);
  const liveCashFlows = liveHoldings ? buildLiveCashFlows(liveHoldings) : null;
  const manualCashFlows = buildManualCashFlows(allSnapshots, baseSnapshot.month, compareSnapshot.month);

  const autoFlowsInPeriod = (key) =>
    liveCashFlows && CONTRIBUTION_ADJUSTABLE_CATEGORIES.includes(key)
      ? Array.from(liveCashFlows[key].values()).flatMap((list) => flowsInPeriod(list, periodStart, periodEnd))
      : [];

  // Per category: ledger flows (drawn from liveHoldings) plus declared ones
  // (breakdown.cashFlows on the checkpoints in between).
  //
  // For the liquid categories the two can describe THE SAME MONEY - a
  // withdrawal recorded in the account's ledger and declared again on the
  // checkpoint - and adding them would net it out twice. There, a ledger
  // that has entries in the period wins, and the declaration only fills in
  // a period the ledger says nothing about. Stocks and provident funds keep
  // adding the two, as they always have: no new declaration can be made
  // for them, and the old ones recorded sales the ledger never could.
  const categoryFlowsInPeriod = (key) => {
    const auto = autoFlowsInPeriod(key);
    const manual = flowsInPeriod(manualCashFlows[key], periodStart, periodEnd);
    if (MANUAL_ENTRY_CATEGORIES.includes(key) && auto.length > 0) return auto;
    return [...auto, ...manual];
  };

  const categoryRows = MONTHLY_CATEGORY_KEYS.map((key) => {
    const baseItems = normalizeCategoryItems(baseBreakdown[key], key);
    const compareItems = normalizeCategoryItems(compareBreakdown[key], key);
    const baseByKey = new Map(baseItems.map((it) => [it.key, it]));
    const compareByKey = new Map(compareItems.map((it) => [it.key, it]));
    const itemKeys = Array.from(new Set([...baseByKey.keys(), ...compareByKey.keys()]));
    // Manually-declared flows have no per-item breakdown - only the
    // auto-detected (ledger) side can be attributed to a specific item.
    const autoItemFlows = liveCashFlows && CONTRIBUTION_ADJUSTABLE_CATEGORIES.includes(key)
      ? liveCashFlows[key]
      : null;

    const items = itemKeys
      .map((itemKey) => {
        const baseItem = baseByKey.get(itemKey);
        const compareItem = compareByKey.get(itemKey);
        const baseValue = baseItem ? baseItem.value : null;
        const compareValue = compareItem ? compareItem.value : null;
        const cashFlows = autoItemFlows
          ? flowsInPeriod(autoItemFlows.get(itemKey), periodStart, periodEnd)
          : null;
        return {
          key: itemKey,
          label: (baseItem && baseItem.label) || (compareItem && compareItem.label) || itemKey,
          baseValue,
          compareValue,
          ...adjustedChangePercent({ baseValue, compareValue, cashFlows, periodStart, periodEnd })
        };
      })
      .sort((a, b) => (b.compareValue ?? b.baseValue ?? 0) - (a.compareValue ?? a.baseValue ?? 0));

    const baseHasCategory = baseItems.length > 0;
    const compareHasCategory = compareItems.length > 0;
    const baseTotal = baseItems.reduce((sum, it) => sum + it.value, 0);
    const compareTotal = compareItems.reduce((sum, it) => sum + it.value, 0);
    const categoryCashFlows = categoryFlowsInPeriod(key);

    return {
      key,
      label: MONTHLY_CATEGORY_LABELS_HE[key],
      baseValue: baseHasCategory ? baseTotal : null,
      compareValue: compareHasCategory ? compareTotal : null,
      ...adjustedChangePercent({
        baseValue: baseHasCategory ? baseTotal : null,
        compareValue: compareHasCategory ? compareTotal : null,
        cashFlows: categoryCashFlows.length > 0 ? categoryCashFlows : null,
        periodStart,
        periodEnd
      }),
      items
    };
  });

  const totalCashFlows = MONTHLY_CATEGORY_KEYS.flatMap((key) => categoryFlowsInPeriod(key));

  // "Partial" only when a category actually holding value has no
  // cash-flow data at all behind it - an account whose ledger has never
  // recorded a single movement, and nothing declared for this period
  // either - i.e. a real, undisclosed gap in what the total's adjustment
  // could account for.
  const partiallyAdjusted = categoryRows.some((row) => {
    const holdsValue = (row.baseValue || 0) !== 0 || (row.compareValue || 0) !== 0;
    if (!holdsValue) return false;
    // Stocks, provident funds and bank savings always carry their dated
    // lots/deposits. A money-market fund or current account only does
    // once a movement has actually been recorded in its ledger.
    const ledgerInUse = !['cashFunds', 'bank'].includes(row.key) || Boolean(liveCashFlows && liveCashFlows[row.key].size > 0);
    const hasManualData = manualCashFlows[row.key].length > 0;
    return !ledgerInUse && !hasManualData;
  });

  const totalRow = {
    key: 'total',
    label: 'סה"כ תיק',
    baseValue: isFiniteNumber(baseSnapshot.totalValueILS) ? baseSnapshot.totalValueILS : null,
    compareValue: isFiniteNumber(compareSnapshot.totalValueILS) ? compareSnapshot.totalValueILS : null,
    ...adjustedChangePercent({
      baseValue: isFiniteNumber(baseSnapshot.totalValueILS) ? baseSnapshot.totalValueILS : null,
      compareValue: isFiniteNumber(compareSnapshot.totalValueILS) ? compareSnapshot.totalValueILS : null,
      cashFlows: totalCashFlows.length > 0 ? totalCashFlows : null,
      periodStart,
      periodEnd
    }),
    partiallyAdjusted,
    items: []
  };

  return [...categoryRows, totalRow];
}
