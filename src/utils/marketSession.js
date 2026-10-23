// Whether a holding's daily change belongs to TODAY.
//
// Every quote carries the date of the session it came from (tradeDate, set
// by the server - see server/marketCalendar.js), and every lot stores it
// alongside the change as dailyChangeTradeDate. A change counts towards
// today only when that session date is today's date in Israel:
//
//   TASE open, US not yet open - the US lots' last session is yesterday's,
//     so they contribute 0 and the daily change is the Israeli movement
//     alone.
//   US open after TASE closed - TASE's session date is still today, so its
//     closing change stays in, alongside the live US movement.
//   No TASE session today (weekend/holiday) - TASE's last session is an
//     earlier date and contributes 0; until the US opens there is no
//     session today at all and the daily change is 0, not a replay of the
//     last closes.
//
// The US session (16:30-23:00 Israel time) falls inside the same calendar
// date in New York and in Israel, so comparing a New York trade date with
// Israel's date is exact. Past midnight in Israel both markets read as "not
// today" until the next session opens.
//
// A lot without a dailyChangeTradeDate (saved before this existed, never
// refreshed since) keeps its change as-is: there is nothing to judge it by,
// and the first price refresh stamps it.

const ISRAEL_TIME_ZONE = 'Asia/Jerusalem';

export function israelToday(now = new Date()) {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: ISRAEL_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(now);
}

// true / false, or null when the lot carries no session date to judge by.
export function tradedToday(stock, today = israelToday()) {
  const date = stock && stock.dailyChangeTradeDate;
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}/.test(date)) return null;
  return date.slice(0, 10) === today;
}

// The daily change % to count for this lot today.
export function effectiveDailyChangePercent(stock, today = israelToday()) {
  const raw = Number(stock && stock.dailyChangePercent);
  if (!Number.isFinite(raw)) return 0;
  return tradedToday(stock, today) === false ? 0 : raw;
}

// The amount a holding worth `value` NOW gained on a day it moved `percent`.
// The percent is against the previous close, so the base is
// value / (1 + p), and the change value x p / (100 + p) - not value x p,
// which counts the day's move on top of itself (+10% on 110 is 10, not 11).
export function changeFromPercent(value, percent) {
  const v = Number(value);
  const p = Number(percent);
  if (!Number.isFinite(v) || !Number.isFinite(p) || p <= -100) return 0;
  return (v * p) / (100 + p);
}

// For a whole market's lots: 'today' when at least one lot's session is
// today, 'closed' when every lot's session is an earlier day, null when
// there are no lots (or none carries a date).
export function marketSessionState(stocks, today = israelToday()) {
  const states = (Array.isArray(stocks) ? stocks : []).map((s) => tradedToday(s, today)).filter((v) => v !== null);
  if (states.length === 0) return null;
  return states.some(Boolean) ? 'today' : 'closed';
}
