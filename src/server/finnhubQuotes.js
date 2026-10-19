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
// The request itself, the key and the shared per-minute budget are in
// finnhubClient.js. Off until FINNHUB_API_KEY is set: without a key every
// quote goes to Yahoo exactly as before. With one, Yahoo is the fallback -
// for a symbol Finnhub does not know, for a failure, and for anything over
// the free plan's per-minute budget.
const { dateInTimeZone } = require('./marketCalendar');
const { finnhubGet, isFinnhubEnabled, toFinnhubSymbol, resetFinnhubBudget, CALLS_PER_MINUTE } = require('./finnhubClient');

// Exchange rates ("USDILS=X") and indices ("^GSPC") are Yahoo symbols with
// no Finnhub equivalent on the free plan; they never come here.
function isFinnhubSymbol(symbol) {
  return /^[A-Z][A-Z0-9.-]{0,9}$/.test(String(symbol || ''));
}

// { currentPrice, changePercent, tradeDate } in the same shape as
// yahooQuotes.js's quote payload. Throws when there is no usable quote, so
// the caller falls back to Yahoo.
async function fetchFinnhubQuote(symbol, deps) {
  if (!isFinnhubEnabled()) throw new Error('finnhub not configured');
  if (!isFinnhubSymbol(symbol)) throw new Error(`not a finnhub symbol: ${symbol}`);

  // { c: current, d: change, dp: change %, h, l, o, pc: previous close,
  //   t: unix seconds of the last trade }
  const q = await finnhubGet('/quote', { symbol: toFinnhubSymbol(symbol) }, deps);
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

module.exports = {
  fetchFinnhubQuote,
  isFinnhubEnabled,
  isFinnhubSymbol,
  toFinnhubSymbol,
  resetFinnhubBudget,
  CALLS_PER_MINUTE
};
