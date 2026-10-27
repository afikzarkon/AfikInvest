// Feature flags and the admin API.
//
//   GET    /api/features            -> { flags: [key...], isAdmin, adminActive, needs2fa }   (anyone)
//          the flags that are ON for the caller - a signed-out visitor and
//          an ordinary user get only what is open to everyone, so a flag
//          kept for admins is not even named to them.
//
// Admin only. Every request is checked on the server against the database:
// the admin role (user_roles) AND two-factor sign-in on the account
// (adminStore.isActiveAdmin). Nothing the client sends grants anything.
//
//   flags     GET /api/admin/flags · POST /api/admin/flags · PATCH|DELETE /api/admin/flags/:key
//   users     GET /api/admin/users?q&limit&offset
//             POST /api/admin/users/:id/block {reason} · /unblock · /revoke-sessions · /password-reset
//   admins    GET|POST /api/admin/admins {email} · DELETE /api/admin/admins/:id
//   settings  GET /api/admin/settings · PUT /api/admin/settings/banner · PUT /api/admin/settings/maintenance
//   insight   GET /api/admin/stats · GET|DELETE /api/admin/errors · GET /api/admin/jobs?status
//             GET /api/admin/sources (third-party data sources, sourceHealth.js)
//   export    GET /api/admin/export/users.csv · GET /api/admin/export/audit.csv
//   log       GET /api/admin/audit?limit&before
//
// What an admin can NOT see, by design: anything inside a user's portfolio
// (holdings, amounts, transactions), passwords or their hashes, 2FA secrets
// and backup codes, and sign-in tokens. The user endpoints return account
// status only. Every change - and every export - is written to
// admin_audit_log.
//
// createFlagGate() is the server half of hiding a feature: an API that
// belongs to a switched-off feature answers 404, as if it did not exist,
// whatever the client shows or does.
const { readAuthUserFromRequest, getJwtSecret, normalizeEmail } = require('./authRoutes');
const { requestContext } = require('./authHelpers');
const { createRateLimiter } = require('./rateLimit');
const { scrub } = require('./errorLog');
const { sourceHealth } = require('./sourceHealth');
const { yahooCooldownState } = require('./yahooQuotes');
const { fmpPlanState } = require('./fmpClient');
const { FLAG_DEFINITIONS, FLAG_KEY_PATTERN, isFlagState, flagVisibleTo, defaultFlagStates } = require('../shared/featureFlags');

const MAX_DESCRIPTION = 300;
const MAX_TEXT = 500;
const BANNER_LEVELS = ['info', 'warning', 'critical'];
const SERVER_ERROR = 'שגיאת שרת';

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
    return admin.isActiveAdmin(optionalUserId(req));
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

const cleanText = (value, max) => (typeof value === 'string' ? value.trim().slice(0, max) : null);

// One CSV cell. A leading = + - @ (or tab/CR) is neutralised, so a value
// cannot run as a formula when the file is opened in a spreadsheet.
function csvCell(value) {
  let s = value === null || value === undefined ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// The BOM makes Excel read the Hebrew as UTF-8.
function sendCsv(res, filename, header, rows) {
  const body = [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n');
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="${filename}"`);
  return res.send(`﻿${body}\r\n`);
}

// accounts: accountStore (blocks, sessions). auth: what mountAuthRoutes
// returns (core.endAllSessions, sendPasswordReset). features: the job queue.
function mountAdminRoutes(app, { admin, store, accounts, auth, features }) {
  const writeLimiter = createRateLimiter({
    windowMs: 60 * 1000,
    max: 30,
    message: 'יותר מדי שינויים, נסה שוב בעוד דקה',
    keyFn: (req) => `admin-write:${req.admin.id}`
  });
  const exportLimiter = createRateLimiter({
    windowMs: 10 * 60 * 1000,
    max: 10,
    message: 'יותר מדי ייצואים, נסה שוב בעוד כמה דקות',
    keyFn: (req) => `admin-export:${req.admin.id}`
  });

  const fail = (res, label, err) => {
    console.error(label, err && err.stack ? err.stack : err);
    return res.status(500).json({ error: SERVER_ERROR });
  };

  // 401 without a valid session; 403 for anyone who is not an admin in the
  // database right now, or is one without two-factor sign-in (code
  // admin_2fa_required, so the panel can say what to do). req.admin =
  // { id, email, ipPrefix } - the actor the audit log records, with the
  // address read fresh from the account.
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
      const status = await admin.adminStatus(userId);
      if (!status.isAdmin) return res.status(403).json({ error: 'אין הרשאה' });
      if (!status.active) {
        return res.status(403).json({ error: 'פאנל הניהול דורש אימות דו-שלבי. יש להפעיל אותו בהגדרות ← אבטחה.', code: 'admin_2fa_required' });
      }
      req.admin = { id: userId, email: user.email, ipPrefix: requestContext(req).ipPrefix };
      return next();
    } catch (err) {
      return fail(res, 'admin auth', err);
    }
  }

  // A user the admin acts on: { id, email } or a 404 already sent.
  async function targetUser(req, res) {
    const id = Number(req.params.id);
    const user = Number.isInteger(id) && id > 0 ? await store.getAuthUser(id) : null;
    if (!user) {
      res.status(404).json({ error: 'משתמש לא נמצא' });
      return null;
    }
    return user;
  }

  app.get('/api/features', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      const userId = optionalUserId(req);
      const [states, status] = await Promise.all([admin.getFlagStates(), admin.adminStatus(userId)]);
      const flags = Object.keys(states).filter((key) => flagVisibleTo(states[key], status.active));
      return res.json({ flags, isAdmin: status.isAdmin, adminActive: status.active, needs2fa: status.needs2fa });
    } catch (err) {
      return fail(res, 'features', err);
    }
  });

  app.use('/api/admin', requireAdmin, (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });

  // ----- feature flags -----
  app.get('/api/admin/flags', async (req, res) => {
    try {
      return res.json({ flags: await admin.listFlags() });
    } catch (err) {
      return fail(res, 'admin flags', err);
    }
  });

  app.post('/api/admin/flags', writeLimiter, async (req, res) => {
    const body = req.body || {};
    const key = typeof body.key === 'string' ? body.key.trim() : '';
    const description = cleanText(body.description, MAX_DESCRIPTION) || '';
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
      return fail(res, 'admin flag create', err);
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
      const description = cleanText(body.description, MAX_DESCRIPTION);
      if (description === null) return res.status(400).json({ error: 'תיאור לא תקין' });
      patch.description = description;
    }
    if (!Object.keys(patch).length) return res.status(400).json({ error: 'אין מה לעדכן' });
    try {
      const flag = await admin.updateFlag(String(req.params.key), patch, req.admin);
      if (!flag) return res.status(404).json({ error: 'לא נמצא' });
      return res.json({ flag });
    } catch (err) {
      return fail(res, 'admin flag update', err);
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
      return fail(res, 'admin flag delete', err);
    }
  });

  // ----- users -----
  app.get('/api/admin/users', async (req, res) => {
    try {
      const q = typeof req.query.q === 'string' ? req.query.q.slice(0, 100) : '';
      return res.json(await admin.listUsers({ q, limit: req.query.limit, offset: req.query.offset }));
    } catch (err) {
      return fail(res, 'admin users', err);
    }
  });

  // Blocking ends every session at once and stops new ones
  // (authSession.js). Not for an admin - remove the role first - and not
  // for oneself.
  app.post('/api/admin/users/:id/block', writeLimiter, async (req, res) => {
    try {
      const user = await targetUser(req, res);
      if (!user) return undefined;
      if (user.id === req.admin.id) return res.status(400).json({ error: 'אי אפשר לחסום את עצמך' });
      if (await admin.isAdmin(user.id)) return res.status(400).json({ error: 'אי אפשר לחסום אדמין - יש להסיר קודם את ההרשאה' });
      const reason = cleanText(req.body && req.body.reason, MAX_DESCRIPTION) || '';
      await accounts.blockUser(user.id, { reason, blockedBy: req.admin.email });
      await auth.core.endAllSessions(user.id);
      await admin.logAdminAction(req.admin, 'user.block', `user:${user.id}`, null, { email: user.email, reason });
      return res.json({ ok: true });
    } catch (err) {
      return fail(res, 'admin block', err);
    }
  });

  app.post('/api/admin/users/:id/unblock', writeLimiter, async (req, res) => {
    try {
      const user = await targetUser(req, res);
      if (!user) return undefined;
      if (!(await accounts.unblockUser(user.id))) return res.status(409).json({ error: 'המשתמש לא חסום' });
      await admin.logAdminAction(req.admin, 'user.unblock', `user:${user.id}`, null, { email: user.email });
      return res.json({ ok: true });
    } catch (err) {
      return fail(res, 'admin unblock', err);
    }
  });

  app.post('/api/admin/users/:id/revoke-sessions', writeLimiter, async (req, res) => {
    try {
      const user = await targetUser(req, res);
      if (!user) return undefined;
      await auth.core.endAllSessions(user.id);
      await admin.logAdminAction(req.admin, 'user.revoke_sessions', `user:${user.id}`, null, { email: user.email });
      return res.json({ ok: true });
    } catch (err) {
      return fail(res, 'admin revoke sessions', err);
    }
  });

  // Sends the user the ordinary reset email - to their own address only.
  // The admin never sees or sets a password.
  app.post('/api/admin/users/:id/password-reset', writeLimiter, async (req, res) => {
    try {
      const user = await targetUser(req, res);
      if (!user) return undefined;
      if (!(await auth.sendPasswordReset(user))) return res.status(503).json({ error: 'שליחת המייל אינה מוגדרת בשרת (APP_URL)' });
      await admin.logAdminAction(req.admin, 'user.password_reset_sent', `user:${user.id}`, null, { email: user.email });
      return res.json({ ok: true });
    } catch (err) {
      return fail(res, 'admin password reset', err);
    }
  });

  // ----- admins -----
  app.get('/api/admin/admins', async (req, res) => {
    try {
      return res.json({ admins: await admin.listAdmins(), require2fa: admin.require2fa });
    } catch (err) {
      return fail(res, 'admin admins', err);
    }
  });

  app.post('/api/admin/admins', writeLimiter, async (req, res) => {
    const email = normalizeEmail(req.body && req.body.email);
    if (!email) return res.status(400).json({ error: 'יש להזין אימייל' });
    try {
      const user = await store.findUserForLogin(email);
      if (!user || !user.email_verified_at || user.deleted_at) {
        return res.status(404).json({ error: 'אין חשבון פעיל ומאומת לכתובת הזו' });
      }
      if (await accounts.isBlocked(user.id)) return res.status(400).json({ error: 'החשבון חסום' });
      const granted = await admin.grantAdmin(user.id, req.admin.email, req.admin);
      if (!granted) return res.status(409).json({ error: 'המשתמש כבר אדמין' });
      return res.status(201).json({ admins: await admin.listAdmins() });
    } catch (err) {
      return fail(res, 'admin grant', err);
    }
  });

  app.delete('/api/admin/admins/:id', writeLimiter, async (req, res) => {
    try {
      const removed = await admin.revokeAdmin(Number(req.params.id), req.admin);
      if (!removed) return res.status(404).json({ error: 'המשתמש אינו אדמין' });
      return res.json({ admins: await admin.listAdmins() });
    } catch (err) {
      if (err && err.code === 'LAST_ADMIN') return res.status(409).json({ error: 'אי אפשר להסיר את האדמין האחרון' });
      return fail(res, 'admin revoke', err);
    }
  });

  // ----- banner and maintenance -----
  app.get('/api/admin/settings', async (req, res) => {
    try {
      const [banner, maintenance] = await Promise.all([admin.getSetting('banner'), admin.getSetting('maintenance')]);
      return res.json({ banner, maintenance });
    } catch (err) {
      return fail(res, 'admin settings', err);
    }
  });

  app.put('/api/admin/settings/banner', writeLimiter, async (req, res) => {
    const body = req.body || {};
    const text = cleanText(body.text, MAX_TEXT);
    const level = body.level === undefined ? 'info' : body.level;
    const expiresAt = body.expiresAt ? String(body.expiresAt) : null;
    if (text === null) return res.status(400).json({ error: 'טקסט לא תקין' });
    if (!BANNER_LEVELS.includes(level)) return res.status(400).json({ error: 'רמה לא תקינה' });
    if (expiresAt && Number.isNaN(Date.parse(expiresAt))) return res.status(400).json({ error: 'תאריך סיום לא תקין' });
    const active = Boolean(body.active);
    if (active && !text) return res.status(400).json({ error: 'באנר פעיל צריך טקסט' });
    try {
      const value = { active, text, level, expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null };
      return res.json({ banner: await admin.setSetting('banner', value, req.admin) });
    } catch (err) {
      return fail(res, 'admin banner', err);
    }
  });

  app.put('/api/admin/settings/maintenance', writeLimiter, async (req, res) => {
    const body = req.body || {};
    const message = body.message === undefined ? '' : cleanText(body.message, MAX_TEXT);
    if (message === null) return res.status(400).json({ error: 'הודעה לא תקינה' });
    try {
      const value = { enabled: Boolean(body.enabled), message };
      return res.json({ maintenance: await admin.setSetting('maintenance', value, req.admin) });
    } catch (err) {
      return fail(res, 'admin maintenance', err);
    }
  });

  // ----- statistics, errors, jobs -----
  app.get('/api/admin/stats', async (req, res) => {
    try {
      return res.json(await admin.getStats());
    } catch (err) {
      return fail(res, 'admin stats', err);
    }
  });

  app.get('/api/admin/errors', async (req, res) => {
    try {
      return res.json({ errors: await admin.listErrors(req.query.limit) });
    } catch (err) {
      return fail(res, 'admin errors', err);
    }
  });

  // How each outside data source is doing in this process - when it last
  // answered, when it last failed and why. Yahoo's shared cooldown is
  // shown on its row, since while it is on no request is made at all.
  app.get('/api/admin/sources', (req, res) => {
    const { cooldownUntil } = yahooCooldownState();
    const fmp = fmpPlanState();
    return res.json({
      sources: sourceHealth.snapshot({
        'yahoo-summary': { cooldownUntil },
        fmp: { cooldownUntil: fmp.cooldownUntil, note: fmp.refusedEndpoints.length ? `לא בתוכנית של המפתח: ${fmp.refusedEndpoints.join(', ')}` : null }
      })
    });
  });

  app.delete('/api/admin/errors', writeLimiter, async (req, res) => {
    try {
      return res.json({ cleared: await admin.clearErrors(req.admin) });
    } catch (err) {
      return fail(res, 'admin errors clear', err);
    }
  });

  // The background job queue. Payloads and results stay out: they can
  // name a user's holdings.
  app.get('/api/admin/jobs', async (req, res) => {
    const status = ['queued', 'running', 'done', 'failed', 'cancelled'].includes(req.query.status) ? req.query.status : null;
    try {
      const jobs = features ? await features.listJobs({ status, limit: 100 }) : [];
      return res.json({
        jobs: jobs.map((j) => ({
          id: j.id,
          name: j.name,
          status: j.status,
          attempts: j.attempts,
          maxAttempts: j.maxAttempts,
          lastError: j.lastError ? scrub(j.lastError) : null,
          runAfter: j.runAfter,
          createdAt: j.createdAt,
          updatedAt: j.updatedAt
        }))
      });
    } catch (err) {
      return fail(res, 'admin jobs', err);
    }
  });

  // ----- exports (each one is itself audited) -----
  app.get('/api/admin/export/users.csv', exportLimiter, async (req, res) => {
    try {
      const all = [];
      for (let offset = 0; ; offset += 1000) {
        const { users } = await admin.listUsers({ limit: 1000, offset });
        all.push(...users);
        if (users.length < 1000) break;
      }
      await admin.logAdminAction(req.admin, 'export.users', null, null, { rows: all.length });
      const yesNo = (b) => (b ? 'כן' : 'לא');
      return sendCsv(
        res,
        'afikinvest-users.csv',
        ['id', 'אימייל', 'נרשם', 'מאומת', 'אימות דו-שלבי', 'ספקים', 'פעילות אחרונה', 'סשנים פעילים', 'אדמין', 'חסום', 'סיבת חסימה', 'ממתין למחיקה'],
        all.map((u) => [
          u.id,
          u.email,
          u.createdAt,
          yesNo(u.emailVerified),
          yesNo(u.has2fa),
          u.providers.join(' '),
          u.lastSeenAt || '',
          u.activeSessions,
          yesNo(u.isAdmin),
          yesNo(u.blocked),
          u.blocked ? u.blocked.reason : '',
          yesNo(u.deletionPending)
        ])
      );
    } catch (err) {
      return fail(res, 'admin export users', err);
    }
  });

  app.get('/api/admin/export/audit.csv', exportLimiter, async (req, res) => {
    try {
      const all = [];
      let before = null;
      for (;;) {
        const page = await admin.listAudit({ limit: 500, before });
        all.push(...page);
        if (page.length < 500) break;
        before = page[page.length - 1].createdAt;
      }
      await admin.logAdminAction(req.admin, 'export.audit', null, null, { rows: all.length });
      return sendCsv(
        res,
        'afikinvest-admin-audit.csv',
        ['זמן', 'מבצע', 'פעולה', 'יעד', 'לפני', 'אחרי', 'רשת'],
        all.map((e) => [
          e.createdAt,
          e.actorEmail || '',
          e.action,
          e.target || '',
          e.before ? JSON.stringify(e.before) : '',
          e.after ? JSON.stringify(e.after) : '',
          e.ipPrefix || ''
        ])
      );
    } catch (err) {
      return fail(res, 'admin export audit', err);
    }
  });

  app.get('/api/admin/audit', async (req, res) => {
    try {
      const entries = await admin.listAudit({ limit: req.query.limit, before: typeof req.query.before === 'string' ? req.query.before : null });
      return res.json({ entries });
    } catch (err) {
      return fail(res, 'admin audit', err);
    }
  });
}

module.exports = { mountAdminRoutes, createFlagGate, optionalUserId, csvCell };
