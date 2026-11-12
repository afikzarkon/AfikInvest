// Ported from day-trader-skill (MIT, Jake Schincariol)
//
// News on my holdings:
//   GET /api/news?symbols=A,B&hours=72
//     -> { items, symbols, unsupported, secConfigured, errors, truncated, hours, generatedAt }
//
// Without ?symbols the user's own US holdings are used. TASE holdings come
// back in `unsupported` (no news source for them yet). Headlines and filings
// are cached per symbol in newsService, so page loads do not hammer Yahoo
// or SEC.
const { requireAuth } = require('./requireAuth');
const { createRateLimiter } = require('./rateLimit');
const { buildHoldingsIndex, loadPortfolios } = require('./holdingsIndex');
const { createNewsService, normalizeTicker } = require('./newsService');

const MAX_SYMBOLS = 25;
const DEFAULT_HOURS = 72;
const MAX_HOURS = 24 * 90;

function parseHours(raw) {
  const h = Number(raw);
  if (raw === undefined || raw === '' || !Number.isFinite(h)) return DEFAULT_HOURS;
  return Math.min(Math.max(h, 1), MAX_HOURS);
}

function mountNewsRoutes(app, { store, newsService = null, fetchers = null, now = () => new Date() }) {
  const service = newsService || createNewsService({ fetchers });
  const limiter = createRateLimiter({
    windowMs: 60 * 1000,
    max: 10,
    message: 'יותר מדי בקשות חדשות, נסו שוב בעוד דקה',
    keyFn: (req) => `news:${req.user.id}`
  });

  app.get('/api/news', requireAuth, limiter, async (req, res) => {
    try {
      const hours = parseHours(req.query.hours);
      const portfolios = await loadPortfolios(store, [req.user.id]);
      const info = buildHoldingsIndex(portfolios).byUser.get(req.user.id);
      const positions = info ? info.positions : [];
      const names = {};
      positions.forEach((p) => {
        if (p.market === 'US' && p.name) names[p.symbol] = p.name;
      });
      const unsupported = positions.filter((p) => p.market !== 'US').map((p) => ({ symbol: p.symbol, market: p.market, name: p.name || '' }));

      let requested;
      if (req.query.symbols !== undefined) {
        const raw = String(req.query.symbols).split(',').map((s) => s.trim()).filter(Boolean);
        requested = [...new Set(raw.map(normalizeTicker).filter(Boolean))];
        if (!requested.length) return res.status(400).json({ error: 'רשימת סימולים לא תקינה' });
      } else {
        requested = [...new Set(positions.filter((p) => p.market === 'US').map((p) => normalizeTicker(p.symbol)).filter(Boolean))];
      }
      const truncated = requested.length > MAX_SYMBOLS;
      const symbols = requested.slice(0, MAX_SYMBOLS);

      const secConfigured = service.isSecConfigured();
      if (!symbols.length) {
        return res.json({ items: [], symbols: [], unsupported, secConfigured, errors: [], truncated: false, hours, generatedAt: now().toISOString() });
      }
      const result = await service.getNews({ symbols, names, hours, now: now() });
      return res.json({
        items: result.items,
        symbols,
        unsupported,
        secConfigured: result.secConfigured,
        // Which source failed for which symbol; the upstream error text stays in the log.
        errors: result.errors.map((e) => ({ symbol: e.symbol, source: e.source })),
        truncated,
        hours,
        generatedAt: now().toISOString()
      });
    } catch (err) {
      console.error('[news] failed', err);
      return res.status(500).json({ error: 'שגיאת שרת' });
    }
  });
}

module.exports = { mountNewsRoutes, MAX_SYMBOLS };
