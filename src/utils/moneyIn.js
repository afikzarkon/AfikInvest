// How much money went in, per month and per year - the one definition both
// the portfolio review ("לאן הלך הכסף", "החודש מול החודשים הקודמים") and
// the analysis page ("פיזור לפי תאריכי קנייה והפקדה") show.
//
// It sums the money events of portfolioReviewData.js's buildMoneyEvents:
//
//   invested  a purchase of a security at its cost - units x price + fees,
//             in shekels at the trade's own exchange rate - every lot,
//             including the ones a later sale closed; plus each deposit into
//             an account that counts as an investment (COUNTS_AS_INVESTED).
//             Gross: sales and withdrawals are not netted out of it.
//   parked    deposits into the accounts that do not count - cash waiting,
//             not invested. Shown beside "invested", never inside it, so
//             money moved to the current account and then used for a
//             purchase is not counted twice.
//   count     the purchases and deposits that make up `invested`, and
//             nothing else - the amount and the count come from the same
//             list.
//
// The month of an event is its date on the Israeli calendar (israelDateOf).
// Pure, no React.

// Which accounts' deposits count as invested. A product decision, kept in
// one place: flip moneyMarket to true to count money-market funds as an
// investment on both pages at once.
export const COUNTS_AS_INVESTED = {
  providentFund: true, // קופות גמל להשקעה
  bankSavings: true, // חיסכון בבנק
  moneyMarket: false, // קרנות כספיות
  bank: false // עו"ש
};

const ISRAEL_DATE = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem', year: 'numeric', month: '2-digit', day: '2-digit' });

// 'YYYY-MM-DD' on the Israeli calendar, or null. A plain date is already
// one; a timestamp ("2026-09-30T22:00:00.000Z") is read in Asia/Jerusalem,
// where it is already October 1st - not cut at its UTC date.
export function israelDateOf(raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  const s = String(raw);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  if (!/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(s)) return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null;
  const t = Date.parse(/[zZ]|[+-]\d{2}:?\d{2}$/.test(s) ? s : `${s.replace(' ', 'T')}Z`);
  return Number.isNaN(t) ? null : ISRAEL_DATE.format(new Date(t));
}

export const isInvestedEvent = (e) => e.kind === 'buy' || (e.kind === 'deposit' && e.invest === true);
export const isParkedEvent = (e) => e.kind === 'deposit' && e.invest === false;

const emptyTotals = () => ({ invested: 0, count: 0, buys: 0, deposits: 0, parked: 0, parkedCount: 0 });

function add(totals, e) {
  if (isInvestedEvent(e)) {
    totals.invested += e.amountILS || 0;
    totals.count += 1;
    if (e.kind === 'buy') totals.buys += 1;
    else totals.deposits += 1;
  } else if (isParkedEvent(e)) {
    totals.parked += e.amountILS || 0;
    totals.parkedCount += 1;
  }
  return totals;
}

// The totals of the events dated in (after, until] - the review's month
// window. Either bound may be omitted.
export function moneyInBetween(events, after, until) {
  return (events || []).reduce((totals, e) => {
    if ((after && !(e.date > after)) || (until && !(e.date <= until))) return totals;
    return add(totals, e);
  }, emptyTotals());
}

function bucket(events, keyLength, keyName) {
  const map = new Map();
  (events || []).forEach((e) => {
    if (!isInvestedEvent(e) && !isParkedEvent(e)) return;
    const key = String(e.date || '').slice(0, keyLength);
    if (key.length !== keyLength) return;
    if (!map.has(key)) map.set(key, emptyTotals());
    add(map.get(key), e);
  });
  return [...map.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, totals]) => ({ [keyName]: key, ...totals }));
}

// [{ month: 'YYYY-MM', invested, count, buys, deposits, parked, parkedCount }], oldest first.
export const moneyInByMonth = (events) => bucket(events, 7, 'month');

// [{ year: 'YYYY', ...same }], oldest first.
export const moneyInByYear = (events) => bucket(events, 4, 'year');
