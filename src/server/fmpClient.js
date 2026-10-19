// Financial Modeling Prep (financialmodelingprep.com), /stable endpoints -
// a fallback for company profiles (sector, industry) and for current
// valuation multiples. fundamentals.js has its own FMP call for financial
// statements; this is the rest.
//
// The free plan allows 250 calls a DAY, so the budget here is daily and
// kept below that. FMP answers a refused request (a bad key, an endpoint
// the plan does not include) with HTTP 200 or 402 and an object instead of
// the expected array - both are failures here, so the caller moves on.
//
// Off until FMP_API_KEY is set.
const axios = require('axios');

const BASE_URL = 'https://financialmodelingprep.com/stable';
const REQUEST_TIMEOUT_MS = 10000;
const CALLS_PER_DAY = 200;
let budgetDay = '';
let callsToday = 0;

function fmpKey() {
  return String(process.env.FMP_API_KEY || '').trim();
}

function isFmpEnabled() {
  return Boolean(fmpKey());
}

function takeBudget(now = new Date()) {
  const day = now.toISOString().slice(0, 10);
  if (day !== budgetDay) {
    budgetDay = day;
    callsToday = 0;
  }
  if (callsToday >= CALLS_PER_DAY) return false;
  callsToday += 1;
  return true;
}

function resetFmpBudget() {
  budgetDay = '';
  callsToday = 0;
}

async function fmpFirstRow(path, symbol, { get = axios.get } = {}) {
  if (!isFmpEnabled()) throw new Error('fmp not configured');
  if (!takeBudget()) {
    const err = new Error('fmp daily budget used up');
    err.code = 'FMP_BUDGET';
    throw err;
  }
  const response = await get(`${BASE_URL}/${path}`, {
    params: { symbol, apikey: fmpKey() },
    timeout: REQUEST_TIMEOUT_MS
  });
  const data = response && response.data;
  if (!Array.isArray(data)) {
    const message = data && (data['Error Message'] || data.error || data.message);
    throw new Error(`fmp ${path}: ${message || 'unexpected response'}`);
  }
  if (!data.length) throw new Error(`fmp ${path}: nothing for ${symbol}`);
  return data[0];
}

const finite = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const firstFinite = (row, keys) => {
  for (const key of keys) {
    const v = finite(row[key]);
    if (v !== null) return v;
  }
  return null;
};

// FMP's sector names are the same taxonomy Yahoo uses ("Technology",
// "Consumer Cyclical", ...), so they need no mapping.
async function fetchFmpProfile(symbol, deps) {
  const p = await fmpFirstRow('profile', symbol, deps);
  return {
    name: p.companyName || null,
    currency: p.currency || null,
    price: finite(p.price),
    marketCap: firstFinite(p, ['marketCap', 'mktCap']),
    beta: finite(p.beta),
    sector: p.sector || null,
    industry: p.industry || null,
    isEtf: p.isEtf === true
  };
}

// Field names differ between FMP's API versions; the stable ones first.
async function fetchFmpRatiosTtm(symbol, deps) {
  const r = await fmpFirstRow('ratios-ttm', symbol, deps);
  return {
    trailingPE: firstFinite(r, ['priceToEarningsRatioTTM', 'peRatioTTM']),
    priceToSales: firstFinite(r, ['priceToSalesRatioTTM', 'priceSalesRatioTTM']),
    priceToFreeCashFlow: firstFinite(r, ['priceToFreeCashFlowRatioTTM', 'priceToFreeCashFlowsRatioTTM'])
  };
}

module.exports = { isFmpEnabled, fetchFmpProfile, fetchFmpRatiosTtm, resetFmpBudget, CALLS_PER_DAY };
