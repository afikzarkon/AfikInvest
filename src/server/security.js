// HTTP-level hardening for the API: security headers, the CORS allowlist,
// a cross-site request check for state-changing requests, and the session
// revocation lookup.
const helmet = require('helmet');
const cors = require('cors');

// Origins allowed to call the API with credentials: APP_URL plus the
// comma-separated CORS_ORIGINS. Outside production, any localhost port is
// allowed too, so the CRA dev server works without configuration.
function configuredOrigins() {
  return [process.env.APP_URL, ...String(process.env.CORS_ORIGINS || '').split(',')]
    .map((o) => String(o || '').trim().replace(/\/+$/, ''))
    .filter(Boolean);
}

const LOCALHOST_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;

function isAllowedOrigin(origin) {
  const o = String(origin || '').replace(/\/+$/, '');
  if (configuredOrigins().includes(o)) return true;
  return process.env.NODE_ENV !== 'production' && LOCALHOST_ORIGIN.test(o);
}

function originOf(url) {
  try {
    return new URL(url).origin;
  } catch {
    return '';
  }
}

function corsMiddleware() {
  return cors({
    // No Origin header: a same-origin or non-browser request, which CORS
    // does not govern.
    origin: (origin, cb) => cb(null, !origin || isAllowedOrigin(origin)),
    credentials: true
  });
}

// The API only ever returns JSON, so the CSP can forbid everything: if a
// response is ever rendered as a page, nothing in it can run or be framed.
function helmetMiddleware() {
  return helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"], baseUri: ["'none'"], formAction: ["'none'"] }
    },
    referrerPolicy: { policy: 'no-referrer' },
    strictTransportSecurity: process.env.NODE_ENV === 'production' ? { maxAge: 31536000, includeSubDomains: true } : false
  });
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

// CSRF defence. The session cookie is SameSite=None when CROSS_SITE_COOKIES
// is on, so a foreign site's form or fetch would carry it. Browsers always
// send Origin on cross-origin POST/PUT/DELETE, so a state-changing request
// whose Origin (or, failing that, Referer) is neither this API nor an
// allowed front end is refused. Requests with neither header come from
// non-browser clients (the job scheduler, curl), which carry no ambient
// cookie and are authenticated explicitly.
function crossSiteRequestGuard() {
  return (req, res, next) => {
    if (SAFE_METHODS.has(req.method)) return next();
    const origin = req.get('origin') || originOf(req.get('referer') || '');
    if (!origin) return next();
    const self = `${req.protocol}://${req.get('host')}`;
    if (origin === self || isAllowedOrigin(origin)) return next();
    return res.status(403).json({ error: 'בקשה ממקור לא מורשה' });
  };
}

// Server-side session revocation. Every session JWT carries the user's
// token_version (`tv`); resetting the password or turning 2FA on bumps it,
// which retires every token issued before. The lookup is cached briefly per
// user so ordinary requests do not each hit the database; invalidate()
// clears the entry the moment this process bumps a version.
//
// Runs before every route and only marks the request - the routes' own auth
// checks (readAuthUserFromRequest) do the refusing, so public routes still
// work for a client holding a stale token.
function createSessionGuard({ ttlMs = 30 * 1000 } = {}) {
  let store = null;
  const cache = new Map(); // userId -> { version, at }

  async function currentVersion(userId) {
    const hit = cache.get(userId);
    if (hit && Date.now() - hit.at < ttlMs) return hit.version;
    const user = await store.getAuthUser(userId);
    const version = user ? user.token_version : null;
    cache.set(userId, { version, at: Date.now() });
    return version;
  }

  async function middleware(req, res, next) {
    if (!store) return next();
    const { readSessionPayload } = require('./authRoutes');
    let payload;
    try {
      payload = readSessionPayload(req);
    } catch {
      return next(); // invalid/expired - the auth checks reject it anyway
    }
    if (!payload) return next();
    try {
      const version = await currentVersion(Number(payload.sub));
      if (version === null || (Number(payload.tv) || 0) !== version) req.sessionRevoked = true;
    } catch (err) {
      // Fail closed: without the lookup, a revoked token would pass.
      console.error('session guard', err && err.message ? err.message : err);
      req.sessionRevoked = true;
    }
    return next();
  }

  return {
    middleware,
    setStore(s) {
      store = s;
    },
    invalidate(userId) {
      cache.delete(Number(userId));
    }
  };
}

function warnAboutConfiguration() {
  if (process.env.NODE_ENV !== 'production') return;
  if (!configuredOrigins().length) {
    console.warn('security: APP_URL / CORS_ORIGINS not set - browsers on other origins cannot call the API');
  }
  const { gmailApiConfigured } = require('./emailService');
  if (!process.env.EMAIL_USER || (!process.env.EMAIL_PASS && !gmailApiConfigured())) {
    console.warn('security: EMAIL_USER plus GMAIL_* (or EMAIL_PASS) not set - welcome and password-reset emails are disabled');
  } else if (!gmailApiConfigured()) {
    console.warn('security: sending mail over SMTP - hosts like Render free block SMTP ports; set GMAIL_* to use the Gmail API');
  }
}

module.exports = {
  corsMiddleware,
  helmetMiddleware,
  crossSiteRequestGuard,
  createSessionGuard,
  isAllowedOrigin,
  warnAboutConfiguration
};
