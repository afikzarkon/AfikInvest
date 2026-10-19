// Stock/FX quote routes: Israeli stock prices (TASE scrape), American stock
// prices, and the USD/ILS exchange rate (both via Yahoo Finance).
// Extracted from server.js — behavior is unchanged, only the location moved.
const {
  readCachedTaseQuote,
  readStaleTaseQuote,
  writeCachedTaseQuote,
  isUsableTasePayload,
  scrapeTaseQuote
} = require('./taseScraper');
const { fetchTaseQuoteFromApi } = require('./taseQuoteApi');
const { fetchTaseQuoteFromEod } = require('./taseHistoryApi');
const { getYahooPayload, fetchYahooHistoricalRateForDate } = require('./yahooQuotes');
const { searchIsraeliSecuritiesByName } = require('./bizportalSearch');
const { lastSessionDate } = require('./marketCalendar');
const { fetchTaseSecurityMeta, isSecurityIdQuery } = require('./taseSecurityLookup');
const { sourceHealth } = require('./sourceHealth');
const { marketMemory } = require('./marketMemory');

// The database key for a security's last good quote (marketMemory.js).
const taseMemoryKey = (stockId) => `quote:tase:${stockId}`;

const taseInFlight = new Map();

// How many symbols one batched quote request may ask for. Matches the cap
// the other batch routes already use (sectorRoutes.js,
// historicalPricesRoutes.js) - comfortably above a realistic portfolio,
// low enough to bound the fan-out one request can trigger.
const MAX_SYMBOLS_PER_BATCH = 60;

// Resolved security metadata (name/type/branch) changes essentially never -
// a security's classification is not a price. Cached for a day so the
// "resolve this id" call the add-stock form makes is free after the first.
const SECURITY_META_TTL_MS = 24 * 60 * 60 * 1000;
const securityMetaCache = new Map(); // securityId -> { data, ts }
const securityMetaInFlight = new Map();

function errMessage(err) {
  if (!err) return 'unknown error';
  if (typeof err === 'string') return err;
  if (err.message) return err.message;
  return String(err);
}

// Ordered fallback chain for an Israeli stock quote - each entry takes a
// security id and is tried in turn until one returns a usable payload.
// Adding another public source later means adding one more entry here, not
// touching fetchTaseQuote's control flow.
//
// Ordering is cheapest-and-most-reliable first. The two JSON APIs are
// independent of each other (different endpoints, different response
// shapes) and independent of the page scraper, so a quote is only lost if
// all three fail - unlike the previous chain, whose axios entry could never
// succeed at all (see taseScraper.js's header), leaving Puppeteer as a
// single point of failure and a null price whenever it timed out.
//
// `retryOnce` stays on the Puppeteer entry only: transient timeouts and RAM
// pressure on small hosting tiers are common there and usually resolve on a
// second attempt. A failing HTTP call to either API is not worth a blind
// retry - the chain itself is the retry, with a different source.
const TASE_SOURCES = [
  { name: 'tase-api', fn: fetchTaseQuoteFromApi, retryOnce: false },
  { name: 'tase-eod', fn: fetchTaseQuoteFromEod, retryOnce: false },
  { name: 'puppeteer', fn: scrapeTaseQuote, retryOnce: true, expensive: true }
];

// Circuit breaker for the Puppeteer source.
//
// It is by far the most expensive entry in the chain - launching/driving a
// headless browser costs seconds and hundreds of MB, and it's tried twice
// (retryOnce) before giving up. When it's broken it is usually broken for
// every symbol at once and for a sustained stretch: no Chrome binary
// installed, not enough memory on the host, or TASE serving a bot-block
// page. Paying that cost per symbol, per poll, for something that is
// currently failing every single time is the worst case the "make the app
// fast" work has to eliminate.
//
// So: after PUPPETEER_FAILURE_THRESHOLD consecutive failures the source is
// skipped entirely for PUPPETEER_COOLDOWN_MS, then allowed one probe. A
// single success resets it. The two JSON APIs ahead of it are unaffected,
// and a stale cached quote still covers the gap (see getTaseQuoteSwr).
const PUPPETEER_FAILURE_THRESHOLD = 3;
const PUPPETEER_COOLDOWN_MS = 10 * 60 * 1000;
const TASE_DISABLE_PUPPETEER = process.env.TASE_DISABLE_PUPPETEER === '1';
let puppeteerConsecutiveFailures = 0;
let puppeteerCooldownUntil = 0;

function isPuppeteerAvailable() {
  if (TASE_DISABLE_PUPPETEER) return false;
  return Date.now() >= puppeteerCooldownUntil;
}

function recordPuppeteerOutcome(succeeded) {
  if (succeeded) {
    puppeteerConsecutiveFailures = 0;
    puppeteerCooldownUntil = 0;
    return;
  }
  puppeteerConsecutiveFailures += 1;
  if (puppeteerConsecutiveFailures >= PUPPETEER_FAILURE_THRESHOLD) {
    puppeteerCooldownUntil = Date.now() + PUPPETEER_COOLDOWN_MS;
    puppeteerConsecutiveFailures = 0;
    console.warn('[tase] puppeteer source tripped its circuit breaker; skipping it for a while', {
      cooldownMs: PUPPETEER_COOLDOWN_MS
    });
  }
}

// Exposed for tests - resets the breaker between cases so one test's
// simulated failures can't leak into the next.
function resetPuppeteerBreaker() {
  puppeteerConsecutiveFailures = 0;
  puppeteerCooldownUntil = 0;
}

// Exposed for tests, for the same reason: the day-long metadata cache is
// module-level, so without this one test's resolved security would still be
// served to the next.
function resetSecurityMetaCache() {
  securityMetaCache.clear();
  securityMetaInFlight.clear();
}

async function attemptTaseSource(source, stockId) {
  const result = await source.fn(stockId);
  const payload = {
    currentPrice: result.currentPrice,
    changePercent: result.changePercent,
    // Which session the change belongs to. The page scrape reports no date,
    // so it is judged by the weekday calendar instead (see marketCalendar.js).
    tradeDate: result.tradeDate || lastSessionDate('tase'),
    // When this quote was fetched - the client shows it next to a price
    // that has not been refreshed for a while.
    fetchedAt: new Date().toISOString()
  };
  if (!isUsableTasePayload(payload)) {
    const err = new Error(`${source.name} returned unusable payload`);
    err._debugTextSnippet = result._debugTextSnippet;
    throw err;
  }
  return { payload, result };
}

async function runTaseSource(source, stockId) {
  try {
    return await attemptTaseSource(source, stockId);
  } catch (firstErr) {
    if (!source.retryOnce) throw firstErr;
    // כשל חד-פעמי/זמני (timeout גבולי, עומס רגעי) הוא נפוץ בסביבות עם
    // מעט RAM כמו ה-tier החינמי של Render - ניסיון חוזר אחד מספיק
    // כדי לתפוס הרבה מהמקרים האלה בלי לפגוע משמעותית בזמן התגובה.
    console.warn(`[tase] first ${source.name} attempt failed, retrying once`, {
      stockId,
      error: errMessage(firstErr)
    });
    return await attemptTaseSource(source, stockId);
  }
}

async function fetchTaseQuote(stockId, req) {
  const errors = {};
  for (const source of TASE_SOURCES) {
    if (source.expensive && !isPuppeteerAvailable()) {
      errors[source.name] = 'skipped (circuit breaker open)';
      continue;
    }
    try {
      const { payload, result } = await runTaseSource(source, stockId);
      // Logged on every success too (not just failures) - a quote can look
      // "usable" (both fields are finite numbers) while still being wrong,
      // e.g. if the scraper's regex matched a different field on the page
      // than intended. Every source fills in _debugPriceMatch, so this line
      // names which source won and what produced the price, and a scaling
      // bug can be diagnosed directly instead of guessed at.
      console.log(`[tase] ${source.name} succeeded`, {
        stockId,
        payload,
        priceMatch: result._debugPriceMatch
      });
      if (source.expensive) recordPuppeteerOutcome(true);
      sourceHealth.success(source.name);
      writeCachedTaseQuote(stockId, payload);
      marketMemory.set(taseMemoryKey(stockId), payload);
      return payload;
    } catch (err) {
      if (source.expensive) recordPuppeteerOutcome(false);
      sourceHealth.failure(source.name, err);
      errors[source.name] = errMessage(err);
      console.warn(`[tase] ${source.name} failed`, {
        stockId,
        error: errMessage(err),
        // מה שהמקור בפועל "ראה" - עוזר לדעת אם הבעיה היא עמוד חסימת בוט,
        // מבנה טקסט שונה מהצפוי, או שהעמוד בכלל לא נטען.
        pageTextSnippet: err._debugTextSnippet
      });
    }
  }

  console.error('[tase] all sources failed', { stockId, errors });
  // The last good quote: this process's copy, or after a restart the
  // database's (marketMemory.js).
  const saved = await marketMemory.get(taseMemoryKey(stockId));
  const stale = readStaleTaseQuote(stockId) || (saved && saved.value);
  if (stale) {
    console.warn('[tase] serving stale cached quote after failures', { stockId, fetchedAt: stale.fetchedAt });
    return { ...stale, stale: true };
  }
  if (req.query && (req.query.debug === '1' || req.query.debug === 'true')) {
    return {
      currentPrice: null,
      changePercent: null,
      _debug: { stockId, sources: TASE_SOURCES.map((s) => s.name), errors }
    };
  }
  return { currentPrice: null, changePercent: null };
}

// Kicks off (or joins) a refresh for one security id, returning the
// promise. Deduplicated via taseInFlight so N concurrent callers for the
// same id share a single upstream chain run.
function refreshTaseQuote(stockId, req) {
  const existing = taseInFlight.get(stockId);
  if (existing) return existing;

  const promise = fetchTaseQuote(stockId, req).finally(() => {
    taseInFlight.delete(stockId);
  });
  taseInFlight.set(stockId, promise);
  return promise;
}

// Stale-while-revalidate: the heart of the "the UI must render immediately"
// requirement.
//
// The old flow was strictly blocking - a cache miss (or a 60s-expired
// entry) made the HTTP response wait for the full source chain: a TASE API
// call, then an EOD API call, then, if both failed, a Puppeteer launch +
// page render + a retry of the same. With one request per holding that is
// exactly where the reported 30-60s first paint came from: every symbol's
// response was gated on the slowest source that eventually answered for it.
//
// Now a request only ever BLOCKS when there is genuinely nothing to serve -
// the very first time a given security is ever asked for. Once any value
// exists for that id, an expired entry is returned immediately and the
// refresh runs in the background, so the client renders a real (at most one
// interval old) price now and picks up the fresh one on its next poll.
// Errors in the background refresh are swallowed deliberately: the client
// already has a usable answer, and fetchTaseQuote logs the details.
async function getTaseQuoteSwr(stockId, req) {
  const fresh = readCachedTaseQuote(stockId);
  if (fresh) return fresh;

  let stale = readStaleTaseQuote(stockId);
  // Nothing in memory - the first request for this security since the
  // process started. A quote saved before the restart is served the same
  // way as an expired in-memory one: immediately, refreshed behind it.
  // Without this, the first visitor after the host wakes up waits on the
  // whole source chain, and gets nothing if the sources are down.
  if (!stale) {
    const saved = await marketMemory.get(taseMemoryKey(stockId));
    if (saved && saved.value) {
      writeCachedTaseQuote(stockId, saved.value, saved.savedAt);
      stale = saved.value;
    }
  }
  if (stale) {
    refreshTaseQuote(stockId, req).catch(() => {});
    return stale;
  }

  try {
    return await refreshTaseQuote(stockId, req);
  } catch (err) {
    console.error('[tase] quote request failed with no cached value to fall back on', {
      stockId,
      error: errMessage(err)
    });
    return { currentPrice: null, changePercent: null };
  }
}

// Cached metadata lookup for one security id (see taseSecurityLookup.js).
async function getSecurityMeta(securityId) {
  const cached = securityMetaCache.get(securityId);
  if (cached && Date.now() - cached.ts < SECURITY_META_TTL_MS) return cached.data;

  const existing = securityMetaInFlight.get(securityId);
  if (existing) return existing;

  const promise = (async () => {
    try {
      const data = await fetchTaseSecurityMeta(securityId);
      securityMetaCache.set(securityId, { data, ts: Date.now() });
      return data;
    } catch (err) {
      console.warn('[tase] security metadata lookup failed', { securityId, error: errMessage(err) });
      return null;
    } finally {
      securityMetaInFlight.delete(securityId);
    }
  })();
  securityMetaInFlight.set(securityId, promise);
  return promise;
}

// Israeli/TASE security search that answers BOTH kinds of query a user
// actually types:
//
//   a security number (e.g. 1159250) -> resolved directly against the
//   exchange's own securitydata API, which answers for every instrument
//   class including ETFs, foreign-listed tracking funds and index
//   trackers. This is the case that was simply broken: Bizportal's
//   name-autocomplete returns an empty array for a numeric query (verified
//   live against 1159250), so searching by security number could never
//   find anything, and the ETFs that aren't in Bizportal's name index at
//   all (again 1159250, "איישרס.חוץ P 500&S") were unreachable by any
//   query text whatsoever.
//
//   a name -> Bizportal's autocomplete as before, now including mutual
//   funds/index trackers (see bizportalSearch.js).
//
// A numeric query still also runs the name search, because some ids are
// legitimately typed as part of a name query and Bizportal occasionally
// matches a symbol containing digits - the direct hit is simply placed
// first. Results are deduplicated by security id.
async function searchIsraeliSecurities(query) {
  const trimmed = String(query || '').trim();
  if (!trimmed) return [];

  const byIdPromise = isSecurityIdQuery(trimmed) ? getSecurityMeta(trimmed) : Promise.resolve(null);
  const byNamePromise = sourceHealth.track('bizportal', () => searchIsraeliSecuritiesByName(trimmed)).catch((err) => {
    console.warn('[israeli-stock-search] name search failed', { query: trimmed, error: errMessage(err) });
    return [];
  });

  const [byId, byName] = await Promise.all([byIdPromise, byNamePromise]);

  const results = [];
  const seen = new Set();
  const push = (entry) => {
    if (!entry || !entry.securityId || seen.has(entry.securityId)) return;
    seen.add(entry.securityId);
    results.push(entry);
  };

  if (byId) {
    push({
      securityId: byId.securityId,
      officialName: byId.officialName,
      symbol: byId.symbol,
      kind: byId.isFund ? 'fund' : 'stock',
      isFund: byId.isFund,
      securityType: byId.securityType,
      branch: byId.branch,
      isForeignETF: byId.isForeignETF,
      underlyingAsset: byId.underlyingAsset
    });
  }
  byName.forEach(push);
  return results;
}

function mountQuotesRoutes(app) {
  app.get('/api/israeli-stock/:id', async (req, res) => {
    const stockId = req.params.id;
    if (!/^\d+$/.test(stockId)) {
      console.warn('[tase] invalid stock id', { stockId });
      return res.status(400).json({ error: 'invalid stock id' });
    }
    return res.json(await getTaseQuoteSwr(stockId, req));
  });

  // Batched form of the route above: one HTTP request for the whole
  // Israeli side of a portfolio instead of one per holding.
  //
  // Browsers cap concurrent connections to a single origin at ~6, so 20
  // holdings previously meant four serialized rounds of requests before the
  // last price could even start loading - on top of whatever each one
  // waited for upstream. Batching collapses that to a single round trip,
  // and the per-id work inside still runs concurrently and still shares the
  // same cache + in-flight dedup as the single-id route.
  app.post('/api/israeli-stocks', async (req, res) => {
    const raw = Array.isArray(req.body && req.body.ids) ? req.body.ids : [];
    const ids = [...new Set(raw.map((id) => String(id || '').trim()).filter((id) => /^\d+$/.test(id)))].slice(
      0,
      MAX_SYMBOLS_PER_BATCH
    );
    if (ids.length === 0) return res.json({ quotes: {} });

    const payloads = await Promise.all(ids.map((id) => getTaseQuoteSwr(id, req)));
    const quotes = {};
    ids.forEach((id, i) => {
      quotes[id] = payloads[i];
    });
    return res.json({ quotes });
  });

  // Identity/classification for one TASE security (see
  // taseSecurityLookup.js) - what the add-stock form calls after the user
  // picks a search result, so the holding is stored with its official name,
  // its instrument type and the exchange's own branch string, instead of a
  // bare number the UI can only ever display as a number.
  app.get('/api/israeli-security/:id', async (req, res) => {
    const securityId = req.params.id;
    if (!/^\d+$/.test(securityId)) {
      return res.status(400).json({ error: 'invalid security id' });
    }
    const meta = await getSecurityMeta(securityId);
    if (!meta) {
      return res.status(404).json({ error: 'לא נמצא נייר ערך עם מספר זה' });
    }
    return res.json(meta);
  });

  app.get('/api/american-stock/:symbol', async (req, res) => {
    const symbol = (req.params.symbol || '').trim();
    if (!symbol) {
      return res.status(400).json({ error: 'invalid symbol' });
    }
    try {
      const payload = await getYahooPayload(symbol);
      return res.json(payload);
    } catch (err) {
      return res.json({ currentPrice: null, changePercent: 0 });
    }
  });

  // Batched American quotes, for the same reason as /api/israeli-stocks
  // above. getYahooPayload already has its own cache + in-flight dedup, so
  // this only removes the per-symbol HTTP round trip from the browser.
  // Promise.allSettled, not all: one delisted/unknown ticker must not blank
  // out every other holding's price.
  app.post('/api/american-stocks', async (req, res) => {
    const raw = Array.isArray(req.body && req.body.symbols) ? req.body.symbols : [];
    const symbols = [...new Set(raw.map((sym) => String(sym || '').trim()).filter(Boolean))].slice(
      0,
      MAX_SYMBOLS_PER_BATCH
    );
    if (symbols.length === 0) return res.json({ quotes: {}, exchangeRate: null });

    // The USD/ILS rate every American holding needs to convert to ILS is
    // fetched alongside the quotes rather than as a separate request the
    // client has to make itself.
    const [rateResult, ...quoteResults] = await Promise.allSettled([
      getYahooPayload('USDILS=X'),
      ...symbols.map((sym) => getYahooPayload(sym))
    ]);

    const quotes = {};
    symbols.forEach((sym, i) => {
      const result = quoteResults[i];
      quotes[sym] =
        result.status === 'fulfilled' ? result.value : { currentPrice: null, changePercent: 0 };
    });
    const exchangeRate =
      rateResult.status === 'fulfilled' && rateResult.value ? rateResult.value.currentPrice : null;

    return res.json({ quotes, exchangeRate });
  });

  // ?currency=EUR for the euro (the main-currency setting); USD otherwise.
  app.get('/api/exchange-rate', async (req, res) => {
    const symbol = req.query.currency === 'EUR' ? 'EURILS=X' : 'USDILS=X';
    try {
      const payload = await getYahooPayload(symbol);
      return res.json({ rate: payload.currentPrice });
    } catch (err) {
      return res.json({ rate: null });
    }
  });

  // The USD/ILS rate on a specific past date (the day a US stock was
  // bought) - lets the "add stock" form auto-fill the exchange-rate field
  // instead of requiring the user to look it up and type it in.
  app.get('/api/exchange-rate/:date', async (req, res) => {
    const date = req.params.date;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ error: 'פורמט תאריך לא תקין' });
    }
    try {
      const result = await fetchYahooHistoricalRateForDate('USDILS=X', date);
      return res.json({ rate: result ? result.rate : null, date: result ? result.date : null });
    } catch (err) {
      return res.json({ rate: null, date: null });
    }
  });

  // Israeli/TASE security search by free-text company name (see
  // bizportalSearch.js) - lets the "add stock" form offer autocomplete
  // suggestions and auto-resolve the official company name instead of
  // requiring the user to already know the numeric TASE security id.
  app.get('/api/israeli-stock-search', async (req, res) => {
    const query = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    if (!query) {
      return res.json({ results: [] });
    }
    try {
      const results = await searchIsraeliSecurities(query);
      return res.json({ results });
    } catch (err) {
      console.warn('[israeli-stock-search] failed', { query, error: errMessage(err) });
      return res.json({ results: [] });
    }
  });
}

module.exports = {
  mountQuotesRoutes,
  searchIsraeliSecurities,
  resetPuppeteerBreaker,
  resetSecurityMetaCache
};
