// Which trading session a quote belongs to.
//
// A daily change is only "today's" change if the market it came from
// actually traded today. Both quote sources keep answering with the last
// session's figures long after that session closed - TASE's securitydata
// API on a Saturday still reports Thursday's/Friday's Change, and Yahoo's
// chart meta before the US open still reports yesterday's close against
// the day before. Summing those into a portfolio "daily change" mixes
// sessions from different days, which is what the dashboard used to show.
//
// So every quote leaving this server carries a tradeDate (YYYY-MM-DD, in
// the exchange's own calendar). The client compares it against today's
// date in Israel and counts the change only when they match - see
// src/utils/marketSession.js.
//
// The exchange's own trade date is always preferred (TASE's TradeDate,
// Yahoo's regularMarketTime): it knows about holidays, early closes and
// halts, which no calendar here does. lastSessionDate() below is only the
// FALLBACK for a source that reports no date at all (the Puppeteer page
// scrape) - a weekday calendar, which is right on every ordinary day and
// wrong only on an exchange holiday.

const MARKETS = {
  tase: {
    timeZone: 'Asia/Jerusalem',
    // Continuous trading starts right after the opening auction, ~09:59.
    openMinutes: 10 * 60,
    // TASE moved from a Sunday-Thursday week to Monday-Friday in January
    // 2026; a date before the switch is judged by the calendar it traded
    // under.
    isTradingWeekday: (isoDate, weekday) =>
      isoDate >= '2026-01-05' ? weekday >= 1 && weekday <= 5 : weekday >= 0 && weekday <= 4
  },
  us: {
    timeZone: 'America/New_York',
    openMinutes: 9 * 60 + 30,
    isTradingWeekday: (isoDate, weekday) => weekday >= 1 && weekday <= 5
  }
};

// { date: 'YYYY-MM-DD', minutes: minutes since local midnight } for an
// instant, in the given IANA time zone.
function zonedParts(instant, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(instant);
  const get = (type) => parts.find((p) => p.type === type).value;
  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    minutes: Number(get('hour')) * 60 + Number(get('minute'))
  };
}

function dateInTimeZone(instant, timeZone) {
  return zonedParts(instant, timeZone).date;
}

// Calendar arithmetic on a plain date string - no clock, no time zone.
function shiftIsoDate(isoDate, days) {
  const [y, m, d] = isoDate.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

function weekdayOfIsoDate(isoDate) {
  const [y, m, d] = isoDate.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

// The date of the most recent session that has at least OPENED as of
// `now`: today once the market has opened on a trading weekday, otherwise
// the previous trading weekday.
function lastSessionDate(marketKey, now = new Date()) {
  const market = MARKETS[marketKey];
  if (!market) return null;
  const { date: today, minutes } = zonedParts(now, market.timeZone);
  let candidate = today;
  if (!market.isTradingWeekday(candidate, weekdayOfIsoDate(candidate)) || minutes < market.openMinutes) {
    candidate = shiftIsoDate(candidate, -1);
  }
  for (let guard = 0; guard < 7; guard += 1) {
    if (market.isTradingWeekday(candidate, weekdayOfIsoDate(candidate))) return candidate;
    candidate = shiftIsoDate(candidate, -1);
  }
  return candidate;
}

// Yahoo chart meta -> the session date its regularMarketPrice belongs to,
// in the exchange's own time zone. null when the meta carries no usable
// timestamp.
function tradeDateFromYahooMeta(meta) {
  if (!meta) return null;
  const seconds = Number(meta.regularMarketTime);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  const timeZone = typeof meta.exchangeTimezoneName === 'string' && meta.exchangeTimezoneName
    ? meta.exchangeTimezoneName
    : MARKETS.us.timeZone;
  try {
    return dateInTimeZone(new Date(seconds * 1000), timeZone);
  } catch {
    // An unrecognised zone name - fall back to New York, where every
    // ticker this app prices through Yahoo trades.
    return dateInTimeZone(new Date(seconds * 1000), MARKETS.us.timeZone);
  }
}

module.exports = {
  MARKETS,
  dateInTimeZone,
  lastSessionDate,
  tradeDateFromYahooMeta,
  shiftIsoDate
};
