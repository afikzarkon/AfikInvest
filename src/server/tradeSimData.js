// Ported from day-trader-skill (MIT, Jake Schincariol)
//
// 60 days of 5-minute bars for the trade simulator (one Yahoo v8 chart
// request per symbol: range=60d, interval=5m - Yahoo keeps 60 days of 5-minute
// bars but only about a week of 1-minute bars), plus a small per-symbol cache
// so repeated simulations of the same stock do not hit Yahoo again.
// Same unauthenticated chart endpoint as yahooQuotes.js (no crumb needed);
// query2 first, then query1 on 429 or 5xx, with a timeout on every request.
const axios = require('axios');

const HOSTS = ['query2', 'query1'];
const TIMEOUT_MS = 12000;
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  Accept: 'application/json'
};

function dataError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

// -> the Yahoo chart result object (result[0]) for `symbol`. Throws an Error
// with code 'not_found' (unknown ticker / no data) or 'upstream' (Yahoo down,
// rate limited, unexpected answer).
async function fetchYahooIntraday5m(symbol, { http = axios } = {}) {
  const ysym = encodeURIComponent(String(symbol).toUpperCase().replace(/\./g, '-'));
  let lastStatus = null;
  for (let h = 0; h < HOSTS.length; h++) {
    let response;
    try {
      response = await http.get(`https://${HOSTS[h]}.finance.yahoo.com/v8/finance/chart/${ysym}`, {
        params: { range: '60d', interval: '5m', includePrePost: false },
        timeout: TIMEOUT_MS,
        headers: HEADERS
      });
    } catch (err) {
      const status = err && err.response && err.response.status;
      lastStatus = status || (err && err.code) || 'network';
      if (status === 404) throw dataError('not_found', `no chart for ${symbol}`);
      if (status === 429 || (status >= 500 && status < 600) || !status) continue;
      throw dataError('upstream', `Yahoo answered HTTP ${status} for ${symbol}`);
    }
    const chart = response && response.data && response.data.chart;
    const result = chart && Array.isArray(chart.result) ? chart.result[0] : null;
    if (!result) {
      const desc = chart && chart.error && chart.error.description;
      throw dataError('not_found', `no data for ${symbol}${desc ? `: ${desc}` : ''}`);
    }
    return result;
  }
  throw dataError('upstream', `Yahoo did not answer for ${symbol} (${lastStatus})`);
}

// get(symbol) -> the cached chart result, fetched at most once per ttlMs per
// symbol; concurrent requests for the same symbol share one fetch.
function createBarCache({ fetcher = fetchYahooIntraday5m, ttlMs = 5 * 60 * 1000, maxEntries = 50, now = () => Date.now() } = {}) {
  const cache = new Map(); // symbol -> { at, data }
  const inFlight = new Map();

  async function get(symbol) {
    const key = String(symbol).toUpperCase();
    const hit = cache.get(key);
    if (hit && now() - hit.at < ttlMs) return { data: hit.data, fetchedAt: hit.at, cached: true };
    if (inFlight.has(key)) return inFlight.get(key);
    const p = (async () => {
      try {
        const data = await fetcher(key);
        const at = now();
        cache.delete(key);
        cache.set(key, { at, data });
        while (cache.size > maxEntries) cache.delete(cache.keys().next().value);
        return { data, fetchedAt: at, cached: false };
      } finally {
        inFlight.delete(key);
      }
    })();
    inFlight.set(key, p);
    return p;
  }

  return { get, clear: () => cache.clear() };
}

module.exports = { fetchYahooIntraday5m, createBarCache };
