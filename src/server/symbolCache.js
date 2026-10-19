// The per-symbol cache shared by every route that resolves one ticker at a
// time from Yahoo (sectors, analyst coverage, dividends).
//
// WHY THIS EXISTS
// ---------------
// The three routes each had their own copy of the same cache, and each copy
// had the same hole in it: when a lookup failed, the null placeholder was
// written into the cache *over whatever was already there*. Yahoo answers a
// burst of requests with a 429 often enough that this was a routine event,
// and the consequence was out of proportion to the cause - a portfolio that
// had been showing sectors and price targets all day would blank out to
//
//     { sectors: { NVDA: { sector: null, industry: null }, ... } }
//
// for the next five minutes, because one refresh had been rate-limited.
//
// The fix is to treat a failure as "no new answer" rather than as "the
// answer is nothing". A sector classification does not change day to day
// and an analyst consensus does not move minute to minute, so yesterday's
// real value is a far better response than today's null. The null
// placeholder is only ever returned when there has never been a good value
// to serve.
//
// STATES a symbol can be in:
//   fresh   - resolved within its TTL. Returned as-is, no request made.
//   stale   - resolved, but the TTL has passed. A refresh is attempted; if
//             it fails, the stale value is returned and its retry clock is
//             reset so the next caller doesn't hammer a failing upstream.
//   unknown - never resolved. A request is made; if it fails, the caller's
//             own `fallback` is returned and briefly remembered, so a
//             portfolio full of bad tickers doesn't retry on every render.

// How long a failure suppresses further attempts for a symbol with no
// known-good value. Deliberately short: most failures here are transient
// rate limits, and a symbol with nothing cached has nothing better to show
// in the meantime, so retrying soon costs little and gains the real value.
const FAILURE_RETRY_MS = 60 * 1000;

//
// PERSISTENCE (optional `memory`, see marketMemory.js): every good value
// is also written to the database, and a symbol this process has never
// seen is first looked up there. After a restart - which on the hosting
// plan this runs on happens whenever the server has been idle - the cache
// starts from the database instead of from nothing: a value saved within
// its TTL is served without asking upstream at all, and an older one is
// still there as the last known value if the refresh fails.
function createSymbolCache({ name, ttlMs, fetchOne, fallback, memory = null, memoryKey = (s) => `${name}:${s}` }) {
  const cache = new Map();
  const inFlight = new Map();

  const isFresh = (entry) => entry && entry.ok && Date.now() - entry.ts < ttlMs;

  const loadSaved = async (symbol) => {
    if (!memory || cache.has(symbol)) return;
    const saved = await memory.get(memoryKey(symbol));
    if (saved && !cache.has(symbol)) cache.set(symbol, { data: saved.value, ts: saved.savedAt, ok: true });
  };

  const resolve = async (symbol) => {
    try {
      const data = await fetchOne(symbol);
      cache.set(symbol, { data, ts: Date.now(), ok: true });
      if (memory) memory.set(memoryKey(symbol), data);
      return data;
    } catch (err) {
      const previous = cache.get(symbol);
      // THE WHOLE POINT: a failed refresh must not erase a good answer.
      if (previous && previous.ok) {
        // The value stays; only its clock moves, so the next caller waits
        // out FAILURE_RETRY_MS before trying the upstream again instead of
        // re-requesting on every single render.
        previous.ts = Date.now() - ttlMs + FAILURE_RETRY_MS;
        console.warn(`[${name}] refresh failed, serving last known value`, {
          symbol,
          error: err && err.message
        });
        return previous.data;
      }
      console.warn(`[${name}] failed to resolve symbol`, { symbol, error: err && err.message });
      cache.set(symbol, { data: fallback(symbol), ts: Date.now(), ok: false });
      return cache.get(symbol).data;
    }
  };

  const get = async (symbol) => {
    // Only awaited when there is a database to ask: without one, a symbol's
    // first request stays synchronous up to fetchOne, as it always was.
    if (memory) await loadSaved(symbol);
    const entry = cache.get(symbol);
    if (isFresh(entry)) return entry.data;
    // A failed symbol is not retried until its short retry window passes.
    if (entry && !entry.ok && Date.now() - entry.ts < FAILURE_RETRY_MS) return entry.data;

    // One in-flight request per symbol, however many callers ask at once -
    // a portfolio holding the same ticker in several lots asks once.
    const existing = inFlight.get(symbol);
    if (existing) return existing;

    const request = resolve(symbol);
    inFlight.set(symbol, request);
    try {
      return await request;
    } finally {
      inFlight.delete(symbol);
    }
  };

  return {
    get,
    // Test seams. Nothing in the app calls these.
    _clear: () => {
      cache.clear();
      inFlight.clear();
    },
    _peek: (symbol) => cache.get(symbol)
  };
}

module.exports = { createSymbolCache, FAILURE_RETRY_MS };
