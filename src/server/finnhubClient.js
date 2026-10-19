// One Finnhub client for everything the app asks Finnhub for: live quotes
// (finnhubQuotes.js), company profiles and sectors, basic financials
// (valuation multiples), analyst recommendation trends and peers
// (marketDataFallbacks.js).
//
// ONE BUDGET. The free plan allows 60 calls a minute across every
// endpoint, so the limit is kept here, shared, rather than per feature -
// a valuation page that asks for five peers' metrics must not leave the
// portfolio's quotes without calls for the rest of the minute. Past the
// budget a call fails at once (code FINNHUB_BUDGET) and the caller moves
// on to its next source.
//
// The key is sent in the X-Finnhub-Token header, never in the URL, so it
// cannot end up in a logged request line. Off until FINNHUB_API_KEY is set.
const axios = require('axios');

const BASE_URL = 'https://finnhub.io/api/v1';
const REQUEST_TIMEOUT_MS = 8000;
const CALLS_PER_MINUTE = 50;
const callTimes = [];

function finnhubKey() {
  return String(process.env.FINNHUB_API_KEY || '').trim();
}

function isFinnhubEnabled() {
  return Boolean(finnhubKey());
}

function takeBudget(now = Date.now()) {
  while (callTimes.length && now - callTimes[0] >= 60 * 1000) callTimes.shift();
  if (callTimes.length >= CALLS_PER_MINUTE) return false;
  callTimes.push(now);
  return true;
}

function resetFinnhubBudget() {
  callTimes.length = 0;
}

async function finnhubGet(path, params, { get = axios.get } = {}) {
  if (!isFinnhubEnabled()) throw new Error('finnhub not configured');
  if (!takeBudget()) {
    const err = new Error('finnhub per-minute budget used up');
    err.code = 'FINNHUB_BUDGET';
    throw err;
  }
  const response = await get(`${BASE_URL}${path}`, {
    params,
    headers: { 'X-Finnhub-Token': finnhubKey() },
    timeout: REQUEST_TIMEOUT_MS
  });
  return response && response.data;
}

// Yahoo writes share classes with a dash (BRK-B), Finnhub with a dot.
function toFinnhubSymbol(symbol) {
  return String(symbol).replace(/-/g, '.');
}

const finite = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

// /stock/profile2: name, currency, market cap and shares (both in
// MILLIONS), and Finnhub's own single industry label. An unknown symbol -
// and most ETFs - come back as an empty object, which is "no profile".
async function fetchFinnhubProfile(symbol, deps) {
  const p = await finnhubGet('/stock/profile2', { symbol: toFinnhubSymbol(symbol) }, deps);
  if (!p || typeof p !== 'object' || !p.name) throw new Error(`finnhub has no profile for ${symbol}`);
  const millions = (v) => (finite(v) === null ? null : v * 1e6);
  return {
    name: p.name,
    currency: p.currency || null,
    industry: p.finnhubIndustry || null,
    marketCap: millions(p.marketCapitalization),
    sharesOutstanding: millions(p.shareOutstanding)
  };
}

// /stock/metric?metric=all: the current valuation multiples and beta.
// Finnhub has used more than one key for the same figure over time, so
// each is read from the first key present.
const firstFinite = (m, keys) => {
  for (const key of keys) {
    const v = finite(m[key]);
    if (v !== null) return v;
  }
  return null;
};

async function fetchFinnhubMetrics(symbol, deps) {
  const data = await finnhubGet('/stock/metric', { symbol: toFinnhubSymbol(symbol), metric: 'all' }, deps);
  const m = (data && data.metric) || {};
  if (!Object.keys(m).length) throw new Error(`finnhub has no metrics for ${symbol}`);
  return {
    trailingPE: firstFinite(m, ['peTTM', 'peExclExtraTTM', 'peBasicExclExtraTTM', 'peNormalizedAnnual']),
    priceToSales: firstFinite(m, ['psTTM', 'psAnnual']),
    priceToFreeCashFlow: firstFinite(m, ['pfcfShareTTM', 'pfcfShareAnnual']),
    beta: firstFinite(m, ['beta'])
  };
}

// /stock/recommendation: monthly buckets of analyst ratings, newest first.
async function fetchFinnhubRecommendation(symbol, deps) {
  const data = await finnhubGet('/stock/recommendation', { symbol: toFinnhubSymbol(symbol) }, deps);
  if (!Array.isArray(data) || data.length === 0) throw new Error(`finnhub has no recommendations for ${symbol}`);
  return data;
}

// /stock/peers: same-industry tickers, the symbol itself included.
async function fetchFinnhubPeers(symbol, deps) {
  const data = await finnhubGet('/stock/peers', { symbol: toFinnhubSymbol(symbol) }, deps);
  if (!Array.isArray(data)) throw new Error(`finnhub has no peers for ${symbol}`);
  const self = toFinnhubSymbol(symbol).toUpperCase();
  // Back to Yahoo's dash form, which is how the rest of the app writes them.
  return data.filter((s) => typeof s === 'string' && s.toUpperCase() !== self).map((s) => s.replace(/\./g, '-'));
}

module.exports = {
  finnhubGet,
  isFinnhubEnabled,
  toFinnhubSymbol,
  resetFinnhubBudget,
  fetchFinnhubProfile,
  fetchFinnhubMetrics,
  fetchFinnhubRecommendation,
  fetchFinnhubPeers,
  CALLS_PER_MINUTE
};
