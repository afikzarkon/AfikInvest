// ONE ENTRY POINT FOR "ADD AN ASSET" AND "RECORD A TRANSACTION".
//
// The add form is both. Picking a name that already exists records a
// transaction on that account (a deposit/withdrawal row in its ledger, or
// another purchase lot of a stock already held); a new name opens a new
// account or holding with that first transaction. That merge used to be
// silent and exact-match only, so the form could not tell the user which
// of the two would happen, and "קרן השתלמות" vs "קרן השתלמות " (a trailing
// space) quietly became two funds - each with half the deposits, each with
// its own return.
//
// This module is the single answer to "where does this entry go?". App.js's
// submit handler uses it to decide, and the form uses it to say so before
// the user submits - the preview cannot disagree with what then happens.

// Comparison key for an account name: surrounding/repeated whitespace and
// letter case are not part of a name's identity.
export const normalizeAccountName = (name) =>
  String(name || '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();

const sameName = (a, b) => {
  const key = normalizeAccountName(b);
  return key !== '' && normalizeAccountName(a) === key;
};

// The existing account an entry of this type would be recorded on, or null
// when it would open a new one.
export function findExistingAccount(itemType, formData, holdings = {}) {
  const data = formData || {};
  switch (itemType) {
    case 'pension':
      return (holdings.pensionFunds || []).find((f) => sameName(f.fundName, data.stockName)) || null;
    case 'bank_savings':
      return (holdings.bankSavingsFunds || []).find((f) => sameName(f.fundName, data.stockName)) || null;
    case 'cash_fund': {
      // Keyed by security number, the field the form requires - the name is
      // optional for a money-market fund.
      const securityId = String(data.securityId || '').trim();
      if (!securityId) return null;
      return (holdings.cashFunds || []).find((f) => String(f.securityId || '').trim() === securityId) || null;
    }
    case 'bank':
      // A single current account - every movement goes to it once it exists.
      return (holdings.bankBalances || [])[0] || null;
    default:
      return null;
  }
}

// The purchase lots already held of the security a stock entry names.
export function existingStockLots(formData, holdings = {}) {
  const data = formData || {};
  const symbol = String(data.stockName || '').trim();
  if (!symbol) return [];
  const lots = data.exchange === 'american' ? holdings.americanStocks : holdings.israeliStocks;
  const matches = (stock) =>
    data.exchange === 'american'
      ? String(stock.stockName || '').trim().toUpperCase() === symbol.toUpperCase()
      : String(stock.stockName || '').trim() === symbol;
  return (lots || []).filter(matches);
}

// A deposit/withdrawal recorded on an EXISTING current account or
// money-market fund moves its balance by that amount - cash in such an
// account is the balance, one for one, and the form says it will. It used
// to only append the ledger row, leaving the balance where it was until
// the user typed the new figure into the table as well: the same movement
// entered twice, and wrong in every total until it was.
//
// Only a movement dated on or after the last recorded balance moves it. A
// backdated one is already inside a balance recorded after it, and adding
// it again would count it twice; it is still logged in the ledger, which
// is what the monthly tracker nets out.
//
// previousValue/previousValueDate are left alone, so "return since the
// previous update" still measures the same period, with this movement
// netted out of it like any other in-period deposit.
export const lastRecordedBalanceDate = (account) => (account && (account.currentValueDate || account.updateDate)) || '';

export const isBeforeLastBalance = (account, date) => {
  const last = lastRecordedBalanceDate(account);
  return Boolean(last && date && date < last);
};

export function applyLiquidAccountTransaction(account, amount, date) {
  const deposits = [...(Array.isArray(account.deposits) ? account.deposits : []), { date, amount }];
  const lastValueDate = lastRecordedBalanceDate(account);
  if (isBeforeLastBalance(account, date)) {
    return { ...account, deposits };
  }
  const balance = Number(account.currentValue ?? account.amount ?? 0) || 0;
  const newBalance = balance + (Number(amount) || 0);
  return {
    ...account,
    deposits,
    currentValue: newBalance,
    currentValueDate: date || lastValueDate,
    amount: newBalance
  };
}

// What submitting the form would do, for the form to say up front.
//   { kind: 'transaction', target }  - recorded on an existing account
//   { kind: 'new-account' }          - opens a new account
//   { kind: 'additional-lot', lots } - another purchase of a stock held
//   { kind: 'new-holding' }          - a stock not held yet
//   null                             - not enough filled in to say
export function describeEntry(formData, holdings = {}) {
  const data = formData || {};
  if (data.itemType === 'stock') {
    if (!String(data.stockName || '').trim()) return null;
    const lots = existingStockLots(data, holdings);
    return lots.length > 0 ? { kind: 'additional-lot', lots } : { kind: 'new-holding' };
  }
  const identified =
    data.itemType === 'bank' ||
    (data.itemType === 'cash_fund' ? String(data.securityId || '').trim() : String(data.stockName || '').trim());
  if (!identified) return null;
  const target = findExistingAccount(data.itemType, data, holdings);
  return target ? { kind: 'transaction', target } : { kind: 'new-account' };
}
