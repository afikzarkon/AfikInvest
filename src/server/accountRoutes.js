// The settings page's server side: the profile and its picture, password
// and email changes, devices, the security log, linked sign-in providers,
// consents and email preferences, the data export, account deletion and
// the help form.
//
// Every route acts on the signed-in user only - ids from the client never
// pick whose data is read. Sensitive changes (password, email, deletion,
// 2FA) re-authenticate first (authCore.checkReauth) and are written to the
// security log, which never holds a password, token or code.
const bcrypt = require('bcryptjs');
const { getAppUrl } = require('./emailService');
const { limiter, publicUser, sendInBackground, BCRYPT_ROUNDS } = require('./authCore');
const { COOKIE_NAME, clearCookieAttrs, BLOCKED_MESSAGE, isBlockedError } = require('./authSession');
const {
  profileSchema,
  emailSchema,
  passwordSchema,
  validate,
  isDisposableEmail,
  pwnedCount,
  PWNED_MESSAGE,
  hashToken,
  randomToken,
  maskEmail,
  describeDevice,
  TERMS_VERSION
} = require('./authHelpers');
const { verifyUnsubscribe, normalizePreferences, CATEGORIES } = require('./emailPreferences');

const EMAIL_CHANGE_HOURS = 24;
const EMAIL_CANCEL_DAYS = 7;
const DELETION_GRACE_DAYS = 14;
const DELETE_CONFIRM_WORD = 'מחק';
const AVATAR_MAX_BYTES = 200 * 1024;
const PROVIDERS = ['google', 'facebook'];
// Profile extras the client may write: onboarding answers and the
// dismissed reminder. Anything else is ignored.
const EXTRA_KEYS = {
  goal: ['growth', 'income', 'retirement', 'saving', 'learning', 'other'],
  experience: ['beginner', 'intermediate', 'advanced'],
  heardFrom: ['friend', 'search', 'social', 'ad', 'article', 'other'],
  onboardingDone: 'boolean',
  profilePromptDismissed: 'boolean'
};
const SERVER_ERROR = 'שגיאת שרת';

const serverError = (res, label, err) => {
  // A sign-in reaching a blocked account (authSession.js) - not a fault.
  if (isBlockedError(err)) return res.status(403).json({ error: BLOCKED_MESSAGE, blocked: true });
  console.error(label, err && err.stack ? err.stack : err);
  return res.status(500).json({ error: SERVER_ERROR });
};
const bodyString = (req, field) => {
  const v = req.body ? req.body[field] : undefined;
  return typeof v === 'string' || typeof v === 'number' ? String(v) : '';
};

// A data URL of a JPEG/PNG/WebP whose bytes really are that format, under
// the size limit. { base64, mimeType } or an error message.
function parseAvatar(dataUrl) {
  const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ''));
  if (!m) return { error: 'יש להעלות תמונה בפורמט JPG, PNG או WebP' };
  const bytes = Buffer.from(m[2], 'base64');
  if (!bytes.length || bytes.length > AVATAR_MAX_BYTES) return { error: 'התמונה גדולה מדי' };
  const sig = {
    'image/jpeg': bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff,
    'image/png': bytes.slice(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47])),
    'image/webp': bytes.slice(0, 4).toString('ascii') === 'RIFF' && bytes.slice(8, 12).toString('ascii') === 'WEBP'
  };
  if (!sig[m[1]]) return { error: 'הקובץ אינו תמונה תקינה' };
  return { base64: bytes.toString('base64'), mimeType: m[1] };
}

const csvCell = (v) => {
  if (v === null || v === undefined) return '';
  const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
// With a byte-order mark, so Excel reads the Hebrew as UTF-8.
const toCsv = (columns, rows) => `﻿${[columns.join(','), ...rows.map((r) => columns.map((c) => csvCell(r[c])).join(','))].join('\r\n')}\r\n`;

const parseJson = (text, fallback) => {
  try {
    return typeof text === 'string' ? JSON.parse(text) : text || fallback;
  } catch {
    return fallback;
  }
};

// auth: what mountAuthRoutes returns ({ core, requireSessionUser }).
function mountAccountRoutes(app, { store, accounts, features, mailer, auth }) {
  const { core, requireSessionUser } = auth;
  const sensitiveLimiter = limiter({ windowMs: 15 * 60 * 1000, limit: 10, message: 'יותר מדי ניסיונות, נסו שוב בעוד כמה דקות' });
  const tokenLimiter = limiter({ windowMs: 15 * 60 * 1000, limit: 20, message: 'יותר מדי ניסיונות, נסו שוב בעוד כמה דקות' });
  const exportLimiter = limiter({ windowMs: 60 * 60 * 1000, limit: 10, message: 'יותר מדי בקשות ייצוא, נסו שוב בעוד שעה' });
  const supportLimiter = limiter({ windowMs: 60 * 60 * 1000, limit: 5, message: 'יותר מדי פניות, נסו שוב בעוד שעה' });

  const createdAtOf = async (userId) => {
    const row = await store.sql.get('SELECT created_at FROM users WHERE id = ?', [userId]);
    return row ? String(row.created_at) : null;
  };

  // ----- the summary the settings page opens with -----
  app.get('/api/account', requireSessionUser, async (req, res) => {
    try {
      const user = req.user;
      const [profile, providers, consents, backupCodesLeft, sessions, createdAt] = await Promise.all([
        accounts.getProfile(user.id),
        accounts.listOAuthAccounts(user.id),
        accounts.listConsents(user.id),
        accounts.countUnusedBackupCodes(user.id),
        accounts.listActiveSessions(user.id),
        createdAtOf(user.id)
      ]);
      return res.json({
        user: { ...publicUser(user), createdAt },
        profile,
        providers,
        availableProviders: PROVIDERS.filter((p) =>
          p === 'google'
            ? process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET
            : process.env.FACEBOOK_APP_ID && process.env.FACEBOOK_APP_SECRET
        ),
        consents,
        needsTerms: Boolean(profile.extra && profile.extra.termsPending),
        security: {
          twoFactorEnabled: Boolean(user.totp_enabled),
          backupCodesLeft,
          emailVerified: Boolean(user.email_verified_at),
          hasPassword: user.password_set !== false,
          providerCount: providers.length,
          sessionCount: sessions.length
        }
      });
    } catch (err) {
      return serverError(res, 'account/summary', err);
    }
  });

  // ----- profile -----
  app.put('/api/account/profile', requireSessionUser, async (req, res) => {
    const parsed = validate(profileSchema, req.body);
    if (!parsed.ok) return res.status(400).json({ error: parsed.error, fieldErrors: parsed.fieldErrors });
    try {
      await accounts.updateProfile(req.user.id, parsed.data);
      return res.json({ profile: await accounts.getProfile(req.user.id) });
    } catch (err) {
      return serverError(res, 'account/profile', err);
    }
  });

  app.put('/api/account/profile/extra', requireSessionUser, async (req, res) => {
    const src = req.body && typeof req.body === 'object' ? req.body : {};
    const patch = {};
    for (const [key, rule] of Object.entries(EXTRA_KEYS)) {
      if (!(key in src)) continue;
      const v = src[key];
      if (v === null) patch[key] = null;
      else if (rule === 'boolean' && typeof v === 'boolean') patch[key] = v;
      else if (Array.isArray(rule) && rule.includes(v)) patch[key] = v;
      else return res.status(400).json({ error: 'ערך לא תקין' });
    }
    try {
      return res.json({ extra: await accounts.updateProfileExtra(req.user.id, patch) });
    } catch (err) {
      return serverError(res, 'account/profile/extra', err);
    }
  });

  app.get('/api/account/avatar', requireSessionUser, async (req, res) => {
    try {
      const avatar = await accounts.getAvatar(req.user.id);
      res.set('Cache-Control', 'private, no-store');
      return res.json({ dataUrl: avatar ? `data:${avatar.mimeType};base64,${avatar.base64}` : null });
    } catch (err) {
      return serverError(res, 'account/avatar', err);
    }
  });

  // The picture arrives already cropped and re-encoded in the browser
  // (which also drops its metadata); here it is only checked.
  app.put('/api/account/avatar', requireSessionUser, async (req, res) => {
    const parsed = parseAvatar(bodyString(req, 'dataUrl'));
    if (parsed.error) return res.status(400).json({ error: parsed.error });
    try {
      await accounts.setAvatar(req.user.id, parsed.base64, parsed.mimeType);
      return res.json({ ok: true });
    } catch (err) {
      return serverError(res, 'account/avatar/put', err);
    }
  });

  app.delete('/api/account/avatar', requireSessionUser, async (req, res) => {
    try {
      await accounts.deleteAvatar(req.user.id);
      return res.json({ ok: true });
    } catch (err) {
      return serverError(res, 'account/avatar/delete', err);
    }
  });

  // ----- password: change it, or set one on an account that has none -----
  // Every other device is signed out; this one gets a new session.
  app.post('/api/account/password', requireSessionUser, sensitiveLimiter, async (req, res) => {
    const user = req.user;
    const parsed = validate(passwordSchema, bodyString(req, 'newPassword'));
    if (!parsed.ok) return res.status(400).json({ error: parsed.error, fieldErrors: { newPassword: parsed.error } });
    try {
      const check = await core.checkReauth(req, user, { password: bodyString(req, 'currentPassword') });
      if (!check.ok) return res.status(check.status).json({ error: check.error, reauth: check.reauth, fieldErrors: { currentPassword: check.error } });
      if ((await pwnedCount(parsed.data)) > 0) return res.status(400).json({ error: PWNED_MESSAGE, fieldErrors: { newPassword: PWNED_MESSAGE } });
      const wasSet = user.password_set === false;
      await accounts.setPassword(user.id, await bcrypt.hash(parsed.data, BCRYPT_ROUNDS), { bump: false });
      await core.endAllSessions(user.id);
      await core.log(req, user.id, wasSet ? 'password_set' : 'password_changed');
      sendInBackground('password-changed', () =>
        mailer.sendAccountEmail(user.email, 'passwordChanged', { resetUrl: `${getAppUrl()}/?mode=forgot`, wasSet })
      );
      const fresh = await store.getAuthUser(user.id);
      const { token } = await core.issueSession(req, res, fresh, { remember: true, method: wasSet ? 'password_set' : 'password_change' });
      return res.json({ user: publicUser(fresh), token });
    } catch (err) {
      return serverError(res, 'account/password', err);
    }
  });

  // ----- email address -----
  // The new address must confirm before anything changes; the old one is
  // told, with a link that cancels - and, if the change already went
  // through, takes the account back.
  app.post('/api/account/email', requireSessionUser, sensitiveLimiter, async (req, res) => {
    const user = req.user;
    const parsed = validate(emailSchema, bodyString(req, 'newEmail'));
    if (!parsed.ok) return res.status(400).json({ error: parsed.error, fieldErrors: { newEmail: parsed.error } });
    const newEmail = parsed.data;
    if (newEmail === user.email) return res.status(400).json({ error: 'זו כבר הכתובת של החשבון', fieldErrors: { newEmail: 'זו כבר הכתובת של החשבון' } });
    if (isDisposableEmail(newEmail)) return res.status(400).json({ error: 'לא ניתן להשתמש בכתובת אימייל זמנית', fieldErrors: { newEmail: 'לא ניתן להשתמש בכתובת אימייל זמנית' } });
    try {
      const check = await core.checkReauth(req, user, { password: bodyString(req, 'currentPassword') });
      if (!check.ok) return res.status(check.status).json({ error: check.error, reauth: check.reauth, fieldErrors: { currentPassword: check.error } });
      const appUrl = getAppUrl();
      const reply = { ok: true, message: `שלחנו קישור אישור ל-${newEmail}. הכתובת תתעדכן אחרי האישור.` };
      if (await store.findUserIdByEmail(newEmail)) {
        sendInBackground('email-change-taken', () => mailer.sendAccountEmail(newEmail, 'emailChangeTaken'));
        return res.json(reply);
      }
      const confirm = randomToken();
      await accounts.createToken({
        tokenHash: hashToken(confirm),
        purpose: 'email_change',
        userId: user.id,
        email: newEmail,
        payload: { oldEmail: user.email },
        ttlMs: EMAIL_CHANGE_HOURS * 3600 * 1000
      });
      const cancel = randomToken();
      await accounts.createToken({
        tokenHash: hashToken(cancel),
        purpose: 'email_change_cancel',
        userId: user.id,
        email: user.email,
        payload: { oldEmail: user.email, newEmail },
        ttlMs: EMAIL_CANCEL_DAYS * 86400 * 1000
      });
      await core.log(req, user.id, 'email_change_requested', { to: maskEmail(newEmail) });
      sendInBackground('email-change', () =>
        mailer.sendAccountEmail(newEmail, 'emailChangeConfirm', { link: `${appUrl}/confirm-email-change?token=${encodeURIComponent(confirm)}`, hours: EMAIL_CHANGE_HOURS })
      );
      sendInBackground('email-change-notice', () =>
        mailer.sendAccountEmail(user.email, 'emailChangeNotice', {
          newEmailMasked: maskEmail(newEmail),
          cancelLink: `${appUrl}/cancel-email-change?token=${encodeURIComponent(cancel)}`,
          days: EMAIL_CANCEL_DAYS
        })
      );
      return res.json(reply);
    } catch (err) {
      return serverError(res, 'account/email', err);
    }
  });

  // Public: opened from the email at the new address.
  app.post('/api/account/email/confirm', tokenLimiter, async (req, res) => {
    const token = bodyString(req, 'token');
    try {
      const used = token ? await accounts.consumeToken(hashToken(token), 'email_change') : null;
      if (!used) return res.status(400).json({ error: 'הקישור אינו תקין, פג תוקפו או שכבר נוצל.' });
      const changed = await accounts.changeEmail(used.userId, used.email);
      if (!changed) return res.status(409).json({ error: 'לא ניתן להשלים את השינוי. בקשו שינוי מחדש מההגדרות.' });
      core.invalidateUser(used.userId);
      await core.log(req, used.userId, 'email_changed', { to: maskEmail(used.email) });
      return res.json({ ok: true, email: used.email });
    } catch (err) {
      return serverError(res, 'account/email/confirm', err);
    }
  });

  // Public: opened from the notice at the old address.
  app.post('/api/account/email/cancel', tokenLimiter, async (req, res) => {
    const token = bodyString(req, 'token');
    try {
      const used = token ? await accounts.consumeToken(hashToken(token), 'email_change_cancel') : null;
      if (!used) return res.status(400).json({ error: 'הקישור אינו תקין, פג תוקפו או שכבר נוצל.' });
      await accounts.deleteTokens(used.userId, 'email_change');
      const user = await store.getAuthUser(used.userId);
      if (user && user.email === used.payload.newEmail) {
        // Already changed: take the account back to this address, sign
        // every device out, and offer a new password.
        await accounts.changeEmail(user.id, used.payload.oldEmail);
        await core.endAllSessions(user.id);
        const resetToken = randomToken();
        await store.createPasswordReset(user.id, hashToken(resetToken), Date.now() + 30 * 60 * 1000);
        sendInBackground('email-change-reverted', () =>
          mailer.sendAccountEmail(used.payload.oldEmail, 'emailChangeReverted', { resetUrl: `${getAppUrl()}/reset-password?token=${encodeURIComponent(resetToken)}` })
        );
      }
      await core.log(req, used.userId, 'email_change_cancelled');
      return res.json({ ok: true });
    } catch (err) {
      return serverError(res, 'account/email/cancel', err);
    }
  });

  // ----- devices -----
  app.get('/api/account/sessions', requireSessionUser, async (req, res) => {
    try {
      const sessions = await accounts.listActiveSessions(req.user.id);
      return res.json({
        currentSessionId: req.sessionId || null,
        sessions: sessions.map((s) => ({
          id: s.id,
          current: s.id === req.sessionId,
          ...describeDevice(s.userAgent),
          ipPrefix: s.ipPrefix,
          country: s.country,
          method: s.authMethod,
          createdAt: s.createdAt,
          lastSeenAt: s.lastSeenAt,
          remember: s.remember
        }))
      });
    } catch (err) {
      return serverError(res, 'account/sessions', err);
    }
  });

  app.delete('/api/account/sessions/:id', requireSessionUser, async (req, res) => {
    try {
      const id = String(req.params.id || '');
      if (!(await accounts.revokeSession(req.user.id, id))) return res.status(404).json({ error: 'המכשיר לא נמצא' });
      core.invalidateSessions([id]);
      await core.log(req, req.user.id, 'session_revoked');
      if (id === req.sessionId) res.clearCookie(COOKIE_NAME, clearCookieAttrs());
      return res.json({ ok: true, signedOut: id === req.sessionId });
    } catch (err) {
      return serverError(res, 'account/sessions/delete', err);
    }
  });

  // Every other device - including sessions from before device sessions,
  // which only a version bump reaches; this device gets a new session.
  app.post('/api/account/sessions/revoke-others', requireSessionUser, async (req, res) => {
    try {
      await core.endAllSessions(req.user.id);
      await core.log(req, req.user.id, 'other_sessions_revoked');
      const fresh = await store.getAuthUser(req.user.id);
      const current = req.sessionId ? await accounts.getSession(req.sessionId) : null;
      const { token } = await core.issueSession(req, res, fresh, { remember: current ? current.remember : true, method: current ? current.authMethod : 'password' });
      return res.json({ ok: true, token });
    } catch (err) {
      return serverError(res, 'account/sessions/revoke-others', err);
    }
  });

  app.get('/api/account/events', requireSessionUser, async (req, res) => {
    try {
      const events = await accounts.listEvents(req.user.id, 100);
      return res.json({ events: events.map((e) => ({ ...e, ...describeDevice(e.userAgent), userAgent: undefined })) });
    } catch (err) {
      return serverError(res, 'account/events', err);
    }
  });

  // ----- linked sign-in providers -----
  // Connecting starts from here, so the provider round-trip knows which
  // signed-in account to link to (oauthRoutes.js reads the intent).
  app.post('/api/account/providers/:provider/link', requireSessionUser, sensitiveLimiter, async (req, res) => {
    const provider = String(req.params.provider);
    if (!PROVIDERS.includes(provider)) return res.status(404).json({ error: 'ספק לא מוכר' });
    try {
      const intent = randomToken();
      await accounts.createToken({ tokenHash: hashToken(intent), purpose: 'oauth_link_intent', userId: req.user.id, payload: { provider }, ttlMs: 10 * 60 * 1000 });
      return res.json({ url: `/api/auth/oauth/${provider}?intent=${encodeURIComponent(intent)}` });
    } catch (err) {
      return serverError(res, 'account/providers/link', err);
    }
  });

  // The last way in cannot be removed: an account with no password keeps
  // at least one provider.
  app.delete('/api/account/providers/:provider', requireSessionUser, async (req, res) => {
    const provider = String(req.params.provider);
    try {
      const linked = await accounts.listOAuthAccounts(req.user.id);
      if (!linked.some((p) => p.provider === provider)) return res.status(404).json({ error: 'הספק אינו מחובר' });
      const remaining = linked.length - 1 + (req.user.password_set !== false ? 1 : 0);
      if (remaining < 1) {
        return res.status(400).json({ error: 'זו שיטת ההתחברות האחרונה לחשבון. הגדירו סיסמה לפני הניתוק.' });
      }
      await accounts.unlinkOAuthAccount(req.user.id, provider);
      await core.log(req, req.user.id, 'provider_unlinked', { provider });
      sendInBackground('provider-unlinked', () => mailer.sendAccountEmail(req.user.email, 'providerChanged', { provider, linked: false }));
      return res.json({ ok: true });
    } catch (err) {
      return serverError(res, 'account/providers/delete', err);
    }
  });

  // ----- consents -----
  app.put('/api/account/consents', requireSessionUser, async (req, res) => {
    try {
      for (const kind of ['marketing', 'analytics']) {
        if (req.body && typeof req.body[kind] === 'boolean') await accounts.setConsent(req.user.id, kind, req.body[kind]);
      }
      return res.json({ consents: await accounts.listConsents(req.user.id) });
    } catch (err) {
      return serverError(res, 'account/consents', err);
    }
  });

  // A new account from Google/Facebook accepts the terms here.
  app.post('/api/account/accept-terms', requireSessionUser, async (req, res) => {
    try {
      await accounts.setConsent(req.user.id, 'terms', true, TERMS_VERSION);
      if (req.body && typeof req.body.marketing === 'boolean') await accounts.setConsent(req.user.id, 'marketing', req.body.marketing);
      await accounts.updateProfileExtra(req.user.id, { termsPending: null });
      return res.json({ ok: true });
    } catch (err) {
      return serverError(res, 'account/accept-terms', err);
    }
  });

  // ----- one-click unsubscribe (public, signed link) -----
  app.post('/api/email/unsubscribe', tokenLimiter, async (req, res) => {
    const src = { ...(req.query || {}), ...(req.body && typeof req.body === 'object' ? req.body : {}) };
    const userId = Number(src.u);
    const category = String(src.c || '');
    if (!Number.isInteger(userId) || !verifyUnsubscribe(userId, category, src.s)) {
      return res.status(400).json({ error: 'הקישור אינו תקין' });
    }
    try {
      const current = normalizePreferences(await features.getPreferences(userId, 'notifications'));
      const next = { ...current };
      (category === 'all' ? CATEGORIES : [category]).forEach((c) => {
        next[c] = false;
      });
      await features.setPreferences(userId, 'notifications', next);
      if (category === 'all' || category === 'product_updates') await accounts.setConsent(userId, 'marketing', false);
      return res.json({ ok: true, category });
    } catch (err) {
      return serverError(res, 'email/unsubscribe', err);
    }
  });

  // ----- export everything -----
  async function collectExport(userId) {
    const [user, profile, avatar, consents, providers, sessions, events, portfolioJson, transactions, snapshots, monthly, targets, alerts, alertSettings] =
      await Promise.all([
        store.getAuthUser(userId),
        accounts.getProfile(userId),
        accounts.getAvatar(userId),
        accounts.listConsents(userId),
        accounts.listOAuthAccounts(userId),
        accounts.listActiveSessions(userId),
        accounts.listEvents(userId, 1000),
        store.getPortfolioPayload(userId),
        store.listTransactions ? store.listTransactions(userId) : [],
        store.listPortfolioSnapshots ? store.listPortfolioSnapshots(userId) : [],
        store.listMonthlySnapshots ? store.listMonthlySnapshots(userId) : [],
        store.getRebalanceTargets ? store.getRebalanceTargets(userId) : null,
        features.listAlerts ? features.listAlerts(userId, { limit: 10000 }) : [],
        features.getAlertSettings ? features.getAlertSettings(userId) : null
      ]);
    const preferences = {};
    for (const ns of ['recommendations', 'display', 'investments', 'notifications']) {
      preferences[ns] = await features.getPreferences(userId, ns);
    }
    return {
      exportedAt: new Date().toISOString(),
      app: 'AfikInvest',
      account: {
        email: user.email,
        createdAt: await createdAtOf(userId),
        emailVerified: Boolean(user.email_verified_at),
        twoFactorEnabled: Boolean(user.totp_enabled),
        hasPassword: user.password_set !== false
      },
      profile: { ...profile, avatar: avatar ? `data:${avatar.mimeType};base64,${avatar.base64}` : null },
      consents,
      linkedProviders: providers,
      preferences,
      portfolio: parseJson(portfolioJson, null),
      transactions,
      portfolioSnapshots: snapshots,
      monthlySnapshots: monthly,
      rebalanceTargets: targets,
      alerts,
      alertSettings,
      activeSessions: sessions.map((s) => ({ ...describeDevice(s.userAgent), createdAt: s.createdAt, lastSeenAt: s.lastSeenAt, method: s.authMethod })),
      securityLog: events.map((e) => ({ type: e.type, createdAt: e.createdAt, ipPrefix: e.ipPrefix, ...describeDevice(e.userAgent) }))
    };
  }

  const stamp = () => new Date().toISOString().slice(0, 10);

  app.get('/api/account/export', requireSessionUser, exportLimiter, async (req, res) => {
    try {
      const data = await collectExport(req.user.id);
      await core.log(req, req.user.id, 'data_exported', { format: 'json' });
      res.set('Cache-Control', 'no-store');
      res.set('Content-Disposition', `attachment; filename="afikinvest-export-${stamp()}.json"`);
      return res.type('application/json').send(JSON.stringify(data, null, 2));
    } catch (err) {
      return serverError(res, 'account/export', err);
    }
  });

  // The holdings and the transactions, one CSV each.
  app.get('/api/account/export/:file', requireSessionUser, exportLimiter, async (req, res) => {
    const file = String(req.params.file);
    if (!['holdings.csv', 'transactions.csv'].includes(file)) return res.status(404).json({ error: 'קובץ לא מוכר' });
    try {
      let csv;
      if (file === 'holdings.csv') {
        const portfolio = parseJson(await store.getPortfolioPayload(req.user.id), {}) || {};
        const rows = [];
        Object.entries(portfolio).forEach(([category, items]) => {
          if (!Array.isArray(items)) return;
          items.forEach((item) => rows.push({ category, ...item }));
        });
        const columns = ['category', ...[...new Set(rows.flatMap((r) => Object.keys(r)))].filter((c) => c !== 'category')];
        csv = toCsv(columns, rows);
      } else {
        const rows = store.listTransactions ? await store.listTransactions(req.user.id) : [];
        const columns = [...new Set(rows.flatMap((r) => Object.keys(r)))];
        csv = toCsv(columns, rows);
      }
      await core.log(req, req.user.id, 'data_exported', { format: file });
      res.set('Cache-Control', 'no-store');
      res.set('Content-Disposition', `attachment; filename="afikinvest-${file.replace('.csv', '')}-${stamp()}.csv"`);
      return res.type('text/csv; charset=utf-8').send(csv);
    } catch (err) {
      return serverError(res, 'account/export/csv', err);
    }
  });

  // ----- deleting the account -----
  // Re-authenticated, confirmed by typing the word, then a 14-day grace
  // period: signing in during it offers a restore; afterwards the purge
  // job (jobs.js) deletes everything. The reason given is kept apart,
  // with nothing that leads back to the account.
  app.post('/api/account/delete', requireSessionUser, sensitiveLimiter, async (req, res) => {
    const user = req.user;
    if (bodyString(req, 'confirm').trim() !== DELETE_CONFIRM_WORD) {
      return res.status(400).json({ error: `יש להקליד "${DELETE_CONFIRM_WORD}" לאישור`, fieldErrors: { confirm: `יש להקליד "${DELETE_CONFIRM_WORD}"` } });
    }
    try {
      const check = await core.checkReauth(req, user, { password: bodyString(req, 'password'), code: bodyString(req, 'code'), requireCode: true });
      if (!check.ok) return res.status(check.status).json({ error: check.error, reauth: check.reauth });
      const purgeAfter = new Date(Date.now() + DELETION_GRACE_DAYS * 86400 * 1000).toISOString();
      await accounts.markDeleted(user.id, purgeAfter);
      await core.endAllSessions(user.id);
      await core.log(req, user.id, 'account_deletion_requested');
      const reason = bodyString(req, 'reason');
      const comment = bodyString(req, 'comment');
      if (reason || comment) await accounts.recordDeletionFeedback(reason, comment);
      sendInBackground('deletion-scheduled', () => mailer.sendAccountEmail(user.email, 'deletionScheduled', { purgeAfter, loginUrl: `${getAppUrl()}/` }));
      res.clearCookie(COOKIE_NAME, clearCookieAttrs());
      return res.json({ ok: true, purgeAfter });
    } catch (err) {
      return serverError(res, 'account/delete', err);
    }
  });

  // ----- help: contact, feedback, suggestions -----
  // Goes to the app's own mailbox, with the user's address to reply to.
  app.post('/api/account/support', requireSessionUser, supportLimiter, async (req, res) => {
    const kind = ['contact', 'feedback', 'suggestion', 'bug'].includes(bodyString(req, 'kind')) ? bodyString(req, 'kind') : 'contact';
    const message = bodyString(req, 'message').trim().slice(0, 3000);
    if (message.length < 5) return res.status(400).json({ error: 'כתבו כמה מילים על הפנייה', fieldErrors: { message: 'כתבו כמה מילים על הפנייה' } });
    const supportAddress = String(process.env.SUPPORT_EMAIL || process.env.EMAIL_USER || '').trim();
    if (!supportAddress) return res.status(503).json({ error: 'שליחת פניות אינה זמינה כרגע' });
    const labels = { contact: 'פנייה', feedback: 'משוב', suggestion: 'הצעה', bug: 'דיווח על תקלה' };
    try {
      const { escapeHtml } = require('./emails/html');
      await mailer.send(
        supportAddress,
        {
          subject: `[AfikInvest] ${labels[kind]} מ-${req.user.email}`,
          text: `${labels[kind]} מ-${req.user.email} (משתמש ${req.user.id}):\n\n${message}`,
          html: `<div dir="rtl" style="font-family:Arial,sans-serif;white-space:pre-wrap;">${escapeHtml(`${labels[kind]} מ-${req.user.email} (משתמש ${req.user.id}):\n\n${message}`)}</div>`
        },
        { replyTo: req.user.email }
      );
      return res.json({ ok: true });
    } catch (err) {
      return serverError(res, 'account/support', err);
    }
  });

  // The running server's version, for the help section.
  app.get('/api/version', (req, res) => {
    const pkg = require('../../package.json');
    const commit = String(process.env.RENDER_GIT_COMMIT || process.env.GIT_COMMIT || '').slice(0, 7);
    res.json({ version: pkg.version, commit: commit || null });
  });
}

module.exports = { mountAccountRoutes, parseAvatar, DELETE_CONFIRM_WORD, DELETION_GRACE_DAYS };
