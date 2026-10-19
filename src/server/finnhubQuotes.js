// Live US stock quotes from Finnhub (finnhub.io) - the primary source for
// American prices, ahead of Yahoo.
//
// WHY FINNHUB. Yahoo has no official API: the chart endpoint the app read
// prices from is undocumented, rate-limits hosted servers without warning,
// and has changed shape before. Finnhub is a documented API with a free
// plan that covers exactly this: real-time quotes for US stocks, 60 calls
// a minute (plus 30 a second), free for personal, non-commercial use, with
// a key from finnhub.io/register. The other free options were weaker for
// this job - Alpha Vantage allows ~25 calls a DAY, Polygon/Massive's free
// plan is end-of-day only at 5 calls a minute, Twelve Data's is 8 a minute.
//
// WHAT IT DOES NOT REPLACE. Only the live quote moves here. Price history,
// dividend history and exchange rates stay on Yahoo: on Finnhub's free plan
// historical dividends are premium, candle history is restricted, and
// shekel FX rates are not something to build on without being able to
// confirm them. Sector/analyst data also stays on Yahoo (symbolProfile.js),
// where it is now cached for hours and kept in the database.
//
// Off until FINNHUB_API_KEY is set: without a key every quote goes to
// Yahoo exactly as before. With one, Yahoo is the fallback - for a symbol
// Finnhub does not know, for a failure, and for anything over the free
// plan's per-minute budget.
const axios = require('axios');
const { dateInTimeZone } = require('./marketCalendar');

const QUOTE_URL = 'https://finnhub.io/api/v1/quote';
const REQUEST_TIMEOUT_MS = 8000;

// The free plan's limit is 60 a minute; staying under it leaves room for a
// burst without a 429. Past it, quotes simply go to Yahoo for the rest of
// the minute.
const CALLS_PER_MINUTE = 50;
const callTimes = [];

function finnhubKey() {
  return String(process.env.FINNHUB_API_KEY || '').trim();
}

function isFinnhubEnabled() {
  return Boolean(finnhubKey());
}

// Exchange rates ("USDILS=X") and indices ("^GSPC") are Yahoo symbols with
// no Finnhub equivalent on the free plan; they never come here.
function isFinnhubSymbol(symbol) {
  return /^[A-Z][A-Z0-9.-]{0,9}$/.test(String(symbol || ''));
}

// Yahoo writes share classes with a dash (BRK-B), Finnhub with a dot.
function toFinnhubSymbol(symbol) {
  return String(symbol).replace(/-/g, '.');
}

function takeBudget(now = Date.now()) {
  while (callTimes.length && now - callTimes[0] >= 60 * 1000) callTimes.shift();
  if (callTimes.length >= CALLS_PER_MINUTE) return false;
  callTimes.push(now);
  return true;
}

// { currentPrice, changePercent, tradeDate } in the same shape as
// yahooQuotes.js's quote payload. Throws when there is no usable quote, so
// the caller falls back to Yahoo.
async function fetchFinnhubQuote(symbol, { get = axios.get } = {}) {
  if (!isFinnhubEnabled()) throw new Error('finnhub not configured');
  if (!isFinnhubSymbol(symbol)) throw new Error(`not a finnhub symbol: ${symbol}`);
  if (!takeBudget()) {
    const err = new Error('finnhub per-minute budget used up');
    err.code = 'FINNHUB_BUDGET';
    throw err;
  }

  const response = await get(QUOTE_URL, {
    params: { symbol: toFinnhubSymbol(symbol) },
    // The key goes in a header rather than the query string, so it never
    // appears in a logged URL.
    headers: { 'X-Finnhub-Token': finnhubKey() },
    timeout: REQUEST_TIMEOUT_MS
  });

  // { c: current, d: change, dp: change %, h, l, o, pc: previous close,
  //   t: unix seconds of the last trade }
  const q = response && response.data;
  const current = Number(q && q.c);
  // An unknown symbol is not an error status: Finnhub answers 200 with
  // every field zero.
  if (!Number.isFinite(current) || current <= 0) {
    throw new Error(`finnhub has no quote for ${symbol}`);
  }
  const previousClose = Number(q.pc);
  // Computed from the two prices, like the Yahoo path, rather than read
  // from dp - one formula for the daily change whichever source answered.
  const changePercent =
    Number.isFinite(previousClose) && previousClose > 0 ? ((current - previousClose) / previousClose) * 100 : 0;
  const seconds = Number(q.t);

  return {
    currentPrice: current,
    changePercent,
    tradeDate: Number.isFinite(seconds) && seconds > 0 ? dateInTimeZone(new Date(seconds * 1000), 'America/New_York') : null
  };
}

// Test seam.
function resetFinnhubBudget() {
  callTimes.length = 0;
}

module.exports = {
  fetchFinnhubQuote,
  isFinnhubEnabled,
  isFinnhubSymbol,
  toFinnhubSymbol,
  resetFinnhubBudget,
  CALLS_PER_MINUTE
};
