// Tiingo (tiingo.com) - the fallback for US dividend history.
//
// Tiingo's end-of-day price rows carry the dividend paid on each ex-date
// (divCash) and the split factor (splitFactor), so one daily-prices request
// for the period is the whole dividend history - the same shape
// yahooQuotes.js's fetchYahooDividendHistory returns.
//
// The free plan is limited per hour and per day; the budget here stays
// under both. The key goes in the Authorization header ("Token <key>"),
// not in the URL. Off until TIINGO_API_KEY is set.
const axios = require('axios');

const BASE_URL = 'https://api.tiingo.com/tiingo/daily';
const REQUEST_TIMEOUT_MS = 15000;
const CALLS_PER_HOUR = 40;
const callTimes = [];

function tiingoKey() {
  return String(process.env.TIINGO_API_KEY || '').trim();
}

function isTiingoEnabled() {
  return Boolean(tiingoKey());
}

function takeBudget(now = Date.now()) {
  while (callTimes.length && now - callTimes[0] >= 60 * 60 * 1000) callTimes.shift();
  if (callTimes.length >= CALLS_PER_HOUR) return false;
  callTimes.push(now);
  return true;
}

function resetTiingoBudget() {
  callTimes.length = 0;
}

// Tiingo writes share classes with a dash, like Yahoo (BRK-B).
async function fetchTiingoDailyRows(symbol, startDate, { get = axios.get } = {}) {
  if (!isTiingoEnabled()) throw new Error('tiingo not configured');
  if (!takeBudget()) {
    const err = new Error('tiingo hourly budget used up');
    err.code = 'TIINGO_BUDGET';
    throw err;
  }
  const response = await get(`${BASE_URL}/${encodeURIComponent(String(symbol).toLowerCase())}/prices`, {
    params: { startDate },
    headers: { Authorization: `Token ${tiingoKey()}`, 'Content-Type': 'application/json' },
    timeout: REQUEST_TIMEOUT_MS
  });
  const rows = response && response.data;
  if (!Array.isArray(rows)) throw new Error(`tiingo returned no price rows for ${symbol}`);
  return rows;
}

// [{ date, amountPerShare }] ascending - fetchYahooDividendHistory's shape.
async function fetchTiingoDividendHistory(symbol, fromDateStr, deps) {
  const startDate = fromDateStr || new Date(Date.now() - 5 * 365 * 86400000).toISOString().slice(0, 10);
  const rows = await fetchTiingoDailyRows(symbol, startDate, deps);
  return rows
    .filter((r) => Number.isFinite(Number(r.divCash)) && Number(r.divCash) > 0)
    .map((r) => ({ date: String(r.date).slice(0, 10), amountPerShare: Number(r.divCash) }))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

// The trailing year's dividends as a stand-in for the forward summary
// Yahoo gives (rate, yield, dates): the rate is what was actually paid in
// the last twelve months; yield and the next dates are unknown here and
// left null rather than guessed.
async function fetchTiingoDividendSummary(symbol, deps) {
  const yearAgo = new Date(Date.now() - 365 * 86400000).toISOString().slice(0, 10);
  const history = await fetchTiingoDividendHistory(symbol, yearAgo, deps);
  const rate = history.reduce((sum, d) => sum + d.amountPerShare, 0);
  const last = history[history.length - 1];
  return {
    dividendRate: history.length ? rate : null,
    dividendYieldPercent: null,
    payoutRatio: null,
    exDividendDateEpoch: last ? Math.floor(Date.parse(`${last.date}T00:00:00Z`) / 1000) : null,
    nextDividendDateEpoch: null
  };
}

module.exports = {
  isTiingoEnabled,
  fetchTiingoDailyRows,
  fetchTiingoDividendHistory,
  fetchTiingoDividendSummary,
  resetTiingoBudget,
  CALLS_PER_HOUR
};
