// Who may use the market-data routes: signed-in users only, each within a
// generous per-user rate.
//
// These routes answer with data the app fetches from outside providers
// (the exchange, Yahoo, Bizportal, Finnhub...). Left open, anyone who
// found the API could pull that data through it, and the app would in
// effect be republishing it to the public. Behind sign-in it reaches only
// the app's own users, for their own portfolios - and sign-in is what the
// app needs anyway, so a user sees no difference.
//
// The rate is far above what the app itself asks for (a page load makes a
// handful of batched calls; search is debounced): it never slows normal
// use, only a script looping over the API.
//
// Mounted in server.js ahead of the market routes, so the route modules
// stay unaware of it (and their tests mount them without it).
const { requireAuth } = require('./requireAuth');
const { createRateLimiter } = require('./rateLimit');

// Every path that serves outside market data. app.use() matches a path and
// anything below it ('/api/cpi' covers '/api/cpi/latest'), but not a
// longer name ('/api/israeli-stock' does not cover '/api/israeli-stocks'),
// so each one is listed.
const MARKET_DATA_PATHS = [
  '/api/israeli-stock',
  '/api/israeli-stocks',
  '/api/israeli-security',
  '/api/israeli-stock-search',
  '/api/israeli-stocks-history',
  '/api/american-stock',
  '/api/american-stocks',
  '/api/american-stocks-history',
  '/api/stock-search',
  '/api/exchange-rate',
  '/api/exchange-rate-history',
  '/api/benchmark-history',
  '/api/stock-sectors',
  '/api/analyst-recommendations',
  '/api/dividend-data',
  '/api/cpi',
  '/api/valuation'
];

const WINDOW_MS = 60 * 1000;
const MAX_PER_WINDOW = 300;

function createMarketDataGate({ windowMs = WINDOW_MS, max = MAX_PER_WINDOW } = {}) {
  const limiter = createRateLimiter({
    windowMs,
    max,
    message: 'יותר מדי בקשות נתוני שוק, נסו שוב בעוד דקה',
    keyFn: (req) => `user:${req.user.id}`
  });
  return [requireAuth, limiter];
}

function mountMarketDataGate(app, options) {
  app.use(MARKET_DATA_PATHS, ...createMarketDataGate(options));
}

module.exports = { mountMarketDataGate, createMarketDataGate, MARKET_DATA_PATHS, MAX_PER_WINDOW };
