// Historical daily closes for an Israeli/TASE security, via TASE's own
// public JSON REST API - found by capturing real browser network traffic
// while visiting a security's "נתונים היסטוריים" (historical data) tab on
// market.tase.co.il during development. Confirmed live: needs no session
// cookie, no API key (unlike the removed official Data Hub product in
// taseApi.js), and is callable directly with a plain POST - not scraped
// HTML, a real REST endpoint.
//
// Request shape (POST, JSON body): { pType, oId, TotalRec, pageNum, lang }
//   oId    - the TASE security id, zero-padded to 8 digits (e.g. "629014"
//            -> "00629014")
//   pType  - how far back the window goes, confirmed by direct testing:
//            0 = today only, 1 = 1 month, 2 = 3 months, 3 = 6 months,
//            4 = 1 year, 5 = 2 years, 6 = 3 years
//   pageNum - each page returns up to PAGE_SIZE rows, newest-first;
//            confirmed contiguous across pages (page N's oldest row is
//            the trading day right before page N+1's newest row) and the
//            response's TotalRec field is the true total row count for
//            the requested pType window, not an echo of the request.
// This module always requests the 3-year window (pType 6) and pages
// backward until fromDateStr is reached or the window/TotalRec is
// exhausted - the caller decides how far back it actually needs.
const axios = require('axios');

const TASE_HISTORY_URL = 'https://api.tase.co.il/api/security/historyeod';
const PAGE_SIZE = 30;
const PTYPE_TODAY_ONLY = 0;
const PTYPE_THREE_YEARS = 6;
// 3 years of trading days is roughly 250/year * 3 = 750, at 30/page that's
// 25 pages - one extra page of margin against off-by-one edges.
const MAX_PAGES = 26;

const BROWSER_HEADERS = {
  'Content-Type': 'application/json;charset=UTF-8',
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept-Language': 'he-IL',
  Referer: 'https://market.tase.co.il/'
};

function toOid(stockId) {
  return String(stockId).padStart(8, '0');
}

// TASE's own date format (DD/MM/YYYY) -> YYYY-MM-DD, the format used
// everywhere else in this app.
function taseDateToIso(taseDate) {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(taseDate || '');
  if (!m) return null;
  const [, dd, mm, yyyy] = m;
  return `${yyyy}-${mm}-${dd}`;
}

async function fetchHistoryPage(stockId, pageNum, pType = PTYPE_THREE_YEARS) {
  const response = await axios.post(
    TASE_HISTORY_URL,
    { pType, oId: toOid(stockId), TotalRec: 1, pageNum, lang: '0' },
    { timeout: 15000, headers: BROWSER_HEADERS }
  );
  return response.data;
}

// A current quote from this same endpoint, using pType 0 ("today only"),
// which returns the single most recent trading day. That row's CloseRate
// and Change are exactly the two fields a quote needs, in the same agorot
// convention as fetchTaseHistoricalCloses below - so this doubles as a
// second, independent quote source behind taseQuoteApi.js without adding
// another third-party dependency.
//
// Being end-of-day data, during an open session this can lag the live
// intraday rate - which is precisely why quotesRoutes.js puts it SECOND,
// after the live securitydata API, rather than first.
async function fetchTaseQuoteFromEod(stockId) {
  const data = await fetchHistoryPage(stockId, 1, PTYPE_TODAY_ONLY);
  const item = data && Array.isArray(data.Items) ? data.Items[0] : null;
  if (!item) {
    return { currentPrice: null, changePercent: null };
  }
  // Number.isFinite on the raw value (not a Number()-converted copy) is
  // what actually rejects a null/missing rate rather than silently
  // reporting a 0 price - same reasoning as the CloseRate check below.
  return {
    currentPrice: Number.isFinite(item.CloseRate) ? item.CloseRate : null,
    changePercent: Number.isFinite(item.Change) ? item.Change : null,
    tradeDate: taseDateToIso(item.TradeDate),
    _debugPriceMatch: {
      matchedLabel: 'EOD CloseRate',
      rawToken: String(item.CloseRate),
      fullMatch: `CloseRate=${item.CloseRate} Change=${item.Change} TradeDate=${item.TradeDate}`
    }
  };
}

// Pages backward from today until fromDateStr (YYYY-MM-DD) is reached, or
// the 3-year window / server-reported TotalRec is exhausted, whichever
// comes first. Returns closes in agorot (TASE's own convention - matching
// the rest of this app's Israeli-stock price handling, see
// taseScraper.js's parseTasePriceToken), ascending by date, deduplicated
// by date (defensive - pages are contiguous in practice, but a date
// appearing on two pages should still collapse to one entry rather than
// throwing off a caller that assumes unique dates). Same {date, close}
// shape as yahooQuotes.js's fetchYahooHistoricalCloses, for a consistent
// interface between the two markets.
async function fetchTaseHistoricalCloses(stockId, fromDateStr) {
  const closesByDate = new Map();
  let pageNum = 1;
  let totalRec = null;
  let totalFetched = 0;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const data = await fetchHistoryPage(stockId, pageNum);
    const items = Array.isArray(data.Items) ? data.Items : [];
    if (totalRec === null) totalRec = Number(data.TotalRec) || items.length;
    if (items.length === 0) break;
    totalFetched += items.length;

    let reachedFromDate = false;
    for (const item of items) {
      const isoDate = taseDateToIso(item.TradeDate);
      // Number(null) is 0, not NaN - checking isFinite on the raw value
      // (not a Number()-converted copy of it) is what actually rejects a
      // null/missing CloseRate instead of silently recording a 0 close.
      if (isoDate && Number.isFinite(item.CloseRate)) {
        closesByDate.set(isoDate, item.CloseRate);
      }
      if (fromDateStr && isoDate && isoDate <= fromDateStr) {
        reachedFromDate = true;
      }
    }

    if (reachedFromDate) break;
    // Tracks actual rows fetched so far against the server-reported total,
    // rather than assuming every page came back at the full PAGE_SIZE -
    // true for the real API (every page but the last is exactly 30 rows),
    // but this is the robust version either way.
    if (totalFetched >= totalRec) break;
    if (pageNum >= MAX_PAGES) break;
    pageNum += 1;
  }

  return Array.from(closesByDate.entries())
    .map(([date, close]) => ({ date, close }))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

module.exports = { fetchTaseHistoricalCloses, fetchTaseQuoteFromEod, taseDateToIso };
