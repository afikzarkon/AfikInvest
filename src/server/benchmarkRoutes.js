// Historical benchmark data (the US and TASE indices below), used by the frontend to
// draw "my portfolio vs. the market" alongside the equity curve from
// snapshotRoutes.js. This is public market data, not user-specific, so
// (like quotesRoutes.js) it doesn't require auth and is cached aggressively
// — a historical close from yesterday doesn't change.
const { fetchYahooHistoricalCloses } = require('./yahooQuotes');
const { fetchTaseIndexHistoricalCloses, TASE_INDEX_IDS } = require('./taseIndexHistoryApi');
const { sourceHealth } = require('./sourceHealth');

// Deliberately whitelisted rather than accepting an arbitrary symbol from
// the query string — this endpoint has no auth, so an open "fetch any
// symbol" proxy would be an easy abuse vector.
//
// `currency` is what the index is quoted in, and it is returned to the
// client because it decides whether the series has to be converted to
// shekels before it can be compared with an ILS portfolio.
//
// `source` picks the fetcher:
//
//   'yahoo' - the US indices. All four symbols were checked against Yahoo
//     for real daily history (not merely for a valid quote, which is a
//     weaker thing): ^GSPC, ^IXIC, ^NDX and ^RUT each return a full series.
//
//   'tase'  - the Israeli indices, from TASE's own index endpoint rather
//     than from Yahoo. This is the primary source for its own indices, and
//     it is the ONLY working source for TA-Banks: Yahoo answers for
//     TA-BANKS.TA with a current quote and exactly one historical point at
//     every range, while TASE returns 738 trading days over three years.
//     See taseIndexHistoryApi.js for the endpoint and the three-year cap.
const BENCHMARKS = {
  sp500: { source: 'yahoo', symbol: '^GSPC', label: 'S&P 500', currency: 'USD' },
  nasdaq: { source: 'yahoo', symbol: '^IXIC', label: 'NASDAQ Composite', currency: 'USD' },
  nasdaq100: { source: 'yahoo', symbol: '^NDX', label: 'NASDAQ 100', currency: 'USD' },
  russell2000: { source: 'yahoo', symbol: '^RUT', label: 'Russell 2000', currency: 'USD' },
  ta125: { source: 'tase', symbol: TASE_INDEX_IDS.ta125, label: 'TA-125', currency: 'ILS' },
  ta35: { source: 'tase', symbol: TASE_INDEX_IDS.ta35, label: 'TA-35', currency: 'ILS' },
  ta90: { source: 'tase', symbol: TASE_INDEX_IDS.ta90, label: 'TA-90', currency: 'ILS' },
  taBanks: { source: 'tase', symbol: TASE_INDEX_IDS.taBanks, label: 'TA-Banks', currency: 'ILS' }
};

const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6h: historical closes barely change intraday
const cache = new Map();
const inFlight = new Map();

function isValidDateString(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

async function getCachedBenchmarkHistory(benchmark, fromDateStr) {
  const { source, symbol } = benchmark;
  // The source is part of the key as well as the symbol: a TASE index id
  // is a small integer and could collide with nothing today, but keying on
  // both means the two namespaces can never be confused for each other.
  const cacheKey = `${source}:${symbol}:${fromDateStr || 'default'}`;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) return cached.data;

  const existingInFlight = inFlight.get(cacheKey);
  if (existingInFlight) return existingInFlight;

  const requestPromise = (async () => {
    try {
      const points =
        source === 'tase'
          ? await sourceHealth.track('tase-index', () => fetchTaseIndexHistoricalCloses(symbol, fromDateStr))
          : await fetchYahooHistoricalCloses(symbol, fromDateStr);
      cache.set(cacheKey, { data: points, ts: Date.now() });
      return points;
    } catch (err) {
      // An expired series is still a good answer: past closes do not
      // change, the only thing missing is the last few hours. Serving it
      // beats the error the chart used to show whenever the 6h cache had
      // run out at a moment the source was down. Its clock is not reset,
      // so the next request tries the source again.
      if (cached) {
        console.warn('[benchmark] refresh failed, serving the expired series', {
          source,
          symbol,
          error: err && err.message
        });
        return cached.data;
      }
      throw err;
    }
  })();

  inFlight.set(cacheKey, requestPromise);
  try {
    return await requestPromise;
  } finally {
    inFlight.delete(cacheKey);
  }
}

function mountBenchmarkRoutes(app) {
  app.get('/api/benchmark-history/:key', async (req, res) => {
    const benchmark = BENCHMARKS[req.params.key];
    if (!benchmark) {
      return res.status(400).json({ error: 'מדד לא נתמך' });
    }
    const from = isValidDateString(req.query.from) ? req.query.from : undefined;
    try {
      const points = await getCachedBenchmarkHistory(benchmark, from);
      return res.json({
        key: req.params.key,
        label: benchmark.label,
        symbol: String(benchmark.symbol),
        source: benchmark.source,
        currency: benchmark.currency,
        points
      });
    } catch (err) {
      console.error('[benchmark] failed to fetch history', {
        key: req.params.key,
        source: benchmark.source,
        symbol: benchmark.symbol,
        error: err && err.message
      });
      return res.status(502).json({ error: 'לא ניתן היה למשוך נתוני מדד ייחוס' });
    }
  });
}

module.exports = { mountBenchmarkRoutes, BENCHMARKS };
