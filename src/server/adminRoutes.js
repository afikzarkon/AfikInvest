// Feature flags and the admin API.
//
//   GET    /api/features            -> { flags: [key...], isAdmin }   (anyone)
//          the flags that are ON for the caller - a signed-out visitor and
//          an ordinary user get only what is open to everyone, so a flag
//          kept for admins is not even named to them.
//
//   Admin only - the role is read from the database (user_roles) on every
//   request, never taken from the client:
//   GET    /api/admin/flags         -> { flags }
//   POST   /api/admin/flags         -> { flag }     { key, description, state }
//   PATCH  /api/admin/flags/:key    -> { flag }     { state?, description? }
//   DELETE /api/admin/flags/:key    -> { ok }       (only flags the code does not define)
//   GET    /api/admin/audit?limit&before -> { entries }
//
// Every change is written to admin_audit_log in the same transaction as the
// change itself (adminStore.js).
//
// createFlagGate() is the server half of hiding a feature: an API that
// belongs to a switched-off feature answers 404, as if it did not exist,
// whatever the client shows or does.
const { readAuthUserFromRequest, getJwtSecret } = require('./authRoutes');
const { requestContext } = require('./authHelpers');
const { createRateLimiter } = require('./rateLimit');
const { FLAG_DEFINITIONS, FLAG_KEY_PATTERN, isFlagState, flagVisibleTo, defaultFlagStates } = require('../shared/featureFlags');

const MAX_DESCRIPTION = 300;

// The signed-in user's id, or null - for routes open to everyone, where a
// missing or stale token simply means "not signed in".
function optionalUserId(req) {
  try {
    const authUser = readAuthUserFromRequest(req, getJwtSecret());
    return authUser ? Number(authUser.id) : null;
  } catch {
    return null;
  }
}

// Gates an API on a flag. Registered ahead of routes that are mounted
// before the database is up (valuation), so it starts on the defined
// defaults and switches to the database once attach() is called.
function createFlagGate() {
  let admin = null;

  async function visible(key, req) {
    const states = admin ? await admin.getFlagStates() : defaultFlagStates();
    const state = states[key] || 'off';
    if (state === 'all') return true;
    if (state !== 'admin' || !admin) return false;
    return admin.isAdmin(optionalUserId(req));
  }

  return {
    attach(adminStore) {
      admin = adminStore;
    },
    require(key) {
      return async (req, res, next) => {
        try {
          if (await visible(key, req)) return next();
        } catch (err) {
          // Fail closed: a feature whose state cannot be read stays hidden.
          console.error('flag gate', key, err && err.message ? err.message : err);
        }
        return res.status(404).json({ error: 'לא נמצא' });
      };
    }
  };
}

function cleanDescription(value) {
  return typeof value === 'string' ? value.trim().slice(0, MAX_DESCRIPTION) : null;
}

function mountAdminRoutes(app, { admin, store }) {
  const writeLimiter = createRateLimiter({
    windowMs: 60 * 1000,
    max: 30,
    message: 'יותר מדי שינויים, נסה שוב בעוד דקה',
    keyFn: (req) => `admin-write:${req.admin.id}`
  });

  // 401 without a valid session, 403 for anyone who is not an admin in the
  // database right now. req.admin = { id, email, ipPrefix } - the actor
  // the audit log records, with the address read fresh from the account.
  async function requireAdmin(req, res, next) {
    let authUser;
    try {
      authUser = readAuthUserFromRequest(req, getJwtSecret());
    } catch {
      return res.status(401).json({ error: 'פג תוקף או טוקן לא תקין' });
    }
    if (!authUser) return res.status(401).json({ error: 'נדרשת התחברות' });
    try {
      const userId = Number(authUser.id);
      const user = await store.getAuthUser(userId);
      if (!user || user.deleted_at) return res.status(401).json({ error: 'נדרשת התחברות' });
      if (!(await admin.isAdmin(userId))) return res.status(403).json({ error: 'אין הרשאה' });
      req.admin = { id: userId, email: user.email, ipPrefix: requestContext(req).ipPrefix };
      return next();
    } catch (err) {
      console.error('admin auth', err && err.stack ? err.stack : err);
      return res.status(500).json({ error: 'שגיאת שרת' });
    }
  }

  app.get('/api/features', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      const userId = optionalUserId(req);
      const [states, isAdmin] = await Promise.all([admin.getFlagStates(), admin.isAdmin(userId)]);
      const flags = Object.keys(states).filter((key) => flagVisibleTo(states[key], isAdmin));
      return res.json({ flags, isAdmin });
    } catch (err) {
      console.error('features', err && err.stack ? err.stack : err);
      return res.status(500).json({ error: 'שגיאת שרת' });
    }
  });

  app.use('/api/admin', requireAdmin, (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });

  app.get('/api/admin/flags', async (req, res) => {
    try {
      return res.json({ flags: await admin.listFlags() });
    } catch (err) {
      console.error('admin flags', err);
      return res.status(500).json({ error: 'שגיאת שרת' });
    }
  });

  app.post('/api/admin/flags', writeLimiter, async (req, res) => {
    const body = req.body || {};
    const key = typeof body.key === 'string' ? body.key.trim() : '';
    const description = cleanDescription(body.description) || '';
    const state = body.state === undefined ? 'off' : body.state;
    if (!FLAG_KEY_PATTERN.test(key)) {
      return res.status(400).json({ error: 'מזהה לא תקין: אותיות לטיניות קטנות, ספרות ומקפים, 2-49 תווים, מתחיל באות' });
    }
    if (!isFlagState(state)) return res.status(400).json({ error: 'מצב לא תקין' });
    try {
      const flag = await admin.createFlag({ key, description, state }, req.admin);
      if (!flag) return res.status(409).json({ error: 'פיצ׳ר בשם הזה כבר קיים' });
      return res.status(201).json({ flag });
    } catch (err) {
      console.error('admin flag create', err);
      return res.status(500).json({ error: 'שגיאת שרת' });
    }
  });

  app.patch('/api/admin/flags/:key', writeLimiter, async (req, res) => {
    const body = req.body || {};
    const patch = {};
    if (body.state !== undefined) {
      if (!isFlagState(body.state)) return res.status(400).json({ error: 'מצב לא תקין' });
      patch.state = body.state;
    }
    if (body.description !== undefined) {
      const description = cleanDescription(body.description);
      if (description === null) return res.status(400).json({ error: 'תיאור לא תקין' });
      patch.description = description;
    }
    if (!Object.keys(patch).length) return res.status(400).json({ error: 'אין מה לעדכן' });
    try {
      const flag = await admin.updateFlag(String(req.params.key), patch, req.admin);
      if (!flag) return res.status(404).json({ error: 'לא נמצא' });
      return res.json({ flag });
    } catch (err) {
      console.error('admin flag update', err);
      return res.status(500).json({ error: 'שגיאת שרת' });
    }
  });

  // The flags the code defines are re-created on the next start, so
  // deleting one would only look like it worked; they are switched off
  // instead.
  app.delete('/api/admin/flags/:key', writeLimiter, async (req, res) => {
    const key = String(req.params.key);
    if (FLAG_DEFINITIONS.some((f) => f.key === key)) {
      return res.status(409).json({ error: 'פיצ׳ר שמוגדר בקוד אי אפשר למחוק - אפשר לכבות אותו' });
    }
    try {
      if (!(await admin.deleteFlag(key, req.admin))) return res.status(404).json({ error: 'לא נמצא' });
      return res.json({ ok: true });
    } catch (err) {
      console.error('admin flag delete', err);
      return res.status(500).json({ error: 'שגיאת שרת' });
    }
  });

  app.get('/api/admin/audit', async (req, res) => {
    try {
      const entries = await admin.listAudit({ limit: req.query.limit, before: typeof req.query.before === 'string' ? req.query.before : null });
      return res.json({ entries });
    } catch (err) {
      console.error('admin audit', err);
      return res.status(500).json({ error: 'שגיאת שרת' });
    }
  });
}

module.exports = { mountAdminRoutes, createFlagGate };
