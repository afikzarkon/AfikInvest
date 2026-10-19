// Dividend data for US stocks: forward-looking yield/payout/next date
// (quoteSummary, same crumb+cookie auth as sectorRoutes.js/analystRoutes.js)
// combined with actual historical payments (public chart endpoint, same as
// benchmarkRoutes.js). The two need different underlying data - a forward
// estimate vs. an actual payment ledger - so they're fetched and cached
// independently, and only combined here at the route layer.
const { fetchYahooDividendHistory } = require('./yahooQuotes');
// Yahoo, then Tiingo when one is configured (marketDataFallbacks.js).
const { fetchDividendHistoryWithFallbacks } = require('./marketDataFallbacks');
// The forward-looking summary comes from the per-symbol profile shared
// with the sector and analyst routes - one Yahoo request for all three
// (symbolProfile.js), with its last known value kept through failures
// and restarts.
const { getSymbolDividendSummary } = require('./symbolProfile');

const HISTORY_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h: past dividend payments never change
const MAX_SYMBOLS_PER_REQUEST = 30;

const historyCache = new Map();
const historyInFlight = new Map();

function isValidDateString(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

async function getCachedDividendHistory(symbol, fromDateStr) {
  const cacheKey = `${symbol}:${fromDateStr || 'default'}`;
  const cached = historyCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < HISTORY_CACHE_TTL_MS) return cached.data;

  const existingInFlight = historyInFlight.get(cacheKey);
  if (existingInFlight) return existingInFlight;

  const requestPromise = (async () => {
    try {
      const history = await fetchDividendHistoryWithFallbacks(symbol, fromDateStr, {
        fetchYahooHistory: fetchYahooDividendHistory
      });
      historyCache.set(cacheKey, { data: history, ts: Date.now() });
      return history;
    } catch (err) {
      console.warn('[dividends] failed to resolve history', { symbol, error: err && err.message });
      // "Fail this one symbol, not the whole batch" approach.
      return [];
    }
  })();

  historyInFlight.set(cacheKey, requestPromise);
  try {
    return await requestPromise;
  } finally {
    historyInFlight.delete(cacheKey);
  }
}

function mountDividendRoutes(app) {
  // POST (not GET) because the symbol list can be longer than is
  // comfortable in a query string — same reasoning as /api/stock-sectors.
  app.post('/api/dividend-data', async (req, res) => {
    const body = req.body || {};
    const symbols = Array.isArray(body.symbols) ? body.symbols : [];
    const cleaned = [...new Set(symbols.map((s) => String(s || '').trim().toUpperCase()).filter(Boolean))].slice(
      0,
      MAX_SYMBOLS_PER_REQUEST
    );
    const from = isValidDateString(body.from) ? body.from : undefined;

    if (cleaned.length === 0) {
      return res.json({ dividends: {} });
    }

    const results = await Promise.all(
      cleaned.map(async (symbol) => {
        const [summary, history] = await Promise.all([
          getSymbolDividendSummary(symbol),
          getCachedDividendHistory(symbol, from)
        ]);
        return { ...summary, history };
      })
    );

    const dividends = {};
    cleaned.forEach((symbol, i) => {
      dividends[symbol] = results[i];
    });
    return res.json({ dividends });
  });
}

module.exports = { mountDividendRoutes };
