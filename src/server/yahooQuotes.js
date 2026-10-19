// US market data: stock quotes (Finnhub first when configured, then Yahoo -
// see fetchUsQuote), exchange rates, price and dividend history, and the
// crumb-authenticated Yahoo endpoints (sectors, analysts, dividends).
const axios = require('axios');
const { getYahooCrumbAndCookie, invalidateYahooCrumb } = require('./yahooCrumb');
const { tradeDateFromYahooMeta, lastSessionDate } = require('./marketCalendar');
const { sourceHealth } = require('./sourceHealth');
const { marketMemory } = require('./marketMemory');
const { fetchFinnhubQuote, isFinnhubEnabled, isFinnhubSymbol } = require('./finnhubQuotes');
const { runFallbackChain } = require('./fallbackChain');
const {
  isFrankfurterSymbol,
  fetchFrankfurterQuote,
  fetchFrankfurterRateForDate,
  fetchFrankfurterHistory
} = require('./frankfurterClient');

// 30s: the client polls every minute, and with Finnhub on, each symbol
// refreshed costs a call from its 60-a-minute free budget.
const YAHOO_CACHE_TTL_MS = 30 * 1000;
const yahooChartCache = new Map();
const yahooInFlight = new Map();
// The last good quote per symbol, with no expiry - what a failed refresh
// serves instead of nothing (see getYahooPayload). The database copy in
// marketMemory covers the time after a restart, when this map is empty.
const yahooLastGood = new Map();

const YAHOO_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'application/json'
};

function readCachedYahoo(symbol) {
  const cached = yahooChartCache.get(symbol);
  if (!cached) return null;
  if (Date.now() - cached.ts > YAHOO_CACHE_TTL_MS) return null;
  return cached.data;
}

function writeCachedYahoo(symbol, data) {
  yahooChartCache.set(symbol, { data, ts: Date.now() });
}

async function fetchYahooChartMeta(symbol) {
  const encoded = encodeURIComponent(symbol);
  const yahooUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${encoded}`;
  const response = await axios.get(yahooUrl, {
    timeout: 12000,
    headers: YAHOO_HEADERS
  });

  const result = response?.data?.chart?.result;
  if (!Array.isArray(result) || result.length === 0 || !result[0]?.meta) {
    throw new Error('missing yahoo chart data');
  }

  return result[0].meta;
}

// The quote as Yahoo's chart endpoint reports it. Throws on any failure.
async function fetchYahooQuote(symbol) {
  const meta = await fetchYahooChartMeta(symbol);
  const currentPrice = Number(meta.regularMarketPrice);
  // Deliberately NOT reading meta.regularMarketChangePercent /
  // changePercent / regularMarketChange / change here. Real Yahoo v8
  // chart responses (verified against current sample data, not just
  // assumed) very often omit these fields entirely - they properly
  // belong to the older v7/finance/quote endpoint - and when one *is*
  // present its meaning is ambiguous: regularMarketChange/change are
  // absolute currency amounts (e.g. $2.34), not percentages, while
  // *ChangePercent fields' scale (fraction like 0.0142 vs already a
  // percent like 1.42) isn't consistent either. The previous code
  // multiplied whichever field it found by 100 regardless, which - if
  // it ever hit an absolute change field, or a field already in percent
  // form - produced numbers with no real relationship to the actual
  // daily % change (this matched a real production report of "wrong"
  // change percentages).
  //
  // previousClose and regularMarketPrice are both unambiguous absolute
  // prices in the same currency, so computing the % change directly
  // from them has no unit-mismatch risk.
  const previousClose = Number(meta.previousClose ?? meta.chartPreviousClose);

  let finalChangePercent = 0;
  if (Number.isFinite(currentPrice) && Number.isFinite(previousClose) && previousClose !== 0) {
    finalChangePercent = ((currentPrice - previousClose) / previousClose) * 100;
  }

  return {
    currentPrice: Number.isFinite(currentPrice) ? currentPrice : null,
    changePercent: Number.isFinite(finalChangePercent) ? finalChangePercent : 0,
    // The session regularMarketPrice belongs to. Before the US open it is
    // still yesterday's - see marketCalendar.js for why that matters.
    tradeDate: tradeDateFromYahooMeta(meta) || lastSessionDate('us')
  };
}

// Finnhub first when it is configured and the symbol is a stock it can
// price (finnhubQuotes.js), Yahoo otherwise - and Yahoo whenever Finnhub
// fails, has no quote for the symbol, or its per-minute budget is spent.
// `source` names which one answered, for the logs and for diagnosing a
// price that looks wrong.
async function fetchUsQuote(symbol) {
  // Exchange rates: Yahoo, then the ECB's daily reference rate through
  // Frankfurter (frankfurterClient.js) - free, no key.
  if (isFrankfurterSymbol(symbol)) {
    const { value, source } = await runFallbackChain(`fx ${symbol}`, [
      { source: 'yahoo-chart', fn: () => fetchYahooQuote(symbol) },
      { source: 'frankfurter', fn: () => fetchFrankfurterQuote(symbol) }
    ]);
    return { ...value, source: source === 'yahoo-chart' ? 'yahoo' : source };
  }
  // Stocks: Finnhub when configured, then Yahoo. Running out of Finnhub's
  // free per-minute budget is the plan working, not Finnhub failing, so it
  // is not counted against it (see fallbackChain.js).
  const { value, source } = await runFallbackChain(`quote ${symbol}`, [
    {
      source: 'finnhub',
      enabled: isFinnhubEnabled() && isFinnhubSymbol(symbol),
      fn: async () => {
        const quote = await fetchFinnhubQuote(symbol);
        return { ...quote, tradeDate: quote.tradeDate || lastSessionDate('us') };
      }
    },
    { source: 'yahoo-chart', fn: () => fetchYahooQuote(symbol) }
  ]);
  return { ...value, source: source === 'yahoo-chart' ? 'yahoo' : source };
}

// A US stock or FX quote, cached briefly and deduplicated per symbol, with
// the last good quote served (marked stale) when every source fails.
// The name is historical: Finnhub answers first when it is configured.
async function getYahooPayload(symbol) {
  const cached = readCachedYahoo(symbol);
  if (cached) return cached;

  const inFlight = yahooInFlight.get(symbol);
  if (inFlight) return inFlight;

  const requestPromise = (async () => {
    const quote = await fetchUsQuote(symbol);
    const payload = {
      ...quote,
      // When this price was fetched, so the client can say how old a price
      // served from the fallback below is.
      fetchedAt: new Date().toISOString()
    };
    writeCachedYahoo(symbol, payload);
    if (payload.currentPrice !== null) {
      yahooLastGood.set(symbol, payload);
      marketMemory.set(`quote:us:${symbol}`, payload);
    }
    return payload;
  })();

  yahooInFlight.set(symbol, requestPromise);
  try {
    return await requestPromise;
  } catch (err) {
    // These failures used to be swallowed by the routes without a trace,
    // which left no way to tell from the logs whether US prices were down.
    console.warn('[yahoo] quote failed', {
      symbol,
      status: err && err.response && err.response.status,
      error: err && err.message
    });
    // The last good price, marked stale, beats no price: the client shows
    // its age instead of silently keeping an unlabelled old number.
    const lastGood = yahooLastGood.get(symbol) || ((await marketMemory.get(`quote:us:${symbol}`)) || {}).value;
    if (lastGood) {
      yahooLastGood.set(symbol, lastGood);
      return { ...lastGood, stale: true };
    }
    throw err;
  } finally {
    yahooInFlight.delete(symbol);
  }
}

// Shared fetch+parse for the v8/finance/chart daily-bars endpoint, given
// explicit unix-second bounds. fetchYahooHistoricalCloses and
// fetchYahooHistoricalRateForDate below just pick different bounds.
async function fetchYahooDailyCloses(symbol, period1, period2) {
  const encoded = encodeURIComponent(symbol);
  const yahooUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${encoded}`;
  const response = await axios.get(yahooUrl, {
    params: { period1, period2, interval: '1d' },
    timeout: 15000,
    headers: YAHOO_HEADERS
  });

  const result = response?.data?.chart?.result;
  if (!Array.isArray(result) || result.length === 0) {
    throw new Error('missing yahoo chart data');
  }

  const { timestamp, indicators } = result[0];
  const closes = indicators?.quote?.[0]?.close;
  if (!Array.isArray(timestamp) || !Array.isArray(closes)) {
    throw new Error('missing yahoo timestamp/close series');
  }

  const points = [];
  for (let i = 0; i < timestamp.length; i++) {
    const close = closes[i];
    if (close === null || close === undefined || !Number.isFinite(Number(close))) continue;
    // Yahoo timestamps are UTC seconds; the UTC calendar date is close
    // enough for daily bars (a trading session doesn't cross midnight UTC
    // in any timezone we care about here).
    const date = new Date(timestamp[i] * 1000).toISOString().slice(0, 10);
    points.push({ date, close: Number(close) });
  }
  return points;
}

// Daily closing prices for a symbol between fromDateStr (YYYY-MM-DD, or ~13
// months back if omitted) and today. Used for benchmark comparison
// (^GSPC / ^TA125.TA) — a different endpoint shape than getYahooPayload
// above (full timestamp+close arrays instead of just the latest meta), so
// it's a separate function rather than reusing fetchYahooChartMeta.
async function fetchYahooHistoricalCloses(symbol, fromDateStr) {
  const period1 = fromDateStr
    ? Math.floor(new Date(`${fromDateStr}T00:00:00Z`).getTime() / 1000)
    : Math.floor(Date.now() / 1000) - 400 * 24 * 60 * 60;
  const period2 = Math.floor(Date.now() / 1000);
  if (!isFrankfurterSymbol(symbol)) return fetchYahooDailyCloses(symbol, period1, period2);
  // An exchange-rate history (the shekel value of US holdings over time)
  // falls back to the ECB's daily rates.
  const { value } = await runFallbackChain(
    `fx history ${symbol}`,
    [
      { source: 'yahoo-chart', fn: () => fetchYahooDailyCloses(symbol, period1, period2) },
      { source: 'frankfurter', fn: () => fetchFrankfurterHistory(symbol, fromDateStr) }
    ],
    { accept: (points) => Array.isArray(points) && points.length > 0 }
  );
  return value;
}

// The historical rate for a symbol on one specific date (e.g. "USDILS=X"
// on the day a US stock was bought) - used to auto-fill the exchange-rate
// field on the "add stock" form instead of requiring the user to look it
// up and type it in. Fetches just a narrow window around the requested
// date (not fromDateStr-to-today like fetchYahooHistoricalCloses above,
// which would pull years of unneeded daily bars for an old purchase
// date), then picks the latest trading day at or before it - FX has no
// bar on weekends/holidays, so "the rate that day" means "the last known
// rate as of that day". Returns null (never a guessed/fabricated rate)
// when nothing on or before the date falls within the window.
async function fetchYahooHistoricalRateForDate(symbol, dateStr) {
  const target = new Date(`${dateStr}T00:00:00Z`);
  if (Number.isNaN(target.getTime())) return null;
  if (!isFrankfurterSymbol(symbol)) return fetchYahooRateForDate(symbol, dateStr, target);
  // The purchase-day rate falls back to the ECB's rate for that day (or the
  // last working day before it).
  try {
    const { value } = await runFallbackChain(
      `fx rate ${symbol} ${dateStr}`,
      [
        { source: 'yahoo-chart', fn: () => fetchYahooRateForDate(symbol, dateStr, target) },
        { source: 'frankfurter', fn: () => fetchFrankfurterRateForDate(symbol, dateStr) }
      ],
      { accept: (v) => v !== null }
    );
    return value;
  } catch (err) {
    // Both answered and neither had a rate on or before the date: that is
    // "no rate", as it always was, not an error.
    if (err.failures && err.failures.every((f) => f.endsWith('no usable data'))) return null;
    throw err;
  }
}

async function fetchYahooRateForDate(symbol, dateStr, target) {
  const period1 = Math.floor(target.getTime() / 1000) - 7 * 24 * 60 * 60;
  const period2 = Math.floor(target.getTime() / 1000) + 24 * 60 * 60;

  const points = await fetchYahooDailyCloses(symbol, period1, period2);
  const onOrBefore = points.filter((p) => p.date <= dateStr);
  if (onOrBefore.length === 0) return null;
  const closest = onOrBefore[onOrBefore.length - 1]; // points is sorted ascending by date
  return { date: closest.date, rate: closest.close };
}

// Ticker/company autocomplete suggestions, via Yahoo's public search
// endpoint (same "no crumb/cookie needed" family as
// fetchYahooHistoricalCloses above — confirmed with a real request during
// development: works with just a User-Agent header, unlike the
// quoteSummary-based functions below).
async function fetchYahooSymbolSearch(query, count = 8) {
  const response = await axios.get('https://query1.finance.yahoo.com/v1/finance/search', {
    params: { q: query, newsCount: 0, quotesCount: count },
    timeout: 15000,
    headers: YAHOO_HEADERS
  });

  const quotes = response?.data?.quotes;
  if (!Array.isArray(quotes)) return [];

  return quotes
    .filter((q) => q.quoteType === 'EQUITY' && q.symbol)
    .map((q) => ({
      symbol: q.symbol,
      name: q.longname || q.shortname || q.symbol,
      exchange: q.exchDisp || q.exchange || null
    }));
}

// Sector/industry classification for a US stock (module=assetProfile),
// used for the "diversification by sector" breakdown - a very different
// question from "how much is it worth" (exchangeDistribution): someone can
// hold 10 different US tickers and still be 90% concentrated in one
// sector, which the exchange-only breakdown can't show.
//
// quoteSummary (unlike the plain chart endpoint above) requires a
// crumb+cookie session - see yahooCrumb.js. If a cached crumb has gone
// stale (401), this retries once with a freshly-fetched one, the same
// "retry once on a transient/stale-auth failure" pattern already used for
// the TASE scraper in quotesRoutes.js.
//
// It's also rate-limited: sectorRoutes.js and analystRoutes.js each
// resolve every unique US ticker in the portfolio via Promise.all, so a
// portfolio with ~10 holdings can fire ~20 near-simultaneous requests at
// this same endpoint (sectors + analyst data, per symbol). Yahoo responds
// to bursts like that with 429s. QUOTE_SUMMARY_MIN_SPACING_MS serializes
// every quoteSummary call (across both features - this queue is
// module-level, not per-caller) through one queue with a minimum gap
// between requests, and a 429 gets one backoff-and-retry, the same as a
// stale crumb does.
const QUOTE_SUMMARY_MIN_SPACING_MS = 350;
// A 429 gets more than one chance. Yahoo rate-limits a burst rather than
// blocking a client, so the limit typically clears within a few seconds -
// but a single fixed retry lands inside the same burst often enough that
// a whole portfolio of symbols would give up together and cache nulls.
// Escalating waits with jitter spread the retries out instead of
// re-synchronising every symbol onto the same instant. Two retries, not
// more: past a few seconds the caller is better served by the last known
// value (see symbolCache.js) than by waiting longer for a fresh one.
const QUOTE_SUMMARY_429_BACKOFF_MS = [1200, 3000];
let quoteSummaryQueueTail = Promise.resolve();

// A shared cooldown for every crumb-authenticated call.
//
// The retries above are for a burst limit, which clears in seconds. When
// a request has used up all of them and is still refused, it is not a
// burst any more: Yahoo is refusing this server's address. Production logs
// showed exactly that - every symbol, across sectors, analysts, dividends
// and valuation, failing with 429 one after another - and each of those
// symbols went on to make its own three attempts, plus a fresh crumb
// request each time, which is more traffic at the moment Yahoo is asking
// for less and keeps the block in place for longer.
//
// So once one request has exhausted its retries on a 429, every
// crumb-authenticated call fails at once, without a request, until the
// cooldown ends. Callers already handle a failure by serving the last
// known value (symbolCache.js), so the user sees no difference beyond
// figures that are a little older. A cooldown that is tripped again soon
// after it ends lasts longer (COOLDOWN_STEPS_MS); a success resets it.
const COOLDOWN_STEPS_MS = [5 * 60 * 1000, 15 * 60 * 1000, 30 * 60 * 1000];
let cooldownUntil = 0;
let cooldownLevel = 0;

function cooldownError() {
  const err = new Error(`yahoo rate limit cooldown until ${new Date(cooldownUntil).toISOString()}`);
  err.code = 'YAHOO_COOLDOWN';
  return err;
}

function inCooldown() {
  return Date.now() < cooldownUntil;
}

function openCooldown() {
  if (inCooldown()) return;
  const ms = COOLDOWN_STEPS_MS[Math.min(cooldownLevel, COOLDOWN_STEPS_MS.length - 1)];
  cooldownLevel += 1;
  cooldownUntil = Date.now() + ms;
  console.warn('[yahoo] rate limited after all retries - pausing crumb-authenticated requests', {
    minutes: ms / 60000,
    until: new Date(cooldownUntil).toISOString()
  });
}

// For the admin panel (adminRoutes.js) and tests.
function yahooCooldownState() {
  return { cooldownUntil: inCooldown() ? new Date(cooldownUntil).toISOString() : null };
}

function resetYahooCooldown() {
  cooldownUntil = 0;
  cooldownLevel = 0;
}

function scheduleOnQuoteSummaryQueue(task) {
  // .finally() (not .then()) so the spacing delay applies whether the
  // request succeeded OR failed - a burst of failures (e.g. repeated
  // 429s) still needs pacing between attempts just as much as a burst of
  // successes does. .finally() also preserves the original
  // resolution/rejection for the caller, it doesn't swallow it.
  const run = quoteSummaryQueueTail.then(() =>
    task().finally(() => new Promise((resolve) => setTimeout(resolve, QUOTE_SUMMARY_MIN_SPACING_MS)))
  );
  // The queue's tail always resolves (never rejects), even if `task`
  // itself throws - otherwise one failed request would permanently jam
  // every request queued behind it.
  quoteSummaryQueueTail = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

// Shared by every crumb-authenticated Yahoo endpoint (quoteSummary below,
// verified against real responses): retries
// once with a freshly-fetched crumb on a stale-auth failure (401/403),
// retries once more after a short backoff on a burst-rate-limit failure
// (429), and always goes through the shared queue so concurrent callers
// don't fire requests at Yahoo back-to-back.
async function fetchYahooWithCrumbRetry(url, extraParams) {
  const doRequest = async (forceRefreshCrumb) => {
    const { crumb, cookie } = await getYahooCrumbAndCookie(forceRefreshCrumb);
    return axios.get(url, {
      // formatted=false asks Yahoo for plain numbers (e.g. targetMeanPrice:
      // 150.5) instead of its default display-ready shape
      // ({ raw: 150.5, fmt: "150.50" }) - without this, every numeric field
      // silently becomes an object and fails a plain Number.isFinite()
      // check downstream.
      params: { ...extraParams, crumb, formatted: false },
      timeout: 12000,
      headers: { ...YAHOO_HEADERS, Cookie: cookie }
    });
  };

  const attemptWithCrumbRetry = async () => {
    // Checked again here, not only on entry: a request that was queued
    // before another one tripped the cooldown must not go out after it.
    if (inCooldown()) throw cooldownError();
    try {
      return await doRequest(false);
    } catch (err) {
      const status = err.response && err.response.status;
      if (status === 401 || status === 403) {
        invalidateYahooCrumb();
        return await doRequest(true);
      }
      throw err;
    }
  };

  // Each retry goes back through the queue rather than jumping it, so a
  // symbol that is being retried still keeps its spacing from whatever
  // else is in flight.
  if (inCooldown()) throw cooldownError();

  let lastError;
  for (let attempt = 0; attempt <= QUOTE_SUMMARY_429_BACKOFF_MS.length; attempt += 1) {
    try {
      const response = await scheduleOnQuoteSummaryQueue(attemptWithCrumbRetry);
      cooldownLevel = 0;
      sourceHealth.success('yahoo-summary');
      return response;
    } catch (err) {
      lastError = err;
      // A cooldown refusal made no request, so it says nothing new about
      // Yahoo's health and is not counted as a failure.
      if (err.code === 'YAHOO_COOLDOWN') throw err;
      const status = err.response && err.response.status;
      const waitMs = QUOTE_SUMMARY_429_BACKOFF_MS[attempt];
      if (status !== 429 || waitMs === undefined) {
        if (status === 429) openCooldown();
        sourceHealth.failure('yahoo-summary', err);
        throw err;
      }
      // Up to 40% jitter. Without it every symbol in a rate-limited
      // batch waits the identical interval and hits Yahoo together
      // again, which is the burst that caused the 429 in the first place.
      const jittered = waitMs * (1 + Math.random() * 0.4);
      await new Promise((resolve) => setTimeout(resolve, jittered));
    }
  }
  throw lastError;
}

async function fetchYahooQuoteSummary(symbol, modules) {
  const encoded = encodeURIComponent(symbol);
  const yahooUrl = `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encoded}`;
  const response = await fetchYahooWithCrumbRetry(yahooUrl, { modules });

  const result = response?.data?.quoteSummary?.result;
  if (!Array.isArray(result) || result.length === 0) {
    throw new Error('missing yahoo quoteSummary data');
  }
  return result[0];
}



// Defensive fallback for the { raw, fmt, longFmt } shape above, in case a
// given field ignores formatted=false (this has happened with Yahoo's
// unofficial API before, inconsistently, per-field) - unwraps either shape
// instead of silently discarding the value.
function unwrapYahooNumber(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'object' && Number.isFinite(value.raw)) return value.raw;
  return null;
}

function parseAssetProfile(quoteSummary) {
  const profile = quoteSummary?.assetProfile || {};
  return {
    sector: profile.sector || null,
    industry: profile.industry || null
  };
}

async function fetchYahooAssetProfile(symbol) {
  const quoteSummary = await fetchYahooQuoteSummary(symbol, 'assetProfile');
  if (!quoteSummary?.assetProfile) {
    throw new Error('missing yahoo assetProfile data');
  }
  return parseAssetProfile(quoteSummary);
}

// Analyst coverage for a US stock: consensus rating, price targets, and
// recent upgrade/downgrade history. Same quoteSummary endpoint/auth as
// fetchYahooAssetProfile above, different modules.
async function fetchYahooAnalystData(symbol) {
  const quoteSummary = await fetchYahooQuoteSummary(
    symbol,
    'financialData,recommendationTrend,upgradeDowngradeHistory'
  );
  return parseAnalystData(quoteSummary);
}

function parseAnalystData(quoteSummary) {
  const financialData = quoteSummary?.financialData || {};
  const recommendationTrend = quoteSummary?.recommendationTrend?.trend || [];
  const upgradeHistoryRaw = quoteSummary?.upgradeDowngradeHistory?.history || [];

  const upgradeHistory = upgradeHistoryRaw
    .map((entry) => ({
      firm: entry.firm || null,
      toGrade: entry.toGrade || null,
      fromGrade: entry.fromGrade || null,
      action: entry.action || null,
      epochGradeDate: unwrapYahooNumber(entry.epochGradeDate)
    }))
    .filter((entry) => entry.epochGradeDate !== null)
    .sort((a, b) => b.epochGradeDate - a.epochGradeDate)
    .slice(0, 8);

  const rawCurrentTrend = recommendationTrend.find((t) => t.period === '0m') || recommendationTrend[0] || null;
  const currentTrend = rawCurrentTrend
    ? {
        period: rawCurrentTrend.period || null,
        strongBuy: unwrapYahooNumber(rawCurrentTrend.strongBuy),
        buy: unwrapYahooNumber(rawCurrentTrend.buy),
        hold: unwrapYahooNumber(rawCurrentTrend.hold),
        sell: unwrapYahooNumber(rawCurrentTrend.sell),
        strongSell: unwrapYahooNumber(rawCurrentTrend.strongSell)
      }
    : null;

  return {
    recommendationKey: financialData.recommendationKey || null,
    numberOfAnalystOpinions: unwrapYahooNumber(financialData.numberOfAnalystOpinions),
    targetMeanPrice: unwrapYahooNumber(financialData.targetMeanPrice),
    targetHighPrice: unwrapYahooNumber(financialData.targetHighPrice),
    targetLowPrice: unwrapYahooNumber(financialData.targetLowPrice),
    // Each entry in Yahoo's recommendationTrend.trend already IS a
    // {period, strongBuy, buy, hold, sell, strongSell} bucket for a given
    // month (0m = current). We only need the current month for a "right
    // now" consensus breakdown.
    currentTrend,
    upgradeHistory
  };
}

// Forward-looking dividend metrics for a US stock: yield, payout ratio and
// the next ex-dividend/payment dates. Same quoteSummary endpoint/auth as
// fetchYahooAssetProfile above, different modules.
//
// calendarEvents is requested alongside summaryDetail because the two
// dividend DATES live there rather than in summaryDetail. Its earnings
// sub-object is deliberately not read: the next-earnings date and the
// consensus EPS/revenue estimates used to ride along here for the
// "לוח רבעונים" board, and that board has been removed.
//
// dividendYield comes back from Yahoo as a fraction (0.0236, not 2.36) -
// converted to a percent here so the UI doesn't have to remember which of
// Yahoo's several "yield" fields is a fraction vs. already a percent (they
// aren't consistent - fiveYearAvgDividendYield, deliberately not used here,
// already comes back as a percent number).
async function fetchYahooDividendSummary(symbol) {
  const quoteSummary = await fetchYahooQuoteSummary(symbol, 'summaryDetail,calendarEvents');
  return parseDividendSummary(quoteSummary);
}

function parseDividendSummary(quoteSummary) {
  const summaryDetail = quoteSummary?.summaryDetail || {};
  const calendarEvents = quoteSummary?.calendarEvents || {};
  const yieldFraction = unwrapYahooNumber(summaryDetail.dividendYield);

  return {
    dividendRate: unwrapYahooNumber(summaryDetail.dividendRate),
    dividendYieldPercent: yieldFraction === null ? null : yieldFraction * 100,
    payoutRatio: unwrapYahooNumber(summaryDetail.payoutRatio),
    exDividendDateEpoch:
      unwrapYahooNumber(summaryDetail.exDividendDate) ?? unwrapYahooNumber(calendarEvents.exDividendDate),
    nextDividendDateEpoch: unwrapYahooNumber(calendarEvents.dividendDate)
  };
}

// Sectors, analyst coverage and the dividend summary for one symbol, in a
// single quoteSummary request.
//
// The three used to be three requests per symbol (one per feature, each
// with its own cache), so a portfolio of 11 US stocks cost 33 crumb-
// authenticated calls on one page load - and all 33 were refused together
// when Yahoo rate-limited the server. The endpoint takes a list of
// modules, and the three features' modules fit in one call: a third of
// the traffic, and one cached answer that all three routes read
// (symbolProfile.js).
//
// A module Yahoo has nothing for is simply absent from the answer (an ETF
// has no assetProfile sector), so each part parses to nulls rather than
// failing the other two.
const SYMBOL_PROFILE_MODULES =
  'assetProfile,financialData,recommendationTrend,upgradeDowngradeHistory,summaryDetail,calendarEvents';

async function fetchYahooSymbolProfile(symbol) {
  const quoteSummary = await fetchYahooQuoteSummary(symbol, SYMBOL_PROFILE_MODULES);
  return {
    sector: parseAssetProfile(quoteSummary),
    analyst: parseAnalystData(quoteSummary),
    dividendSummary: parseDividendSummary(quoteSummary)
  };
}

// Actual historical dividend payments (date + $/share) for a US stock, via
// the same public chart endpoint as fetchYahooHistoricalCloses (events=div)
// — no crumb/cookie needed, unlike fetchYahooDividendSummary above. Used to
// compute "total dividends received" against a holding's actual purchase
// history, not just a forward-looking yield estimate.
async function fetchYahooDividendHistory(symbol, fromDateStr) {
  const encoded = encodeURIComponent(symbol);
  const period1 = fromDateStr
    ? Math.floor(new Date(`${fromDateStr}T00:00:00Z`).getTime() / 1000)
    : Math.floor(Date.now() / 1000) - 5 * 365 * 24 * 60 * 60; // 5y default: dividends pay quarterly, so a
  // short lookback (like fetchYahooHistoricalCloses's ~400 days) would miss
  // most of a long-held position's payment history.
  const period2 = Math.floor(Date.now() / 1000);

  const yahooUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${encoded}`;
  const response = await axios.get(yahooUrl, {
    params: { period1, period2, interval: '1d', events: 'div' },
    timeout: 15000,
    headers: YAHOO_HEADERS
  });

  const dividends = response?.data?.chart?.result?.[0]?.events?.dividends;
  if (!dividends || typeof dividends !== 'object') return [];

  return Object.values(dividends)
    .map((d) => ({
      date: new Date(d.date * 1000).toISOString().slice(0, 10),
      amountPerShare: Number(d.amount)
    }))
    .filter((d) => Number.isFinite(d.amountPerShare))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}


// Daily OHLCV bars for the anomaly engine: ~3 months, split-adjusted closes
// (adjclose when Yahoo provides it, so a split is not read as a crash) and
// raw volume. [{ date, close, volume }] ascending.
async function fetchYahooDailyBars(symbol, range = '3mo') {
  const encoded = encodeURIComponent(symbol);
  const response = await axios.get(`https://query1.finance.yahoo.com/v8/finance/chart/${encoded}`, {
    params: { range, interval: '1d' },
    timeout: 15000,
    headers: YAHOO_HEADERS
  });
  const result = response?.data?.chart?.result?.[0];
  const timestamps = result?.timestamp;
  const quote = result?.indicators?.quote?.[0] || {};
  const adj = result?.indicators?.adjclose?.[0]?.adjclose;
  if (!Array.isArray(timestamps) || !Array.isArray(quote.close)) throw new Error('missing yahoo chart bars');
  const bars = [];
  for (let i = 0; i < timestamps.length; i += 1) {
    const close = Array.isArray(adj) && Number.isFinite(adj[i]) ? adj[i] : quote.close[i];
    if (!Number.isFinite(close)) continue;
    bars.push({
      date: new Date(timestamps[i] * 1000).toISOString().slice(0, 10),
      close,
      volume: Number.isFinite(quote.volume?.[i]) ? quote.volume[i] : 0
    });
  }
  return bars;
}

// Announced earnings / dividend dates (calendarEvents) plus summaryDetail
// (dividend rate, ex-date fallback) for the event calendar.
async function fetchYahooCalendar(symbol) {
  const result = await fetchYahooQuoteSummary(symbol, 'calendarEvents,summaryDetail');
  return { calendarEvents: result?.calendarEvents || {}, summaryDetail: result?.summaryDetail || {} };
}

module.exports = {
  getYahooPayload,
  fetchYahooDailyBars,
  fetchYahooCalendar,
  fetchYahooHistoricalCloses,
  fetchYahooHistoricalRateForDate,
  fetchYahooSymbolSearch,
  fetchYahooAssetProfile,
  fetchYahooAnalystData,
  fetchYahooDividendSummary,
  fetchYahooSymbolProfile,
  fetchYahooDividendHistory,
  fetchYahooQuoteSummary,
  fetchYahooWithCrumbRetry,
  yahooCooldownState,
  resetYahooCooldown,
  unwrapYahooNumber
};
