// What every way of signing in has in common, shared by authRoutes.js
// (password, sign-in link, verification), oauthRoutes.js (Google,
// Facebook) and accountRoutes.js (the settings page):
//
//   loginOutcome  - once someone has proven who they are, what happens next:
//                   an unverified address goes to verification, an account
//                   waiting out its deletion is offered a restore, 2FA asks
//                   for its code, and otherwise a session is issued.
//   reauth        - the extra proof a sensitive change needs (the password,
//                   or a fresh sign-in for an account without one; plus the
//                   2FA code where asked).
//   verification  - sending the address-confirmation link and code.
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { rateLimit, ipKeyGenerator } = require('express-rate-limit');
const { createSessionIssuer } = require('./authSession');
const { decryptSecret, verifyTotp } = require('./totp');
const { hashToken, randomToken, randomCode, safeEqual, requestContext } = require('./authHelpers');
const { getAppUrl } = require('./emailService');

const BCRYPT_ROUNDS = 12;
const JWT_ALGORITHMS = ['HS256'];
const MFA_CHALLENGE_TTL = '5m';
const RESTORE_CHALLENGE_TTL = '10m';
const VERIFY_MINUTES = 60;
const MAX_CODE_ATTEMPTS = 5;
// A session younger than this counts as a fresh sign-in, for accounts that
// have no password to re-enter.
const FRESH_SESSION_MS = 10 * 60 * 1000;
const BACKUP_CODE_COUNT = 10;

// A key of its own per kind of challenge, so no token passes as another.
function derivedSecret(jwtSecret, label) {
  return crypto.createHash('sha256').update(`${jwtSecret}:${label}`).digest('hex');
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

// Per email address, for routes that take one (case-folded, so case
// variants share a budget).
const emailKey = (req) => {
  const v = req.body && typeof req.body.email === 'string' ? req.body.email.trim().toLowerCase() : '';
  return v ? `email:${v}` : ipKeyGenerator(req.ip || '');
};

// Fire-and-forget: a slow or failing mail server must neither fail the
// request nor make its timing reveal whether an account exists.
function sendInBackground(label, promiseFactory) {
  Promise.resolve()
    .then(promiseFactory)
    .catch((err) => console.error(`email/${label}`, err && err.message ? err.message : err));
}

function publicUser(user) {
  return {
    id: user.id,
    email: user.email,
    twoFactorEnabled: Boolean(user.totp_enabled),
    emailVerified: Boolean(user.email_verified_at),
    hasPassword: user.password_set !== false
  };
}

// "abcde-fghij": 50 bits each, from an alphabet without look-alikes.
const BACKUP_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
function newBackupCode() {
  let out = '';
  for (let i = 0; i < 10; i += 1) out += BACKUP_ALPHABET[crypto.randomInt(0, BACKUP_ALPHABET.length)];
  return `${out.slice(0, 5)}-${out.slice(5)}`;
}
const normalizeBackupCode = (code) => String(code || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const hashBackupCode = (code) => hashToken(`backup:${normalizeBackupCode(code)}`);
const looksLikeBackupCode = (code) => normalizeBackupCode(code).length === 10;

function createAuthCore({ store, accounts, mailer, sessionGuard, jwtSecret }) {
  const issueSession = createSessionIssuer({ accounts, jwtSecret });
  const mfaSecret = derivedSecret(jwtSecret, 'mfa-challenge');
  const restoreSecret = derivedSecret(jwtSecret, 'restore-challenge');

  const invalidateUser = (userId) => sessionGuard && sessionGuard.invalidate(userId);
  const invalidateSessions = (ids) => sessionGuard && sessionGuard.invalidateSessions && sessionGuard.invalidateSessions(ids);

  // Everything recorded in the security log comes through here, with where
  // the request came from; meta carries labels only, never secrets.
  async function log(req, userId, type, meta = null) {
    if (!accounts) return;
    try {
      const { ipPrefix, userAgent } = requestContext(req);
      await accounts.logEvent(userId, type, { ipPrefix, userAgent, meta });
    } catch (err) {
      console.error('auth/log', err && err.message ? err.message : err);
    }
  }

  // Every session of the user ends: the version bump retires tokens from
  // before device sessions, the rows retire the rest.
  async function endAllSessions(userId, exceptSessionId = null) {
    if (!exceptSessionId) await accounts.bumpTokenVersion(userId);
    const ids = await accounts.revokeSessions(userId, exceptSessionId);
    invalidateUser(userId);
    invalidateSessions(ids);
  }

  // Checks a TOTP code against the user's secret and burns its time step.
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

  // A TOTP code, or one of the backup codes (each works once).
  async function checkSecondFactor(user, code) {
    if (looksLikeBackupCode(code)) {
      const ok = accounts ? await accounts.consumeBackupCode(user.id, hashBackupCode(code)) : false;
      return ok ? 'backup' : null;
    }
    return (await checkTotp(user, code)) ? 'totp' : null;
  }

  async function generateBackupCodes(userId) {
    const codes = Array.from({ length: BACKUP_CODE_COUNT }, newBackupCode);
    await accounts.replaceBackupCodes(userId, codes.map(hashBackupCode));
    return codes;
  }

  // ----- email verification -----

  // A link and a 6-digit code, in one email. passwordHash: the password
  // chosen at the sign-up this verifies - applied only when this token is
  // the one used (see verifyToken).
  async function sendVerification(user, { passwordHash = null } = {}) {
    const appUrl = getAppUrl();
    const token = randomToken();
    const code = randomCode();
    const tokenHash = hashToken(token);
    await accounts.createToken({
      tokenHash,
      purpose: 'verify_email',
      userId: user.id,
      email: user.email,
      payload: { codeHash: hashToken(`${tokenHash}:${code}`), passwordHash },
      ttlMs: VERIFY_MINUTES * 60 * 1000,
      // Several sign-ups for one unverified address each keep their own
      // link: a stranger's sign-up must not cancel the owner's.
      replace: false
    });
    const link = `${appUrl}/verify-email?token=${encodeURIComponent(token)}`;
    sendInBackground('verify', () => mailer.sendAccountEmail(user.email, 'verifyEmail', { link, code, minutes: VERIFY_MINUTES }));
  }

  // A resend repeats the newest pending sign-up's password choice.
  async function resendVerification(user) {
    const latest = await accounts.latestToken(user.id, 'verify_email');
    if (latest && Date.now() - Date.parse(latest.createdAt) < 60 * 1000) return; // one a minute
    await sendVerification(user, { passwordHash: latest ? latest.payload.passwordHash || null : null });
  }

  // Applies a verification: the address is proven. The password set is the
  // one chosen at the sign-up whose token was used - unless sign-ups with
  // different passwords are pending, in which case nobody's choice can be
  // trusted (someone may have pre-registered the address) and the account
  // is left without a password, to be set by the person who just proved
  // they own the address.
  async function completeVerification(user, usedToken) {
    const pending = (await accounts.listTokens(user.id, 'verify_email')).concat([usedToken]);
    const hashes = new Set(pending.map((t) => t.payload && t.payload.passwordHash).filter(Boolean));
    let passwordWithheld = false;
    if (hashes.size > 1) {
      await accounts.setUnusablePassword(user.id, await bcrypt.hash(randomToken(), BCRYPT_ROUNDS));
      passwordWithheld = true;
    } else if (usedToken.payload && usedToken.payload.passwordHash) {
      await accounts.setPassword(user.id, usedToken.payload.passwordHash, { bump: false });
    }
    await accounts.markEmailVerified(user.id);
    await accounts.deleteTokens(user.id, 'verify_email');
    invalidateUser(user.id);
    return { passwordWithheld };
  }

  // The verification token behind a code typed for an address. Every live
  // token for the account is tried; each wrong guess counts against all of
  // them, and a token is dead after five.
  async function findTokenByCode(user, code) {
    const tokens = (await accounts.listTokens(user.id, 'verify_email')).filter((t) => t.attempts < MAX_CODE_ATTEMPTS);
    const clean = String(code || '').replace(/\D/g, '');
    const match = tokens.find((t) => t.payload && t.payload.codeHash && safeEqual(t.payload.codeHash, hashToken(`${t.tokenHash}:${clean}`)));
    if (match) return accounts.consumeToken(match.tokenHash, 'verify_email');
    for (const t of tokens) await accounts.addTokenAttempt(t.tokenHash);
    return null;
  }

  // ----- what follows a proven identity -----

  function signChallenge(user, { remember, method }) {
    return jwt.sign({ sub: user.id, tv: user.token_version, rem: remember ? 1 : 0, m: method }, mfaSecret, {
      expiresIn: MFA_CHALLENGE_TTL,
      algorithm: 'HS256'
    });
  }

  function readChallenge(token) {
    const payload = jwt.verify(String(token || ''), mfaSecret, { algorithms: JWT_ALGORITHMS });
    return { userId: Number(payload.sub), tokenVersion: Number(payload.tv) || 0, remember: payload.rem === 1, method: payload.m || 'password' };
  }

  function signRestore(user, { remember, method }) {
    return jwt.sign({ sub: user.id, tv: user.token_version, rem: remember ? 1 : 0, m: method }, restoreSecret, {
      expiresIn: RESTORE_CHALLENGE_TTL,
      algorithm: 'HS256'
    });
  }

  function readRestore(token) {
    const payload = jwt.verify(String(token || ''), restoreSecret, { algorithms: JWT_ALGORITHMS });
    return { userId: Number(payload.sub), tokenVersion: Number(payload.tv) || 0, remember: payload.rem === 1, method: payload.m || 'password' };
  }

  // The JSON a sign-in answers with. skip: steps already passed.
  async function loginOutcome(req, res, user, { remember = true, method = 'password', skipVerification = false, skipRestore = false } = {}) {
    if (!user.email_verified_at && !skipVerification) {
      await resendVerification(user);
      return { verificationRequired: true, email: user.email };
    }
    if (user.deleted_at && !skipRestore) {
      return { deletionPending: true, restoreToken: signRestore(user, { remember, method }), purgeAfter: user.purge_after };
    }
    if (user.totp_enabled) {
      return { twoFactorRequired: true, challengeToken: signChallenge(user, { remember, method }) };
    }
    const { token } = await issueSession(req, res, user, { remember, method });
    return { user: publicUser(user), token, remember };
  }

  // ----- re-authentication for sensitive changes -----

  // { ok } or { ok: false, status, error, reauth } - reauth tells the page
  // what it is missing ('password', 'fresh_login', 'code').
  async function checkReauth(req, user, { password = '', code = '', requireCode = false } = {}) {
    if (user.password_set !== false) {
      const ok = await bcrypt.compare(String(password || ''), user.password_hash);
      if (!ok) return { ok: false, status: 401, error: password ? 'הסיסמה שגויה' : 'יש להזין את הסיסמה הנוכחית', reauth: 'password' };
    } else {
      const session = req.sessionId && accounts ? await accounts.getSession(req.sessionId) : null;
      if (!session || Date.now() - Date.parse(session.createdAt) > FRESH_SESSION_MS) {
        return { ok: false, status: 401, error: 'מטעמי אבטחה, התחברו מחדש ונסו שוב', reauth: 'fresh_login' };
      }
    }
    if (requireCode && user.totp_enabled) {
      if (!(await checkSecondFactor(user, code))) {
        return { ok: false, status: 401, error: code ? 'קוד האימות שגוי' : 'יש להזין קוד אימות', reauth: 'code' };
      }
    }
    return { ok: true };
  }

  return {
    issueSession,
    log,
    endAllSessions,
    checkTotp,
    checkSecondFactor,
    generateBackupCodes,
    sendVerification,
    resendVerification,
    completeVerification,
    findTokenByCode,
    loginOutcome,
    readChallenge,
    readRestore,
    checkReauth,
    invalidateUser,
    invalidateSessions
  };
}

module.exports = {
  createAuthCore,
  publicUser,
  limiter,
  emailKey,
  sendInBackground,
  hashBackupCode,
  BCRYPT_ROUNDS,
  JWT_ALGORITHMS,
  VERIFY_MINUTES,
  FRESH_SESSION_MS
};
