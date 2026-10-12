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
const { requireAuth } = require('./requireAuth');
const { createRateLimiter } = require('./rateLimit');
const {
  DEFAULT_ALERT_SETTINGS,
  normalizeAlertSettings,
  runAnomalyScan,
  runCalendarRefresh,
  buildUserCalendar
} = require('./alertEngine');

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const addDays = (date, days) => new Date(Date.parse(`${date}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);

function mountAlertRoutes(app, { store, features, marketData, now = () => new Date() }) {
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
}

module.exports = { mountAlertRoutes };
