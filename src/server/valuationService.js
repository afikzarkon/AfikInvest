// Assembles the multiples part of the valuation page for one symbol:
// current and historical multiples against peers. (The DCF's raw data has
// its own snapshot - server/dcfSnapshot.js.) Cached per symbol; the sources
// are injected so tests run on fixtures.
const { historicalMultiples, buildMultiplesTable, trailingTwelveMonths } = require('../shared/valuationMultiples');

// 24h: multiples and peers move slowly, and every rebuild spends free-plan
// calls (Finnhub, FMP) on the symbol and its peers.
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const FAILURE_TTL_MS = 2 * 60 * 1000;
const PARTIAL_TTL_MS = 15 * 60 * 1000;
const MAX_PEERS = 5;

const latest = (rows, key) => {
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    if (Number.isFinite(rows[i][key])) return rows[i][key];
  }
  return null;
};

function createValuationService({ sources, now = () => new Date(), logger = console }) {
  const cache = new Map();
  const inFlight = new Map();

  const describe = (settled) => (settled.status === 'fulfilled' ? 'ok' : `error: ${(settled.reason && settled.reason.message) || settled.reason}`);

  // Each source may fail on its own (Yahoo's endpoints are unofficial and
  // refuse requests unpredictably); the page shows whatever did load and
  // says what is missing. Only a missing PRICE makes the whole result fail.
  async function build(symbol) {
    const [sumR, stR, prR] = await Promise.allSettled([
      sources.summary(symbol),
      sources.statements(symbol),
      sources.monthlyPrices(symbol)
    ]);
    const diagnostics = { summary: describe(sumR), statements: describe(stR), prices: describe(prR) };
    Object.entries(diagnostics).forEach(([source, status]) => {
      if (status !== 'ok') logger.warn && logger.warn(`[valuation] ${symbol} ${source} ${status}`);
    });

    const summary = sumR.status === 'fulfilled' ? sumR.value || {} : {};
    const statements = stR.status === 'fulfilled' ? stR.value || {} : {};
    const prices = prR.status === 'fulfilled' ? prR.value || {} : {};
    const annual = statements.annual || [];
    const quarterly = statements.quarterly || [];
    const meta = prices.meta || {};

    const price = Number.isFinite(summary.price) ? summary.price : meta.price;
    if (!Number.isFinite(price)) {
      const err = new Error(`no price for ${symbol} (${Object.entries(diagnostics).map(([k, v]) => `${k}: ${v}`).join('; ')})`);
      err.diagnostics = diagnostics;
      throw err;
    }
    const shares = summary.sharesOutstanding ?? latest(quarterly, 'sharesOutstanding') ?? latest(quarterly, 'dilutedShares') ?? latest(annual, 'dilutedShares');
    const marketCap = Number.isFinite(summary.marketCap) ? summary.marketCap : Number.isFinite(shares) ? price * shares : null;

    // Reported with the other sources: a failed peer list empties the whole
    // sector column, and used to say nothing about why.
    diagnostics.peers = 'ok';
    const [peers] = await Promise.all([
      (async () => {
        try {
          const symbols = (await sources.peerSymbols(symbol)).filter((s) => s.toUpperCase() !== symbol).slice(0, MAX_PEERS);
          const out = [];
          for (const peer of symbols) {
            try {
              const peerSummary = await sources.summary(peer);
              // A summary from Finnhub or FMP brings its own P/FCF; the
              // statement-basis figure is only fetched (from Yahoo) when it
              // did not.
              const needsFcf = !Number.isFinite(peerSummary && peerSummary.priceToFreeCashFlow);
              const peerFcf =
                needsFcf && sources.peerFreeCashFlow ? await sources.peerFreeCashFlow(peer).catch(() => null) : null;
              out.push(Object.assign({ symbol: peer }, sources.peerMultiples(peerSummary, peerFcf)));
            } catch (err) {
              logger.warn && logger.warn('[valuation] peer failed', peer, err && err.message);
            }
          }
          return out;
        } catch (err) {
          diagnostics.peers = `error: ${(err && err.message) || err}`;
          logger.warn && logger.warn(`[valuation] ${symbol} peers ${diagnostics.peers}`);
          return [];
        }
      })()
    ]);

    const ttm = trailingTwelveMonths(quarterly) || annual[annual.length - 1] || {};
    const today = now().toISOString().slice(0, 10);
    const fromDate = `${Number(today.slice(0, 4)) - 5}${today.slice(4)}`;
    const history = historicalMultiples({ annual, splits: prices.splits || [], monthlyCloses: prices.closes || [], fromDate });
    const multiples = buildMultiplesTable({
      current: {
        marketCap,
        ttm,
        fallback: {
          PE: summary.trailingPE,
          PS: summary.priceToSales,
          PFCF: Number.isFinite(marketCap) && summary.freeCashflow > 0 ? marketCap / summary.freeCashflow : null
        }
      },
      history,
      peers
    });

    const warnings = [];
    if (summary.financialCurrency && summary.currency && summary.financialCurrency !== summary.currency) {
      warnings.push(`הדוחות הכספיים מדווחים ב-${summary.financialCurrency} והמניה נסחרת ב-${summary.currency} - מכפילי המכירות והתזרים מערבבים שני מטבעות.`);
    }
    if (diagnostics.statements !== 'ok') {
      warnings.push('לא ניתן היה לטעון את הדוחות הכספיים ההיסטוריים - אין השוואה ל-5 שנים, והמכפילים הנוכחיים מבוססים על נתוני הציטוט בלבד.');
    } else if (annual.length < 3) {
      warnings.push(`נמצאו רק ${annual.length} שנות דוחות.`);
    }
    if (diagnostics.prices !== 'ok') warnings.push('לא ניתן היה לטעון מחירים חודשיים - אין השוואה היסטורית של מכפילים.');
    if (diagnostics.summary !== 'ok') warnings.push('לא ניתן היה לטעון את נתוני הציטוט (בטא, צמיחה צפויה, סקטור) - הוצגו ערכי ברירת מחדל.');
    if (diagnostics.peers !== 'ok') warnings.push('לא ניתן היה לטעון חברות להשוואה - אין חציון ענפי.');

    return {
      symbol,
      name: summary.name || meta.name || null,
      sector: summary.sector || null,
      industry: summary.industry || null,
      currency: summary.currency || meta.currency || null,
      financialCurrency: summary.financialCurrency || (annual[annual.length - 1] && annual[annual.length - 1].currency) || summary.currency || meta.currency || null,
      price,
      marketCap,
      multiples,
      historySamples: history.samples,
      fiscalYears: annual.slice(-6),
      peers,
      warnings,
      diagnostics,
      partial: Object.values(diagnostics).some((v) => v !== 'ok'),
      sources: { statements: statements.source || null, summary: summary.source || null },
      asOf: now().toISOString()
    };
  }

  async function getValuation(symbol) {
    const cached = cache.get(symbol);
    if (cached && now().getTime() - cached.ts < (cached.error ? FAILURE_TTL_MS : cached.ttl || CACHE_TTL_MS)) {
      if (cached.error) throw cached.error;
      return cached.data;
    }
    if (inFlight.has(symbol)) return inFlight.get(symbol);
    const p = build(symbol)
      .then((data) => {
        // A partial result is kept only briefly, so a source that was
        // refusing requests gets another chance soon.
        cache.set(symbol, { data, ts: now().getTime(), ttl: data.partial ? PARTIAL_TTL_MS : CACHE_TTL_MS });
        return data;
      })
      .catch((err) => {
        // The last good valuation, if there is one, beats an error: the
        // final link of the fallback chain. It is kept as it was, and
        // retried after the short failure window like any failure.
        const previous = cached && cached.data;
        if (previous) {
          logger.warn && logger.warn(`[valuation] ${symbol} rebuild failed, serving the last good result: ${err && err.message}`);
          cache.set(symbol, { data: previous, ts: now().getTime(), ttl: FAILURE_TTL_MS });
          return previous;
        }
        cache.set(symbol, { error: err, ts: now().getTime() });
        throw err;
      })
      .finally(() => inFlight.delete(symbol));
    inFlight.set(symbol, p);
    return p;
  }

  return { getValuation, build };
}

// Each source is a fallback chain (marketDataFallbacks.js): the summary
// and peers from Finnhub first, then FMP, then Yahoo; the monthly prices
// from Yahoo, then Tiingo. The statements keep their own FMP-then-Yahoo
// order (fundamentals.js's fetchStatements).
function createDefaultSources(env = process.env) {
  const f = require('./fundamentals');
  const m = require('./marketDataFallbacks');
  return {
    summary: (symbol) => m.fetchValuationSummaryWithFallbacks(symbol, { fetchYahooSummary: f.fetchValuationSummary }),
    statements: (symbol) => f.fetchStatements(symbol, { fmpApiKey: env.FMP_API_KEY || '' }),
    monthlyPrices: (symbol) => m.fetchMonthlyPricesWithFallbacks(symbol, { fetchYahooMonthly: f.fetchMonthlyPrices }),
    peerSymbols: (symbol) => m.fetchPeersWithFallbacks(symbol, { fetchYahooPeers: f.fetchPeerSymbols }),
    peerMultiples: f.peerMultiples,
    peerFreeCashFlow: (symbol) => f.fetchTrailingFreeCashFlow(symbol)
  };
}

module.exports = { createValuationService, createDefaultSources };
