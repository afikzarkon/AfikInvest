// WHICH MONTH A MONTHLY CHECKPOINT IS FOR, AND WHICH DAYS IT MAY BE TAKEN ON.
//
// A month's report is usually taken in the first days of the NEXT month:
// provident funds and the like only publish their month-end figures then,
// so "October" is typically saved on November 1st, or the 7th. The figures
// are true for the day they were taken (its as-of date), and the comparison
// measures from one as-of date to the next - so all a checkpoint needs is
// to be allowed to carry that real date.
//
// So a month's checkpoint may be dated from the month's first day up to
// GRACE_DAYS into the following month (never in the future), and during
// those first GRACE_DAYS of a month a save is filed, by default, under the
// month that just ended.
//
// CommonJS on purpose: shared by the Node server (which does not transpile)
// and the React app. Written without object/array spread for the same
// reason as shared/transactionLedger.js.

// Provident-fund statements for a month-end arrive within this many days -
// the same grace the statement matching uses (utils/snapshotAsOf.js).
const GRACE_DAYS = 10;

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const DATE_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

function lastDayOfMonth(month) {
  const parts = month.split('-').map(Number);
  return new Date(Date.UTC(parts[0], parts[1], 0)).toISOString().slice(0, 10);
}

function addDays(date, days) {
  return new Date(Date.parse(date + 'T00:00:00Z') + days * 86400000).toISOString().slice(0, 10);
}

function previousMonth(month) {
  const parts = month.split('-').map(Number);
  return new Date(Date.UTC(parts[0], parts[1] - 2, 1)).toISOString().slice(0, 7);
}

// The month a save made today is for, by default: the month that just
// ended during its first GRACE_DAYS, otherwise this month.
function reportingMonthFor(today) {
  const day = Number(String(today).slice(8, 10));
  const month = String(today).slice(0, 7);
  return day <= GRACE_DAYS ? previousMonth(month) : month;
}

// The months a save made today may be filed under: this month, and during
// its first GRACE_DAYS also the month before. The default comes first.
function savableMonths(today) {
  const month = String(today).slice(0, 7);
  const reporting = reportingMonthFor(today);
  return reporting === month ? [month] : [reporting, month];
}

// The dates a month's checkpoint may be valid for: { min, max }, or null.
function asOfRange(month, today) {
  if (!MONTH_RE.test(String(month || '')) || !DATE_RE.test(String(today || ''))) return null;
  const min = month + '-01';
  const latest = addDays(lastDayOfMonth(month), GRACE_DAYS);
  const max = latest > today ? today : latest;
  return min > max ? null : { min: min, max: max };
}

function isValidAsOfDate(month, date, today) {
  const range = asOfRange(month, today);
  return Boolean(range && DATE_RE.test(String(date || '')) && date >= range.min && date <= range.max);
}

// The date a checkpoint for `month` is taken on when none is chosen: today,
// when today is one it may carry (a save made now); otherwise the month's
// last day (a month filled in long after it ended, valued at its end).
function defaultAsOfDate(month, today) {
  const range = asOfRange(month, today);
  if (!range) return null;
  if (today >= range.min && today <= range.max) return today;
  const end = lastDayOfMonth(month);
  return end < range.max ? end : range.max;
}

module.exports = {
  GRACE_DAYS: GRACE_DAYS,
  lastDayOfMonth: lastDayOfMonth,
  previousMonth: previousMonth,
  reportingMonthFor: reportingMonthFor,
  savableMonths: savableMonths,
  asOfRange: asOfRange,
  isValidAsOfDate: isValidAsOfDate,
  defaultAsOfDate: defaultAsOfDate
};
