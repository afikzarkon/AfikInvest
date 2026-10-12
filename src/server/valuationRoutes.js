// GET /api/valuation/:symbol -> multiples (current vs 5y vs peers) and DCF
// inputs for one US-listed symbol. Public market data, so no auth, but rate
// limited per client: every uncached symbol costs several upstream calls.
const { createRateLimiter } = require('./rateLimit');

const SYMBOL_RE = /^[A-Z0-9][A-Z0-9.\-^=]{0,14}$/;

function mountValuationRoutes(app, { valuation }) {
  const limiter = createRateLimiter({ windowMs: 10 * 60 * 1000, max: 40, message: 'יותר מדי בקשות הערכת שווי, נסו שוב בעוד כמה דקות' });

  app.get('/api/valuation/:symbol', limiter, async (req, res) => {
    const symbol = String(req.params.symbol || '').trim().toUpperCase();
    if (!SYMBOL_RE.test(symbol)) return res.status(400).json({ error: 'סימול לא תקין' });
    try {
      return res.json(await valuation.getValuation(symbol));
    } catch (err) {
      console.warn('[valuation] failed', symbol, err && err.message);
      return res.status(502).json({
        error: 'לא ניתן היה לטעון נתונים פיננסיים לסימול הזה כרגע',
        diagnostics: (err && err.diagnostics) || null
      });
    }
  });
}

module.exports = { mountValuationRoutes };
