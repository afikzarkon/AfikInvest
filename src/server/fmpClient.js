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

// A KEY THE PLAN DOES NOT COVER. FMP answers an endpoint that is not in
// the key's plan with 402 (or 401/403 for a bad key) - on every request,
// for good, until the plan changes. Asking again on every page load only
// fills the logs with the same refusal (it did, in production: "fmp is
// failing: 5 failures in a row - 402"). So a refused endpoint is not asked
// again for PLAN_REFUSAL_PAUSE_MS; until then it fails at once, without a
// request (code FMP_PLAN), and the chain moves on to the next source.
const PLAN_REFUSAL_PAUSE_MS = 24 * 60 * 60 * 1000;
const PLAN_REFUSAL_STATUSES = new Set([401, 402, 403]);
const refusedUntil = new Map(); // endpoint -> ms

function fmpRefusedUntil(endpoint, now = Date.now()) {
  const until = refusedUntil.get(endpoint);
  return until && until > now ? until : null;
}

// Call with the error of a failed request; true when it was a plan refusal
// (and the endpoint is now paused).
function noteFmpError(endpoint, err, now = Date.now()) {
  const status = err && err.response && err.response.status;
  if (!PLAN_REFUSAL_STATUSES.has(status)) return false;
  if (!fmpRefusedUntil(endpoint, now)) {
    console.warn(`[fmp] ${endpoint} refused with HTTP ${status} - the key's plan does not include it; not asking again for 24h`);
  }
  refusedUntil.set(endpoint, now + PLAN_REFUSAL_PAUSE_MS);
  return true;
}

function planRefusalError(endpoint) {
  const err = new Error(`fmp ${endpoint}: not in this key's plan (paused until ${new Date(fmpRefusedUntil(endpoint)).toISOString()})`);
  err.code = 'FMP_PLAN';
  return err;
}

// For the admin panel: the latest pause, if any endpoint is paused.
function fmpPlanState(now = Date.now()) {
  const active = [...refusedUntil.entries()].filter(([, until]) => until > now);
  if (!active.length) return { cooldownUntil: null, refusedEndpoints: [] };
  return {
    cooldownUntil: new Date(Math.max(...active.map(([, u]) => u))).toISOString(),
    refusedEndpoints: active.map(([endpoint]) => endpoint)
  };
}

function resetFmpBudget() {
  budgetDay = '';
  callsToday = 0;
  refusedUntil.clear();
}

async function fmpFirstRow(path, symbol, { get = axios.get } = {}) {
  if (!isFmpEnabled()) throw new Error('fmp not configured');
  if (fmpRefusedUntil(path)) throw planRefusalError(path);
  if (!takeBudget()) {
    const err = new Error('fmp daily budget used up');
    err.code = 'FMP_BUDGET';
    throw err;
  }
  let response;
  try {
    response = await get(`${BASE_URL}/${path}`, {
      params: { symbol, apikey: fmpKey() },
      timeout: REQUEST_TIMEOUT_MS
    });
  } catch (err) {
    noteFmpError(path, err);
    throw err;
  }
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

module.exports = {
  isFmpEnabled,
  fetchFmpProfile,
  fetchFmpRatiosTtm,
  fmpRefusedUntil,
  noteFmpError,
  fmpPlanState,
  resetFmpBudget,
  CALLS_PER_DAY
};
