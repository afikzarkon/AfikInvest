// Signing up, signing in and out, verifying the address, sign-in links,
// password reset, account restore and the 2FA routes.
//
// Nothing here says whether an address has an account: sign-up, the
// sign-in link and "forgot password" answer the same either way, and only
// the address's owner learns the difference, by email. Sign-in failures
// are one message for an unknown address and a wrong password.
//
// The shared steps (what follows a proven identity, re-authentication,
// verification emails) are authCore.js; sessions are authSession.js.
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { ipKeyGenerator } = require('express-rate-limit');
const { PG_UNIQUE_VIOLATION } = require('./dataStore');
const { createEmailService, getAppUrl } = require('./emailService');
const { createTotpEnrollment, encryptSecret } = require('./totp');
const { COOKIE_NAME, clearCookieAttrs } = require('./authSession');
const {
  createAuthCore,
  publicUser,
  limiter,
  emailKey,
  sendInBackground,
  BCRYPT_ROUNDS,
  JWT_ALGORITHMS
} = require('./authCore');
const {
  signupSchema,
  emailSchema,
  passwordSchema,
  validate,
  isDisposableEmail,
  pwnedCount,
  PWNED_MESSAGE,
  verifyTurnstile,
  hashToken,
  randomToken,
  TERMS_VERSION,
  PASSWORD_MIN,
  PASSWORD_MAX_BYTES
} = require('./authHelpers');

const RESET_TOKEN_MINUTES = 30;
const MAGIC_LINK_MINUTES = 15;

const GENERIC_FORGOT_REPLY = 'אם הכתובת רשומה במערכת, נשלח אליה קישור לאיפוס הסיסמה';
const GENERIC_MAGIC_REPLY = 'אם הכתובת רשומה במערכת, נשלח אליה קישור כניסה';
const BAD_CREDENTIALS = 'אימייל או סיסמה שגויים';
const SERVER_ERROR = 'שגיאת שרת';

function getJwtSecret() {
  const s = process.env.JWT_SECRET;
  if (!s || String(s).trim() === '') {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('JWT_SECRET must be set in production');
    }
    // Kept from the app's previous name on purpose: without
    // TOTP_ENCRYPTION_KEY, totp.js derives the key that encrypts stored 2FA
    // secrets from this value, so changing it would lock every local
    // development account out of its 2FA. Production always sets JWT_SECRET.
    return 'stockview-dev-secret-change-me';
  }
  return s;
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

// Body fields are coerced to strings, so an object or array smuggled into
// JSON (`{"email": {"$ne": ""}}`) can never reach a query as anything else.
function bodyString(req, field) {
  const v = req.body ? req.body[field] : undefined;
  return typeof v === 'string' || typeof v === 'number' ? String(v) : '';
}
const bodyBool = (req, field, fallback = false) => (req.body && typeof req.body[field] === 'boolean' ? req.body[field] : fallback);

// Hebrew error text, or '' when the password is acceptable.
function passwordProblem(password) {
  const r = validate(passwordSchema, password);
  return r.ok ? '' : r.fieldErrors._ || r.error;
}

function extractBearerToken(req) {
  const raw = req.headers && (req.headers.authorization || req.headers.Authorization);
  if (!raw) return '';
  const m = String(raw).match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : '';
}

// The verified session JWT payload, null without a token; throws on an
// invalid or expired one.
function readSessionPayload(req, jwtSecret) {
  const cookieToken = req.cookies ? req.cookies[COOKIE_NAME] : '';
  const bearerToken = extractBearerToken(req);
  const token = bearerToken || cookieToken;
  if (!token) return null;
  const payload = jwt.verify(token, jwtSecret || getJwtSecret(), { algorithms: JWT_ALGORITHMS });
  return { ...payload, tokenSource: bearerToken ? 'bearer' : 'cookie' };
}

function readAuthUserFromRequest(req, jwtSecret) {
  const payload = readSessionPayload(req, jwtSecret);
  if (!payload) return null;
  // Marked by the session guard (security.js): the password was reset, 2FA
  // turned on, this device signed out, or the account is being deleted.
  if (req.sessionRevoked) throw new Error('Session revoked');
  return { id: payload.sub, email: payload.email, tokenSource: payload.tokenSource, sessionId: payload.sid || null };
}

// Compared against when the email is unknown, so a login for a
// non-existent account takes as long as one with a wrong password.
let dummyHashPromise = null;
function dummyHash() {
  if (!dummyHashPromise) dummyHashPromise = bcrypt.hash('afikinvest-timing-equalizer', BCRYPT_ROUNDS);
  return dummyHashPromise;
}

const serverError = (res, label, err) => {
  console.error(label, err && err.stack ? err.stack : err);
  return res.status(500).json({ error: SERVER_ERROR });
};

// options.mailer: the email service (tests pass a fake).
// options.accounts: accountStore.js.
// options.sessionGuard: security.js's guard, told about revocations.
function mountAuthRoutes(app, store, options = {}) {
  const JWT_SECRET = getJwtSecret();
  const mailer = options.mailer || createEmailService();
  const { accounts } = options;
  const core = createAuthCore({ store, accounts, mailer, sessionGuard: options.sessionGuard, jwtSecret: JWT_SECRET });

  const loginLimiter = limiter({ windowMs: 15 * 60 * 1000, limit: 10, message: 'יותר מדי ניסיונות התחברות, נסה שוב בעוד כמה דקות' });
  const registerLimiter = limiter({ windowMs: 60 * 60 * 1000, limit: 10, message: 'יותר מדי ניסיונות הרשמה, נסה שוב בעוד כמה דקות' });
  const registerEmailLimiter = limiter({ windowMs: 60 * 60 * 1000, limit: 5, message: 'יותר מדי ניסיונות הרשמה, נסה שוב מאוחר יותר', keyGenerator: emailKey });
  // Per client and per account, so neither one machine nor many machines
  // can work through the million 6-digit codes.
  const twoFactorIpLimiter = limiter({ windowMs: 15 * 60 * 1000, limit: 10, message: 'יותר מדי ניסיונות אימות, נסה שוב בעוד כמה דקות' });
  const twoFactorUserLimiter = limiter({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    message: 'יותר מדי ניסיונות אימות, נסה שוב בעוד כמה דקות',
    keyGenerator: (req) => {
      const sub = req.mfaUserId || (req.user && req.user.id);
      return sub ? `user:${sub}` : ipKeyGenerator(req.ip || '');
    }
  });
  const forgotIpLimiter = limiter({ windowMs: 15 * 60 * 1000, limit: 5, message: 'יותר מדי בקשות איפוס, נסה שוב בעוד כמה דקות' });
  // Stops anyone from flooding one inbox.
  const emailInboxLimiter = limiter({
    windowMs: 60 * 60 * 1000,
    limit: 3,
    message: 'יותר מדי בקשות לכתובת זו, נסה שוב מאוחר יותר',
    keyGenerator: (req) => `email:${normalizeEmail(bodyString(req, 'email'))}`
  });
  const tokenLimiter = limiter({ windowMs: 15 * 60 * 1000, limit: 10, message: 'יותר מדי ניסיונות, נסה שוב בעוד כמה דקות' });
  const codeEmailLimiter = limiter({ windowMs: 15 * 60 * 1000, limit: 10, message: 'יותר מדי ניסיונות, נסה שוב בעוד כמה דקות', keyGenerator: emailKey });

  // Signed-in user, loaded fresh from the store.
  async function requireSessionUser(req, res, next) {
    let authUser;
    try {
      authUser = readAuthUserFromRequest(req, JWT_SECRET);
    } catch {
      return res.status(401).json({ error: 'פג תוקף או טוקן לא תקין' });
    }
    if (!authUser) return res.status(401).json({ error: 'נדרשת התחברות' });
    try {
      const user = await store.getAuthUser(Number(authUser.id));
      if (!user) return res.status(401).json({ error: 'נדרשת התחברות' });
      req.user = user;
      req.sessionId = authUser.sessionId || req.sessionId || null;
      return next();
    } catch (err) {
      return serverError(res, 'auth/session', err);
    }
  }

  app.get('/api/auth/me', async (req, res) => {
    let authUser;
    try {
      authUser = readAuthUserFromRequest(req, JWT_SECRET);
    } catch {
      res.clearCookie(COOKIE_NAME, clearCookieAttrs());
      return res.json({ user: null });
    }
    if (!authUser) return res.json({ user: null });
    try {
      const user = store.getAuthUser ? await store.getAuthUser(Number(authUser.id)) : null;
      if (!user) {
        res.clearCookie(COOKIE_NAME, clearCookieAttrs());
        return res.json({ user: null });
      }
      return res.json({ user: publicUser(user) });
    } catch (err) {
      return serverError(res, 'auth/me', err);
    }
  });

  // Public: which sign-in options to offer (the page draws only these).
  app.get('/api/auth/options', (req, res) => {
    res.json({
      providers: {
        google: Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET),
        facebook: Boolean(process.env.FACEBOOK_APP_ID && process.env.FACEBOOK_APP_SECRET)
      },
      magicLink: Boolean(accounts),
      // Where to send the browser to start a Google/Facebook sign-in.
      oauthBaseUrl: require('./oauthRoutes').apiPublicUrl(),
      turnstileSiteKey: process.env.TURNSTILE_SECRET_KEY ? process.env.TURNSTILE_SITE_KEY || '' : '',
      termsVersion: TERMS_VERSION,
      passwordMin: PASSWORD_MIN,
      passwordMaxBytes: PASSWORD_MAX_BYTES
    });
  });

  // ----- sign-up -----
  //
  // Always answers "check your email" for a valid request, whether the
  // address is new, unverified or taken. A taken address's owner gets an
  // email saying someone tried; a new one, the verification email.
  app.post('/api/auth/register', registerLimiter, registerEmailLimiter, async (req, res) => {
    const parsed = validate(signupSchema, req.body);
    if (!parsed.ok) return res.status(400).json({ error: parsed.error, fieldErrors: parsed.fieldErrors });
    const input = parsed.data;
    const accepted = { verificationRequired: true, email: input.email };

    // The honeypot: a field only bots fill in. Answered like success.
    if (input.website) return res.status(202).json(accepted);
    if (!(await verifyTurnstile(input.turnstileToken, req.ip))) {
      return res.status(400).json({ error: 'אימות האנושיות נכשל, נסו שוב', fieldErrors: { turnstile: 'נסו שוב' } });
    }
    if (isDisposableEmail(input.email)) {
      return res.status(400).json({ error: 'לא ניתן להירשם עם כתובת אימייל זמנית', fieldErrors: { email: 'לא ניתן להירשם עם כתובת אימייל זמנית' } });
    }
    if ((await pwnedCount(input.password)) > 0) {
      return res.status(400).json({ error: PWNED_MESSAGE, fieldErrors: { password: PWNED_MESSAGE } });
    }

    try {
      const passwordHash = await bcrypt.hash(input.password, BCRYPT_ROUNDS);
      const existing = await store.findUserForLogin(input.email);
      if (existing && existing.email_verified_at) {
        const appUrl = getAppUrl();
        sendInBackground('signup-existing', () =>
          mailer.sendAccountEmail(existing.email, 'signupAttemptExisting', { loginUrl: `${appUrl}/`, resetUrl: `${appUrl}/?mode=forgot` })
        );
        return res.status(202).json(accepted);
      }
      if (existing) {
        // Unverified: this sign-up gets its own verification link.
        await core.sendVerification(existing, { passwordHash });
        return res.status(202).json(accepted);
      }

      let userId;
      try {
        userId = (await store.insertUser(input.email, passwordHash)).id;
      } catch (e) {
        if (e && (e.code === 'SQLITE_CONSTRAINT_UNIQUE' || e.code === PG_UNIQUE_VIOLATION)) return res.status(202).json(accepted);
        throw e;
      }
      await accounts.setConsent(userId, 'terms', true, TERMS_VERSION);
      await accounts.setConsent(userId, 'marketing', Boolean(input.marketingOptIn));
      if (input.fullName) await accounts.updateProfile(userId, { displayName: input.fullName });
      if (input.referralCode) await accounts.updateProfileExtra(userId, { referralCode: input.referralCode });
      await core.log(req, userId, 'signup', { method: 'password' });
      await core.sendVerification({ id: userId, email: input.email }, { passwordHash });
      return res.status(202).json(accepted);
    } catch (err) {
      return serverError(res, 'auth/register', err);
    }
  });

  // After a verification, the welcome email (with its opt-out link).
  function sendWelcome(user) {
    const { unsubscribeUrlFor, oneClickUrlFor } = require('./emailPreferences');
    sendInBackground('welcome', async () => {
      const profile = await accounts.getProfile(user.id);
      const name = profile.displayName || profile.firstName || profile.providerName || '';
      return mailer.sendWelcomeEmail(user.email, {
        name,
        unsubscribeUrl: unsubscribeUrlFor(user.id, 'all'),
        oneClickUrl: oneClickUrlFor(user.id, 'all')
      });
    });
  }

  async function finishVerification(req, res, usedToken) {
    const user = await store.getAuthUser(usedToken.userId);
    if (!user) return res.status(400).json({ error: 'הקישור אינו תקין או שפג תוקפו' });
    const firstTime = !user.email_verified_at;
    const { passwordWithheld } = await core.completeVerification(user, usedToken);
    await core.log(req, user.id, 'email_verified');
    if (firstTime) sendWelcome(user);
    const fresh = await store.getAuthUser(user.id);
    const outcome = await core.loginOutcome(req, res, fresh, { remember: bodyBool(req, 'remember', true), method: 'email_verification', skipVerification: true });
    return res.json({ ...outcome, verified: true, passwordWithheld });
  }

  // The link in the email.
  app.post('/api/auth/verify-email', tokenLimiter, async (req, res) => {
    const token = bodyString(req, 'token');
    if (!token) return res.status(400).json({ error: 'הקישור אינו תקין' });
    try {
      const used = await accounts.consumeToken(hashToken(token), 'verify_email');
      if (!used) return res.status(400).json({ error: 'הקישור אינו תקין או שפג תוקפו. בקשו קישור חדש.', expired: true });
      return finishVerification(req, res, used);
    } catch (err) {
      return serverError(res, 'auth/verify-email', err);
    }
  });

  // The 6-digit code from the same email, typed on the sign-up screen.
  app.post('/api/auth/verify-email/code', tokenLimiter, codeEmailLimiter, async (req, res) => {
    const email = normalizeEmail(bodyString(req, 'email'));
    const code = bodyString(req, 'code');
    const wrong = { error: 'הקוד שגוי או שפג תוקפו' };
    try {
      const user = email ? await store.findUserForLogin(email) : null;
      if (!user || user.email_verified_at) return res.status(400).json(wrong);
      const used = await core.findTokenByCode(user, code);
      if (!used) return res.status(400).json(wrong);
      return finishVerification(req, res, used);
    } catch (err) {
      return serverError(res, 'auth/verify-email/code', err);
    }
  });

  app.post('/api/auth/verify-email/resend', forgotIpLimiter, emailInboxLimiter, async (req, res) => {
    const email = normalizeEmail(bodyString(req, 'email'));
    try {
      const user = email ? await store.findUserForLogin(email) : null;
      if (user && !user.email_verified_at) await core.resendVerification(user);
      return res.json({ ok: true, message: 'אם הכתובת ממתינה לאימות, נשלח אליה מייל חדש' });
    } catch (err) {
      return serverError(res, 'auth/verify-email/resend', err);
    }
  });

  // ----- sign-in -----

  app.post('/api/auth/login', loginLimiter, async (req, res) => {
    const email = normalizeEmail(bodyString(req, 'email'));
    const password = bodyString(req, 'password');
    if (!email || !password) return res.status(400).json({ error: 'יש למלא אימייל וסיסמה' });

    try {
      const row = await store.findUserForLogin(email);
      const ok = await bcrypt.compare(password, row && row.password_set !== false ? row.password_hash : await dummyHash());
      if (!row || !ok || row.password_set === false) {
        if (row) await core.log(req, row.id, 'login_failed');
        return res.status(401).json({ error: BAD_CREDENTIALS });
      }
      return res.json(await core.loginOutcome(req, res, row, { remember: bodyBool(req, 'remember', true), method: 'password' }));
    } catch (err) {
      return serverError(res, 'auth/login', err);
    }
  });

  // Second step for accounts with 2FA: a code from the app, or a backup code.
  app.post(
    '/api/auth/login/2fa',
    twoFactorIpLimiter,
    (req, res, next) => {
      try {
        const challenge = core.readChallenge(bodyString(req, 'challengeToken'));
        req.mfaUserId = challenge.userId;
        req.mfaChallenge = challenge;
        return next();
      } catch {
        return res.status(401).json({ error: 'פג תוקף שלב האימות, התחברו מחדש', restart: true });
      }
    },
    twoFactorUserLimiter,
    async (req, res) => {
      try {
        const { userId, tokenVersion, remember, method } = req.mfaChallenge;
        const user = await store.getAuthUser(userId);
        // A reset or 2FA change since the first step retires the challenge.
        if (!user || !user.totp_enabled || user.token_version !== tokenVersion || user.deleted_at) {
          return res.status(401).json({ error: 'פג תוקף שלב האימות, התחברו מחדש', restart: true });
        }
        const kind = await core.checkSecondFactor(user, bodyString(req, 'code'));
        if (!kind) {
          await core.log(req, user.id, 'two_factor_failed');
          return res.status(401).json({ error: 'קוד האימות שגוי' });
        }
        if (kind === 'backup') await core.log(req, user.id, 'backup_code_used');
        const { token } = await core.issueSession(req, res, user, { remember, method });
        return res.json({ user: publicUser(user), token, remember, backupCodesLeft: kind === 'backup' ? await accounts.countUnusedBackupCodes(user.id) : undefined });
      } catch (err) {
        return serverError(res, 'auth/login/2fa', err);
      }
    }
  );

  // Ends this device's session.
  app.post('/api/auth/logout', async (req, res) => {
    try {
      const authUser = readAuthUserFromRequest(req, JWT_SECRET);
      if (authUser && authUser.sessionId && accounts) {
        await accounts.revokeSession(Number(authUser.id), authUser.sessionId);
        core.invalidateSessions([authUser.sessionId]);
        await core.log(req, Number(authUser.id), 'logout');
      }
    } catch {
      // An invalid or revoked token: there is nothing to end.
    }
    res.clearCookie(COOKIE_NAME, clearCookieAttrs());
    return res.json({ ok: true });
  });

  // ----- sign-in link (no password) -----

  app.post('/api/auth/magic-link', forgotIpLimiter, emailInboxLimiter, async (req, res) => {
    const parsedEmail = validate(emailSchema, bodyString(req, 'email'));
    if (!parsedEmail.ok) return res.status(400).json({ error: parsedEmail.error });
    const email = parsedEmail.data;
    if (!(await verifyTurnstile(bodyString(req, 'turnstileToken'), req.ip))) {
      return res.status(400).json({ error: 'אימות האנושיות נכשל, נסו שוב' });
    }
    try {
      const appUrl = getAppUrl();
      const user = await store.findUserForLogin(email);
      if (user) {
        const token = randomToken();
        await accounts.createToken({ tokenHash: hashToken(token), purpose: 'magic_link', userId: user.id, email, ttlMs: MAGIC_LINK_MINUTES * 60 * 1000 });
        const link = `${appUrl}/magic-link?token=${encodeURIComponent(token)}`;
        sendInBackground('magic', () => mailer.sendAccountEmail(email, 'magicLink', { link, minutes: MAGIC_LINK_MINUTES }));
      } else {
        sendInBackground('magic-none', () => mailer.sendAccountEmail(email, 'magicLinkNoAccount', { signupUrl: `${appUrl}/?mode=register` }));
      }
      return res.json({ ok: true, message: GENERIC_MAGIC_REPLY });
    } catch (err) {
      return serverError(res, 'auth/magic-link', err);
    }
  });

  app.post('/api/auth/magic-link/verify', tokenLimiter, async (req, res) => {
    const token = bodyString(req, 'token');
    try {
      const used = token ? await accounts.consumeToken(hashToken(token), 'magic_link') : null;
      const user = used ? await store.getAuthUser(used.userId) : null;
      if (!user) return res.status(400).json({ error: 'הקישור אינו תקין, פג תוקפו או שכבר נוצל. בקשו קישור חדש.', expired: true });
      // The link went to the address, so it is proven too.
      if (!user.email_verified_at) {
        await accounts.markEmailVerified(user.id);
        await accounts.deleteTokens(user.id, 'verify_email');
      }
      const fresh = await store.getAuthUser(user.id);
      return res.json(await core.loginOutcome(req, res, fresh, { remember: bodyBool(req, 'remember', true), method: 'magic_link' }));
    } catch (err) {
      return serverError(res, 'auth/magic-link/verify', err);
    }
  });

  // ----- restoring an account waiting out its deletion -----

  app.post('/api/auth/restore', tokenLimiter, async (req, res) => {
    let challenge;
    try {
      challenge = core.readRestore(bodyString(req, 'restoreToken'));
    } catch {
      return res.status(401).json({ error: 'פג תוקף הבקשה, התחברו מחדש', restart: true });
    }
    try {
      const user = await store.getAuthUser(challenge.userId);
      if (!user || !user.deleted_at || user.token_version !== challenge.tokenVersion) {
        return res.status(401).json({ error: 'פג תוקף הבקשה, התחברו מחדש', restart: true });
      }
      await accounts.restoreDeleted(user.id);
      await accounts.deleteTokens(user.id, 'deletion_reminder');
      core.invalidateUser(user.id);
      await core.log(req, user.id, 'account_restored');
      sendInBackground('restored', () => mailer.sendAccountEmail(user.email, 'accountRestored'));
      const fresh = await store.getAuthUser(user.id);
      return res.json(await core.loginOutcome(req, res, fresh, { remember: challenge.remember, method: challenge.method, skipRestore: true }));
    } catch (err) {
      return serverError(res, 'auth/restore', err);
    }
  });

  // ----- forgotten password -----

  // Always the same reply, whether or not the address has an account.
  app.post('/api/auth/forgot-password', forgotIpLimiter, emailInboxLimiter, async (req, res) => {
    const parsedEmail = validate(emailSchema, bodyString(req, 'email'));
    if (!parsedEmail.ok) return res.status(400).json({ error: 'כתובת אימייל לא תקינה' });
    const email = parsedEmail.data;
    try {
      const user = await store.findUserForLogin(email);
      if (user) {
        const appUrl = getAppUrl();
        if (!appUrl) {
          console.error('auth/forgot-password: APP_URL is not set - cannot build a reset link');
        } else {
          const token = crypto.randomBytes(32).toString('base64url');
          const expiresAt = Date.now() + RESET_TOKEN_MINUTES * 60 * 1000;
          // Only the hash is stored: a database leak yields no usable link.
          await store.createPasswordReset(user.id, hashToken(token), expiresAt);
          const link = `${appUrl}/reset-password?token=${encodeURIComponent(token)}`;
          sendInBackground('reset', () => mailer.sendPasswordResetEmail(user.email, link, RESET_TOKEN_MINUTES));
        }
      }
      return res.json({ ok: true, message: GENERIC_FORGOT_REPLY });
    } catch (err) {
      return serverError(res, 'auth/forgot-password', err);
    }
  });

  // Lets the reset page say "this link has expired" before the user types a
  // new password. POST so the token stays out of access logs.
  app.post('/api/auth/reset-password/verify', tokenLimiter, async (req, res) => {
    const token = bodyString(req, 'token');
    if (!token) return res.json({ valid: false });
    try {
      const found = await store.findPasswordReset(hashToken(token), Date.now());
      return res.json({ valid: Boolean(found) });
    } catch (err) {
      return serverError(res, 'auth/reset-password/verify', err);
    }
  });

  app.post('/api/auth/reset-password', tokenLimiter, async (req, res) => {
    const token = bodyString(req, 'token');
    const password = bodyString(req, 'password');
    if (!token) return res.status(400).json({ error: 'קישור האיפוס אינו תקין' });
    const problem = passwordProblem(password);
    if (problem) return res.status(400).json({ error: problem });
    if ((await pwnedCount(password)) > 0) return res.status(400).json({ error: PWNED_MESSAGE });

    try {
      const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
      const done = await store.consumePasswordReset(hashToken(token), Date.now(), passwordHash);
      if (!done) {
        return res.status(400).json({ error: 'קישור האיפוס פג תוקף או כבר נוצל. בקשו קישור חדש.' });
      }
      if (accounts) {
        // The link went to the address: it is proven, and every session ends.
        await accounts.markEmailVerified(done.userId);
        await accounts.deleteTokens(done.userId, 'verify_email');
        core.invalidateSessions(await accounts.revokeSessions(done.userId));
        await core.log(req, done.userId, 'password_reset');
      }
      core.invalidateUser(done.userId);
      // Every session, including this browser's, was just revoked.
      res.clearCookie(COOKIE_NAME, clearCookieAttrs());
      return res.json({ ok: true });
    } catch (err) {
      return serverError(res, 'auth/reset-password', err);
    }
  });

  // ----- 2FA management (signed-in) -----

  // Step 1: a fresh secret, stored as pending until a code proves the app
  // has it. Refused while 2FA is on - replacing the secret would quietly
  // turn the protection off.
  app.post('/api/auth/2fa/setup', requireSessionUser, twoFactorUserLimiter, async (req, res) => {
    if (req.user.totp_enabled) return res.status(409).json({ error: 'אימות דו-שלבי כבר פעיל בחשבון' });
    try {
      const enrollment = await createTotpEnrollment(req.user.email);
      await store.setPendingTotpSecret(req.user.id, encryptSecret(enrollment.secret));
      return res.json({ qrCodeDataUrl: enrollment.qrCodeDataUrl, secret: enrollment.secret, otpauthUrl: enrollment.otpauthUrl });
    } catch (err) {
      return serverError(res, 'auth/2fa/setup', err);
    }
  });

  // Step 2: the first code from the app turns 2FA on, hands out the backup
  // codes (shown once), and revokes every other session - so this browser
  // gets a new token.
  app.post('/api/auth/2fa/enable', requireSessionUser, twoFactorUserLimiter, async (req, res) => {
    if (req.user.totp_enabled) return res.status(409).json({ error: 'אימות דו-שלבי כבר פעיל בחשבון' });
    if (!req.user.totp_secret) return res.status(400).json({ error: 'יש להתחיל את ההגדרה מחדש' });
    try {
      if (!(await core.checkTotp(req.user, bodyString(req, 'code')))) return res.status(400).json({ error: 'קוד האימות שגוי' });
      await store.enableTotp(req.user.id);
      core.invalidateUser(req.user.id);
      const backupCodes = accounts ? await core.generateBackupCodes(req.user.id) : [];
      if (accounts) {
        core.invalidateSessions(await accounts.revokeSessions(req.user.id));
        await core.log(req, req.user.id, 'two_factor_enabled');
        sendInBackground('2fa-on', () => mailer.sendAccountEmail(req.user.email, 'twoFactorChanged', { enabled: true }));
      }
      const user = await store.getAuthUser(req.user.id);
      const { token } = await core.issueSession(req, res, user, { remember: true, method: 'two_factor_setup' });
      return res.json({ user: publicUser(user), token, backupCodes });
    } catch (err) {
      return serverError(res, 'auth/2fa/enable', err);
    }
  });

  // Needs re-authentication and a current code (or a backup code): a
  // stolen session alone must not be able to strip the second factor.
  app.post('/api/auth/2fa/disable', requireSessionUser, twoFactorUserLimiter, async (req, res) => {
    if (!req.user.totp_enabled) return res.status(400).json({ error: 'אימות דו-שלבי אינו פעיל' });
    try {
      const check = await core.checkReauth(req, req.user, { password: bodyString(req, 'password'), code: bodyString(req, 'code'), requireCode: true });
      if (!check.ok) return res.status(check.status).json({ error: check.error, reauth: check.reauth });
      await store.disableTotp(req.user.id);
      if (accounts) {
        await accounts.deleteBackupCodes(req.user.id);
        await core.log(req, req.user.id, 'two_factor_disabled');
        sendInBackground('2fa-off', () => mailer.sendAccountEmail(req.user.email, 'twoFactorChanged', { enabled: false }));
      }
      return res.json({ user: publicUser({ ...req.user, totp_enabled: false }) });
    } catch (err) {
      return serverError(res, 'auth/2fa/disable', err);
    }
  });

  // New backup codes (the old ones stop working), shown once.
  app.post('/api/auth/2fa/backup-codes', requireSessionUser, twoFactorUserLimiter, async (req, res) => {
    if (!req.user.totp_enabled) return res.status(400).json({ error: 'אימות דו-שלבי אינו פעיל' });
    try {
      const check = await core.checkReauth(req, req.user, { password: bodyString(req, 'password'), code: bodyString(req, 'code'), requireCode: true });
      if (!check.ok) return res.status(check.status).json({ error: check.error, reauth: check.reauth });
      const backupCodes = await core.generateBackupCodes(req.user.id);
      await core.log(req, req.user.id, 'backup_codes_regenerated');
      return res.json({ backupCodes });
    } catch (err) {
      return serverError(res, 'auth/2fa/backup-codes', err);
    }
  });

  return { core, requireSessionUser };
}

module.exports = {
  mountAuthRoutes,
  getJwtSecret,
  COOKIE_NAME,
  readAuthUserFromRequest,
  readSessionPayload,
  passwordProblem,
  normalizeEmail,
  bodyString
};
