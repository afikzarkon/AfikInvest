// Company fundamentals for the valuation page: annual and quarterly
// statements, the current quote/market cap, split history and monthly
// prices, peers, and the 10-year Treasury yield (for the suggested discount
// rate).
//
// Sources:
//   * Yahoo (default, no key): quoteSummary (price, summaryDetail,
//     financialData, defaultKeyStatistics, earningsTrend, assetProfile), the
//     fundamentals-timeseries endpoint for statements (~4-5 fiscal years),
//     the chart endpoint for monthly prices and split events, and
//     recommendationsbysymbol for peers. All unofficial - they can change.
//   * Financial Modeling Prep, when FMP_API_KEY is set: statements from its
//     documented income-statement / cash-flow-statement endpoints (longer
//     history). Yahoo still supplies prices and peers.
//
// Each response shape is parsed by an exported pure function, tested
// against recorded fixtures.
const axios = require('axios');
const { fetchYahooQuoteSummary, fetchYahooWithCrumbRetry, unwrapYahooNumber } = require('./yahooQuotes');

const YAHOO_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  Accept: 'application/json'
};

const n = (v) => {
  const x = unwrapYahooNumber(v);
  return x === null || x === undefined ? null : x;
};

// ---------------------------------------------------------------------------
// Statements (Yahoo fundamentals-timeseries)

const FIELD_TYPES = {
  revenue: 'TotalRevenue',
  netIncome: 'NetIncome',
  operatingCashFlow: 'OperatingCashFlow',
  capex: 'CapitalExpenditure',
  freeCashFlow: 'FreeCashFlow',
  dilutedShares: 'DilutedAverageShares',
  cashAndShortTerm: 'CashCashEquivalentsAndShortTermInvestments',
  cash: 'CashAndCashEquivalents',
  totalDebt: 'TotalDebt',
  sharesOutstanding: 'OrdinarySharesNumber'
};

function timeseriesTypes(prefix) {
  return Object.values(FIELD_TYPES).map((t) => `${prefix}${t}`);
}

// Yahoo timeseries -> [{ periodEnd, currency, revenue, ... }] ascending.
function parseYahooTimeseries(data, prefix) {
  const results = (data && data.timeseries && data.timeseries.result) || [];
  const byDate = new Map();
  const typeToField = {};
  Object.entries(FIELD_TYPES).forEach(([field, t]) => {
    typeToField[`${prefix}${t}`] = field;
  });
  results.forEach((r) => {
    const type = r && r.meta && Array.isArray(r.meta.type) ? r.meta.type[0] : null;
    const field = typeToField[type];
    if (!field || !Array.isArray(r[type])) return;
    r[type].forEach((entry) => {
      if (!entry || !entry.asOfDate) return;
      const value = entry.reportedValue ? n(entry.reportedValue) : null;
      if (value === null) return;
      const row = byDate.get(entry.asOfDate) || { periodEnd: entry.asOfDate, currency: entry.currencyCode || null };
      row[field] = value;
      byDate.set(entry.asOfDate, row);
    });
  });
  return [...byDate.values()]
    .map((row) => {
      if (row.cashAndShortTerm === undefined && row.cash !== undefined) row.cashAndShortTerm = row.cash;
      return row;
    })
    .sort((a, b) => (a.periodEnd < b.periodEnd ? -1 : 1));
}

// Yahoo refuses the timeseries endpoint without the same crumb + cookie
// session quoteSummary needs, so by default the request goes through that
// authenticated path (with its retry on a stale crumb). query2 first, then
// query1, which Yahoo sometimes serves when the other is refusing.
const crumbGet = (url, config) => fetchYahooWithCrumbRetry(url, config.params);

async function fetchYahooStatements(symbol, { get = crumbGet } = {}) {
  const period2 = Math.floor(Date.now() / 1000);
  const period1 = period2 - 8 * 365 * 86400;
  const path = `/ws/fundamentals-timeseries/v1/finance/timeseries/${encodeURIComponent(symbol)}`;
  const fetchPrefix = async (prefix) => {
    const params = { type: timeseriesTypes(prefix).join(','), period1, period2, merge: false, padTimeSeries: true, lang: 'en-US' };
    let lastError;
    for (const host of ['https://query2.finance.yahoo.com', 'https://query1.finance.yahoo.com']) {
      try {
        const res = await get(`${host}${path}`, { params, timeout: 15000, headers: YAHOO_HEADERS });
        return parseYahooTimeseries(res.data, prefix);
      } catch (err) {
        lastError = err;
      }
    }
    throw lastError;
  };
  const [annual, quarterly] = await Promise.all([fetchPrefix('annual'), fetchPrefix('quarterly')]);
  if (!annual.length && !quarterly.length) throw new Error('yahoo returned no financial statements');
  return { annual, quarterly, source: 'yahoo' };
}

// ---------------------------------------------------------------------------
// Statements (Financial Modeling Prep, optional)

// FMP income + cash-flow + balance-sheet arrays -> the same row shape.
function parseFmpStatements(income, cashflow, balance) {
  const byDate = new Map();
  const row = (date, currency) => {
    const r = byDate.get(date) || { periodEnd: date, currency: currency || null };
    byDate.set(date, r);
    return r;
  };
  (income || []).forEach((x) => {
    const r = row(x.date, x.reportedCurrency);
    r.revenue = x.revenue;
    r.netIncome = x.netIncome;
    r.dilutedShares = x.weightedAverageShsOutDil;
  });
  (cashflow || []).forEach((x) => {
    const r = row(x.date, x.reportedCurrency);
    r.operatingCashFlow = x.operatingCashFlow;
    r.capex = x.capitalExpenditure;
    r.freeCashFlow = x.freeCashFlow;
  });
  (balance || []).forEach((x) => {
    const r = row(x.date, x.reportedCurrency);
    r.cashAndShortTerm = x.cashAndShortTermInvestments;
    r.totalDebt = x.totalDebt;
  });
  return [...byDate.values()].sort((a, b) => (a.periodEnd < b.periodEnd ? -1 : 1));
}

async function fetchFmpStatements(symbol, apiKey, { get = axios.get } = {}) {
  const base = 'https://financialmodelingprep.com/api/v3';
  const call = (path, period) =>
    get(`${base}/${path}/${encodeURIComponent(symbol)}`, { params: { period, limit: period === 'quarter' ? 8 : 10, apikey: apiKey }, timeout: 15000 }).then((r) => r.data);
  const [ia, ca, ba, iq, cq, bq] = await Promise.all([
    call('income-statement', 'annual'),
    call('cash-flow-statement', 'annual'),
    call('balance-sheet-statement', 'annual'),
    call('income-statement', 'quarter'),
    call('cash-flow-statement', 'quarter'),
    call('balance-sheet-statement', 'quarter')
  ]);
  return { annual: parseFmpStatements(ia, ca, ba), quarterly: parseFmpStatements(iq, cq, bq), source: 'fmp' };
}

// ---------------------------------------------------------------------------
// Quote summary: price, market cap, beta, analyst growth, sector

function parseValuationSummary(qs) {
  const price = qs.price || {};
  const sd = qs.summaryDetail || {};
  const fd = qs.financialData || {};
  const ks = qs.defaultKeyStatistics || {};
  const profile = qs.assetProfile || {};
  const trend = ((qs.earningsTrend && qs.earningsTrend.trend) || []).find((t) => t.period === '+5y');
  return {
    name: price.longName || price.shortName || null,
    currency: price.currency || null,
    financialCurrency: fd.financialCurrency || null,
    price: n(price.regularMarketPrice) ?? n(fd.currentPrice),
    marketCap: n(price.marketCap) ?? n(sd.marketCap),
    sharesOutstanding: n(ks.sharesOutstanding),
    beta: n(ks.beta) ?? n(sd.beta),
    trailingPE: n(sd.trailingPE),
    priceToSales: n(sd.priceToSalesTrailing12Months),
    freeCashflow: n(fd.freeCashflow),
    totalCash: n(fd.totalCash),
    totalDebt: n(fd.totalDebt),
    analystGrowth5y: trend ? n(trend.growth) : null,
    sector: profile.sector || null,
    industry: profile.industry || null,
    quoteType: price.quoteType || null
  };
}

async function fetchValuationSummary(symbol) {
  const qs = await fetchYahooQuoteSummary(symbol, 'price,summaryDetail,financialData,defaultKeyStatistics,earningsTrend,assetProfile');
  return parseValuationSummary(qs);
}

// ---------------------------------------------------------------------------
// Monthly prices and splits

function parseMonthlyChart(data) {
  const result = data && data.chart && data.chart.result && data.chart.result[0];
  if (!result || !Array.isArray(result.timestamp)) throw new Error('missing yahoo monthly chart');
  const closes = (result.indicators && result.indicators.quote && result.indicators.quote[0] && result.indicators.quote[0].close) || [];
  // Monthly bars are stamped at the start of the month; the close is the
  // month's last close, so it is dated to the month's last day.
  const points = [];
  result.timestamp.forEach((ts, i) => {
    const close = closes[i];
    if (!Number.isFinite(close)) return;
    const d = new Date(ts * 1000);
    const end = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
    points.push({ date: end, close });
  });
  const splitEvents = (result.events && result.events.splits) || {};
  const splits = Object.values(splitEvents)
    .map((s) => ({ date: new Date(s.date * 1000).toISOString().slice(0, 10), ratio: Number(s.numerator) / Number(s.denominator) }))
    .filter((s) => Number.isFinite(s.ratio) && s.ratio > 0)
    .sort((a, b) => (a.date < b.date ? -1 : 1));
  // A month can appear twice (the current partial month); keep the last.
  const byDate = new Map(points.map((p) => [p.date, p]));
  const meta = result.meta || {};
  return {
    closes: [...byDate.values()].sort((a, b) => (a.date < b.date ? -1 : 1)),
    splits,
    // The live quote, used when quoteSummary is unavailable.
    meta: {
      price: Number.isFinite(meta.regularMarketPrice) ? meta.regularMarketPrice : null,
      currency: meta.currency || null,
      name: meta.longName || meta.shortName || null
    }
  };
}

async function fetchMonthlyPrices(symbol, { get = axios.get } = {}) {
  const res = await get(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}`, {
    params: { range: '6y', interval: '1mo', events: 'split' },
    timeout: 15000,
    headers: YAHOO_HEADERS
  });
  return parseMonthlyChart(res.data);
}

// ---------------------------------------------------------------------------
// Peers and the risk-free rate

function parsePeers(data) {
  const result = data && data.finance && data.finance.result && data.finance.result[0];
  return ((result && result.recommendedSymbols) || []).map((s) => s.symbol).filter(Boolean);
}

async function fetchPeerSymbols(symbol, { get = axios.get } = {}) {
  const res = await get(`https://query2.finance.yahoo.com/v6/finance/recommendationsbysymbol/${encodeURIComponent(symbol)}`, {
    timeout: 15000,
    headers: YAHOO_HEADERS
  });
  return parsePeers(res.data);
}

// A peer's current multiples from its quote summary. P/FCF uses Yahoo's
// own free-cash-flow figure (levered FCF), so the peer benchmark for it is
// approximate - the page says so.
function peerMultiples(summary) {
  const cap = summary.marketCap;
  return {
    PE: summary.trailingPE,
    PS: summary.priceToSales,
    PFCF: Number.isFinite(cap) && summary.freeCashflow > 0 ? cap / summary.freeCashflow : null
  };
}

async function fetchRiskFreeRate({ get = axios.get } = {}) {
  // ^TNX quotes the 10-year Treasury yield in percent.
  const res = await get('https://query1.finance.yahoo.com/v8/finance/chart/%5ETNX', {
    params: { range: '5d', interval: '1d' },
    timeout: 15000,
    headers: YAHOO_HEADERS
  });
  const meta = res.data && res.data.chart && res.data.chart.result && res.data.chart.result[0] && res.data.chart.result[0].meta;
  const pct = meta ? Number(meta.regularMarketPrice) : NaN;
  return Number.isFinite(pct) && pct > 0 && pct < 20 ? pct / 100 : null;
}

module.exports = {
  FIELD_TYPES,
  parseYahooTimeseries,
  fetchYahooStatements,
  parseFmpStatements,
  fetchFmpStatements,
  parseValuationSummary,
  fetchValuationSummary,
  parseMonthlyChart,
  fetchMonthlyPrices,
  parsePeers,
  fetchPeerSymbols,
  peerMultiples,
  fetchRiskFreeRate
};
