// The site-wide state an admin sets (adminStore.js system_settings): the
// banner and maintenance mode.
//
//   GET /api/system/status -> { banner, maintenance: { enabled, message } }
//       open to everyone, signed in or not; banner is null unless one is
//       active and not past its end time.
//
// Maintenance mode: while it is on, every API call answers 503 - except for
// active admins (role + 2FA, checked on the server), and for what is needed
// to reach that point: this status, signing in, the flags and the admin API
// (which checks the admin itself), and the scheduler's internal routes.
//
// Registered before the routes it guards, so it starts before the database
// is up (everything open, no banner) and reads the settings once attach()
// is called.
const { optionalUserId } = require('./adminRoutes');

const OPEN_DURING_MAINTENANCE = ['/api/system/', '/api/auth/', '/api/features', '/api/admin/', '/api/internal/'];

function visibleBanner(banner, now = new Date()) {
  if (!banner || !banner.active || !String(banner.text || '').trim()) return null;
  if (banner.expiresAt && Date.parse(banner.expiresAt) <= now.getTime()) return null;
  return { text: banner.text, level: banner.level || 'info', id: banner.updatedAt || '' };
}

function createSystemGate() {
  let admin = null;

  async function status() {
    if (!admin) return { banner: null, maintenance: { enabled: false, message: '' } };
    const [banner, maintenance] = await Promise.all([admin.getSetting('banner'), admin.getSetting('maintenance')]);
    return { banner: visibleBanner(banner), maintenance: { enabled: Boolean(maintenance.enabled), message: maintenance.message || '' } };
  }

  return {
    attach(adminStore) {
      admin = adminStore;
    },
    mountStatus(app) {
      app.get('/api/system/status', async (req, res) => {
        res.set('Cache-Control', 'no-store');
        try {
          return res.json(await status());
        } catch (err) {
          console.error('system/status', err && err.message ? err.message : err);
          return res.json({ banner: null, maintenance: { enabled: false, message: '' } });
        }
      });
    },
    async middleware(req, res, next) {
      if (!admin || !req.path.startsWith('/api/')) return next();
      if (OPEN_DURING_MAINTENANCE.some((p) => req.path === p.replace(/\/$/, '') || req.path.startsWith(p))) return next();
      try {
        const maintenance = await admin.getSetting('maintenance');
        if (!maintenance.enabled) return next();
        if (await admin.isActiveAdmin(optionalUserId(req))) return next();
        res.set('Retry-After', '600');
        return res.status(503).json({ error: maintenance.message || 'האתר בתחזוקה. נחזור בקרוב.', maintenance: true });
      } catch (err) {
        // The settings unreadable: let the request through rather than
        // take the whole site down with it.
        console.error('maintenance gate', err && err.message ? err.message : err);
        return next();
      }
    }
  };
}

module.exports = { createSystemGate, visibleBanner };
