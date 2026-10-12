// The monthly report's data: one plain object built from what the server
// has stored (monthly snapshots, the portfolio, the transactions ledger,
// market events). The PDF is a pure view of this model, and the model's
// hash decides whether a re-render can reuse an existing file.
//
// Conventions match the monthly tracker page (utils/monthlySnapshotComparison.js),
// so the report and the page never disagree about the same month:
//   * Values come from the saved monthly checkpoints (M and the month
//     before it), not from live prices.
//   * "Net capital added" = stock purchases + account deposits (withdrawals
//     negative) - sale proceeds - dividends paid out + the flows the user
//     declared by hand for the liquid accounts when saving the month.
//   * Monthly return = Modified Dietz on net worth with those dated flows.
const { closedLotSlices, ledgerCashFlows, realizedLots } = require('../../shared/transactionLedger');
const { previousMonth, monthEnd, nextMonth } = require('../../shared/monthlySync');

const CATEGORY_KEYS = ['israeli', 'american', 'pension', 'cashFunds', 'bank', 'bankSavings'];
const CATEGORY_LABELS = {
  israeli: 'מניות - בורסה ישראלית',
  american: 'מניות - בורסה אמריקאית',
  pension: 'קופות גמל ופנסיה',
  cashFunds: 'קרנות כספיות',
  bank: 'עו"ש',
  bankSavings: 'חיסכון בנקאי'
};
// The report's allocation groups (spec: equities, fixed income,
// provident/pension, cash reserves). The app has no bond breakdown inside
// the stock lists, so fixed income = the bank savings deposits.
const ALLOCATION_GROUPS = [
  { key: 'equities', label: 'מניות', categories: ['israeli', 'american'] },
  { key: 'fixedIncome', label: 'חיסכון והכנסה קבועה', categories: ['bankSavings'] },
  { key: 'pension', label: 'קופות גמל ופנסיה', categories: ['pension'] },
  { key: 'cash', label: 'מזומן ועו"ש', categories: ['bank', 'cashFunds'] }
];

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

function itemsOf(breakdown, category) {
  const raw = breakdown ? breakdown[category] : null;
  if (Array.isArray(raw)) return raw.map((i) => ({ key: String(i.key), label: i.label || String(i.key), value: num(i.value) }));
  if (Number.isFinite(Number(raw)) && Number(raw) !== 0) return [{ key: category, label: CATEGORY_LABELS[category], value: Number(raw) }];
  return [];
}

function categoryTotals(breakdown) {
  const out = {};
  CATEGORY_KEYS.forEach((c) => {
    out[c] = itemsOf(breakdown, c).reduce((s, i) => s + i.value, 0);
  });
  return out;
}

const inMonth = (date, month) => typeof date === 'string' && date.slice(0, 7) === month;

// Every external flow dated inside `month`, attributed to a category and
// an item key (the same keys the snapshot breakdown uses).
function flowsForMonth({ portfolio, transactions, snapshot, month }) {
  const flows = [];
  const p = portfolio || {};
  const slices = closedLotSlices(transactions);
  const lots = (market) => (market === 'israeli' ? (p.israeliStocks || []).concat(slices.israeliStocks) : (p.americanStocks || []).concat(slices.americanStocks));

  ['israeli', 'american'].forEach((market) => {
    lots(market).forEach((lot) => {
      if (!inMonth(lot.purchaseDate, month)) return;
      const rate = market === 'american' ? num(lot.exchangeRate) : 1;
      const amount = num(lot.purchasePrice) * num(lot.quantity) * rate;
      if (amount) flows.push({ date: lot.purchaseDate, amount, category: market, itemKey: String(lot.stockName).trim(), kind: 'PURCHASE' });
    });
  });

  (transactions || [])
    .filter((tx) => (tx.type === 'SELL' || tx.type === 'DIVIDEND') && inMonth(tx.date, month))
    .forEach((tx) => {
      const [flow] = ledgerCashFlows([tx]);
      if (flow) flows.push({ date: flow.date, amount: flow.amount, category: tx.assetClass, itemKey: String(tx.assetId), kind: tx.type === 'SELL' ? 'SALE' : 'DIVIDEND' });
    });

  [['pensionFunds', 'pension', 'pension'], ['cashFunds', 'cashFunds', 'cash'], ['bankSavingsFunds', 'bankSavings', 'bank-savings']].forEach(([key, category, prefix]) => {
    (p[key] || []).forEach((account) => {
      (account.deposits || []).forEach((d) => {
        if (!inMonth(d.date, month) || !num(d.amount)) return;
        flows.push({
          date: d.date,
          amount: num(d.amount),
          category,
          itemKey: account.fundName || `${prefix}-${account.id}`,
          kind: num(d.amount) > 0 ? 'DEPOSIT' : 'WITHDRAWAL'
        });
      });
    });
  });

  // Current accounts: only deposits/withdrawals recorded through the
  // transactions ledger (entries carrying a txId). The account's own
  // deposit list otherwise holds its opening balance, and ordinary balance
  // changes are not flows (see portfolioCashFlows.js).
  (p.bankBalances || []).forEach((account, index) => {
    (account.deposits || []).forEach((d) => {
      if (!d || !d.txId || !inMonth(d.date, month) || !num(d.amount)) return;
      flows.push({
        date: d.date,
        amount: num(d.amount),
        category: 'bank',
        itemKey: `bank-${index + 1}`,
        kind: num(d.amount) > 0 ? 'DEPOSIT' : 'WITHDRAWAL'
      });
    });
  });

  // Flows the user declared by hand when saving the month (liquid accounts).
  const declared = (snapshot && snapshot.breakdown && snapshot.breakdown.cashFlows) || {};
  Object.keys(declared).forEach((category) => {
    const amount = num(declared[category]);
    if (amount) flows.push({ date: monthEnd(month), amount, category, itemKey: null, kind: 'DECLARED' });
  });

  return flows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

// A short fingerprint of everything that moves the month's cash-flow
// section: purchases, sales, dividends, deposits and withdrawals dated in
// the month. A change after the month was completed means the report is
// out of date and needs a new version.
function monthFlowsFingerprint({ portfolio, transactions, month }) {
  const canonical = flowsForMonth({ portfolio, transactions, snapshot: null, month })
    .map((f) => `${f.date}|${f.kind}|${f.category}|${f.itemKey}|${Math.round(f.amount * 100)}`)
    .sort()
    .join(';');
  let h = 5381;
  for (let i = 0; i < canonical.length; i += 1) h = ((h << 5) + h + canonical.charCodeAt(i)) >>> 0;
  return h.toString(16);
}

// Modified Dietz for one period (same formula as utils/modifiedDietz.js).
function modifiedDietz(bmv, emv, flows, periodStart, periodEnd) {
  const start = Date.parse(`${periodStart}T00:00:00Z`);
  const end = Date.parse(`${periodEnd}T00:00:00Z`);
  const net = flows.reduce((s, f) => s + f.amount, 0);
  const weighted = flows.reduce((s, f) => {
    const t = Math.min(Math.max(Date.parse(`${f.date}T00:00:00Z`), start), end);
    return s + f.amount * (end > start ? (end - t) / (end - start) : 0);
  }, 0);
  const denom = bmv + weighted;
  return denom > 0 ? ((emv - bmv - net) / denom) * 100 : null;
}

function buildReportModel({
  userEmail = '',
  month,
  snapshots,
  portfolio,
  transactions = [],
  events = [],
  syncStatus = null,
  targets = null,
  usdRateEnd = null,
  usdRatePrev = null,
  // Dividends found in the market data but not recorded in the ledger:
  // [{ date, symbol, currency, amountPerShare, units }]. Shown, marked as
  // estimates, and kept out of the return and capital figures (the amount
  // actually received after withholding tax is unknown).
  estimatedDividends = [],
  generatedAt = new Date().toISOString()
}) {
  const byMonth = new Map((snapshots || []).map((s) => [s.month, s]));
  const current = byMonth.get(month);
  if (!current) throw new Error(`no monthly snapshot saved for ${month}`);
  const prevKey = previousMonth(month);
  const earlier = (snapshots || []).filter((s) => s.month < month).sort((a, b) => (a.month < b.month ? 1 : -1));
  const previous = byMonth.get(prevKey) || earlier[0] || null;

  const netWorth = num(current.totalValueILS);
  const prevNetWorth = previous ? num(previous.totalValueILS) : null;
  const flows = flowsForMonth({ portfolio, transactions, snapshot: current, month });
  const netCapitalAdded = flows.reduce((s, f) => s + f.amount, 0);
  const change = prevNetWorth === null ? null : netWorth - prevNetWorth;
  const periodStart = previous ? monthEnd(previous.month) : `${month}-01`;
  const returnPct = prevNetWorth === null ? null : modifiedDietz(prevNetWorth, netWorth, flows, periodStart, monthEnd(month));

  // Allocation
  const totals = categoryTotals(current.breakdown);
  const totalAll = CATEGORY_KEYS.reduce((s, c) => s + totals[c], 0) || netWorth;
  const allocation = ALLOCATION_GROUPS.map((g) => {
    const value = g.categories.reduce((s, c) => s + totals[c], 0);
    const target = targets ? g.categories.reduce((s, c) => s + num(targets[c]), 0) : null;
    return { key: g.key, label: g.label, value, percent: totalAll > 0 ? (value / totalAll) * 100 : 0, targetPercent: target };
  });
  const categories = CATEGORY_KEYS.map((c) => ({ key: c, label: CATEGORY_LABELS[c], value: totals[c], percent: totalAll > 0 ? (totals[c] / totalAll) * 100 : 0 }));

  // Movers: per item, value change net of that item's own flows.
  const movers = [];
  if (previous) {
    CATEGORY_KEYS.forEach((c) => {
      const now = itemsOf(current.breakdown, c);
      const before = itemsOf(previous.breakdown, c);
      const keys = new Set(now.map((i) => i.key).concat(before.map((i) => i.key)));
      keys.forEach((key) => {
        const a = before.find((i) => i.key === key);
        const b = now.find((i) => i.key === key);
        const itemFlows = flows.filter((f) => f.category === c && f.itemKey === key).reduce((s, f) => s + f.amount, 0);
        const startValue = a ? a.value : 0;
        const endValue = b ? b.value : 0;
        const contribution = endValue - startValue - itemFlows;
        const base = startValue + Math.max(0, itemFlows);
        if (Math.abs(contribution) < 0.5) return;
        movers.push({
          key,
          label: (b || a).label,
          category: c,
          categoryLabel: CATEGORY_LABELS[c],
          startValue,
          endValue,
          flows: itemFlows,
          contributionILS: contribution,
          percent: base > 0 ? (contribution / base) * 100 : null
        });
      });
    });
  }
  movers.sort((x, y) => y.contributionILS - x.contributionILS);
  const topMovers = movers.filter((m) => m.contributionILS > 0).slice(0, 5);
  const topDraggers = movers.filter((m) => m.contributionILS < 0).slice(-5).reverse();

  // Cash flows
  const dividends = (transactions || [])
    .filter((tx) => tx.type === 'DIVIDEND' && inMonth(tx.date, month))
    .map((tx) => ({
      date: tx.date,
      symbol: tx.assetId,
      currency: tx.currency,
      gross: num(tx.amount),
      taxWithheld: num(tx.taxWithheld),
      net: num(tx.amount) - num(tx.taxWithheld),
      netILS: (num(tx.amount) - num(tx.taxWithheld)) * (tx.currency === 'USD' ? num(tx.fxRate) : 1)
    }));
  const estimated = (estimatedDividends || []).map((d) => {
    const gross = num(d.amountPerShare) * num(d.units);
    const rate = d.currency === 'USD' ? num(usdRateEnd) : 1;
    return {
      date: d.date,
      symbol: d.symbol,
      currency: d.currency,
      units: num(d.units),
      amountPerShare: num(d.amountPerShare),
      gross,
      grossILS: rate ? gross * rate : null
    };
  });
  const sumKind = (kind) => flows.filter((f) => f.kind === kind).reduce((s, f) => s + f.amount, 0);
  const realized = realizedLots(transactions).filter((r) => inMonth(r.saleDate, month));

  const nextM = nextMonth(month);
  const upcomingEvents = (events || []).filter((e) => e.eventDate >= `${nextM}-01` && e.eventDate <= monthEnd(nextM));

  return {
    version: 1,
    month,
    generatedAt,
    userEmail,
    previousMonth: previous ? previous.month : null,
    previousIsAdjacent: previous ? previous.month === prevKey : false,
    summary: {
      netWorthILS: netWorth,
      prevNetWorthILS: prevNetWorth,
      changeILS: change,
      changePct: prevNetWorth ? (change / prevNetWorth) * 100 : null,
      netCapitalAddedILS: netCapitalAdded,
      marketChangeILS: change === null ? null : change - netCapitalAdded,
      returnPct,
      usdRateEnd,
      netWorthUSD: usdRateEnd ? netWorth / usdRateEnd : null,
      changeUSD: usdRateEnd && usdRatePrev && prevNetWorth !== null ? netWorth / usdRateEnd - prevNetWorth / usdRatePrev : null
    },
    allocation,
    categories,
    topMovers,
    topDraggers,
    cashFlow: {
      dividends,
      dividendsNetILS: dividends.reduce((s, d) => s + d.netILS, 0),
      estimatedDividends: estimated,
      estimatedDividendsGrossILS: estimated.every((d) => d.grossILS !== null) ? estimated.reduce((s, d) => s + d.grossILS, 0) : null,
      purchasesILS: sumKind('PURCHASE'),
      saleProceedsILS: -sumKind('SALE'),
      depositsILS: sumKind('DEPOSIT'),
      withdrawalsILS: -sumKind('WITHDRAWAL'),
      declaredILS: sumKind('DECLARED'),
      netCapitalAddedILS: netCapitalAdded,
      realizedGainILS: realized.reduce((s, r) => s + r.nominalGainILS, 0),
      realizedCount: realized.length
    },
    upcomingEvents,
    dataFreshness: syncStatus
      ? syncStatus.accounts.map((a) => ({ name: a.name, category: a.category, valueDate: a.valueDate, updated: a.updated, excluded: a.excluded }))
      : []
  };
}

// Market-data dividends (ex-date inside the month) for held US securities
// that have no DIVIDEND recorded in the ledger for that month. Units are
// those held on the ex-date: bought before it, and not sold before it.
function estimateUnrecordedDividends({ portfolio, transactions, month, historyBySymbol }) {
  const p = portfolio || {};
  const lots = (p.americanStocks || []).concat(closedLotSlices(transactions).americanStocks);
  const recorded = new Set(
    (transactions || []).filter((tx) => tx.type === 'DIVIDEND' && inMonth(tx.date, month)).map((tx) => String(tx.assetId).toUpperCase())
  );
  const out = [];
  Object.keys(historyBySymbol || {}).forEach((symbol) => {
    if (recorded.has(symbol.toUpperCase())) return;
    (historyBySymbol[symbol] || []).forEach((d) => {
      if (!inMonth(d.date, month) || !(num(d.amountPerShare) > 0)) return;
      const units = lots
        .filter((lot) => String(lot.stockName).trim().toUpperCase() === symbol.toUpperCase())
        .filter((lot) => lot.purchaseDate && lot.purchaseDate < d.date && !(lot.soldDate && lot.soldDate < d.date))
        .reduce((s, lot) => s + num(lot.quantity), 0);
      if (units > 0) out.push({ date: d.date, symbol: symbol.toUpperCase(), currency: 'USD', amountPerShare: num(d.amountPerShare), units });
    });
  });
  return out.sort((a, b) => (a.date < b.date ? -1 : 1));
}

// US symbols held at some point during the month (open lots or closed slices).
function usSymbolsHeldInMonth({ portfolio, transactions, month }) {
  const p = portfolio || {};
  const start = `${month}-01`;
  const end = monthEnd(month);
  const lots = (p.americanStocks || []).concat(closedLotSlices(transactions).americanStocks);
  return [
    ...new Set(
      lots
        .filter((lot) => lot.purchaseDate && lot.purchaseDate <= end && !(lot.soldDate && lot.soldDate < start))
        .map((lot) => String(lot.stockName).trim().toUpperCase())
        .filter(Boolean)
    )
  ].sort();
}

module.exports = {
  buildReportModel,
  flowsForMonth,
  monthFlowsFingerprint,
  estimateUnrecordedDividends,
  usSymbolsHeldInMonth,
  modifiedDietz,
  CATEGORY_LABELS,
  ALLOCATION_GROUPS
};
