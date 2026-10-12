// Live TASE quote via the exchange's own public JSON API - the very
// endpoint that populates the major_data page taseScraper.js renders and
// regex-scrapes. Found the same way taseHistoryApi.js's endpoint was: by
// capturing real browser network traffic on market.tase.co.il.
//
// Verified live against the existing Puppeteer scraper on six securities
// (ordinary shares, a dual-listed share, and an ETF): LastRate/Change come
// back identical to what the scraper extracts from the rendered page, in
// ~40ms instead of ~700-2700ms, with no browser and no HTML parsing.
//
//   GET https://api.tase.co.il/api/company/securitydata?securityId=629014&lang=0
//   -> { "LastRate": 11960, "Change": 1.36, "TradeDate": "17/09/2026",
//        "CompanyName": "טבע", "Symbol": "טבע", "ISIN": "IL0006290147",
//        "isTrading": false, "LastDealTime": "סוף יום", ... }
//
// Like bizportalSearch.js's endpoint this is unofficial and undocumented,
// which is exactly why it sits at the head of a chain rather than alone -
// quotesRoutes.js falls through to the EOD API and then the scraper.
const axios = require('axios');
const { taseDateToIso } = require('./taseHistoryApi');

const TASE_QUOTE_URL = 'https://api.tase.co.il/api/company/securitydata';

// Referer is the ONE header this endpoint actually requires. Confirmed by
// testing each in isolation against the live API: no headers -> 403, a
// browser User-Agent alone -> 403, this Referer alone -> 200. Sending a
// fake User-Agent on top adds nothing and is one more thing that can look
// like bot traffic, so it isn't sent.
const QUOTE_HEADERS = {
  Referer: 'https://market.tase.co.il/',
  'Accept-Language': 'he-IL'
};

const REQUEST_TIMEOUT_MS = 10000;

// TASE returns prices in agorot (the major_data page labels the field
// "שער אחרון (באגורות)"), matching the convention the rest of this app's
// Israeli-stock handling already uses - see taseScraper.js's
// parseTasePriceToken and taseHistoryApi.js's fetchTaseHistoricalCloses.
// No scaling is applied here for the same reason it isn't applied there.
async function fetchTaseQuoteFromApi(stockId) {
  const response = await axios.get(TASE_QUOTE_URL, {
    params: { securityId: String(stockId), lang: 0 },
    timeout: REQUEST_TIMEOUT_MS,
    headers: QUOTE_HEADERS
  });

  const data = response.data;

  // An unknown security id does NOT come back as a 404 - the API answers
  // HTTP 200 with a literal `null` body. Without this guard that null would
  // throw on the first field access ("Cannot read properties of null")
  // instead of falling through to the next source in the chain, so the
  // check is what separates "no such security" from a usable quote.
  if (!data || typeof data !== 'object') {
    return { currentPrice: null, changePercent: null };
  }

  return {
    currentPrice: typeof data.LastRate === 'number' ? data.LastRate : null,
    changePercent: typeof data.Change === 'number' ? data.Change : null,
    // The session that Change belongs to - TASE keeps reporting the last
    // session's figures until the next one opens (see marketCalendar.js).
    tradeDate: taseDateToIso(data.TradeDate),
    // Same diagnostic shape the scraper returns, so quotesRoutes.js's
    // success logging reads identically no matter which source won.
    _debugPriceMatch: {
      matchedLabel: 'API LastRate',
      rawToken: String(data.LastRate),
      fullMatch: `LastRate=${data.LastRate} Change=${data.Change} TradeDate=${data.TradeDate}`
    }
  };
}

module.exports = { fetchTaseQuoteFromApi };
