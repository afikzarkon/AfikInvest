// ONE ENTRY FORM FOR EVERYTHING THAT CHANGES A HOLDING - the logic behind
// components/AssetEntryModal.js.
//
// Opening a position, adding to it, selling it, a dividend, a deposit, a
// withdrawal, opening a new account and recording a statement value all go
// through the same form. Everything except the statement value is written
// through the transactions ledger (server/transactionRoutes.js), so every
// change to a holding is also a line in its history, and deleting the line
// undoes the change. There used to be two creation flows - an "add" page
// that wrote lots and deposits straight into the portfolio, outside the
// ledger, and a separate form on the transactions page - which recorded
// the same kinds of event two different ways, so neither the history nor
// the holdings could be trusted to be complete.
//
// A statement value (what a provident fund or money-market fund was worth
// on a date) is not a transaction - no money moved - so
// it updates the account's recorded value (portfolioMath.js's
// applyLedgerValueEditPayload), still from this same form.

export const ASSET_CLASSES = [
  { key: 'israeli', label: 'מניה / קרן - בורסה ישראלית', kind: 'stock', holdingsKey: 'israeliStocks' },
  { key: 'american', label: 'מניה / קרן - בורסה אמריקאית', kind: 'stock', holdingsKey: 'americanStocks' },
  { key: 'pension', label: 'קופת גמל / השתלמות', kind: 'account', holdingsKey: 'pensionFunds', valueTracked: true, tableKey: 'pension' },
  { key: 'cashFunds', label: 'קרן כספית', kind: 'account', holdingsKey: 'cashFunds', valueTracked: true, tableKey: 'cash_fund' },
  // A current account does not grow: its balance is its deposits less its
  // withdrawals, so it has no statement value to record.
  { key: 'bank', label: 'עו"ש', kind: 'account', holdingsKey: 'bankBalances', valueTracked: false, tableKey: 'bank' },
  { key: 'bankSavings', label: 'קופת חיסכון בבנק', kind: 'account', holdingsKey: 'bankSavingsFunds', valueTracked: false }
];

export const classInfo = (key) => ASSET_CLASSES.find((c) => c.key === key) || ASSET_CLASSES[0];

export const ACTION_LABELS = {
  BUY: 'קנייה',
  SELL: 'מכירה',
  DIVIDEND: 'דיבידנד',
  DEPOSIT: 'הפקדה',
  WITHDRAWAL: 'משיכה',
  VALUE: 'עדכון שווי לפי דוח'
};

export const NEW_ASSET = 'new';

// Comparison key for an account name: surrounding/repeated whitespace and
// letter case are not part of a name's identity.
export const normalizeAccountName = (name) =>
  String(name || '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();

// The symbols currently held in a market, with the units held.
export function heldSymbols(lots) {
  const bySymbol = new Map();
  (lots || []).forEach((lot) => {
    const symbol = String(lot.stockName || '').trim();
    if (!symbol) return;
    const entry = bySymbol.get(symbol) || { symbol, name: lot.officialName || '', units: 0 };
    entry.units += Number(lot.quantity) || 0;
    if (!entry.name && lot.officialName) entry.name = lot.officialName;
    bySymbol.set(symbol, entry);
  });
  return [...bySymbol.values()].sort((a, b) => a.symbol.localeCompare(b.symbol));
}

export const accountLabel = (assetClass, account, index) =>
  account.fundName || (assetClass === 'bank' ? `עו"ש #${index + 1}` : `${classInfo(assetClass).label} #${index + 1}`);

const sameSymbol = (assetClass, a, b) =>
  assetClass === 'american'
    ? String(a || '').trim().toUpperCase() === String(b || '').trim().toUpperCase()
    : String(a || '').trim() === String(b || '').trim();

// Units of `symbol` held in that market.
export function unitsHeld(holdings, assetClass, symbol) {
  const lots = holdings[classInfo(assetClass).holdingsKey] || [];
  return lots.filter((lot) => sameSymbol(assetClass, lot.stockName, symbol)).reduce((s, lot) => s + (Number(lot.quantity) || 0), 0);
}

// What can be done to this asset. A stock not held can only be bought; a
// new account can only be opened (with its first deposit); a statement
// value only exists for the accounts whose value is typed in.
export function actionsFor(assetClass, { isNew = false, held = 0 } = {}) {
  const info = classInfo(assetClass);
  if (info.kind === 'stock') return held > 0 ? ['BUY', 'SELL', 'DIVIDEND'] : ['BUY'];
  if (isNew) return ['DEPOSIT'];
  return info.valueTracked ? ['DEPOSIT', 'WITHDRAWAL', 'VALUE'] : ['DEPOSIT', 'WITHDRAWAL'];
}

export const emptyNewAccount = () => ({ fundName: '', securityId: '', investmentTrack: '', interestRate: '', isLinkedToIndex: false });

// The form's state. `prefill` comes from wherever the form was opened:
//   { assetClass, assetId, action } from an account's or a holding's row,
//   nothing from the global "+" button.
export function emptyEntry(prefill = {}, today = '') {
  const assetClass = prefill.assetClass && ASSET_CLASSES.some((c) => c.key === prefill.assetClass) ? prefill.assetClass : 'israeli';
  return {
    editingTxId: null,
    assetClass,
    assetId: prefill.assetId !== undefined && prefill.assetId !== null ? String(prefill.assetId) : '',
    action: prefill.action || (classInfo(assetClass).kind === 'stock' ? 'BUY' : 'DEPOSIT'),
    date: today,
    units: '',
    price: '',
    fees: '',
    fxRate: '',
    amount: '',
    taxWithheld: '',
    lotMethod: 'FIFO',
    note: '',
    value: '',
    // A BUY's identity details for a security picked from the search (its
    // official name and classification), carried onto the lot.
    lotDetails: null,
    newAccount: emptyNewAccount()
  };
}

const str = (v) => (v === null || v === undefined ? '' : String(v));

// The form state for editing a recorded transaction.
export function entryFromTransaction(tx) {
  return {
    ...emptyEntry({ assetClass: tx.assetClass, assetId: tx.assetId, action: tx.type }, tx.date),
    editingTxId: tx.id,
    units: str(tx.units),
    // A recorded BUY folds its fees into nothing (the lot carries them in
    // its price); the transaction itself keeps both.
    price: str(tx.price),
    fees: tx.fees ? str(tx.fees) : '',
    fxRate: tx.currency === 'USD' ? str(tx.fxRate) : '',
    amount: str(tx.amount),
    taxWithheld: tx.taxWithheld ? str(tx.taxWithheld) : '',
    lotMethod: tx.lotMethod || 'FIFO',
    note: tx.note || '',
    lotDetails: tx.lotDetails || null,
    newAccount: tx.newAccount ? { ...emptyNewAccount(), ...tx.newAccount } : emptyNewAccount()
  };
}

const n = (v) => (v === '' || v === null || v === undefined ? undefined : Number(v));

// Form state -> what to do with it:
//   { kind: 'transaction', tx }                         -> the ledger
//   { kind: 'value', assetClass, assetId, value, date } -> the account's recorded value
// The server's normalizeTransaction is the authority on validity; this only
// shapes the fields.
export function buildEntryPayload(state) {
  const { assetClass, action } = state;
  if (action === 'VALUE') {
    return { kind: 'value', assetClass, assetId: state.assetId, value: Number(state.value), date: state.date };
  }
  const isUsd = assetClass === 'american';
  const base = { type: action, date: state.date, assetClass, assetId: state.assetId, note: state.note || undefined };
  let tx;
  if (action === 'BUY' || action === 'SELL') {
    tx = {
      ...base,
      units: Number(state.units),
      price: Number(state.price),
      fees: n(state.fees) || 0,
      fxRate: isUsd ? Number(state.fxRate) : undefined,
      lotMethod: action === 'SELL' ? state.lotMethod : undefined,
      lotDetails: action === 'BUY' && state.lotDetails ? state.lotDetails : undefined
    };
  } else if (action === 'DIVIDEND') {
    tx = { ...base, amount: Number(state.amount), taxWithheld: n(state.taxWithheld) || 0, fxRate: isUsd ? Number(state.fxRate) : undefined };
  } else {
    tx = { ...base, amount: Number(state.amount) };
    if (action === 'DEPOSIT' && state.assetId === NEW_ASSET) {
      const a = state.newAccount || {};
      const details = {};
      if (assetClass !== 'bank') details.fundName = (a.fundName || '').trim();
      if (assetClass === 'cashFunds') details.securityId = (a.securityId || '').trim();
      if (assetClass === 'bankSavings') {
        details.investmentTrack = a.investmentTrack || '';
        details.interestRate = Number(a.interestRate) || 0;
        details.isLinkedToIndex = Boolean(a.isLinkedToIndex);
      }
      tx.newAccount = details;
      delete tx.assetId;
    }
  }
  return { kind: 'transaction', tx };
}

// An existing account the new one would duplicate: the same name (or, for a
// money-market fund, the same security number), whitespace and case aside.
export function duplicateAccount(state, holdings) {
  if (state.assetId !== NEW_ASSET) return null;
  const info = classInfo(state.assetClass);
  if (info.kind !== 'account') return null;
  const accounts = holdings[info.holdingsKey] || [];
  if (state.assetClass === 'cashFunds') {
    const id = String(state.newAccount.securityId || '').trim();
    return (id && accounts.find((a) => String(a.securityId || '').trim() === id)) || null;
  }
  const key = normalizeAccountName(state.newAccount.fundName);
  return (key && accounts.find((a) => normalizeAccountName(a.fundName) === key)) || null;
}

const money = (v) => Number(v || 0).toLocaleString('he-IL', { maximumFractionDigits: 2 });

// What submitting will do, said before it is done. null when not enough is
// filled in to tell.
export function entryPreview(state, holdings) {
  const info = classInfo(state.assetClass);
  if (!state.assetId) return null;
  if (state.editingTxId) return 'העסקה המקורית תבוטל והעסקה המתוקנת תירשם במקומה - בפעולה אחת.';

  if (info.kind === 'stock') {
    const held = unitsHeld(holdings, state.assetClass, state.assetId);
    if (state.action === 'BUY') {
      return held > 0
        ? `כבר מוחזקות ${held} יחידות. הקנייה תירשם כמנה נוספת באותה החזקה, עם תאריך ומחיר משלה, ותופיע ביומן העסקאות.`
        : 'החזקה חדשה: תיפתח שורה חדשה בטבלה, והקנייה תופיע ביומן העסקאות.';
    }
    if (state.action === 'SELL') {
      const units = Number(state.units);
      if (units > held) return `מוחזקות רק ${held} יחידות - אי אפשר למכור ${units}.`;
      return `היחידות שיימכרו יורדו מהמנות לפי ${state.lotMethod}, והתמורה תירשם כתזרים יוצא - כך שהמכירה לא תיראה כהפסד.`;
    }
    return 'הדיבידנד יירשם כתזרים יוצא מההחזקה (תשואה ששולמה), בלי לשנות את הכמות.';
  }

  if (state.assetId === NEW_ASSET) {
    return `ייפתח חשבון חדש מסוג ${info.label}, וההפקדה הזו תהיה הראשונה בפנקס שלו.`;
  }
  const account = (holdings[info.holdingsKey] || []).find((a) => String(a.id) === String(state.assetId));
  if (!account) return null;
  if (state.action === 'VALUE') {
    return 'השווי והתאריך יירשמו כעדכון השווי האחרון של החשבון, והשווי הקודם יישמר כ"שווי קודם". תנועות שנרשמו אחרי התאריך הזה ימשיכו להתווסף אליו.';
  }
  const signed = state.action === 'WITHDRAWAL' ? -Number(state.amount || 0) : Number(state.amount || 0);
  if (state.assetClass === 'pension') {
    return 'התנועה תירשם בפנקס ההפקדות של הקופה. שווי הקופה עצמו מתעדכן מדוח הקופה ("עדכון שווי לפי דוח").';
  }
  if (state.assetClass === 'bankSavings') {
    return 'התנועה תירשם בפנקס של הקופה, והשווי יחושב ממנה אוטומטית.';
  }
  return `התנועה (${signed >= 0 ? '+' : ''}${money(signed)} ₪) תירשם בפנקס ותתווסף ליתרה מיד - אין צורך לעדכן את היתרה בנפרד.`;
}
