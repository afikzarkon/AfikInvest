// Issuing a sign-in session: a row in user_sessions (the device list in the
// settings page), a JWT that names it (`sid`), and the httpOnly cookie that
// carries it. Every way in - password, 2FA, Google/Facebook, a sign-in link,
// email verification, account restore - ends here, so every session shows
// up in the device list and the security log.
//
// "Remember me": a remembered session lasts 30 days in a persistent
// cookie; otherwise 12 hours, in a cookie that ends with the browser.
const jwt = require('jsonwebtoken');
const { requestContext } = require('./authHelpers');

const COOKIE_NAME = 'auth_token';
const REMEMBER_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const SHORT_TTL_MS = 12 * 60 * 60 * 1000;

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

function cookieOptions(remember = true, ttlMs = REMEMBER_TTL_MS) {
  return {
    ...cookieSharedAttributes(),
    httpOnly: true,
    ...(remember ? { maxAge: ttlMs } : {})
  };
}

function clearCookieAttrs() {
  return cookieSharedAttributes();
}

// Thrown by issueSession for an account an admin has blocked; the route
// error helpers turn it into a 403 with BLOCKED_MESSAGE.
const BLOCKED_MESSAGE = 'החשבון הזה חסום. לפרטים אפשר לפנות לתמיכה.';
function blockedError() {
  const err = new Error('Account blocked');
  err.code = 'ACCOUNT_BLOCKED';
  return err;
}
const isBlockedError = (err) => Boolean(err && err.code === 'ACCOUNT_BLOCKED');

function signSession(user, jwtSecret, { sid = null, ttlMs = REMEMBER_TTL_MS } = {}) {
  const claims = { sub: user.id, email: user.email, tv: user.token_version || 0 };
  if (sid) claims.sid = sid;
  return jwt.sign(claims, jwtSecret, { expiresIn: Math.floor(ttlMs / 1000), algorithm: 'HS256' });
}

// accounts: accountStore (optional - without it, a session is the JWT alone,
// as before device sessions existed).
function createSessionIssuer({ accounts, jwtSecret }) {
  return async function issueSession(req, res, user, { remember = true, method = 'password' } = {}) {
    // Every way in ends here, so a blocked account is refused here once.
    if (accounts && accounts.isBlocked && (await accounts.isBlocked(user.id))) throw blockedError();
    const ttlMs = remember ? REMEMBER_TTL_MS : SHORT_TTL_MS;
    const context = requestContext(req);
    let sid = null;
    if (accounts) {
      sid = await accounts.createSession({ userId: user.id, remember, authMethod: method, ttlMs, ...context });
      await accounts.logEvent(user.id, 'login', { ipPrefix: context.ipPrefix, userAgent: context.userAgent, meta: { method } });
    }
    const token = signSession(user, jwtSecret, { sid, ttlMs });
    res.cookie(COOKIE_NAME, token, cookieOptions(remember, ttlMs));
    return { token, sid, remember };
  };
}

module.exports = {
  COOKIE_NAME,
  REMEMBER_TTL_MS,
  SHORT_TTL_MS,
  cookieOptions,
  clearCookieAttrs,
  signSession,
  createSessionIssuer,
  BLOCKED_MESSAGE,
  isBlockedError
};
