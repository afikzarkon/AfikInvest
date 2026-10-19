// Frankfurter (frankfurter.dev) - the fallback for exchange rates.
//
// Free, no key, no published call limit; the rates are the European
// Central Bank's daily reference rates, which include the shekel. Checked
// live: /v1/latest?base=USD&symbols=ILS, a single date (a weekend or
// holiday answers with the last working day before it), and a date range.
//
// ONE DIFFERENCE FROM YAHOO, stated so it is not discovered later: the ECB
// publishes once a working day, around 16:00 Central European time. So a
// rate from here is that day's reference rate, not a live one - close
// enough to value a portfolio in shekels while Yahoo is down, and labelled
// with its source so it is never taken for a live quote.
const axios = require('axios');

const BASE_URL = 'https://api.frankfurter.dev/v1';
const REQUEST_TIMEOUT_MS = 10000;

// Yahoo's FX symbols this app uses -> the Frankfurter pair.
function frankfurterPair(symbol) {
  const m = /^([A-Z]{3})([A-Z]{3})=X$/.exec(String(symbol || ''));
  return m ? { base: m[1], quote: m[2] } : null;
}

function isFrankfurterSymbol(symbol) {
  return Boolean(frankfurterPair(symbol));
}

async function getRates(path, pair, { get = axios.get } = {}) {
  const response = await get(`${BASE_URL}/${path}`, {
    params: { base: pair.base, symbols: pair.quote },
    timeout: REQUEST_TIMEOUT_MS
  });
  return response && response.data;
}

// The latest rate, with the change from the working day before it - the
// same { currentPrice, changePercent, tradeDate } a Yahoo quote has. One
// request: a short range ending today holds both days.
async function fetchFrankfurterQuote(symbol, deps) {
  const pair = frankfurterPair(symbol);
  if (!pair) throw new Error(`not an exchange-rate symbol: ${symbol}`);
  const from = new Date(Date.now() - 10 * 86400000).toISOString().slice(0, 10);
  const data = await getRates(`${from}..`, pair, deps);
  const points = Object.entries((data && data.rates) || {})
    .map(([date, rates]) => ({ date, rate: Number(rates && rates[pair.quote]) }))
    .filter((p) => Number.isFinite(p.rate))
    .sort((a, b) => (a.date < b.date ? -1 : 1));
  if (!points.length) throw new Error(`frankfurter has no ${pair.base}/${pair.quote} rate`);
  const last = points[points.length - 1];
  const prev = points.length > 1 ? points[points.length - 2] : null;
  return {
    currentPrice: last.rate,
    changePercent: prev ? ((last.rate - prev.rate) / prev.rate) * 100 : 0,
    tradeDate: last.date
  };
}

// The rate on one date, or the last working day before it -
// fetchYahooHistoricalRateForDate's { date, rate }.
async function fetchFrankfurterRateForDate(symbol, dateStr, deps) {
  const pair = frankfurterPair(symbol);
  if (!pair) throw new Error(`not an exchange-rate symbol: ${symbol}`);
  const data = await getRates(dateStr, pair, deps);
  const rate = Number(data && data.rates && data.rates[pair.quote]);
  if (!Number.isFinite(rate) || !data.date) return null;
  return { date: data.date, rate };
}

// Daily rates from a date to today - fetchYahooHistoricalCloses's
// [{ date, close }] ascending.
async function fetchFrankfurterHistory(symbol, fromDateStr, deps) {
  const pair = frankfurterPair(symbol);
  if (!pair) throw new Error(`not an exchange-rate symbol: ${symbol}`);
  const from = fromDateStr || new Date(Date.now() - 400 * 86400000).toISOString().slice(0, 10);
  const data = await getRates(`${from}..`, pair, deps);
  return Object.entries((data && data.rates) || {})
    .map(([date, rates]) => ({ date, close: Number(rates && rates[pair.quote]) }))
    .filter((p) => Number.isFinite(p.close))
    .sort((a, b) => (a.date < b.date ? -1 : 1));
}

module.exports = {
  isFrankfurterSymbol,
  fetchFrankfurterQuote,
  fetchFrankfurterRateForDate,
  fetchFrankfurterHistory
};
