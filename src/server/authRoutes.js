const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { rateLimit, ipKeyGenerator } = require('express-rate-limit');
const { PG_UNIQUE_VIOLATION } = require('./dataStore');
const { createEmailService, getAppUrl } = require('./emailService');
const { createTotpEnrollment, verifyTotp, encryptSecret, decryptSecret } = require('./totp');

const COOKIE_NAME = 'auth_token';
const BCRYPT_ROUNDS = 12;
const JWT_TTL = '7d';
const JWT_ALGORITHMS = ['HS256'];
// Between a correct password and the 2FA code.
const MFA_CHALLENGE_TTL = '5m';
const RESET_TOKEN_MINUTES = 30;
const PASSWORD_MIN = 8;
const PASSWORD_MAX = 128;
// bcrypt ignores everything after the first 72 bytes, so a longer password
// would silently be only partly checked.
const PASSWORD_MAX_BYTES = 72;

const GENERIC_FORGOT_REPLY = 'אם הכתובת רשומה במערכת, נשלח אליה קישור לאיפוס הסיסמה';

function getJwtSecret() {
  const s = process.env.JWT_SECRET;
  if (!s || String(s).trim() === '') {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('JWT_SECRET must be set in production');
    }
    return 'stockview-dev-secret-change-me';
  }
  return s;
}

// The 2FA challenge token is signed with a different key, so it can never
// pass as a session token (and a session token never as a challenge).
function getMfaSecret() {
  return crypto.createHash('sha256').update(`${getJwtSecret()}:mfa-challenge`).digest('hex');
}

function crossSiteCookies() {
  return process.env.CROSS_SITE_COOKIES === '1' || process.env.CROSS_SITE_COOKIES === 'true';
}

function cookieSharedAttributes() {
  const cross = crossSiteCookies();
  return {
    path: '/',
    sameSite: cross ? 'none' : 'lax',
    secure: cross || process.env.NODE_ENV === 'production'
  };
}

function cookieOptions() {
  return {
    ...cookieSharedAttributes(),
    httpOnly: true,
    maxAge: 7 * 24 * 60 * 60 * 1000
  };
}

function clearCookieAttrs() {
  return cookieSharedAttributes();
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function isValidEmail(email) {
  const s = normalizeEmail(email);
  if (s.length < 5 || s.length > 254) return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}

// Body fields are coerced to strings, so an object or array smuggled into
// JSON (`{"email": {"$ne": ""}}`) can never reach a query as anything else.
function bodyString(req, field) {
  const v = req.body ? req.body[field] : undefined;
  return typeof v === 'string' || typeof v === 'number' ? String(v) : '';
}

// Hebrew error text, or '' when the password is acceptable.
function passwordProblem(password) {
  if (password.length < PASSWORD_MIN) return `הסיסמה חייבת להכיל לפחות ${PASSWORD_MIN} תווים`;
  if (password.length > PASSWORD_MAX || Buffer.byteLength(password, 'utf8') > PASSWORD_MAX_BYTES) {
    return 'הסיסמה ארוכה מדי';
  }
  return '';
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
  // Marked by the session guard (security.js) when the password was reset
  // or 2FA turned on after this token was issued.
  if (req.sessionRevoked) throw new Error('Session revoked');
  return { id: payload.sub, email: payload.email, tokenSource: payload.tokenSource };
}

function signSession(user, jwtSecret) {
  return jwt.sign({ sub: user.id, email: user.email, tv: user.token_version || 0 }, jwtSecret, {
    expiresIn: JWT_TTL,
    algorithm: 'HS256'
  });
}

function publicUser(user) {
  return { id: user.id, email: user.email, twoFactorEnabled: Boolean(user.totp_enabled) };
}

function hashResetToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

// Compared against when the email is unknown, so a login for a
// non-existent account takes as long as one with a wrong password.
let dummyHashPromise = null;
function dummyHash() {
  if (!dummyHashPromise) dummyHashPromise = bcrypt.hash('stockview-timing-equalizer', BCRYPT_ROUNDS);
  return dummyHashPromise;
}

function limiter({ windowMs, limit, message, keyGenerator }) {
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { error: message || 'יותר מדי בקשות, נסה שוב מאוחר יותר' },
    ...(keyGenerator ? { keyGenerator } : {})
  });
}

// Fire-and-forget: a slow or failing mail server must neither fail the
// request nor make its timing reveal whether an account exists.
function sendInBackground(label, promiseFactory) {
  Promise.resolve()
    .then(promiseFactory)
    .catch((err) => console.error(`email/${label}`, err && err.message ? err.message : err));
}

// options.mailer: the email service (tests pass a fake).
// options.sessionGuard: security.js's guard, told when a version is bumped.
function mountAuthRoutes(app, store, options = {}) {
  const JWT_SECRET = getJwtSecret();
  const mailer = options.mailer || createEmailService();
  const invalidateSession = (userId) => {
    if (options.sessionGuard) options.sessionGuard.invalidate(userId);
  };

  const loginLimiter = limiter({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    message: 'יותר מדי ניסיונות התחברות, נסה שוב בעוד כמה דקות'
  });
  const registerLimiter = limiter({
    windowMs: 60 * 60 * 1000,
    limit: 10,
    message: 'יותר מדי ניסיונות הרשמה, נסה שוב בעוד כמה דקות'
  });
  // Per client and per account, so neither one machine nor many machines
  // can work through the million 6-digit codes.
  const twoFactorIpLimiter = limiter({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    message: 'יותר מדי ניסיונות אימות, נסה שוב בעוד כמה דקות'
  });
  const twoFactorUserLimiter = limiter({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    message: 'יותר מדי ניסיונות אימות, נסה שוב בעוד כמה דקות',
    keyGenerator: (req) => {
      const sub = req.mfaUserId || (req.user && req.user.id);
      return sub ? `user:${sub}` : ipKeyGenerator(req.ip || '');
    }
  });
  const forgotIpLimiter = limiter({
    windowMs: 15 * 60 * 1000,
    limit: 5,
    message: 'יותר מדי בקשות איפוס, נסה שוב בעוד כמה דקות'
  });
  // Stops anyone from flooding one inbox with reset emails.
  const forgotEmailLimiter = limiter({
    windowMs: 60 * 60 * 1000,
    limit: 3,
    message: 'יותר מדי בקשות איפוס לכתובת זו, נסה שוב מאוחר יותר',
    keyGenerator: (req) => `email:${normalizeEmail(bodyString(req, 'email'))}`
  });
  const resetLimiter = limiter({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    message: 'יותר מדי ניסיונות, נסה שוב בעוד כמה דקות'
  });

  function issueSession(res, user) {
    const token = signSession(user, JWT_SECRET);
    res.cookie(COOKIE_NAME, token, cookieOptions());
    return token;
  }

  // Signed-in user for the 2FA settings routes, loaded fresh from the store.
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
      return next();
    } catch (err) {
      console.error('auth/session', err && err.stack ? err.stack : err);
      return res.status(500).json({ error: 'שגיאת שרת' });
    }
  }

  // Checks a code against the user's stored secret and burns its time step.
  async function checkTotp(user, code) {
    if (!user.totp_secret) return false;
    let secret;
    try {
      secret = decryptSecret(user.totp_secret);
    } catch {
      console.error(`auth/2fa: cannot decrypt the TOTP secret of user ${user.id} (TOTP_ENCRYPTION_KEY changed?)`);
      return false;
    }
    const step = verifyTotp(secret, code);
    if (step === null) return false;
    return store.claimTotpStep(user.id, step);
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
      console.error('auth/me', err && err.stack ? err.stack : err);
      return res.status(500).json({ error: 'שגיאת שרת' });
    }
  });

  app.post('/api/auth/register', registerLimiter, async (req, res) => {
    const email = normalizeEmail(bodyString(req, 'email'));
    const password = bodyString(req, 'password');

    if (!isValidEmail(email)) {
      return res.status(400).json({ error: 'כתובת אימייל לא תקינה' });
    }
    const problem = passwordProblem(password);
    if (problem) return res.status(400).json({ error: problem });

    try {
      const existing = await store.findUserIdByEmail(email);
      if (existing) {
        return res.status(409).json({ error: 'כתובת האימייל כבר רשומה במערכת' });
      }

      const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
      let userId;
      try {
        const created = await store.insertUser(email, passwordHash);
        userId = created.id;
      } catch (e) {
        if (e && (e.code === 'SQLITE_CONSTRAINT_UNIQUE' || e.code === PG_UNIQUE_VIOLATION)) {
          return res.status(409).json({ error: 'כתובת האימייל כבר רשומה במערכת' });
        }
        throw e;
      }

      const user = { id: userId, email, token_version: 0, totp_enabled: false };
      const token = issueSession(res, user);
      sendInBackground('welcome', () => mailer.sendWelcomeEmail(email));
      return res.status(201).json({ user: publicUser(user), token });
    } catch (err) {
      console.error('auth/register', err && err.stack ? err.stack : err);
      return res.status(500).json({ error: 'שגיאת שרת' });
    }
  });

  app.post('/api/auth/login', loginLimiter, async (req, res) => {
    const email = normalizeEmail(bodyString(req, 'email'));
    const password = bodyString(req, 'password');

    if (!email || !password) {
      return res.status(400).json({ error: 'יש למלא אימייל וסיסמה' });
    }

    try {
      const row = await store.findUserForLogin(email);
      const ok = await bcrypt.compare(password, row ? row.password_hash : await dummyHash());
      if (!row || !ok) {
        return res.status(401).json({ error: 'אימייל או סיסמה שגויים' });
      }

      if (row.totp_enabled) {
        // Password proven; no session until the code is too.
        const challengeToken = jwt.sign({ sub: row.id, tv: row.token_version }, getMfaSecret(), {
          expiresIn: MFA_CHALLENGE_TTL,
          algorithm: 'HS256'
        });
        return res.json({ twoFactorRequired: true, challengeToken });
      }

      const token = issueSession(res, row);
      return res.json({ user: publicUser(row), token });
    } catch (err) {
      console.error('auth/login', err && err.stack ? err.stack : err);
      return res.status(500).json({ error: 'שגיאת שרת' });
    }
  });

  // Second login step for accounts with 2FA.
  app.post(
    '/api/auth/login/2fa',
    twoFactorIpLimiter,
    (req, res, next) => {
      try {
        const payload = jwt.verify(bodyString(req, 'challengeToken'), getMfaSecret(), { algorithms: JWT_ALGORITHMS });
        req.mfaUserId = Number(payload.sub);
        req.mfaTokenVersion = Number(payload.tv) || 0;
        return next();
      } catch {
        return res.status(401).json({ error: 'פג תוקף שלב האימות, התחברו מחדש', restart: true });
      }
    },
    twoFactorUserLimiter,
    async (req, res) => {
      try {
        const user = await store.getAuthUser(req.mfaUserId);
        // A reset or 2FA change since the password step retires the challenge.
        if (!user || !user.totp_enabled || user.token_version !== req.mfaTokenVersion) {
          return res.status(401).json({ error: 'פג תוקף שלב האימות, התחברו מחדש', restart: true });
        }
        if (!(await checkTotp(user, bodyString(req, 'code')))) {
          return res.status(401).json({ error: 'קוד האימות שגוי' });
        }
        const token = issueSession(res, user);
        return res.json({ user: publicUser(user), token });
      } catch (err) {
        console.error('auth/login/2fa', err && err.stack ? err.stack : err);
        return res.status(500).json({ error: 'שגיאת שרת' });
      }
    }
  );

  app.post('/api/auth/logout', (req, res) => {
    res.clearCookie(COOKIE_NAME, clearCookieAttrs());
    return res.json({ ok: true });
  });

  // Always the same reply, whether or not the address has an account.
  app.post('/api/auth/forgot-password', forgotIpLimiter, forgotEmailLimiter, async (req, res) => {
    const email = normalizeEmail(bodyString(req, 'email'));
    if (!isValidEmail(email)) {
      return res.status(400).json({ error: 'כתובת אימייל לא תקינה' });
    }
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
          await store.createPasswordReset(user.id, hashResetToken(token), expiresAt);
          const link = `${appUrl}/reset-password?token=${encodeURIComponent(token)}`;
          sendInBackground('reset', () => mailer.sendPasswordResetEmail(user.email, link, RESET_TOKEN_MINUTES));
        }
      }
      return res.json({ ok: true, message: GENERIC_FORGOT_REPLY });
    } catch (err) {
      console.error('auth/forgot-password', err && err.stack ? err.stack : err);
      return res.status(500).json({ error: 'שגיאת שרת' });
    }
  });

  // Lets the reset page say "this link has expired" before the user types a
  // new password. POST so the token stays out of access logs.
  app.post('/api/auth/reset-password/verify', resetLimiter, async (req, res) => {
    const token = bodyString(req, 'token');
    if (!token) return res.json({ valid: false });
    try {
      const found = await store.findPasswordReset(hashResetToken(token), Date.now());
      return res.json({ valid: Boolean(found) });
    } catch (err) {
      console.error('auth/reset-password/verify', err && err.stack ? err.stack : err);
      return res.status(500).json({ error: 'שגיאת שרת' });
    }
  });

  app.post('/api/auth/reset-password', resetLimiter, async (req, res) => {
    const token = bodyString(req, 'token');
    const password = bodyString(req, 'password');
    if (!token) return res.status(400).json({ error: 'קישור האיפוס אינו תקין' });
    const problem = passwordProblem(password);
    if (problem) return res.status(400).json({ error: problem });

    try {
      const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
      const done = await store.consumePasswordReset(hashResetToken(token), Date.now(), passwordHash);
      if (!done) {
        return res.status(400).json({ error: 'קישור האיפוס פג תוקף או כבר נוצל. בקשו קישור חדש.' });
      }
      invalidateSession(done.userId);
      // Every session, including this browser's, was just revoked.
      res.clearCookie(COOKIE_NAME, clearCookieAttrs());
      return res.json({ ok: true });
    } catch (err) {
      console.error('auth/reset-password', err && err.stack ? err.stack : err);
      return res.status(500).json({ error: 'שגיאת שרת' });
    }
  });

  // --- 2FA management (signed-in) ---

  // Step 1: a fresh secret, stored as pending until a code proves the app
  // has it. Refused while 2FA is on - replacing the secret would quietly
  // turn the protection off.
  app.post('/api/auth/2fa/setup', requireSessionUser, twoFactorUserLimiter, async (req, res) => {
    if (req.user.totp_enabled) {
      return res.status(409).json({ error: 'אימות דו-שלבי כבר פעיל בחשבון' });
    }
    try {
      const enrollment = await createTotpEnrollment(req.user.email);
      await store.setPendingTotpSecret(req.user.id, encryptSecret(enrollment.secret));
      return res.json({
        qrCodeDataUrl: enrollment.qrCodeDataUrl,
        secret: enrollment.secret,
        otpauthUrl: enrollment.otpauthUrl
      });
    } catch (err) {
      console.error('auth/2fa/setup', err && err.stack ? err.stack : err);
      return res.status(500).json({ error: 'שגיאת שרת' });
    }
  });

  // Step 2: the first code from the app turns 2FA on. That also revokes
  // every other session, so this browser gets a new token.
  app.post('/api/auth/2fa/enable', requireSessionUser, twoFactorUserLimiter, async (req, res) => {
    if (req.user.totp_enabled) {
      return res.status(409).json({ error: 'אימות דו-שלבי כבר פעיל בחשבון' });
    }
    if (!req.user.totp_secret) {
      return res.status(400).json({ error: 'יש להתחיל את ההגדרה מחדש' });
    }
    try {
      if (!(await checkTotp(req.user, bodyString(req, 'code')))) {
        return res.status(400).json({ error: 'קוד האימות שגוי' });
      }
      await store.enableTotp(req.user.id);
      invalidateSession(req.user.id);
      const user = await store.getAuthUser(req.user.id);
      const token = issueSession(res, user);
      return res.json({ user: publicUser(user), token });
    } catch (err) {
      console.error('auth/2fa/enable', err && err.stack ? err.stack : err);
      return res.status(500).json({ error: 'שגיאת שרת' });
    }
  });

  // Needs both the password and a current code: a stolen session alone must
  // not be able to strip the second factor.
  app.post('/api/auth/2fa/disable', requireSessionUser, twoFactorUserLimiter, async (req, res) => {
    if (!req.user.totp_enabled) {
      return res.status(400).json({ error: 'אימות דו-שלבי אינו פעיל' });
    }
    try {
      const passwordOk = await bcrypt.compare(bodyString(req, 'password'), req.user.password_hash);
      if (!passwordOk) return res.status(401).json({ error: 'הסיסמה שגויה' });
      if (!(await checkTotp(req.user, bodyString(req, 'code')))) {
        return res.status(401).json({ error: 'קוד האימות שגוי' });
      }
      await store.disableTotp(req.user.id);
      return res.json({ user: publicUser({ ...req.user, totp_enabled: false }) });
    } catch (err) {
      console.error('auth/2fa/disable', err && err.stack ? err.stack : err);
      return res.status(500).json({ error: 'שגיאת שרת' });
    }
  });
}

module.exports = {
  mountAuthRoutes,
  getJwtSecret,
  COOKIE_NAME,
  readAuthUserFromRequest,
  readSessionPayload,
  passwordProblem
};
