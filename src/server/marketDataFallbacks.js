// The second and third sources behind every piece of US market data that
// used to come from Yahoo alone. Each function here is one data type's
// chain, run through fallbackChain.js, so the order, the logging and the
// admin panel's health list work the same way everywhere:
//
//   sectors / profile   Yahoo -> Finnhub (profile2) -> FMP (profile)
//   analyst ratings     Yahoo -> Finnhub (recommendation trends)
//   dividend summary    Yahoo -> Tiingo (the last year's payments)
//   dividend history    Yahoo -> Tiingo (end-of-day rows, divCash)
//   valuation multiples Finnhub (metric) -> FMP (ratios-ttm) -> Yahoo
//   peers               Finnhub (peers) -> Yahoo
//   monthly prices      Yahoo -> Tiingo (daily rows, splits included)
//   exchange rates      Yahoo -> Frankfurter   (in yahooQuotes.js)
//
// Each source is skipped quietly when its key is not configured, so the
// app runs with none of them, any of them or all of them.
//
// WHAT THE FALLBACKS DO NOT HAVE. They are free plans, and they say so in
// the data rather than inventing it: Finnhub's free plan has no analyst
// price targets and no upgrade/downgrade history, Tiingo knows what was
// paid but not the next payment date or the yield, and none of them has
// Yahoo's consensus revenue estimates, which the DCF uses. Those fields
// stay null when a fallback answered, and the page shows them as missing.
const { runFallbackChain } = require('./fallbackChain');
const { isFinnhubEnabled, fetchFinnhubProfile, fetchFinnhubMetrics, fetchFinnhubRecommendation, fetchFinnhubPeers } = require('./finnhubClient');
const { fetchFinnhubQuote } = require('./finnhubQuotes');
const { isFmpEnabled, fetchFmpProfile, fetchFmpRatiosTtm } = require('./fmpClient');
const { isTiingoEnabled, fetchTiingoDividendHistory, fetchTiingoDividendSummary, fetchTiingoDailyRows } = require('./tiingoClient');

// Finnhub labels a company with one industry of its own ("Semiconductors",
// "Banking"); the app groups by the eleven GICS-style sectors Yahoo and
// FMP use (utils/sectorLabels.js). An industry missing here gives no
// sector, and the chain asks FMP instead.
const FINNHUB_INDUSTRY_SECTOR = {
  Technology: 'Technology',
  Semiconductors: 'Technology',
  'Electronic Equipment, Instruments & Components': 'Technology',
  Communications: 'Communication Services',
  Telecommunication: 'Communication Services',
  Media: 'Communication Services',
  Banking: 'Financial Services',
  'Financial Services': 'Financial Services',
  Insurance: 'Financial Services',
  Pharmaceuticals: 'Healthcare',
  Biotechnology: 'Healthcare',
  'Health Care': 'Healthcare',
  'Life Sciences Tools & Services': 'Healthcare',
  Retail: 'Consumer Cyclical',
  Automobiles: 'Consumer Cyclical',
  'Auto Components': 'Consumer Cyclical',
  'Hotels, Restaurants & Leisure': 'Consumer Cyclical',
  'Textiles, Apparel & Luxury Goods': 'Consumer Cyclical',
  'Leisure Products': 'Consumer Cyclical',
  'Diversified Consumer Services': 'Consumer Cyclical',
  Distributors: 'Consumer Cyclical',
  'Consumer products': 'Consumer Defensive',
  'Food Products': 'Consumer Defensive',
  Beverages: 'Consumer Defensive',
  Tobacco: 'Consumer Defensive',
  Energy: 'Energy',
  Utilities: 'Utilities',
  'Real Estate': 'Real Estate',
  'Aerospace & Defense': 'Industrials',
  Airlines: 'Industrials',
  Machinery: 'Industrials',
  'Logistics & Transportation': 'Industrials',
  Building: 'Industrials',
  Construction: 'Industrials',
  'Electrical Equipment': 'Industrials',
  'Commercial Services & Supplies': 'Industrials',
  'Professional Services': 'Industrials',
  'Road & Rail': 'Industrials',
  Marine: 'Industrials',
  'Trading Companies & Distributors': 'Industrials',
  'Industrial Conglomerates': 'Industrials',
  'Transportation Infrastructure': 'Industrials',
  Chemicals: 'Basic Materials',
  'Metals & Mining': 'Basic Materials',
  'Paper & Forest': 'Basic Materials',
  Packaging: 'Basic Materials'
};

const sectorFromFinnhubIndustry = (industry) => FINNHUB_INDUSTRY_SECTOR[industry] || null;

// ---------------------------------------------------------------------------
// Sector

async function fetchSectorFallback(symbol) {
  const { value } = await runFallbackChain(
    `sector ${symbol}`,
    [
      {
        source: 'finnhub',
        enabled: isFinnhubEnabled(),
        fn: async () => {
          const p = await fetchFinnhubProfile(symbol);
          return { sector: sectorFromFinnhubIndustry(p.industry), industry: p.industry };
        }
      },
      {
        source: 'fmp',
        enabled: isFmpEnabled(),
        fn: async () => {
          const p = await fetchFmpProfile(symbol);
          return { sector: p.sector, industry: p.industry };
        }
      }
    ],
    { accept: (v) => Boolean(v && v.sector) }
  );
  return value;
}

// ---------------------------------------------------------------------------
// Analyst ratings

// The consensus label from the rating counts, on the same 1 (strong buy) to
// 5 (sell) scale Yahoo's recommendationMean uses, and the same keys
// (utils/analystData.js translates them).
function recommendationKeyFromTrend(t) {
  const counts = [t.strongBuy, t.buy, t.hold, t.sell, t.strongSell].map((n) => (Number.isFinite(n) ? n : 0));
  const total = counts.reduce((a, b) => a + b, 0);
  if (!total) return null;
  const mean = counts.reduce((sum, n, i) => sum + n * (i + 1), 0) / total;
  if (mean <= 1.5) return 'strong_buy';
  if (mean <= 2.5) return 'buy';
  if (mean <= 3.5) return 'hold';
  if (mean <= 4.5) return 'underperform';
  return 'sell';
}

async function fetchAnalystFallback(symbol) {
  const trends = await fetchFinnhubRecommendation(symbol);
  const latest = trends[0];
  const currentTrend = {
    period: '0m',
    strongBuy: latest.strongBuy ?? null,
    buy: latest.buy ?? null,
    hold: latest.hold ?? null,
    sell: latest.sell ?? null,
    strongSell: latest.strongSell ?? null
  };
  const opinions = ['strongBuy', 'buy', 'hold', 'sell', 'strongSell'].reduce((s, k) => s + (latest[k] || 0), 0);
  return {
    recommendationKey: recommendationKeyFromTrend(latest),
    numberOfAnalystOpinions: opinions || null,
    // Not on Finnhub's free plan - said as missing, not guessed.
    targetMeanPrice: null,
    targetHighPrice: null,
    targetLowPrice: null,
    currentTrend,
    upgradeHistory: []
  };
}

// ---------------------------------------------------------------------------
// The per-symbol profile (sector + analysts + dividend summary) -
// symbolProfile.js's fetchOne.

const EMPTY_SECTOR = { sector: null, industry: null };

// fetchYahooProfile: yahooQuotes.js's fetchYahooSymbolProfile (injected so
// this module does not depend on it, and tests can stand in for it).
async function fetchProfileWithFallbacks(symbol, { fetchYahooProfile, logger = console }) {
  let profile = null;
  try {
    // Yahoo's crumb-authenticated calls track their own health
    // (yahooQuotes.js), so the chain does not count them twice.
    ({ value: profile } = await runFallbackChain(`profile ${symbol}`, [
      { source: 'yahoo-summary', track: false, fn: () => fetchYahooProfile(symbol) }
    ]));
  } catch (err) {
    profile = null;
    logger.warn(`[market-data] profile ${symbol}: yahoo failed (${err.message}), trying fallbacks`);
  }

  if (profile) {
    // Yahoo answered but has no sector for this symbol: ask the others for
    // the sector alone. (An ETF has none anywhere, and that is fine.)
    if (!profile.sector || !profile.sector.sector) {
      const sector = await fetchSectorFallback(symbol).catch(() => null);
      if (sector) profile = { ...profile, sector };
    }
    return { ...profile, source: 'yahoo' };
  }

  // Yahoo failed: each part from its own fallback, independently - a
  // missing Tiingo key must not cost the sector.
  const [sector, analyst, dividendSummary] = await Promise.all([
    fetchSectorFallback(symbol).catch(() => null),
    runFallbackChain(`analyst ${symbol}`, [
      { source: 'finnhub', enabled: isFinnhubEnabled(), fn: () => fetchAnalystFallback(symbol) }
    ])
      .then((r) => r.value)
      .catch(() => null),
    runFallbackChain(`dividend summary ${symbol}`, [
      { source: 'tiingo', enabled: isTiingoEnabled(), fn: () => fetchTiingoDividendSummary(symbol) }
    ])
      .then((r) => r.value)
      .catch(() => null)
  ]);
  if (!sector && !analyst && !dividendSummary) {
    throw new Error(`profile ${symbol}: yahoo and every fallback failed`);
  }
  return { sector: sector || EMPTY_SECTOR, analyst, dividendSummary, source: 'fallback' };
}

// ---------------------------------------------------------------------------
// Dividend history

// Yahoo first. An empty list from Yahoo is asked of Tiingo too - but a
// stock that simply pays no dividend is empty everywhere, and that is an
// answer, not a failure.
async function fetchDividendHistoryWithFallbacks(symbol, fromDateStr, { fetchYahooHistory }) {
  let yahooAnsweredEmpty = false;
  try {
    const { value } = await runFallbackChain(
      `dividends ${symbol}`,
      [
        {
          source: 'yahoo-chart',
          fn: async () => {
            const rows = await fetchYahooHistory(symbol, fromDateStr);
            if (Array.isArray(rows) && rows.length === 0) yahooAnsweredEmpty = true;
            return rows;
          }
        },
        { source: 'tiingo', enabled: isTiingoEnabled(), fn: () => fetchTiingoDividendHistory(symbol, fromDateStr) }
      ],
      { accept: (rows) => Array.isArray(rows) && rows.length > 0 }
    );
    return value;
  } catch (err) {
    if (yahooAnsweredEmpty) return [];
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Valuation: the current multiples and the figures around them, in
// fundamentals.js's parseValuationSummary shape.

async function fetchFinnhubValuationSummary(symbol) {
  const [profile, metrics, quote] = await Promise.all([
    fetchFinnhubProfile(symbol),
    fetchFinnhubMetrics(symbol),
    fetchFinnhubQuote(symbol)
  ]);
  return {
    name: profile.name,
    currency: profile.currency,
    // Not reported by Finnhub's free endpoints; the valuation reads the
    // reporting currency from the statements instead.
    financialCurrency: null,
    price: quote.currentPrice,
    marketCap: profile.marketCap,
    sharesOutstanding: profile.sharesOutstanding,
    beta: metrics.beta,
    trailingPE: metrics.trailingPE,
    priceToSales: metrics.priceToSales,
    priceToFreeCashFlow: metrics.priceToFreeCashFlow,
    freeCashflow: null,
    totalCash: null,
    totalDebt: null,
    analystGrowth5y: null,
    sector: sectorFromFinnhubIndustry(profile.industry),
    industry: profile.industry,
    quoteType: 'EQUITY'
  };
}

async function fetchFmpValuationSummary(symbol) {
  const [profile, ratios] = await Promise.all([fetchFmpProfile(symbol), fetchFmpRatiosTtm(symbol)]);
  return {
    name: profile.name,
    currency: profile.currency,
    financialCurrency: null,
    price: profile.price,
    marketCap: profile.marketCap,
    sharesOutstanding: Number.isFinite(profile.marketCap) && profile.price > 0 ? profile.marketCap / profile.price : null,
    beta: profile.beta,
    trailingPE: ratios.trailingPE,
    priceToSales: ratios.priceToSales,
    priceToFreeCashFlow: ratios.priceToFreeCashFlow,
    freeCashflow: null,
    totalCash: null,
    totalDebt: null,
    analystGrowth5y: null,
    sector: profile.sector,
    industry: profile.industry,
    quoteType: profile.isEtf ? 'ETF' : 'EQUITY'
  };
}

// Finnhub -> FMP -> Yahoo. An answer without a price is no answer: the
// valuation cannot be built without one.
async function fetchValuationSummaryWithFallbacks(symbol, { fetchYahooSummary }) {
  const { value, source } = await runFallbackChain(
    `valuation ${symbol}`,
    [
      { source: 'finnhub', enabled: isFinnhubEnabled(), fn: () => fetchFinnhubValuationSummary(symbol) },
      { source: 'fmp', enabled: isFmpEnabled(), fn: () => fetchFmpValuationSummary(symbol) },
      { source: 'yahoo-summary', track: false, fn: () => fetchYahooSummary(symbol) }
    ],
    { accept: (v) => Boolean(v) && Number.isFinite(v.price) }
  );
  return { ...value, source };
}

async function fetchPeersWithFallbacks(symbol, { fetchYahooPeers }) {
  const { value } = await runFallbackChain(
    `peers ${symbol}`,
    [
      { source: 'finnhub', enabled: isFinnhubEnabled(), fn: () => fetchFinnhubPeers(symbol) },
      { source: 'yahoo-summary', track: false, fn: () => fetchYahooPeers(symbol) }
    ],
    { accept: (list) => Array.isArray(list) && list.length > 0 }
  );
  return value;
}

// The DCF's quote figures (price, shares, beta, sector) when Yahoo's quote
// summary fails - in dcfSnapshot.js's parseQuote shape. No consensus: the
// revenue estimates are Yahoo's alone, and the DCF flags them as missing.
async function fetchDcfQuoteFallback(symbol, retrievedDay) {
  const { value: v, source } = await runFallbackChain(`dcf quote ${symbol}`, [
    { source: 'finnhub', enabled: isFinnhubEnabled(), fn: () => fetchFinnhubValuationSummary(symbol) },
    { source: 'fmp', enabled: isFmpEnabled(), fn: () => fetchFmpValuationSummary(symbol) }
  ]);
  const provider = source === 'finnhub' ? 'Finnhub' : 'Financial Modeling Prep';
  const label = (what) => `${provider} - ${what} (מקור גיבוי)`;
  return {
    name: v.name || null,
    currency: v.currency || null,
    financialCurrency: null,
    price: Number.isFinite(v.price) ? { value: v.price, asOf: retrievedDay, source: label('מחיר אחרון') } : null,
    sharesOutstanding: Number.isFinite(v.sharesOutstanding) ? v.sharesOutstanding : null,
    betaRaw: Number.isFinite(v.beta) ? { value: v.beta, asOf: retrievedDay, source: label('בטא') } : null,
    // No consensus at all rather than an empty one: the DCF then says the
    // estimates are missing (dcfRules.js reads a missing consensus as {}).
    consensus: null,
    profile: { sector: v.sector || null, industry: v.industry || null, quoteType: v.quoteType || null, source: label('פרופיל') }
  };
}

// ---------------------------------------------------------------------------
// Monthly prices (valuation history) from Tiingo's daily rows, in
// fundamentals.js's parseMonthlyChart shape: month-end closes adjusted for
// splits (as Yahoo's are - a split must not read as a crash), the splits
// themselves, and the latest price.
function monthlyFromTiingoRows(rows) {
  const sorted = [...rows].sort((a, b) => (a.date < b.date ? -1 : 1));
  // Each close divided by every split that happened AFTER it, so the whole
  // series is on today's share count.
  const splits = sorted
    .filter((r) => Number.isFinite(Number(r.splitFactor)) && Number(r.splitFactor) > 0 && Number(r.splitFactor) !== 1)
    .map((r) => ({ date: String(r.date).slice(0, 10), ratio: Number(r.splitFactor) }));
  const byMonth = new Map();
  sorted.forEach((r) => {
    const date = String(r.date).slice(0, 10);
    const close = Number(r.close);
    if (!Number.isFinite(close)) return;
    const later = splits.filter((s) => s.date > date).reduce((f, s) => f * s.ratio, 1);
    const [y, m] = date.split('-').map(Number);
    const monthEnd = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
    byMonth.set(monthEnd, { date: monthEnd, close: close / later });
  });
  const last = sorted[sorted.length - 1];
  return {
    closes: [...byMonth.values()],
    splits,
    meta: { price: last && Number.isFinite(Number(last.close)) ? Number(last.close) : null, currency: 'USD', name: null }
  };
}

async function fetchMonthlyPricesWithFallbacks(symbol, { fetchYahooMonthly }) {
  const { value } = await runFallbackChain(`monthly prices ${symbol}`, [
    { source: 'yahoo-chart', fn: () => fetchYahooMonthly(symbol) },
    {
      source: 'tiingo',
      enabled: isTiingoEnabled(),
      fn: async () => {
        const from = new Date(Date.now() - 6 * 365 * 86400000).toISOString().slice(0, 10);
        return monthlyFromTiingoRows(await fetchTiingoDailyRows(symbol, from));
      }
    }
  ]);
  return value;
}

module.exports = {
  FINNHUB_INDUSTRY_SECTOR,
  sectorFromFinnhubIndustry,
  recommendationKeyFromTrend,
  fetchSectorFallback,
  fetchAnalystFallback,
  fetchProfileWithFallbacks,
  fetchDividendHistoryWithFallbacks,
  fetchValuationSummaryWithFallbacks,
  fetchPeersWithFallbacks,
  fetchDcfQuoteFallback,
  monthlyFromTiingoRows,
  fetchMonthlyPricesWithFallbacks
};
