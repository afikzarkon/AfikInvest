// Yahoo's simpler `chart` endpoint (v8, used for prices/FX/history) mostly
// works without special auth. Its `quoteSummary` endpoint (v10, used for
// sector data and analyst recommendations) is stricter: since Yahoo
// tightened this down, it requires a session cookie + a matching "crumb"
// token, or it returns 401 "Invalid Crumb". This module gets and caches
// that cookie/crumb pair. It's an unofficial workaround for an unofficial
// API — Yahoo could change this mechanism again without notice, the same
// way this exact break has already happened to it more than once.
const axios = require('axios');

const BROWSER_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.5'
};

const CRUMB_TTL_MS = 55 * 60 * 1000; // refresh a bit before a typical 1h session expiry
// A failed attempt is remembered this long and rethrown without a request.
// Without it every queued quoteSummary call made its own two-request
// attempt at a session while Yahoo was refusing them all, which only
// added to the traffic that got the server refused in the first place.
const FAILURE_BACKOFF_MS = 60 * 1000;
let cached = null; // { crumb, cookie, ts }
let inFlightRequest = null;
let lastFailure = null; // { err, ts }

function extractCookieHeader(setCookieHeaders) {
  if (!setCookieHeaders) return '';
  const list = Array.isArray(setCookieHeaders) ? setCookieHeaders : [setCookieHeaders];
  return list
    .map((c) => c.split(';')[0].trim())
    .filter(Boolean)
    .join('; ');
}

async function fetchSessionCookie() {
  // Step 1: fc.yahoo.com is the lightest-weight page known to set the base
  // Yahoo session cookies without pulling a full finance.yahoo.com page.
  try {
    const r = await axios.get('https://fc.yahoo.com', {
      headers: BROWSER_HEADERS,
      timeout: 10000,
      maxRedirects: 0,
      validateStatus: () => true
    });
    const cookie = extractCookieHeader(r.headers['set-cookie']);
    if (cookie) return cookie;
  } catch {
    // fall through to the fallback below
  }
  // Fallback: the full finance page also sets cookies, just with more
  // overhead per request.
  const r2 = await axios.get('https://finance.yahoo.com', {
    headers: BROWSER_HEADERS,
    timeout: 12000
  });
  return extractCookieHeader(r2.headers['set-cookie']);
}

async function fetchCrumb(cookie) {
  const r = await axios.get('https://query1.finance.yahoo.com/v1/test/getcrumb', {
    headers: { ...BROWSER_HEADERS, Cookie: cookie },
    timeout: 10000
  });
  const crumb = typeof r.data === 'string' ? r.data.trim() : '';
  // A failed crumb fetch sometimes comes back as an HTML error page (still
  // HTTP 200) rather than a clean error status, so check the shape too.
  if (!crumb || crumb.length > 100 || crumb.includes('<')) {
    throw new Error('did not receive a valid yahoo crumb');
  }
  return crumb;
}

async function getYahooCrumbAndCookie(forceRefresh = false) {
  if (!forceRefresh && cached && Date.now() - cached.ts < CRUMB_TTL_MS) {
    return cached;
  }
  if (inFlightRequest) return inFlightRequest;
  if (lastFailure && Date.now() - lastFailure.ts < FAILURE_BACKOFF_MS) throw lastFailure.err;

  inFlightRequest = (async () => {
    try {
      const cookie = await fetchSessionCookie();
      if (!cookie) throw new Error('could not obtain a yahoo session cookie');
      const crumb = await fetchCrumb(cookie);
      const result = { crumb, cookie, ts: Date.now() };
      cached = result;
      lastFailure = null;
      return result;
    } catch (err) {
      lastFailure = { err, ts: Date.now() };
      throw err;
    }
  })();

  try {
    return await inFlightRequest;
  } finally {
    inFlightRequest = null;
  }
}

// Call after a request using the cached crumb/cookie comes back
// unauthorized, so the next attempt fetches a fresh pair instead of
// retrying with what we now know is stale.
function invalidateYahooCrumb() {
  cached = null;
}

// Test seam.
function resetYahooCrumb() {
  cached = null;
  inFlightRequest = null;
  lastFailure = null;
}

module.exports = { getYahooCrumbAndCookie, invalidateYahooCrumb, resetYahooCrumb };
