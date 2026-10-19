// One cached Yahoo answer per US symbol that the sector, analyst and
// dividend routes all read from (see yahooQuotes.js's
// fetchYahooSymbolProfile for why it is one request rather than three).
//
// 24h: an analyst consensus and a dividend yield do not move within a
// day, and a sector not at all - and every refresh spends free-plan calls
// when Yahoo is down and the fallbacks answer instead. Kept in the
// database as well (marketMemory.js), so a restart neither empties it nor
// sends a burst of requests out.
//
// Yahoo first; when it fails, Finnhub, FMP and Tiingo each fill the part
// they can (marketDataFallbacks.js's fetchProfileWithFallbacks).
const { fetchYahooSymbolProfile } = require('./yahooQuotes');
const { fetchProfileWithFallbacks } = require('./marketDataFallbacks');
const { createSymbolCache } = require('./symbolCache');
const { marketMemory } = require('./marketMemory');

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

const EMPTY_SECTOR = { sector: null, industry: null };
const EMPTY_ANALYST = {
  recommendationKey: null,
  numberOfAnalystOpinions: null,
  targetMeanPrice: null,
  targetHighPrice: null,
  targetLowPrice: null,
  currentTrend: null,
  upgradeHistory: []
};
const EMPTY_DIVIDEND_SUMMARY = {
  dividendRate: null,
  dividendYieldPercent: null,
  payoutRatio: null,
  exDividendDateEpoch: null,
  nextDividendDateEpoch: null
};

const profileCache = createSymbolCache({
  name: 'yahoo-profile',
  ttlMs: CACHE_TTL_MS,
  fetchOne: (symbol) => fetchProfileWithFallbacks(symbol, { fetchYahooProfile: fetchYahooSymbolProfile }),
  fallback: () => ({
    sector: { ...EMPTY_SECTOR },
    analyst: { ...EMPTY_ANALYST, upgradeHistory: [] },
    dividendSummary: { ...EMPTY_DIVIDEND_SUMMARY }
  }),
  memory: marketMemory,
  memoryKey: (symbol) => `profile:${symbol}`
});

// Each part separately, filled out to its full shape.
async function getSymbolSector(symbol) {
  const p = await profileCache.get(symbol);
  return { ...EMPTY_SECTOR, ...(p && p.sector) };
}

async function getSymbolAnalyst(symbol) {
  const p = await profileCache.get(symbol);
  return { ...EMPTY_ANALYST, ...(p && p.analyst) };
}

async function getSymbolDividendSummary(symbol) {
  const p = await profileCache.get(symbol);
  return { ...EMPTY_DIVIDEND_SUMMARY, ...(p && p.dividendSummary) };
}

module.exports = { profileCache, getSymbolSector, getSymbolAnalyst, getSymbolDividendSummary };
