// The transactions ledger: every BUY, SELL, DEPOSIT, WITHDRAWAL and
// DIVIDEND the user records, and what each one does to the portfolio.
//
// WHY THIS EXISTS
//
// Before the ledger the app only knew about money going IN: a lot row is a
// purchase, a deposit-ledger entry is a deposit. Selling meant deleting or
// editing a lot, and a withdrawal was invisible. Both then read as a fall
// in value - i.e. as an investment LOSS - in every return figure, and the
// sold lot vanished from the history too, as if it had never been owned.
//
// THE MODEL
//
// * Lot rows (israeliStocks / americanStocks in the portfolio payload) hold
//   only what is STILL owned. Every consumer that reads `lot.quantity` -
//   the tables, the summary, tax, rebalancing - therefore sees the real,
//   reduced position with no changes of its own.
// * A SELL records, per lot it consumed, an allocation carrying a full
//   snapshot of that lot. From those, expandHoldingsWithClosedLots()
//   rebuilds "closed slices" - the sold units, still with their original
//   purchase date/price/rate, plus a soldDate - so the historical
//   valuation keeps counting them up to the day they were sold, and the
//   cash-flow builder books their purchase exactly as before.
// * The sale proceeds leave as a negative cash flow on the sale date
//   (ledgerCashFlows). Value that disappears on that day is thereby
//   matched by money that left, and the difference between the proceeds
//   and the last valuation is the real gain or loss.
// * DEPOSIT / WITHDRAWAL target a ledger account (provident fund, money
//   market, current account, bank savings) and are written into that
//   account's existing `deposits` list - a withdrawal as a negative
//   entry. Everything that already reads that list (cash flows, the
//   ledger-account history, bank-savings compounding, real-gain tax)
//   handles it with no further change.
// * A DIVIDEND changes no holding. It is income paid OUT of the position,
//   so it is a negative flow: the position's value drop on the ex-date is
//   thereby credited back as return.
//
// The server applies a transaction to the stored portfolio and stores the
// transaction in the same database transaction (see
// server/transactionRoutes.js), so the two can never drift apart; deleting
// a transaction reverts exactly what applying it did.
//
// CommonJS on purpose: this file is shared by the Node server (which does
// not transpile) and the React app (whose bundler accepts CommonJS).
// Written without object/array spread or class inheritance, because the
// React build would compile those into ES-module helper imports and turn
// this into a module with no exports.

const TRANSACTION_TYPES = ['BUY', 'SELL', 'DEPOSIT', 'WITHDRAWAL', 'DIVIDEND'];

// assetClass -> the portfolio payload array it lives in
const STOCK_CLASSES = { israeli: 'israeliStocks', american: 'americanStocks' };
const ACCOUNT_CLASSES = {
  pension: 'pensionFunds',
  cashFunds: 'cashFunds',
  bank: 'bankBalances',
  bankSavings: 'bankSavingsFunds'
};

// FIFO is the default because it is what Israeli brokers apply per account
// for identical securities. The others exist for brokers that support
// specific identification, and for "what if" comparisons.
const LOT_METHODS = ['FIFO', 'LIFO', 'HIFO', 'SPECIFIC'];

// Extra lot fields a BUY may carry into the new lot row (the add-stock
// form writes these; anything else is ignored).
const LOT_DETAIL_KEYS = [
  'officialName',
  'securityType',
  'securitySubType',
  'branch',
  'isFund',
  'isForeignETF'
];

const EPSILON = 1e-9;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

// A plain constructor rather than `class extends Error`: subclassing a
// built-in makes the React build inject an ES-module helper import into
// this CommonJS file, which then loses its exports. Same behaviour -
// `instanceof LedgerError` and `instanceof Error` both hold.
function LedgerError(code, message) {
  const err = new Error(message);
  Object.setPrototypeOf(err, LedgerError.prototype);
  err.name = 'LedgerError';
  err.code = code;
  return err;
}
LedgerError.prototype = Object.create(Error.prototype, {
  constructor: { value: LedgerError, writable: true, configurable: true }
});

const num = (value) => {
  if (value === null || value === undefined || value === '') return NaN;
  const n = Number(value);
  return Number.isFinite(n) ? n : NaN;
};

const isValidDate = (s) => {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
};

const normalizeSymbol = (assetClass, symbol) => {
  const s = String(symbol == null ? '' : symbol).trim();
  return assetClass === 'american' ? s.toUpperCase() : s;
};

const sameSymbol = (assetClass, a, b) => normalizeSymbol(assetClass, a) === normalizeSymbol(assetClass, b);

const round = (n, digits = 10) => Math.round(n * 10 ** digits) / 10 ** digits;

// Validates and canonicalizes a transaction coming from a client. Throws a
// LedgerError('INVALID', ...) naming the first problem. `today` (YYYY-MM-DD)
// rejects a future-dated transaction.
function normalizeTransaction(input, { today } = {}) {
  const tx = input && typeof input === 'object' ? input : {};
  const fail = (message) => {
    throw new LedgerError('INVALID', message);
  };

  const type = String(tx.type || '').toUpperCase();
  if (!TRANSACTION_TYPES.includes(type)) fail(`type must be one of ${TRANSACTION_TYPES.join(', ')}`);

  const date = String(tx.date || '');
  if (!isValidDate(date)) fail('date must be YYYY-MM-DD');
  if (today && date > today) fail('date cannot be in the future');

  const time = tx.time ? String(tx.time) : null;
  if (time && !TIME_RE.test(time)) fail('time must be HH:MM');

  const assetClass = String(tx.assetClass || '');
  const isStockClass = Object.prototype.hasOwnProperty.call(STOCK_CLASSES, assetClass);
  const isAccountClass = Object.prototype.hasOwnProperty.call(ACCOUNT_CLASSES, assetClass);

  const assetId = normalizeSymbol(assetClass, tx.assetId);
  if (!assetId) fail('assetId is required');

  const fees = tx.fees === undefined || tx.fees === null || tx.fees === '' ? 0 : num(tx.fees);
  if (!(fees >= 0)) fail('fees must be zero or positive');

  const note = tx.note ? String(tx.note).slice(0, 500) : null;

  const out = {
    type,
    date,
    time,
    assetClass,
    assetId,
    units: null,
    price: null,
    fees,
    currency: 'ILS',
    fxRate: 1,
    amount: null,
    taxWithheld: 0,
    lotMethod: null,
    specificLots: null,
    lotDetails: null,
    note
  };

  if (type === 'BUY' || type === 'SELL' || type === 'DIVIDEND') {
    if (!isStockClass) fail(`${type} needs assetClass "israeli" or "american"`);
    out.currency = assetClass === 'american' ? 'USD' : 'ILS';
    if (out.currency === 'USD') {
      const fxRate = num(tx.fxRate);
      if (!(fxRate > 0)) fail('fxRate (ILS per USD on the trade date) is required for a USD transaction');
      out.fxRate = fxRate;
    }
  } else {
    if (!isAccountClass) fail(`${type} needs assetClass one of ${Object.keys(ACCOUNT_CLASSES).join(', ')}`);
  }

  if (type === 'BUY' || type === 'SELL') {
    const units = num(tx.units);
    const price = num(tx.price);
    if (!(units > 0)) fail('units must be positive');
    if (!(price > 0)) fail('price must be positive');
    out.units = units;
    out.price = price;
    out.amount = round(units * price);
    if (type === 'SELL' && fees > out.amount) fail('fees cannot exceed the sale amount');
  }

  if (type === 'SELL') {
    const method = String(tx.lotMethod || 'FIFO').toUpperCase();
    if (!LOT_METHODS.includes(method)) fail(`lotMethod must be one of ${LOT_METHODS.join(', ')}`);
    out.lotMethod = method;
    if (method === 'SPECIFIC') {
      const list = Array.isArray(tx.specificLots) ? tx.specificLots : [];
      if (!list.length) fail('specificLots is required when lotMethod is SPECIFIC');
      const specific = list.map((entry) => ({ lotId: String(entry && entry.lotId), units: num(entry && entry.units) }));
      if (specific.some((e) => !e.lotId || !(e.units > 0))) fail('each specific lot needs a lotId and positive units');
      const total = specific.reduce((s, e) => s + e.units, 0);
      if (Math.abs(total - out.units) > EPSILON) fail('specificLots units must add up to the units sold');
      out.specificLots = specific;
    }
  }

  if (type === 'BUY' && tx.lotDetails && typeof tx.lotDetails === 'object') {
    const details = {};
    LOT_DETAIL_KEYS.forEach((key) => {
      if (tx.lotDetails[key] !== undefined) details[key] = tx.lotDetails[key];
    });
    out.lotDetails = details;
  }

  if (type === 'DIVIDEND') {
    const amount = num(tx.amount);
    if (!(amount > 0)) fail('amount (gross dividend, in the security currency) must be positive');
    const taxWithheld = tx.taxWithheld === undefined || tx.taxWithheld === null || tx.taxWithheld === '' ? 0 : num(tx.taxWithheld);
    if (!(taxWithheld >= 0) || taxWithheld > amount) fail('taxWithheld must be between 0 and the gross amount');
    out.amount = amount;
    out.taxWithheld = taxWithheld;
    const units = num(tx.units);
    out.units = units > 0 ? units : null;
  }

  if (type === 'DEPOSIT' || type === 'WITHDRAWAL') {
    const amount = num(tx.amount);
    if (!(amount > 0)) fail('amount must be positive');
    out.amount = amount;
  }

  return out;
}

// ---------------------------------------------------------------------------
// Lot selection

// ILS paid per unit - the HIFO ordering key. An Israeli lot is already in
// shekels; an American lot is converted at the rate it was bought at.
const lotCostPerUnitILS = (assetClass, lot) => {
  const price = num(lot.purchasePrice) || 0;
  return assetClass === 'american' ? price * (num(lot.exchangeRate) || 0) : price;
};

const byPurchaseDate = (a, b) => {
  const da = String(a.purchaseDate || '');
  const db = String(b.purchaseDate || '');
  if (da !== db) return da < db ? -1 : 1;
  return String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0;
};

// Chooses which lots a sale of `units` consumes. Returns
// [{ lot, units }] in consumption order, or throws INSUFFICIENT_UNITS /
// LOT_NOT_FOUND. Only lots bought on or before the sale date are eligible -
// a sale cannot close a position opened after it.
function selectLotsForSale(lots, { assetClass, assetId, units, date, lotMethod = 'FIFO', specificLots = null }) {
  const eligible = (lots || []).filter(
    (lot) =>
      lot &&
      sameSymbol(assetClass, lot.stockName, assetId) &&
      (num(lot.quantity) || 0) > EPSILON &&
      lot.purchaseDate &&
      lot.purchaseDate <= date
  );

  if (lotMethod === 'SPECIFIC') {
    return (specificLots || []).map((entry) => {
      const lot = eligible.find((l) => String(l.id) === String(entry.lotId));
      if (!lot) throw new LedgerError('LOT_NOT_FOUND', `lot ${entry.lotId} of ${assetId} is not held on ${date}`);
      if (entry.units > num(lot.quantity) + EPSILON) {
        throw new LedgerError('INSUFFICIENT_UNITS', `lot ${entry.lotId} holds only ${num(lot.quantity)} units`);
      }
      return { lot, units: entry.units };
    });
  }

  const ordered = eligible.slice().sort(byPurchaseDate);
  if (lotMethod === 'LIFO') ordered.reverse();
  if (lotMethod === 'HIFO') {
    ordered.sort((a, b) => lotCostPerUnitILS(assetClass, b) - lotCostPerUnitILS(assetClass, a) || byPurchaseDate(a, b));
  }

  const available = ordered.reduce((s, lot) => s + num(lot.quantity), 0);
  if (units > available + EPSILON) {
    throw new LedgerError(
      'INSUFFICIENT_UNITS',
      `cannot sell ${units} units of ${assetId}: only ${round(available, 6)} held on ${date}`
    );
  }

  const picks = [];
  let remaining = units;
  for (const lot of ordered) {
    if (remaining <= EPSILON) break;
    const take = Math.min(num(lot.quantity), remaining);
    picks.push({ lot, units: take });
    remaining -= take;
  }
  return picks;
}

// ---------------------------------------------------------------------------
// Apply / revert

const clonePortfolio = (portfolio) => {
  const p = portfolio && typeof portfolio === 'object' ? portfolio : {};
  const out = {};
  Object.values(STOCK_CLASSES).concat(Object.values(ACCOUNT_CLASSES)).forEach((key) => {
    out[key] = Array.isArray(p[key]) ? p[key].map((item) => Object.assign({}, item)) : [];
  });
  return out;
};

// Applies a NORMALIZED transaction (see normalizeTransaction) that already
// has an `id`. Returns { portfolio, transaction } - new objects; the inputs
// are not mutated. The returned transaction carries what revert needs
// (createdLotId / allocations) and the derived money figures.
//
// newLotId: the id to give the lot a BUY creates (numeric like the ids the
// add-stock form generates, so nothing downstream can tell them apart).
function applyTransaction(portfolio, tx, { newLotId } = {}) {
  if (!tx || !tx.id) throw new LedgerError('INVALID', 'transaction needs an id before it is applied');
  const next = clonePortfolio(portfolio);
  const applied = Object.assign({}, tx);

  if (tx.type === 'BUY') {
    const key = STOCK_CLASSES[tx.assetClass];
    const lotId = newLotId !== undefined && newLotId !== null ? newLotId : Date.now();
    // Fees are part of the cost basis (for tax and for the cash flow alike),
    // so they are folded into the per-unit purchase price.
    const purchasePrice = round((tx.units * tx.price + (tx.fees || 0)) / tx.units);
    const lot = Object.assign({
      id: lotId,
      stockName: tx.assetId,
      officialName: '',
      purchaseDate: tx.date,
      purchasePrice,
      quantity: tx.units,
      exchangeRate: tx.assetClass === 'american' ? tx.fxRate : null,
      currentPrice: tx.price,
      dailyChangePercent: 0
    }, tx.lotDetails || {}, { txId: tx.id });
    next[key].push(lot);
    applied.createdLotId = lotId;
    applied.amountILS = round((tx.units * tx.price + (tx.fees || 0)) * tx.fxRate, 6);
    return { portfolio: next, transaction: applied };
  }

  if (tx.type === 'SELL') {
    const key = STOCK_CLASSES[tx.assetClass];
    const picks = selectLotsForSale(next[key], tx);
    const gross = tx.units * tx.price;
    const allocations = picks.map(({ lot, units }) => {
      const feeShare = tx.fees ? (tx.fees * units) / tx.units : 0;
      const snapshot = Object.assign({}, lot);
      delete snapshot.sales;
      return {
        lotId: lot.id,
        units,
        purchaseDate: lot.purchaseDate,
        purchasePrice: num(lot.purchasePrice) || 0,
        purchaseFxRate: tx.assetClass === 'american' ? num(lot.exchangeRate) || null : null,
        feeShare: round(feeShare),
        lotSnapshot: snapshot
      };
    });

    allocations.forEach((alloc) => {
      const lot = next[key].find((l) => String(l.id) === String(alloc.lotId));
      lot.quantity = round(num(lot.quantity) - alloc.units);
      alloc.closedLot = lot.quantity <= EPSILON;
    });
    next[key] = next[key].filter((lot) => !(num(lot.quantity) <= EPSILON && allocations.some((a) => String(a.lotId) === String(lot.id))));

    applied.allocations = allocations;
    applied.amountILS = round((gross - (tx.fees || 0)) * tx.fxRate, 6);
    return { portfolio: next, transaction: applied };
  }

  if (tx.type === 'DEPOSIT' || tx.type === 'WITHDRAWAL') {
    const key = ACCOUNT_CLASSES[tx.assetClass];
    const account = next[key].find((a) => String(a.id) === String(tx.assetId));
    if (!account) throw new LedgerError('ACCOUNT_NOT_FOUND', `no ${tx.assetClass} account with id ${tx.assetId}`);
    const signed = tx.type === 'WITHDRAWAL' ? -tx.amount : tx.amount;
    account.deposits = (Array.isArray(account.deposits) ? account.deposits : []).concat([{ date: tx.date, amount: signed, txId: tx.id }]);
    applied.amountILS = signed;
    return { portfolio: next, transaction: applied };
  }

  if (tx.type === 'DIVIDEND') {
    applied.amountILS = round((tx.amount - (tx.taxWithheld || 0)) * tx.fxRate, 6);
    return { portfolio: next, transaction: applied };
  }

  throw new LedgerError('INVALID', `unknown transaction type ${tx.type}`);
}

// Undoes exactly what applyTransaction did. Throws CANNOT_REVERT when later
// activity makes that impossible (a bought lot that has since been partly
// sold - delete that sale first).
function revertTransaction(portfolio, tx) {
  const next = clonePortfolio(portfolio);

  if (tx.type === 'BUY') {
    const key = STOCK_CLASSES[tx.assetClass];
    const index = next[key].findIndex((lot) => String(lot.id) === String(tx.createdLotId));
    if (index === -1) {
      throw new LedgerError('CANNOT_REVERT', 'the lot this purchase created no longer exists (it was sold or deleted); delete the sale first');
    }
    if (Math.abs(num(next[key][index].quantity) - tx.units) > EPSILON) {
      throw new LedgerError('CANNOT_REVERT', 'part of the lot this purchase created has been sold; delete the sale first');
    }
    next[key].splice(index, 1);
    return next;
  }

  if (tx.type === 'SELL') {
    const key = STOCK_CLASSES[tx.assetClass];
    (tx.allocations || []).forEach((alloc) => {
      const lot = next[key].find((l) => String(l.id) === String(alloc.lotId));
      if (lot) {
        lot.quantity = round(num(lot.quantity) + alloc.units);
      } else {
        next[key].push(Object.assign({}, alloc.lotSnapshot, { quantity: alloc.units }));
      }
    });
    return next;
  }

  if (tx.type === 'DEPOSIT' || tx.type === 'WITHDRAWAL') {
    const key = ACCOUNT_CLASSES[tx.assetClass];
    const account = next[key].find((a) => String(a.id) === String(tx.assetId));
    if (account && Array.isArray(account.deposits)) {
      account.deposits = account.deposits.filter((d) => d.txId !== tx.id);
    }
    return next;
  }

  return next;
}

// ---------------------------------------------------------------------------
// Derived views for analytics

const byDateAsc = (a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0);

// The units each SELL closed, rebuilt as lots that were held from their
// original purchase date until the sale (soldDate). Keyed like the payload.
function closedLotSlices(transactions) {
  const out = { israeliStocks: [], americanStocks: [] };
  (transactions || []).forEach((tx) => {
    if (!tx || tx.type !== 'SELL') return;
    const key = STOCK_CLASSES[tx.assetClass];
    if (!key) return;
    (tx.allocations || []).forEach((alloc) => {
      out[key].push(Object.assign({}, alloc.lotSnapshot || {}, {
        id: `${alloc.lotId}:sold:${tx.id}`,
        stockName: (alloc.lotSnapshot && alloc.lotSnapshot.stockName) || tx.assetId,
        purchaseDate: alloc.purchaseDate,
        purchasePrice: alloc.purchasePrice,
        exchangeRate: alloc.purchaseFxRate !== null && alloc.purchaseFxRate !== undefined ? alloc.purchaseFxRate : alloc.lotSnapshot && alloc.lotSnapshot.exchangeRate,
        quantity: alloc.units,
        soldDate: tx.date,
        soldTxId: tx.id,
        isClosedSlice: true
      }));
    });
  });
  return out;
}

// Holdings for a HISTORICAL view (valuation series, cash flows, inception
// date): the open lots plus the closed slices. Never feed this to anything
// that shows the CURRENT position - closed slices are history only.
function expandHoldingsWithClosedLots(holdings, transactions) {
  const slices = closedLotSlices(transactions);
  const h = holdings || {};
  return Object.assign({}, h, {
    israeliStocks: (h.israeliStocks || []).concat(slices.israeliStocks),
    americanStocks: (h.americanStocks || []).concat(slices.americanStocks)
  });
}

// The external cash flows only the ledger knows about: sale proceeds and
// dividends leaving the invested positions. Purchases are NOT here - they
// come from the lot rows and closed slices (portfolioCashFlows.js) - and
// neither are deposits/withdrawals, which live in the accounts' deposit
// lists. Returns [{ date, amount }] with amount < 0 (money out).
//
// assetClasses: restrict to these classes (a market segment of the
// performance chart). americanExchangeRate: value USD flows at one fixed
// rate, matching a fixed-rate valuation series (see portfolioCashFlows).
function ledgerCashFlows(transactions, { assetClasses = null, americanExchangeRate = null } = {}) {
  const allowed = assetClasses ? new Set(assetClasses) : null;
  const fixed = Number.isFinite(americanExchangeRate) && americanExchangeRate > 0;
  const flows = [];
  (transactions || []).forEach((tx) => {
    if (!tx || (tx.type !== 'SELL' && tx.type !== 'DIVIDEND')) return;
    if (allowed && !allowed.has(tx.assetClass)) return;
    const rate = tx.currency === 'USD' ? (fixed ? americanExchangeRate : num(tx.fxRate) || 0) : 1;
    const net =
      tx.type === 'SELL' ? tx.units * tx.price - (tx.fees || 0) : (tx.amount || 0) - (tx.taxWithheld || 0);
    const amount = -net * rate;
    if (amount !== 0 && Number.isFinite(amount)) flows.push({ date: tx.date, amount });
  });
  return flows.sort(byDateAsc);
}

// One row per lot slice a sale closed, with nominal figures in the
// security's currency and in ILS. Real (CPI / FX-indexed) gains and the tax
// on them are layered on top in utils/realizedGains.js, which owns the
// Israeli tax rules.
function realizedLots(transactions) {
  const rows = [];
  (transactions || []).forEach((tx) => {
    if (!tx || tx.type !== 'SELL') return;
    const saleFx = tx.currency === 'USD' ? num(tx.fxRate) || 0 : 1;
    (tx.allocations || []).forEach((alloc) => {
      const purchaseFx = tx.currency === 'USD' ? num(alloc.purchaseFxRate) || 0 : 1;
      const proceeds = alloc.units * tx.price - (alloc.feeShare || 0);
      const cost = alloc.units * alloc.purchasePrice;
      const proceedsILS = proceeds * saleFx;
      const costILS = cost * purchaseFx;
      const holdingDays = Math.round(
        (Date.parse(`${tx.date}T00:00:00Z`) - Date.parse(`${alloc.purchaseDate}T00:00:00Z`)) / 86400000
      );
      rows.push({
        txId: tx.id,
        saleDate: tx.date,
        assetClass: tx.assetClass,
        symbol: tx.assetId,
        lotId: alloc.lotId,
        units: alloc.units,
        purchaseDate: alloc.purchaseDate,
        purchasePrice: alloc.purchasePrice,
        salePrice: tx.price,
        currency: tx.currency,
        purchaseFxRate: purchaseFx,
        saleFxRate: saleFx,
        proceeds,
        cost,
        gain: proceeds - cost,
        proceedsILS,
        costILS,
        nominalGainILS: proceedsILS - costILS,
        holdingDays
      });
    });
  });
  return rows.sort((a, b) => (a.saleDate < b.saleDate ? -1 : a.saleDate > b.saleDate ? 1 : 0));
}

// One assignment per export (rather than `module.exports = { ... }`) so the
// React bundler can see each name statically and allow `import { x }`.
exports.TRANSACTION_TYPES = TRANSACTION_TYPES;
exports.STOCK_CLASSES = STOCK_CLASSES;
exports.ACCOUNT_CLASSES = ACCOUNT_CLASSES;
exports.LOT_METHODS = LOT_METHODS;
exports.LedgerError = LedgerError;
exports.normalizeTransaction = normalizeTransaction;
exports.selectLotsForSale = selectLotsForSale;
exports.applyTransaction = applyTransaction;
exports.revertTransaction = revertTransaction;
exports.closedLotSlices = closedLotSlices;
exports.expandHoldingsWithClosedLots = expandHoldingsWithClosedLots;
exports.ledgerCashFlows = ledgerCashFlows;
exports.realizedLots = realizedLots;
