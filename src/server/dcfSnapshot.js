// The raw data an automatic DCF is derived from (shared/dcfRules.js), as
// one dated snapshot: the last quarters' statements, the last fiscal years,
// the price, the analysts' revenue consensus, beta, the 10-year Treasury
// yield and the company's sector - each with its source and date. The
// snapshot is all the derivation needs; the input card carries it whole so
// a valuation can be redone offline.
//
// Sources (Yahoo, unofficial - they can change):
//   statements    fundamentals-timeseries, quarterly and annual
//   quote         quoteSummary: price, defaultKeyStatistics (beta, shares),
//                 earningsTrend (revenue consensus 0y / +1y), assetProfile
//   risk-free     the ^TNX chart (10-year Treasury yield, in percent)
//
// The parsers are pure and exported, tested on recorded shapes.
const axios = require('axios');
const { fetchYahooQuoteSummary, fetchYahooWithCrumbRetry, unwrapYahooNumber } = require('./yahooQuotes');

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  Accept: 'application/json'
};
const HOSTS = ['https://query2.finance.yahoo.com', 'https://query1.finance.yahoo.com'];

const QUARTER_FIELDS = {
  revenue: 'TotalRevenue',
  operatingCashFlow: 'OperatingCashFlow',
  capex: 'CapitalExpenditure',
  sbc: 'StockBasedCompensation',
  netIncome: 'NetIncome',
  dilutedShares: 'DilutedAverageShares',
  basicShares: 'OrdinarySharesNumber',
  cash: 'CashAndCashEquivalents',
  currentDebt: 'CurrentDebt',
  longTermDebt: 'LongTermDebt'
};
const ANNUAL_FIELDS = {
  revenue: 'TotalRevenue',
  operatingCashFlow: 'OperatingCashFlow',
  capex: 'CapitalExpenditure',
  sbc: 'StockBasedCompensation',
  netIncome: 'NetIncome'
};

const SOURCES = {
  quarters: 'Yahoo Finance - דוחות רבעוניים (fundamentals-timeseries)',
  annual: 'Yahoo Finance - דוחות שנתיים (fundamentals-timeseries)',
  price: 'Yahoo Finance - מחיר אחרון (quoteSummary.price)',
  consensus: 'Yahoo Finance - קונצנזוס אנליסטים (earningsTrend.revenueEstimate)',
  beta: 'Yahoo Finance - בטא 5 שנים, חודשית (defaultKeyStatistics.beta)',
  rf: 'אג"ח ממשלת ארה"ב ל-10 שנים (^TNX), Yahoo Finance',
  profile: 'Yahoo Finance - פרופיל החברה (assetProfile)'
};

const num = (v) => {
  const x = unwrapYahooNumber(v);
  return x === null || x === undefined ? null : x;
};
const isoDay = (epochSeconds) => (Number.isFinite(epochSeconds) ? new Date(epochSeconds * 1000).toISOString().slice(0, 10) : null);

// Timeseries -> rows [{ periodEnd, currency, <field>: value }] ascending.
function parseTimeseries(data, prefix, fields) {
  const results = (data && data.timeseries && data.timeseries.result) || [];
  const typeToField = {};
  Object.entries(fields).forEach(([field, type]) => {
    typeToField[`${prefix}${type}`] = field;
  });
  const byDate = new Map();
  results.forEach((r) => {
    const type = r && r.meta && Array.isArray(r.meta.type) ? r.meta.type[0] : null;
    const field = typeToField[type];
    if (!field || !Array.isArray(r[type])) return;
    r[type].forEach((entry) => {
      if (!entry || !entry.asOfDate) return;
      const value = entry.reportedValue ? num(entry.reportedValue) : null;
      if (value === null) return;
      const row = byDate.get(entry.asOfDate) || { periodEnd: entry.asOfDate, currency: entry.currencyCode || null };
      row[field] = value;
      byDate.set(entry.asOfDate, row);
    });
  });
  return [...byDate.values()].sort((a, b) => (a.periodEnd < b.periodEnd ? -1 : 1));
}

// quoteSummary -> price, consensus, beta, profile; dated by the quote's own
// market time (price) and the retrieval day (the rest).
function parseQuote(qs, retrievedDay) {
  const price = qs.price || {};
  const fd = qs.financialData || {};
  const ks = qs.defaultKeyStatistics || {};
  const sd = qs.summaryDetail || {};
  const profile = qs.assetProfile || {};
  const trend = (qs.earningsTrend && qs.earningsTrend.trend) || [];
  const estimate = (period) => {
    const t = trend.find((x) => x.period === period);
    const value = t && t.revenueEstimate ? num(t.revenueEstimate.avg) : null;
    return value === null ? null : { value, periodEnd: t.endDate || null, analysts: t.revenueEstimate ? num(t.revenueEstimate.numberOfAnalysts) : null };
  };
  const priceValue = num(price.regularMarketPrice) ?? num(fd.currentPrice);
  const betaValue = num(ks.beta) ?? num(sd.beta);
  return {
    name: price.longName || price.shortName || null,
    currency: price.currency || null,
    financialCurrency: fd.financialCurrency || null,
    price: priceValue === null ? null : { value: priceValue, asOf: isoDay(num(price.regularMarketTime)) || retrievedDay, source: SOURCES.price },
    sharesOutstanding: num(ks.sharesOutstanding),
    betaRaw: betaValue === null ? null : { value: betaValue, asOf: retrievedDay, source: SOURCES.beta },
    consensus: { rev0y: estimate('0y'), rev1y: estimate('+1y'), asOf: retrievedDay, source: SOURCES.consensus },
    profile: { sector: profile.sector || null, industry: profile.industry || null, quoteType: price.quoteType || null, source: SOURCES.profile }
  };
}

function parseRiskFree(data) {
  const meta = data && data.chart && data.chart.result && data.chart.result[0] && data.chart.result[0].meta;
  const pct = meta ? Number(meta.regularMarketPrice) : NaN;
  if (!(Number.isFinite(pct) && pct > 0 && pct < 20)) return null;
  return { value: pct / 100, asOf: isoDay(Number(meta.regularMarketTime)), source: SOURCES.rf };
}

async function fetchTimeseries(symbol, prefix, fields, years, { get, plainGet }) {
  const period2 = Math.floor(Date.now() / 1000);
  const params = {
    type: Object.values(fields).map((t) => `${prefix}${t}`).join(','),
    period1: period2 - years * 365 * 86400,
    period2,
    merge: false,
    padTimeSeries: true,
    lang: 'en-US'
  };
  const path = `/ws/fundamentals-timeseries/v1/finance/timeseries/${encodeURIComponent(symbol)}`;
  let lastError;
  for (const fetcher of [get, plainGet]) {
    for (const host of HOSTS) {
      try {
        const res = await fetcher(`${host}${path}`, { params, timeout: 15000, headers: HEADERS });
        return parseTimeseries(res.data, prefix, fields);
      } catch (err) {
        lastError = err;
      }
    }
  }
  throw lastError;
}

const defaultDeps = {
  get: (url, config) => fetchYahooWithCrumbRetry(url, config.params),
  plainGet: axios.get,
  quoteSummary: (symbol) => fetchYahooQuoteSummary(symbol, 'price,summaryDetail,financialData,defaultKeyStatistics,earningsTrend,assetProfile'),
  riskFree: () => axios.get('https://query1.finance.yahoo.com/v8/finance/chart/%5ETNX', { params: { range: '5d', interval: '1d' }, timeout: 15000, headers: HEADERS })
};

// Each source may fail on its own; what failed is recorded, and the
// derivation then flags the missing figures instead of guessing them.
async function fetchDcfSnapshot(symbol, deps = {}) {
  const d = Object.assign({}, defaultDeps, deps);
  const retrievedAt = new Date().toISOString();
  const retrievedDay = retrievedAt.slice(0, 10);
  const [qR, aR, sR, rR] = await Promise.allSettled([
    fetchTimeseries(symbol, 'quarterly', QUARTER_FIELDS, 3, d),
    fetchTimeseries(symbol, 'annual', ANNUAL_FIELDS, 6, d),
    d.quoteSummary(symbol),
    d.riskFree()
  ]);
  const status = (r) => (r.status === 'fulfilled' ? 'ok' : `error: ${(r.reason && r.reason.message) || r.reason}`);
  const quote = sR.status === 'fulfilled' ? parseQuote(sR.value, retrievedDay) : {};
  return {
    ticker: symbol,
    retrievedAt,
    name: quote.name || null,
    currency: quote.currency || null,
    financialCurrency: quote.financialCurrency || null,
    price: quote.price || null,
    sharesOutstanding: quote.sharesOutstanding ?? null,
    betaRaw: quote.betaRaw || null,
    consensus: quote.consensus || null,
    rf: rR.status === 'fulfilled' ? parseRiskFree(rR.value.data) : null,
    profile: quote.profile || null,
    quarters: qR.status === 'fulfilled' ? qR.value : [],
    annual: aR.status === 'fulfilled' ? aR.value : [],
    sources: { quarters: SOURCES.quarters, annual: SOURCES.annual },
    diagnostics: { quarters: status(qR), annual: status(aR), quote: status(sR), riskFree: status(rR) }
  };
}

// Cached per symbol: 12 hours, 15 minutes when a source failed, so a
// refusing source gets another chance soon.
function createDcfSnapshotService({ fetch = fetchDcfSnapshot, now = () => Date.now() } = {}) {
  const cache = new Map();
  const inFlight = new Map();
  return async function getDcfSnapshot(symbol) {
    const hit = cache.get(symbol);
    if (hit && now() - hit.ts < hit.ttl) return hit.data;
    if (inFlight.has(symbol)) return inFlight.get(symbol);
    const p = fetch(symbol)
      .then((data) => {
        const partial = Object.values(data.diagnostics).some((s) => s !== 'ok');
        cache.set(symbol, { data, ts: now(), ttl: partial ? 15 * 60 * 1000 : 12 * 60 * 60 * 1000 });
        return data;
      })
      .finally(() => inFlight.delete(symbol));
    inFlight.set(symbol, p);
    return p;
  };
}

module.exports = { QUARTER_FIELDS, ANNUAL_FIELDS, SOURCES, parseTimeseries, parseQuote, parseRiskFree, fetchDcfSnapshot, createDcfSnapshotService };
