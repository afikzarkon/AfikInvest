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

// Yahoo has refused the timeseries endpoint without the same crumb + cookie
// session quoteSummary needs, so by default the request goes through that
// authenticated path (with its retry on a stale crumb). query2 first, then
// query1, which Yahoo sometimes serves when the other is refusing.
//
// The endpoint has since been answering plain requests too, and the crumb
// is the part a hosted server loses first (Yahoo refuses the session from
// some data-centre addresses), so the same two hosts are then tried
// without it before the statements are given up on.
const crumbGet = (url, config) => fetchYahooWithCrumbRetry(url, config.params);
const YAHOO_HOSTS = ['https://query2.finance.yahoo.com', 'https://query1.finance.yahoo.com'];

async function fetchYahooStatements(symbol, { get = crumbGet, plainGet = axios.get } = {}) {
  const period2 = Math.floor(Date.now() / 1000);
  const period1 = period2 - 8 * 365 * 86400;
  const path = `/ws/fundamentals-timeseries/v1/finance/timeseries/${encodeURIComponent(symbol)}`;
  const fetchPrefix = async (prefix) => {
    const params = { type: timeseriesTypes(prefix).join(','), period1, period2, merge: false, padTimeSeries: true, lang: 'en-US' };
    let lastError;
    for (const fetcher of [get, plainGet]) {
      for (const host of YAHOO_HOSTS) {
        try {
          const res = await fetcher(`${host}${path}`, { params, timeout: 15000, headers: YAHOO_HEADERS });
          return parseYahooTimeseries(res.data, prefix);
        } catch (err) {
          lastError = err;
        }
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

// FMP answers a refused request (bad key, a plan that does not include the
// endpoint, a retired endpoint) with HTTP 200 and an object instead of the
// array of statements - which the parser used to crash on with a TypeError
// that said nothing about why.
function fmpRows(data, path) {
  if (Array.isArray(data)) return data;
  const message = data && (data['Error Message'] || data.error || data.message);
  throw new Error(`fmp ${path}: ${message || 'unexpected response'}`);
}

// The /stable endpoints: FMP retired the /api/v3 ones for keys issued after
// August 2025. Quarterly statements are a paid feature on its free plan, so
// they are optional here - without them the result has no quarterly rows,
// and fetchStatements fills them from Yahoo.
async function fetchFmpStatements(symbol, apiKey, { get = axios.get } = {}) {
  const base = 'https://financialmodelingprep.com/stable';
  const call = (path, period) =>
    get(`${base}/${path}`, { params: { symbol, period, limit: period === 'quarter' ? 8 : 10, apikey: apiKey }, timeout: 15000 }).then((r) =>
      fmpRows(r.data, path)
    );
  const [ia, ca, ba] = await Promise.all([
    call('income-statement', 'annual'),
    call('cash-flow-statement', 'annual'),
    call('balance-sheet-statement', 'annual')
  ]);
  const quarters = await Promise.allSettled([
    call('income-statement', 'quarter'),
    call('cash-flow-statement', 'quarter'),
    call('balance-sheet-statement', 'quarter')
  ]);
  const quarterly = quarters.every((q) => q.status === 'fulfilled') ? parseFmpStatements(...quarters.map((q) => q.value)) : [];
  return { annual: parseFmpStatements(ia, ca, ba), quarterly, source: 'fmp' };
}

// The statements the valuation uses: FMP's when a key is configured, and
// Yahoo's otherwise - or whenever FMP fails or has nothing for the symbol,
// so a refused key costs the longer history, not the statements. FMP
// without quarterly rows borrows Yahoo's, which the trailing twelve months
// are computed from.
async function fetchStatements(symbol, { fmpApiKey = '', fmp = fetchFmpStatements, yahoo = fetchYahooStatements, logger = console } = {}) {
  if (!fmpApiKey) return yahoo(symbol);
  let fromFmp = null;
  try {
    fromFmp = await fmp(symbol, fmpApiKey);
  } catch (err) {
    logger.warn && logger.warn(`[valuation] ${symbol} fmp statements failed, using yahoo: ${err && err.message}`);
  }
  if (!fromFmp || !fromFmp.annual.length) return yahoo(symbol);
  if (fromFmp.quarterly.length) return fromFmp;
  try {
    const fromYahoo = await yahoo(symbol);
    return { ...fromFmp, quarterly: fromYahoo.quarterly };
  } catch {
    return fromFmp;
  }
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

// A plain request first; then through the crumb session, for a server
// whose plain requests Yahoo is refusing - without peers the whole sector
// column of the multiples table is empty.
async function fetchPeerSymbols(symbol, { get = axios.get, sessionGet = crumbGet } = {}) {
  const url = `https://query2.finance.yahoo.com/v6/finance/recommendationsbysymbol/${encodeURIComponent(symbol)}`;
  let res;
  try {
    res = await get(url, { timeout: 15000, headers: YAHOO_HEADERS });
  } catch {
    res = await sessionGet(url, { params: {}, timeout: 15000, headers: YAHOO_HEADERS });
  }
  return parsePeers(res.data);
}

// A peer's trailing-twelve-month free cash flow from its STATEMENTS
// (operating cash flow + capex), the same basis the subject company's own
// P/FCF is computed on. One timeseries request; null when Yahoo has none.
async function fetchTrailingFreeCashFlow(symbol, { get = crumbGet, plainGet = axios.get } = {}) {
  const period2 = Math.floor(Date.now() / 1000);
  const period1 = period2 - 2 * 365 * 86400;
  const path = `/ws/fundamentals-timeseries/v1/finance/timeseries/${encodeURIComponent(symbol)}`;
  const params = { type: 'trailingFreeCashFlow', period1, period2, merge: false, padTimeSeries: true, lang: 'en-US' };
  const config = { params, timeout: 15000, headers: YAHOO_HEADERS };
  // Without the crumb as a second try - see fetchYahooStatements.
  const res = await get(`https://query2.finance.yahoo.com${path}`, config).catch(() => plainGet(`https://query2.finance.yahoo.com${path}`, config));
  const rows = parseYahooTimeseries(res.data, 'trailing').filter((r) => Number.isFinite(r.freeCashFlow));
  return rows.length ? rows[rows.length - 1].freeCashFlow : null;
}

// A peer's current multiples from its quote summary, and P/FCF from its
// statement-basis TTM free cash flow (fetchTrailingFreeCashFlow).
//
// P/FCF used to divide by quoteSummary's financialData.freeCashflow, which
// is Yahoo's LEVERED free cash flow - a different, much smaller figure for
// most large companies. Against Apple's statement-basis 36x that put the
// "sector median" at 240x (Microsoft 240x, Amazon 879x) and reported Apple
// as 85% cheaper than its peers. Without a statement figure the peer is
// left out of the P/FCF median rather than measured on the wrong basis; a
// negative FCF leaves the multiple undefined, as everywhere else.
//
// A peer that reports in one currency and trades in another (an ADR such
// as TSM: statements in TWD, price in USD) has its P/S and P/FCF dividing
// a USD market cap by TWD figures - TSM read 0.43x sales and 1.9x free cash
// flow, dragging the sector median down. Those two are left out for such a
// peer; P/E is Yahoo's own and already on one currency.
//
// A summary from Finnhub or FMP (marketDataFallbacks.js) carries its own
// price-to-free-cash-flow, computed by them on the same statement basis
// (operating cash flow less capital spending). It stands in when there is
// no statement figure to divide by - which is the case whenever that
// summary came from them, since the peer's Yahoo statements are then not
// fetched at all.
function peerMultiples(summary, trailingFreeCashFlow = null) {
  const cap = summary.marketCap;
  const mixedCurrency = !!(summary.financialCurrency && summary.currency && summary.financialCurrency !== summary.currency);
  const ownPfcf = Number.isFinite(summary.priceToFreeCashFlow) && summary.priceToFreeCashFlow > 0 ? summary.priceToFreeCashFlow : null;
  return {
    PE: summary.trailingPE,
    PS: mixedCurrency ? null : summary.priceToSales,
    PFCF: mixedCurrency ? null : Number.isFinite(cap) && trailingFreeCashFlow > 0 ? cap / trailingFreeCashFlow : ownPfcf
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
  fetchStatements,
  parseValuationSummary,
  fetchValuationSummary,
  parseMonthlyChart,
  fetchMonthlyPrices,
  parsePeers,
  fetchPeerSymbols,
  peerMultiples,
  fetchTrailingFreeCashFlow,
  fetchRiskFreeRate
};
