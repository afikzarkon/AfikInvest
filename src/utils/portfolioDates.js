import { israelToday } from './marketSession';

// Dates derived from the portfolio itself, shared by the pages that need
// the same answer.
//
// The analytics page and the monthly tracker both value the portfolio over
// its full history, so both need to know when that history starts. Each
// used to work it out inline; with the two now on separate pages that would
// be the same derivation written twice, free to drift.

// The earliest date anything was bought or deposited - the portfolio's
// inception, and the natural start of any "since the beginning" range.
//
// Only fully-formed ISO dates count: a half-typed or malformed one would
// sort before every real date and drag the range back to an arbitrary
// point with no prices behind it.
export function computePortfolioInceptionDate({
  israeliStocks = [],
  americanStocks = [],
  pensionFunds = [],
  bankSavingsFunds = []
} = {}) {
  const dates = [
    ...israeliStocks.map((s) => s.purchaseDate),
    ...americanStocks.map((s) => s.purchaseDate),
    ...pensionFunds.flatMap((f) => (Array.isArray(f.deposits) ? f.deposits : []).map((d) => d.date)),
    ...bankSavingsFunds.flatMap((f) => (Array.isArray(f.deposits) ? f.deposits : []).map((d) => d.date))
  ].filter((d) => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}/.test(d));
  if (dates.length === 0) return '';
  return dates.sort()[0].slice(0, 10);
}

// The earliest date a SHARE was bought - deposits into provident funds,
// bank savings and cash accounts deliberately excluded.
//
// This is what "since the beginning" means for a performance curve about
// equities. computePortfolioInceptionDate above answers a different
// question (when did this portfolio start existing at all), and using it
// for the stock curve dragged the range back to whatever non-traded
// account happened to be funded first - a provident-fund deposit in 2008
// opening a chart of stocks first bought in 2012, with four empty years
// in front of it.
export function computeFirstStockPurchaseDate({ israeliStocks = [], americanStocks = [] } = {}) {
  return computePortfolioInceptionDate({ israeliStocks, americanStocks });
}

// Today's date in ISRAEL, not in UTC. toISOString() is UTC, which is still
// "yesterday" until 02:00/03:00 Israel time - long enough for a save made
// just after midnight on the 1st to be filed under the previous month.
export function todayISO(now = new Date()) {
  return israelToday(now);
}

// THE QUICK PERIOD TOGGLES.
//
// A date range is the precise control and stays; these are the handful of
// ranges actually asked for, as one click each. `key` is what the UI holds
// in state, and is also what tells it which button to mark as current.
//
// 'ytd' is the default the page opens on (see DEFAULT_RETURN_PERIOD): the
// question a portfolio is opened with is almost always "how is it doing
// this year", and opening on the full history instead answered a question
// about 2012 with a curve nobody had asked for and a fetch across every
// year in between.
//
// 'all' is the escape hatch back to the whole history. It resolves to ''
// rather than to a date, because '' is what the page reads as "track
// inception as holdings change" rather than pinning a start.
export const RETURN_PERIODS = [
  { key: 'day', label: 'יומי', hint: 'מאז סגירת המסחר הקודמת' },
  { key: 'month', label: 'חודשי', hint: 'החודש האחרון' },
  { key: 'ytd', label: 'מתחילת השנה', hint: 'מ-1 בינואר ועד היום' },
  { key: '1y', label: 'שנה', hint: 'שנה אחורה' },
  { key: '3y', label: '3 שנים', hint: 'שלוש שנים אחורה' },
  { key: '5y', label: '5 שנים', hint: 'חמש שנים אחורה' },
  { key: 'all', label: 'הכל', hint: 'מאז הרכישה הראשונה' }
];

export const DEFAULT_RETURN_PERIOD = 'ytd';

// UTC throughout, like every other date in this module: the ISO strings
// these produce are compared against ISO strings from the exchanges, and a
// local-time construction shifts the boundary by the offset - which in
// Israel means "1 בינואר" resolving to the 31st of December.
export function startDateForPeriod(periodKey, today = todayISO()) {
  if (periodKey === 'all') return '';
  const base = new Date(`${today}T00:00:00Z`);
  if (Number.isNaN(base.getTime())) return '';

  const shifted = new Date(base.getTime());
  switch (periodKey) {
    case 'day':
      shifted.setUTCDate(shifted.getUTCDate() - 1);
      break;
    case 'month':
      shifted.setUTCMonth(shifted.getUTCMonth() - 1);
      break;
    case 'ytd':
      return `${base.getUTCFullYear()}-01-01`;
    case '1y':
      shifted.setUTCFullYear(shifted.getUTCFullYear() - 1);
      break;
    case '3y':
      shifted.setUTCFullYear(shifted.getUTCFullYear() - 3);
      break;
    case '5y':
      shifted.setUTCFullYear(shifted.getUTCFullYear() - 5);
      break;
    default:
      return '';
  }
  return shifted.toISOString().slice(0, 10);
}

// Which toggle a given range corresponds to, or null when the user has
// typed a range of their own. Derived rather than stored alongside the
// dates, so editing a date input cannot leave a button highlighted for a
// period the chart is no longer showing.
export function periodKeyForRange(fromDate, toDate, today = todayISO()) {
  if (toDate && toDate !== today) return null;
  if (!fromDate) return 'all';
  const match = RETURN_PERIODS.find(
    (period) => period.key !== 'all' && startDateForPeriod(period.key, today) === fromDate
  );
  return match ? match.key : null;
}

// A "YYYY-MM" key -> a Hebrew month name and year ("מרץ 2024").
//
// The key itself is a clean sortable string used as-is everywhere else;
// this is display only, so the raw sort key is never shown to the user.
export function formatMonthLabel(monthKey) {
  const [year, month] = String(monthKey).split('-').map(Number);
  if (!year || !month) return monthKey;
  return new Date(year, month - 1, 1).toLocaleDateString('he-IL', { month: 'long', year: 'numeric' });
}

// The last calendar day of a month, never later than `today` - the date a
// month's checkpoint is valued at. A month still in progress is valued as
// of today rather than at a future date with no prices behind it.
export function monthEndDate(monthKey, today = todayISO()) {
  if (!/^\d{4}-\d{2}$/.test(String(monthKey || ''))) return null;
  const [year, month] = monthKey.split('-').map(Number);
  const lastDay = new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
  return lastDay > today ? today : lastDay;
}
