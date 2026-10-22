// The facts the portfolio review is built from, one calendar month at a
// time: how much money went in and where, what the portfolio was worth at
// each month-end, the month's return, and how each holding did.
//
// Pure: holdings, the transactions ledger and the fetched historical
// closes in, plain numbers out. Nothing here scores or words anything -
// that is portfolioReviewScoring.js and portfolioReviewText.js - so the
// same facts back the review of any month, the trend across months, and
// the tests.
//
// WHAT COUNTS AS "INVESTED"
//
// Money that went into an investment: a purchase of a security (every lot,
// including the slices a later sale closed - they were bought all the
// same), a deposit into a provident fund, and a deposit into a bank savings
// plan. Money parked in a money-market fund or left in the current account
// is not invested; it is the cash the "idle cash" category looks at. Sale
// proceeds and withdrawals are recorded separately, so the month shows both
// the gross amount put in and the net.
//
// HISTORICAL VALUES
//
// Month-end values come from the same engine as the performance chart
// (historicalPortfolioValue.js), over the holdings expanded with their
// closed slices, so a month before a sale still counts what was sold. A
// month whose value could not be computed in full (a symbol with no close)
// is flagged rather than summed short - every figure built on it says so.
import { expandHoldingsWithClosedLots } from '../shared/transactionLedger';
import { liquidBalanceOn } from '../shared/liquidBalance';
import { buildPortfolioCashFlows } from './portfolioCashFlows';
import { closeOnOrBefore, computePortfolioValueAtDate, isLotHeldOn } from './historicalPortfolioValue';
import { valueOfLedgerAccountAtDate } from './ledgerAccountHistory';
import { computeBankSavingsFundValue } from './bankSavingsFund';
import { calculateModifiedDietzReturn } from './modifiedDietz';
import { detectIsraeliFund, effectiveExchangeForIsraeliStock, resolveIsraeliSector } from './israeliEtfClassifier';
import { sectorFromTaseBranch } from './israeliSectorMapping';
import { ETF_SECTOR_KEY, UNCLASSIFIED_SECTOR_KEY, sectorLabelHe } from './sectorLabels';
import { MONTHLY_CATEGORY_LABELS_HE } from './monthlySnapshotComparison';
import { normalizeIsraeliPrice, toNum } from './formatters';

// US tickers that are funds rather than single companies. Yahoo's profile
// gives them no sector, so without this list an S&P 500 tracker would read
// as one undiversified stock. Extend as needed.
export const KNOWN_US_FUNDS = [
  'SPY', 'VOO', 'IVV', 'VTI', 'VT', 'VXUS', 'VEA', 'VWO', 'QQQ', 'QQQM', 'DIA', 'IWM', 'SCHD', 'SCHB',
  'SCHX', 'VUG', 'VTV', 'VIG', 'VYM', 'ACWI', 'EFA', 'EEM', 'IEFA', 'IEMG', 'BND', 'AGG', 'TLT', 'IEF',
  'SHY', 'BNDX', 'TIP', 'VNQ', 'GLD', 'IAU', 'SLV', 'XLK', 'XLF', 'XLV', 'XLE', 'XLY', 'XLP', 'XLI',
  'XLU', 'XLB', 'XLRE', 'XLC', 'SMH', 'SOXX', 'ARKK', 'VGT', 'SPLG', 'RSP', 'MDY', 'IJH', 'IJR'
];
const KNOWN_US_FUND_SET = new Set(KNOWN_US_FUNDS);

export const INSTRUMENT_LABELS_HE = {
  stock: 'מניות בודדות',
  fund: 'קרנות סל ונאמנות',
  providentFund: 'קופות גמל להשקעה',
  deposit: 'חיסכון בבנק',
  moneyMarket: 'קרן כספית',
  cash: 'עו"ש'
};

export const CURRENCY_LABELS_HE = { ILS: 'שקל', USD: 'דולר / מט"ח' };
export const REGION_LABELS_HE = { israel: 'ישראל', abroad: 'חו"ל' };

// ---------------------------------------------------------------------------
// Month arithmetic. Month keys are 'YYYY-MM'; dates are 'YYYY-MM-DD'.

export const monthKeyOf = (date) => String(date || '').slice(0, 7);

export const shiftMonth = (monthKey, delta) => {
  const [y, m] = monthKey.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return d.toISOString().slice(0, 7);
};

export const lastDayOfMonth = (monthKey) => {
  const [y, m] = monthKey.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
};

export const monthRange = (fromKey, toKey) => {
  const out = [];
  if (!fromKey || !toKey || fromKey > toKey) return out;
  for (let key = fromKey; key <= toKey; key = shiftMonth(key, 1)) out.push(key);
  return out;
};

const addDays = (date, days) => new Date(Date.parse(`${date}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);

export const daysBetween = (from, to) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000);

const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}/.test(s);

// ---------------------------------------------------------------------------
// What a holding is

// One description per security, shared by every figure that splits money
// by asset, sector, instrument type, currency, region or account.
export function describeSecurity(market, lot, sectorBySymbol = {}) {
  const symbol = market === 'american' ? String(lot.stockName || '').trim().toUpperCase() : String(lot.stockName || '').trim();
  if (market === 'american') {
    const isFund = KNOWN_US_FUND_SET.has(symbol);
    const yahooSector = sectorBySymbol[symbol] && sectorBySymbol[symbol].sector;
    const sectorKey = isFund ? ETF_SECTOR_KEY : yahooSector || UNCLASSIFIED_SECTOR_KEY;
    return {
      id: `american:${symbol}`,
      market,
      symbol,
      label: symbol,
      instrument: isFund ? 'fund' : 'stock',
      sectorKey,
      currency: 'USD',
      region: 'abroad',
      account: 'american'
    };
  }
  const isFund = detectIsraeliFund(lot);
  const abroad = effectiveExchangeForIsraeliStock(lot) === 'american';
  return {
    id: `israeli:${symbol}`,
    market: 'israeli',
    symbol,
    label: lot.officialName ? `${lot.officialName}` : symbol,
    instrument: isFund ? 'fund' : 'stock',
    sectorKey: resolveIsraeliSector(lot, sectorFromTaseBranch),
    // A TASE fund tracking a foreign index trades in shekels but its value
    // moves with the foreign market and currency - that is the exposure.
    currency: abroad ? 'USD' : 'ILS',
    region: abroad ? 'abroad' : 'israel',
    account: 'israeli'
  };
}

const ACCOUNT_KINDS = {
  pensionFunds: { account: 'pension', instrument: 'providentFund', label: 'קופת גמל', invest: true },
  bankSavingsFunds: { account: 'bankSavings', instrument: 'deposit', label: 'חיסכון בבנק', invest: true },
  cashFunds: { account: 'cashFunds', instrument: 'moneyMarket', label: 'קרן כספית', invest: false },
  bankBalances: { account: 'bank', instrument: 'cash', label: 'עו"ש', invest: false }
};

function describeAccount(key, account, index) {
  const kind = ACCOUNT_KINDS[key];
  return {
    id: `${kind.account}:${account.id != null ? account.id : index}`,
    market: kind.account,
    symbol: null,
    label: account.fundName || kind.label,
    instrument: kind.instrument,
    // A provident fund's track is free text; its sector and region are not
    // known, so it is left out of those splits rather than guessed.
    sectorKey: null,
    currency: 'ILS',
    region: null,
    account: kind.account,
    invest: kind.invest
  };
}

// ---------------------------------------------------------------------------
// Money events

const lotCostILS = (market, lot) => {
  const cost = toNum(lot.purchasePrice) * toNum(lot.quantity);
  return market === 'american' ? cost * toNum(lot.exchangeRate) : cost;
};

// Every dated movement of money the review counts, flattened:
//   kind: 'buy' | 'sell' | 'deposit' | 'withdrawal' | 'dividend' | 'fee'
//   amountILS: always positive; the kind says which way it went.
export function buildMoneyEvents({ holdings, transactions = [], sectorBySymbol = {} }) {
  const expanded = expandHoldingsWithClosedLots(holdings, transactions);
  const events = [];

  // A lot that was partly sold lives on as two rows - the open remainder
  // and the closed slice - but it was one purchase. They are merged back
  // by the lot they came from, so a purchase is counted once.
  const buys = new Map();
  ['israeli', 'american'].forEach((market) => {
    const lots = market === 'american' ? expanded.americanStocks : expanded.israeliStocks;
    (lots || []).forEach((lot) => {
      if (!isDate(lot.purchaseDate)) return;
      const amountILS = lotCostILS(market, lot);
      if (!(amountILS > 0)) return;
      const originId = lot.isClosedSlice ? String(lot.id).split(':sold:')[0] : String(lot.id);
      const key = `${market}|${originId}|${lot.purchaseDate.slice(0, 10)}`;
      const existing = buys.get(key);
      if (existing) {
        existing.amountILS += amountILS;
        return;
      }
      const event = {
        kind: 'buy',
        date: lot.purchaseDate.slice(0, 10),
        amountILS,
        security: describeSecurity(market, lot, sectorBySymbol),
        fromLedger: Boolean(lot.txId)
      };
      buys.set(key, event);
      events.push(event);
    });
  });

  Object.keys(ACCOUNT_KINDS).forEach((key) => {
    (holdings[key] || []).forEach((account, index) => {
      const security = describeAccount(key, account, index);
      (Array.isArray(account.deposits) ? account.deposits : []).forEach((deposit) => {
        const amount = toNum(deposit && deposit.amount);
        if (!deposit || !isDate(deposit.date) || amount === 0) return;
        events.push({
          kind: amount > 0 ? 'deposit' : 'withdrawal',
          date: deposit.date.slice(0, 10),
          amountILS: Math.abs(amount),
          security,
          invest: security.invest
        });
      });
    });
  });

  (transactions || []).forEach((tx) => {
    if (!tx || !isDate(tx.date)) return;
    const rate = tx.currency === 'USD' ? toNum(tx.fxRate) : 1;
    const security =
      tx.assetClass === 'israeli' || tx.assetClass === 'american'
        ? describeSecurity(tx.assetClass, { stockName: tx.assetId }, sectorBySymbol)
        : null;
    if ((tx.type === 'BUY' || tx.type === 'SELL') && toNum(tx.fees) > 0) {
      events.push({ kind: 'fee', date: tx.date, amountILS: toNum(tx.fees) * rate, security, txType: tx.type });
    }
    // Converting at a worse rate than the representative one costs the
    // difference on the converted amount, whichever way the trade went.
    const paidRate = toNum(tx.fxPaidRate);
    if (tx.currency === 'USD' && (tx.type === 'BUY' || tx.type === 'SELL') && paidRate > 0 && rate > 0) {
      const fxCost = Math.abs(paidRate - rate) * toNum(tx.units) * toNum(tx.price);
      if (fxCost > 0) events.push({ kind: 'fxCost', date: tx.date, amountILS: fxCost, security, txType: tx.type });
    }
    if (tx.type === 'SELL') {
      events.push({
        kind: 'sell',
        date: tx.date,
        amountILS: (toNum(tx.units) * toNum(tx.price) - toNum(tx.fees)) * rate,
        grossILS: toNum(tx.units) * toNum(tx.price) * rate,
        security,
        txId: tx.id
      });
    }
    if (tx.type === 'DIVIDEND') {
      events.push({
        kind: 'dividend',
        date: tx.date,
        amountILS: (toNum(tx.amount) - toNum(tx.taxWithheld)) * rate,
        taxWithheldILS: toNum(tx.taxWithheld) * rate,
        security
      });
    }
  });

  return events.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

// True when the user records trades through the ledger at all - the only
// place fees are known. Lots typed straight into a table carry none.
export const hasLedgerTrades = (transactions) =>
  (transactions || []).some((tx) => tx && (tx.type === 'BUY' || tx.type === 'SELL'));

// ---------------------------------------------------------------------------
// Pricing one security on a date

function closeILS(market, symbol, date, priceData) {
  const { taseHistoricalCloses = {}, yahooHistoricalCloses = {}, fxHistoricalCloses = [] } = priceData || {};
  if (market === 'american') {
    const usd = closeOnOrBefore(date, yahooHistoricalCloses[symbol]);
    const fx = closeOnOrBefore(date, fxHistoricalCloses);
    return usd === null || fx === null ? null : usd * fx;
  }
  const agorot = closeOnOrBefore(date, taseHistoricalCloses[symbol]);
  return agorot === null ? null : agorot / 100;
}

// The live price, in ILS - used only on today's date, when a symbol has no
// close yet (a fetch that failed, or a security just added).
function livePriceILS(market, lot) {
  const price = market === 'american' ? toNum(lot.currentPrice) * toNum(lot.currentExchangeRate || lot.exchangeRate) : normalizeIsraeliPrice(lot.currentPrice);
  return price > 0 ? price : null;
}

// What the lots of one symbol were worth on `date`, or null when it cannot
// be priced. A lot bought that very day is worth what was paid for it (the
// same day-0 rule the performance chart uses).
function symbolValueOn(market, symbol, lots, date, priceData, { allowLive = false } = {}) {
  let total = 0;
  let held = false;
  let price;
  for (const lot of lots) {
    if (!isLotHeldOn(lot, date)) continue;
    const qty = toNum(lot.quantity);
    if (qty <= 0) continue;
    held = true;
    if (lot.purchaseDate && lot.purchaseDate.slice(0, 10) === date && toNum(lot.purchasePrice) > 0) {
      total += lotCostILS(market, lot);
      continue;
    }
    if (price === undefined) {
      price = closeILS(market, symbol, date, priceData);
      if (price === null && allowLive) price = livePriceILS(market, lot);
    }
    if (price === null) return null;
    total += qty * price;
  }
  return held ? total : 0;
}

function groupLots(expanded) {
  const groups = new Map();
  ['israeli', 'american'].forEach((market) => {
    const lots = market === 'american' ? expanded.americanStocks : expanded.israeliStocks;
    (lots || []).forEach((lot) => {
      const symbol = market === 'american' ? String(lot.stockName || '').trim().toUpperCase() : String(lot.stockName || '').trim();
      if (!symbol) return;
      const id = `${market}:${symbol}`;
      if (!groups.has(id)) groups.set(id, { id, market, symbol, lots: [] });
      groups.get(id).lots.push(lot);
    });
  });
  return [...groups.values()];
}

// ---------------------------------------------------------------------------
// Allocation on a date: every holding and account with its value, and the
// splits the diversification category reads.

export function allocationOn(date, { holdings, transactions = [], priceData, sectorBySymbol = {}, today }) {
  const expanded = expandHoldingsWithClosedLots(holdings, transactions);
  const allowLive = date >= today;
  const items = [];
  const unpriced = [];

  groupLots(expanded).forEach((group) => {
    const value = symbolValueOn(group.market, group.symbol, group.lots, date, priceData, { allowLive });
    if (value === null) {
      unpriced.push(group.symbol);
      return;
    }
    if (value <= 0) return;
    const lot = group.lots.find((l) => l.officialName) || group.lots[0];
    items.push({ ...describeSecurity(group.market, lot, sectorBySymbol), value });
  });

  Object.keys(ACCOUNT_KINDS).forEach((key) => {
    (holdings[key] || []).forEach((account, index) => {
      let value;
      if (key === 'bankSavingsFunds') value = toNum(computeBankSavingsFundValue(account, date));
      else if (allowLive && (key === 'cashFunds' || key === 'bankBalances')) value = liquidBalanceOn(account, date);
      else value = valueOfLedgerAccountAtDate(account, date);
      if (value > 0) items.push({ ...describeAccount(key, account, index), value });
    });
  });

  return summarizeAllocation(items, { date, unpriced });
}

// The splits over a list of valued items. Separate from allocationOn so a
// hypothetical allocation (the ideas engine's "what if 10% of the next
// deposit went here") is summarized exactly like the real one.
export function summarizeAllocation(items, { date = null, unpriced = [] } = {}) {
  const total = items.reduce((sum, item) => sum + item.value, 0);
  const securities = items.filter((item) => item.market === 'israeli' || item.market === 'american');
  const securitiesTotal = securities.reduce((sum, item) => sum + item.value, 0);

  return {
    date,
    items,
    total,
    securitiesTotal,
    unpriced,
    byInstrument: splitBy(items, (i) => i.instrument, (k) => INSTRUMENT_LABELS_HE[k]),
    byCurrency: splitBy(items, (i) => i.currency, (k) => CURRENCY_LABELS_HE[k]),
    byAccount: splitBy(items, (i) => i.account, (k) => MONTHLY_CATEGORY_LABELS_HE[k]),
    // Sectors and regions are about the securities only: a provident fund's
    // track or a bank balance has neither.
    bySector: splitBy(securities, (i) => i.sectorKey, (k) => sectorLabelHe(k)),
    byRegion: splitBy(securities, (i) => i.region, (k) => REGION_LABELS_HE[k])
  };
}

// [{ key, label, amount, share }] sorted largest first; share in 0-1.
export function splitBy(rows, keyOf, labelOf, amountOf = (r) => r.value) {
  const totals = new Map();
  rows.forEach((row) => {
    const key = keyOf(row);
    if (key === null || key === undefined) return;
    totals.set(key, (totals.get(key) || 0) + amountOf(row));
  });
  const sum = [...totals.values()].reduce((s, v) => s + v, 0);
  return [...totals.entries()]
    .map(([key, amount]) => ({ key, label: labelOf(key) || key, amount, share: sum > 0 ? amount / sum : 0 }))
    .filter((row) => row.amount > 0)
    .sort((a, b) => b.amount - a.amount);
}

// ---------------------------------------------------------------------------
// The month

// Inception: the first dated purchase, deposit or ledger entry.
export function inceptionDate(events) {
  return events.length ? events[0].date : null;
}

// Everything the review needs about one month.
//
// `today` decides whether the month is still running: its end is then
// today, and every figure is "so far" (isPartial).
export function buildMonthFacts(monthKey, ctx) {
  const { events, priceData, today } = ctx;
  const start = addDays(`${monthKey}-01`, -1); // the previous month's last day
  const fullEnd = lastDayOfMonth(monthKey);
  const isPartial = fullEnd > today;
  const end = isPartial ? today : fullEnd;
  const inMonth = (e) => e.date > start && e.date <= end;
  const monthEvents = events.filter(inMonth);

  const investEvents = monthEvents.filter((e) => e.kind === 'buy' || (e.kind === 'deposit' && e.invest));
  const invested = sum(investEvents);
  const sold = sum(monthEvents.filter((e) => e.kind === 'sell'));
  const withdrawn = sum(monthEvents.filter((e) => e.kind === 'withdrawal' && e.invest));
  const parked = sum(monthEvents.filter((e) => e.kind === 'deposit' && !e.invest));
  const fees = sum(monthEvents.filter((e) => e.kind === 'fee'));
  const dividends = sum(monthEvents.filter((e) => e.kind === 'dividend'));

  const asRows = (list) => list.map((e) => ({ ...e.security, value: e.amountILS }));
  const investRows = asRows(investEvents);
  const destinations = {
    byAsset: splitBy(investRows, (r) => r.id, (k) => (investRows.find((r) => r.id === k) || {}).label),
    bySector: splitBy(investRows.filter((r) => r.sectorKey), (r) => r.sectorKey, (k) => sectorLabelHe(k)),
    byInstrument: splitBy(investRows, (r) => r.instrument, (k) => INSTRUMENT_LABELS_HE[k]),
    byCurrency: splitBy(investRows, (r) => r.currency, (k) => CURRENCY_LABELS_HE[k]),
    byAccount: splitBy(investRows, (r) => r.account, (k) => MONTHLY_CATEGORY_LABELS_HE[k])
  };
  // The largest single individual stock this month's money went into.
  const stockRows = investRows.filter((r) => r.instrument === 'stock');
  const topStock = splitBy(stockRows, (r) => r.id, (k) => (stockRows.find((r) => r.id === k) || {}).label)[0] || null;

  const buys = monthEvents.filter((e) => e.kind === 'buy').length;
  const sells = monthEvents.filter((e) => e.kind === 'sell').length;
  const deposits = monthEvents.filter((e) => e.kind === 'deposit' && e.invest).length;

  // Value and return.
  const expanded = ctx.expanded;
  const startPoint = computePortfolioValueAtDate(start, expanded, priceData, { anchorLedgerAccountsToFirstRecord: true });
  const endPoint = computePortfolioValueAtDate(end, expanded, priceData, { anchorLedgerAccountsToFirstRecord: true });
  const startValue = startPoint.valueILS || 0;
  let endValue = endPoint.valueILS;
  let valuePartial = Boolean(startPoint.isPartial || endPoint.isPartial);
  // The running month may have no close yet for a symbol bought days ago;
  // today's live figure stands in for the end value then.
  if (isPartial && (endPoint.isPartial || endValue === null) && Number.isFinite(ctx.liveTotalValueILS)) {
    endValue = ctx.liveTotalValueILS;
    valuePartial = Boolean(startPoint.isPartial);
  }
  const flows = ctx.returnFlows.filter((f) => f.date > start && f.date <= end);
  const md =
    endValue === null || endValue === undefined
      ? null
      : calculateModifiedDietzReturn({ beginningValue: startValue, endingValue: endValue, cashFlows: flows, periodStart: start, periodEnd: end });
  const denominator = md ? startValue + md.weightedCashFlow : 0;
  const returnPct = md && denominator > 0 && !valuePartial ? md.percent : null;

  const positions = positionResults({ start, end, events: monthEvents, ctx, denominator, isPartial });

  return {
    month: monthKey,
    start,
    end,
    isPartial,
    elapsedFraction: isPartial ? Math.max(0, daysBetween(start, end)) / daysBetween(start, fullEnd) : 1,
    invested,
    sold,
    withdrawn,
    parked,
    net: invested - sold - withdrawn,
    fees,
    dividends,
    buys,
    sells,
    deposits,
    trades: buys + sells,
    destinations,
    topStock: topStock ? { ...topStock, shareOfMonth: invested > 0 ? topStock.amount / invested : 0 } : null,
    startValue: startPoint.valueILS,
    endValue: endValue === undefined ? null : endValue,
    valuePartial,
    missingSymbols: [...new Set([...(startPoint.missingSymbols || []), ...(endPoint.missingSymbols || [])])],
    endByCategory: endPoint.byCategory,
    gain: md && !valuePartial ? md.gain : null,
    returnPct,
    positions,
    hasActivity: monthEvents.length > 0
  };
}

const sum = (list) => list.reduce((s, e) => s + (e.amountILS || 0), 0);

// How each security did over (start, end]: its value change, net of what
// was bought and sold of it, plus what it paid out.
function positionResults({ start, end, events, ctx, denominator, isPartial }) {
  const out = [];
  ctx.lotGroups.forEach((group) => {
    const heldAtStart = group.lots.some((lot) => isLotHeldOn(lot, start));
    const heldAtEnd = group.lots.some((lot) => isLotHeldOn(lot, end));
    const own = events.filter((e) => e.security && e.security.id === group.id);
    const touched = own.some((e) => e.kind === 'buy' || e.kind === 'sell');
    if (!heldAtStart && !heldAtEnd && !touched) return;

    const startValue = heldAtStart ? symbolValueOn(group.market, group.symbol, group.lots, start, ctx.priceData) : 0;
    const endValue = heldAtEnd ? symbolValueOn(group.market, group.symbol, group.lots, end, ctx.priceData, { allowLive: isPartial }) : 0;
    const bought = sum(own.filter((e) => e.kind === 'buy'));
    const soldGross = own.filter((e) => e.kind === 'sell').reduce((s, e) => s + (e.grossILS || 0), 0);
    const dividends = sum(own.filter((e) => e.kind === 'dividend'));
    const lot = group.lots.find((l) => l.officialName) || group.lots[0];
    const security = describeSecurity(group.market, lot, ctx.sectorBySymbol);

    if (startValue === null || endValue === null) {
      out.push({ ...security, missing: true });
      return;
    }
    const pnl = endValue - startValue - bought + soldGross + dividends;
    const basis = startValue + bought;
    out.push({
      ...security,
      missing: false,
      startValue,
      endValue,
      bought,
      sold: soldGross,
      dividends,
      pnl,
      pnlPct: basis > 0 ? (pnl / basis) * 100 : null,
      contributionPct: denominator > 0 ? (pnl / denominator) * 100 : null,
      boughtThisMonth: bought > 0
    });
  });
  return out.sort((a, b) => (b.pnl || 0) - (a.pnl || 0));
}

// ---------------------------------------------------------------------------
// The shared context, built once per review and reused for every month.

export function buildReviewContext({
  holdings = {},
  transactions = [],
  priceData = {},
  sectorBySymbol = {},
  today,
  liveTotalValueILS = null
}) {
  const h = {
    israeliStocks: holdings.israeliStocks || [],
    americanStocks: holdings.americanStocks || [],
    pensionFunds: holdings.pensionFunds || [],
    cashFunds: holdings.cashFunds || [],
    bankBalances: holdings.bankBalances || [],
    bankSavingsFunds: holdings.bankSavingsFunds || []
  };
  const tx = Array.isArray(transactions) ? transactions : [];
  const expanded = expandHoldingsWithClosedLots(h, tx);
  const events = buildMoneyEvents({ holdings: h, transactions: tx, sectorBySymbol });
  const pd = {
    taseHistoricalCloses: (priceData && priceData.taseHistoricalCloses) || {},
    yahooHistoricalCloses: (priceData && priceData.yahooHistoricalCloses) || {},
    fxHistoricalCloses: (priceData && priceData.fxHistoricalCloses) || []
  };
  return {
    holdings: h,
    transactions: tx,
    expanded,
    events,
    priceData: pd,
    hasPriceData:
      Object.keys(pd.taseHistoricalCloses).length > 0 || Object.keys(pd.yahooHistoricalCloses).length > 0,
    sectorBySymbol: sectorBySymbol || {},
    today,
    liveTotalValueILS: Number.isFinite(liveTotalValueILS) ? liveTotalValueILS : null,
    lotGroups: groupLots(expanded),
    // The flows that neutralize the monthly return - the same pairing the
    // performance chart uses (anchored ledger accounts + opening balances).
    returnFlows: buildPortfolioCashFlows({ ...expanded, includeLedgerOpeningBalances: true, transactions: tx }),
    inception: inceptionDate(events)
  };
}
