// Smart Alerts API (per user):
//   GET  /api/alerts?unread=1&limit=100  -> { alerts, unreadCount }
//   POST /api/alerts/:id/read            -> { ok }
//   POST /api/alerts/read-all            -> { ok, updated }
//   GET  /api/alert-settings             -> { settings }
//   PUT  /api/alert-settings             -> { settings }
//   GET  /api/calendar?from&to           -> { events }  (only the user's holdings)
//   POST /api/alerts/refresh             -> scan the user's own holdings now
//                                           (rate limited; the scheduled scan
//                                           covers everyone - see jobRunner.js)
//   GET    /api/price-alerts                -> { rules, max }  (user price alerts)
//   POST   /api/price-alerts                -> 201 { rule, currentPrice, alreadyMet }
//   PATCH  /api/price-alerts/:id            -> { rule }  ({ value, note, ruleType, ... }
//                                           and/or { status: 'active' } to re-arm)
//   DELETE /api/price-alerts/:id            -> { ok }
const { requireAuth } = require('./requireAuth');
const { createRateLimiter } = require('./rateLimit');
const {
  DEFAULT_ALERT_SETTINGS,
  normalizeAlertSettings,
  runAnomalyScan,
  runCalendarRefresh,
  buildUserCalendar
} = require('./alertEngine');
const {
  MAX_PRICE_ALERTS_PER_USER,
  validatePriceAlertInput,
  evaluatePriceAlert
} = require('../shared/priceAlertRules');

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const addDays = (date, days) => new Date(Date.parse(`${date}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);

const QUOTE_LOOKUP_TIMEOUT_MS = 8000;

// The current quote for a new rule, or undefined when the source failed or
// was slow (the rule is still saved; the job will price it). { price: null }
// means the source answered and has no such security.
async function lookupQuote(priceQuotes, market, symbol) {
  if (!priceQuotes) return undefined;
  let timer;
  try {
    return await Promise.race([
      priceQuotes.getQuote(market, symbol),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(undefined), QUOTE_LOOKUP_TIMEOUT_MS);
      })
    ]);
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

// priceQuotes: { getQuote(market, symbol) } for checking a new price alert's
// symbol (priceAlerts.js createPriceQuotes); left out -> the production
// quotes, created on first use; null -> no lookup.
function mountAlertRoutes(app, { store, features, marketData, now = () => new Date(), priceQuotes }) {
  let quotesForLookup = priceQuotes;
  const getPriceQuotes = () => {
    if (quotesForLookup === undefined) quotesForLookup = require('./priceAlerts').createPriceQuotes({ waitTries: 0 });
    return quotesForLookup;
  };
  const priceAlertWriteLimiter = createRateLimiter({
    windowMs: 10 * 60 * 1000,
    max: 60,
    message: 'יותר מדי שינויים בהתראות מחיר, נסו שוב בעוד כמה דקות',
    keyFn: (req) => `price-alerts-write:${req.user.id}`
  });

  const refreshLimiter = createRateLimiter({
    windowMs: 10 * 60 * 1000,
    max: 1,
    message: 'אפשר לרענן התראות פעם ב-10 דקות',
    keyFn: (req) => `alerts-refresh:${req.user.id}`
  });

  app.get('/api/alerts', requireAuth, async (req, res) => {
    try {
      const alerts = await features.listAlerts(req.user.id, {
        unreadOnly: req.query.unread === '1',
        limit: req.query.limit
      });
      const unreadCount = await features.countUnreadAlerts(req.user.id);
      return res.json({ alerts, unreadCount });
    } catch (err) {
      console.error('[alerts] list failed', err);
      return res.status(500).json({ error: 'שגיאת שרת' });
    }
  });

  app.post('/api/alerts/read-all', requireAuth, async (req, res) => {
    try {
      const updated = await features.markAllAlertsRead(req.user.id);
      return res.json({ ok: true, updated });
    } catch (err) {
      return res.status(500).json({ error: 'שגיאת שרת' });
    }
  });

  app.post('/api/alerts/:id/read', requireAuth, async (req, res) => {
    try {
      const ok = await features.markAlertRead(req.user.id, String(req.params.id));
      return ok ? res.json({ ok: true }) : res.status(404).json({ error: 'לא נמצא' });
    } catch (err) {
      return res.status(500).json({ error: 'שגיאת שרת' });
    }
  });

  app.get('/api/alert-settings', requireAuth, async (req, res) => {
    try {
      const stored = await features.getAlertSettings(req.user.id);
      return res.json({ settings: Object.assign({}, DEFAULT_ALERT_SETTINGS, stored || {}) });
    } catch (err) {
      return res.status(500).json({ error: 'שגיאת שרת' });
    }
  });

  app.put('/api/alert-settings', requireAuth, async (req, res) => {
    let settings;
    try {
      const stored = await features.getAlertSettings(req.user.id);
      settings = normalizeAlertSettings(req.body, stored || DEFAULT_ALERT_SETTINGS);
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
    try {
      await features.upsertAlertSettings(req.user.id, settings);
      return res.json({ settings });
    } catch (err) {
      return res.status(500).json({ error: 'שגיאת שרת' });
    }
  });

  app.get('/api/calendar', requireAuth, async (req, res) => {
    const today = now().toISOString().slice(0, 10);
    const from = DATE_RE.test(String(req.query.from || '')) ? req.query.from : addDays(today, -7);
    const to = DATE_RE.test(String(req.query.to || '')) ? req.query.to : addDays(today, 120);
    if (from > to) return res.status(400).json({ error: 'from must not be after to' });
    try {
      const events = await buildUserCalendar({ store, features, userId: req.user.id, from, to });
      return res.json({ events, from, to });
    } catch (err) {
      console.error('[calendar] failed', err);
      return res.status(500).json({ error: 'שגיאת שרת' });
    }
  });

  app.post('/api/alerts/refresh', requireAuth, refreshLimiter, async (req, res) => {
    try {
      const userIds = [req.user.id];
      const scan = await runAnomalyScan({ store, features, marketData, now: now(), userIds });
      const calendar = await runCalendarRefresh({ store, features, marketData, now: now(), userIds });
      return res.json({ scan, calendar });
    } catch (err) {
      console.error('[alerts] refresh failed', err);
      return res.status(500).json({ error: 'שגיאת שרת' });
    }
  });

  // ----- user price alerts -----
  app.get('/api/price-alerts', requireAuth, async (req, res) => {
    try {
      const rules = await features.listPriceAlerts(req.user.id);
      return res.json({ rules, max: MAX_PRICE_ALERTS_PER_USER });
    } catch (err) {
      console.error('[price-alerts] list failed', err);
      return res.status(500).json({ error: 'שגיאת שרת' });
    }
  });

  app.post('/api/price-alerts', requireAuth, priceAlertWriteLimiter, async (req, res) => {
    let input;
    try {
      input = validatePriceAlertInput(req.body);
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
    try {
      if ((await features.countPriceAlerts(req.user.id)) >= MAX_PRICE_ALERTS_PER_USER) {
        return res.status(400).json({ error: `אפשר להגדיר עד ${MAX_PRICE_ALERTS_PER_USER} התראות מחיר. מחקו התראה ישנה כדי להוסיף חדשה.` });
      }
      const quote = await lookupQuote(getPriceQuotes(), input.market, input.symbol);
      if (quote && quote.price === null) {
        return res.status(400).json({ error: 'לא נמצא מחיר לנייר הזה - בדקו את הסימול' });
      }
      const currentPrice = quote && Number.isFinite(quote.price) ? quote.price : null;
      const rule = await features.createPriceAlert(
        Object.assign({}, input, { userId: req.user.id, lastPrice: currentPrice, createdAt: now().toISOString() })
      );
      const alreadyMet = currentPrice !== null ? evaluatePriceAlert(rule, quote).hit : null;
      return res.status(201).json({ rule, currentPrice, alreadyMet });
    } catch (err) {
      console.error('[price-alerts] create failed', err);
      return res.status(500).json({ error: 'שגיאת שרת' });
    }
  });

  app.patch('/api/price-alerts/:id', requireAuth, priceAlertWriteLimiter, async (req, res) => {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    if (body.status !== undefined && body.status !== 'active') {
      return res.status(400).json({ error: 'אפשר רק להפעיל מחדש התראה (status: active)' });
    }
    try {
      const existing = await features.getPriceAlert(req.user.id, String(req.params.id));
      if (!existing) return res.status(404).json({ error: 'לא נמצא' });
      let input;
      try {
        // The security itself cannot change; a different security is a new rule.
        input = validatePriceAlertInput({ ruleType: body.ruleType, value: body.value, note: body.note }, existing);
      } catch (err) {
        return res.status(400).json({ error: err.message });
      }
      const rule = await features.updatePriceAlert(req.user.id, existing.id, {
        ruleType: input.ruleType,
        value: input.value,
        note: input.note,
        rearm: body.status === 'active',
        updatedAt: now().toISOString()
      });
      return res.json({ rule });
    } catch (err) {
      console.error('[price-alerts] update failed', err);
      return res.status(500).json({ error: 'שגיאת שרת' });
    }
  });

  app.delete('/api/price-alerts/:id', requireAuth, priceAlertWriteLimiter, async (req, res) => {
    try {
      const ok = await features.deletePriceAlert(req.user.id, String(req.params.id));
      return ok ? res.json({ ok: true }) : res.status(404).json({ error: 'לא נמצא' });
    } catch (err) {
      return res.status(500).json({ error: 'שגיאת שרת' });
    }
  });
}

module.exports = { mountAlertRoutes };
