// "Has the user finished this month's manual update?" - the trigger for the
// monthly PDF report.
//
// Stocks are priced automatically; the accounts below are not - their
// values come from statements the user types in. A report generated before
// they are in would state a net worth that is simply wrong, so the report
// waits for them rather than for a calendar date.
//
// Required accounts: every provident/pension fund, money-market fund and
// current account with a non-zero balance, minus any the user excluded
// ("don't wait for this one"). Bank savings funds are not required - their
// value is computed from their deposits and rate, never typed in.
//
// An account counts as updated for month M when its value date falls inside
// M, or within the first 10 days of M+1 (statements for M arrive early in
// the next month).
//
// CommonJS without spread/class syntax - see transactionLedger.js for why.

const MANUAL_ACCOUNT_CATEGORIES = [
  { category: 'pension', key: 'pensionFunds', label: 'קופת גמל' },
  { category: 'cashFunds', key: 'cashFunds', label: 'קרן כספית' },
  { category: 'bank', key: 'bankBalances', label: 'עו"ש' }
];

const GRACE_DAYS = 10;
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

const isValidMonth = (m) => typeof m === 'string' && MONTH_RE.test(m);

function nextMonth(month) {
  const [y, m] = month.split('-').map(Number);
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
}

function previousMonth(month) {
  const [y, m] = month.split('-').map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
}

function monthEnd(month) {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}

// The month a sync made today is most likely about: in the first 10 days of
// a month, the previous one (its statements are what just arrived);
// otherwise the current one.
function targetMonthFor(today) {
  const month = today.slice(0, 7);
  return Number(today.slice(8, 10)) <= GRACE_DAYS ? previousMonth(month) : month;
}

function accountValue(account) {
  const v = Number(account.amount !== undefined && account.amount !== null ? account.amount : account.currentValue);
  return Number.isFinite(v) ? v : 0;
}

function accountValueDate(account) {
  const d = account.currentValueDate || account.updateDate || null;
  return typeof d === 'string' && /^\d{4}-\d{2}-\d{2}/.test(d) ? d.slice(0, 10) : null;
}

function isUpdatedForMonth(valueDate, month) {
  if (!valueDate) return false;
  const start = `${month}-01`;
  const graceEnd = `${nextMonth(month)}-${String(GRACE_DAYS).padStart(2, '0')}`;
  return valueDate >= start && valueDate <= graceEnd;
}

const accountKey = (category, account, index) => `${category}:${account.id !== undefined && account.id !== null ? account.id : index}`;

// portfolio: the stored payload. excluded: account keys the user chose not
// to wait for. Returns { month, accounts, required, updatedCount,
// allUpdated, anyUpdated }.
function evaluateSyncStatus(portfolio, month, { excluded = [] } = {}) {
  const skip = new Set(excluded || []);
  const accounts = [];
  MANUAL_ACCOUNT_CATEGORIES.forEach(({ category, key, label }) => {
    ((portfolio && portfolio[key]) || []).forEach((account, index) => {
      const value = accountValue(account);
      if (value === 0) return;
      const valueDate = accountValueDate(account);
      const id = accountKey(category, account, index);
      accounts.push({
        key: id,
        category,
        name: account.fundName || (category === 'bank' ? `${label} #${index + 1}` : label),
        value,
        valueDate,
        updated: isUpdatedForMonth(valueDate, month),
        excluded: skip.has(id)
      });
    });
  });
  const required = accounts.filter((a) => !a.excluded);
  const updatedCount = required.filter((a) => a.updated).length;
  return {
    month,
    accounts,
    required,
    updatedCount,
    allUpdated: required.length > 0 && updatedCount === required.length,
    anyUpdated: updatedCount > 0
  };
}

// A short, stable fingerprint of the required accounts' values and dates -
// a change after completion means the month was corrected and the report
// needs a new version. djb2 over a canonical string (no crypto needed).
function syncFingerprint(status) {
  const canonical = (status.required || [])
    .map((a) => `${a.key}=${a.value}@${a.valueDate || ''}`)
    .sort()
    .join('|');
  let h = 5381;
  for (let i = 0; i < canonical.length; i += 1) {
    h = ((h << 5) + h + canonical.charCodeAt(i)) >>> 0;
  }
  return `${h.toString(16)}:${(status.required || []).length}`;
}

// The next state of the sync state machine, given a fresh evaluation.
//   OPEN -> IN_PROGRESS (first account updated) -> COMPLETE (all updated,
//   or the user said so). COMPLETE stays COMPLETE; whether a later change
//   needs a new report version is decided by the fingerprint.
function nextSyncState(currentState, evaluation) {
  if (currentState === 'COMPLETE') return 'COMPLETE';
  if (evaluation.allUpdated) return 'COMPLETE';
  if (evaluation.anyUpdated) return 'IN_PROGRESS';
  return 'OPEN';
}

exports.MANUAL_ACCOUNT_CATEGORIES = MANUAL_ACCOUNT_CATEGORIES;
exports.GRACE_DAYS = GRACE_DAYS;
exports.isValidMonth = isValidMonth;
exports.nextMonth = nextMonth;
exports.previousMonth = previousMonth;
exports.monthEnd = monthEnd;
exports.targetMonthFor = targetMonthFor;
exports.isUpdatedForMonth = isUpdatedForMonth;
exports.evaluateSyncStatus = evaluateSyncStatus;
exports.syncFingerprint = syncFingerprint;
exports.nextSyncState = nextSyncState;
