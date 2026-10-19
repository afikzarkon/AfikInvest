// One cached Yahoo answer per US symbol that the sector, analyst and
// dividend routes all read from (see yahooQuotes.js's
// fetchYahooSymbolProfile for why it is one request rather than three).
//
// 6h, the shortest of what the three used to be on their own: an analyst
// consensus and a dividend yield do not move minute to minute, and a
// sector not at all. Kept in the database as well (marketMemory.js), so a
// restart neither empties it nor sends a burst of requests to Yahoo.
const { fetchYahooSymbolProfile } = require('./yahooQuotes');
const { createSymbolCache } = require('./symbolCache');
const { marketMemory } = require('./marketMemory');

const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

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
  fetchOne: fetchYahooSymbolProfile,
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
