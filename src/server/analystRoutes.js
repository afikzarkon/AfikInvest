// Analyst coverage for US stocks: consensus rating, price targets, and
// recent upgrade/downgrade history — via the same Yahoo quoteSummary
// endpoint already used for sector data (sectorRoutes.js), so it shares
// the same crumb/cookie auth (yahooCrumb.js) and the same batched-POST +
// per-symbol-cache shape. Public data, no user auth needed.
// Served from the per-symbol profile shared with the sector and dividend
// routes (symbolProfile.js): one Yahoo request per symbol for all three.
// A few-hours-old target price is a far better answer than a null - see
// symbolCache.js.
const { getSymbolAnalyst } = require('./symbolProfile');

const MAX_SYMBOLS_PER_REQUEST = 30;

function mountAnalystRoutes(app) {
  app.post('/api/analyst-recommendations', async (req, res) => {
    const body = req.body || {};
    const symbols = Array.isArray(body.symbols) ? body.symbols : [];
    const cleaned = [...new Set(symbols.map((s) => String(s || '').trim().toUpperCase()).filter(Boolean))].slice(
      0,
      MAX_SYMBOLS_PER_REQUEST
    );

    if (cleaned.length === 0) {
      return res.json({ recommendations: {} });
    }

    try {
      const results = await Promise.all(cleaned.map((symbol) => getSymbolAnalyst(symbol)));
      const recommendations = {};
      cleaned.forEach((symbol, i) => {
        recommendations[symbol] = results[i];
      });
      return res.json({ recommendations });
    } catch (err) {
      console.error('[analyst] failed to resolve symbols', { symbols: cleaned, error: err && err.message });
      return res.status(502).json({ error: 'לא ניתן היה למשוך נתוני אנליסטים' });
    }
  });
}

module.exports = { mountAnalystRoutes };
