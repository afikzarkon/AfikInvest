// Signing in with Google and Facebook (Passport strategies), linking them
// to an existing account from the settings page, and Facebook's data
// deletion callback.
//
// The round-trip: the browser opens /api/auth/oauth/:provider here, goes
// to the provider, comes back to .../callback, and is sent on to the web
// app's /auth/callback with a one-time code; the page trades that code for
// a session (POST /api/auth/oauth/exchange), so the session token never
// travels in a URL. State and PKCE live in a signed, short-lived cookie
// (no server sessions needed).
//
// Linking rules - no account can be taken over through a provider:
//   - a provider identity already linked signs in to its account;
//   - an address matching an existing account is linked automatically only
//     when the provider says it verified the address (Google does; Facebook
//     does not say), otherwise the account's own address is asked to
//     confirm the link first;
//   - otherwise a new account is opened, with the terms to accept on the
//     way in (and the address to verify, when the provider did not).
const crypto = require('crypto');
const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const passportLib = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const FacebookStrategy = require('passport-facebook').Strategy;
const { getAppUrl } = require('./emailService');
const { limiter, sendInBackground, BCRYPT_ROUNDS } = require('./authCore');
const { hashToken, randomToken, maskEmail } = require('./authHelpers');
const { BLOCKED_MESSAGE, isBlockedError } = require('./authSession');

const STATE_COOKIE = 'oauth_state';
const STATE_TTL_SECONDS = 10 * 60;
const EXCHANGE_TTL_MS = 2 * 60 * 1000;
const LINK_CONFIRM_MINUTES = 30;

// Where the provider sends the browser back: the API's public address.
// In development the web app's dev server does not proxy page loads, so the
// API is reached directly.
function apiPublicUrl() {
  const configured = String(process.env.API_PUBLIC_URL || '').trim().replace(/\/+$/, '');
  if (configured) return configured;
  if (process.env.NODE_ENV === 'production') return '';
  return `http://localhost:${Number(process.env.PORT) || 5000}`;
}

function providerConfigured(provider) {
  if (provider === 'google') return Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
  if (provider === 'facebook') return Boolean(process.env.FACEBOOK_APP_ID && process.env.FACEBOOK_APP_SECRET);
  return false;
}

// Passport's state store, in a signed cookie instead of a server session:
// the random handle sent to the provider, the PKCE verifier, and what the
// sign-in is for. One use: read and cleared on the way back.
function cookieStateStore(secret) {
  const cookieOpts = () => ({
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/api/auth/oauth',
    maxAge: STATE_TTL_SECONDS * 1000
  });
  return {
    store(req, verifier, state, meta, callback) {
      const handle = crypto.randomBytes(18).toString('base64url');
      const token = jwt.sign({ h: handle, v: verifier || null, s: state || {} }, secret, { expiresIn: STATE_TTL_SECONDS, algorithm: 'HS256' });
      req.res.cookie(STATE_COOKIE, token, cookieOpts());
      callback(null, handle);
    },
    verify(req, providedState, callback) {
      const token = req.cookies ? req.cookies[STATE_COOKIE] : '';
      req.res.clearCookie(STATE_COOKIE, { ...cookieOpts(), maxAge: undefined });
      let payload;
      try {
        payload = jwt.verify(String(token || ''), secret, { algorithms: ['HS256'] });
      } catch {
        return callback(null, false, { message: 'state' });
      }
      const a = Buffer.from(String(payload.h));
      const b = Buffer.from(String(providedState || ''));
      if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return callback(null, false, { message: 'state' });
      // A verifier means PKCE; otherwise "true" lets the exchange go ahead.
      return callback(null, payload.v || true, payload.s || {});
    }
  };
}

// The provider's profile, reduced to what is used. emailVerified only when
// the provider vouches for it.
function normalizeProfile(provider, profile) {
  const json = profile._json || {};
  const email = String((profile.emails && profile.emails[0] && profile.emails[0].value) || json.email || '')
    .trim()
    .toLowerCase();
  const emailVerified = provider === 'google' ? json.email_verified === true || json.email_verified === 'true' : false;
  const name = String(profile.displayName || [json.given_name, json.family_name].filter(Boolean).join(' ') || '').slice(0, 80);
  return { provider, id: String(profile.id), email, emailVerified, name };
}

// Decodes and checks a Facebook signed_request; the payload or null.
function parseSignedRequest(signedRequest, appSecret) {
  const [sig, body] = String(signedRequest || '').split('.');
  if (!sig || !body || !appSecret) return null;
  const expected = crypto.createHmac('sha256', appSecret).update(body).digest();
  const given = Buffer.from(sig, 'base64url');
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    return payload && String(payload.algorithm || '').toUpperCase() === 'HMAC-SHA256' ? payload : null;
  } catch {
    return null;
  }
}

// auth: what mountAuthRoutes returns ({ core }).
function mountOAuthRoutes(app, { store, accounts, mailer, auth, jwtSecret }) {
  const { core } = auth;
  const passport = new passportLib.Passport();
  const stateStore = cookieStateStore(crypto.createHash('sha256').update(`${jwtSecret}:oauth-state`).digest('hex'));
  const verifyProfile = (provider) => (accessToken, refreshToken, profile, done) => done(null, normalizeProfile(provider, profile));
  const callbackUrl = (provider) => `${apiPublicUrl()}/api/auth/oauth/${provider}/callback`;
  const startLimiter = limiter({ windowMs: 15 * 60 * 1000, limit: 30, message: 'יותר מדי ניסיונות, נסו שוב בעוד כמה דקות' });
  const exchangeLimiter = limiter({ windowMs: 15 * 60 * 1000, limit: 30, message: 'יותר מדי ניסיונות, נסו שוב בעוד כמה דקות' });

  if (providerConfigured('google')) {
    passport.use(
      'google',
      new GoogleStrategy(
        {
          clientID: process.env.GOOGLE_CLIENT_ID,
          clientSecret: process.env.GOOGLE_CLIENT_SECRET,
          callbackURL: callbackUrl('google'),
          // The least there is: who the person is and their address.
          scope: ['openid', 'email', 'profile'],
          pkce: true,
          state: true,
          store: stateStore
        },
        verifyProfile('google')
      )
    );
  }
  if (providerConfigured('facebook')) {
    passport.use(
      'facebook',
      new FacebookStrategy(
        {
          clientID: process.env.FACEBOOK_APP_ID,
          clientSecret: process.env.FACEBOOK_APP_SECRET,
          callbackURL: callbackUrl('facebook'),
          scope: ['email', 'public_profile'],
          profileFields: ['id', 'displayName', 'emails'],
          enableProof: true,
          state: true,
          store: stateStore
        },
        verifyProfile('facebook')
      )
    );
  }

  const appUrl = () => getAppUrl();
  const finish = (res, params) => res.redirect(`${appUrl()}/auth/callback?${new URLSearchParams(params).toString()}`);

  // A one-time code the web app trades for the outcome.
  async function exchangeCode(userId, { method, remember, newUser = false }) {
    const code = randomToken();
    await accounts.createToken({ tokenHash: hashToken(code), purpose: 'oauth_exchange', userId, payload: { method, remember, newUser }, ttlMs: EXCHANGE_TTL_MS, replace: false });
    return code;
  }

  // Start: ?remember=0|1 for a sign-in, ?intent=... (from the settings
  // page) to link to the signed-in account.
  app.get('/api/auth/oauth/:provider', startLimiter, async (req, res, next) => {
    const provider = String(req.params.provider);
    if (!providerConfigured(provider)) return finish(res, { error: 'provider_unavailable' });
    try {
      let state = { mode: 'login', remember: req.query.remember !== '0' };
      if (req.query.intent) {
        const intent = await accounts.consumeToken(hashToken(String(req.query.intent)), 'oauth_link_intent');
        if (!intent || intent.payload.provider !== provider) return finish(res, { error: 'link_expired', provider });
        state = { mode: 'link', userId: intent.userId };
      }
      return passport.authenticate(provider, { session: false, state })(req, res, next);
    } catch (err) {
      console.error('oauth/start', err && err.message ? err.message : err);
      return finish(res, { error: 'server' });
    }
  });

  app.get('/api/auth/oauth/:provider/callback', (req, res, next) => {
    const provider = String(req.params.provider);
    if (!providerConfigured(provider)) return finish(res, { error: 'provider_unavailable' });
    return passport.authenticate(provider, { session: false }, async (err, profile, info) => {
      if (err || !profile) {
        // Cancelled at the provider, or a stale/forged state.
        const cancelled = req.query.error === 'access_denied' || (req.query.error_reason === 'user_denied');
        if (err) console.error('oauth/callback', err && err.message ? err.message : err);
        return finish(res, { error: cancelled ? 'cancelled' : 'failed', provider });
      }
      const state = (info && info.state) || {};
      try {
        return await resolve(req, res, profile, state);
      } catch (e) {
        console.error('oauth/resolve', e && e.stack ? e.stack : e);
        return finish(res, { error: 'server', provider });
      }
    })(req, res, next);
  });

  async function resolve(req, res, profile, state) {
    const { provider } = profile;
    const linked = await accounts.findOAuthAccount(provider, profile.id);

    // Linking from the settings page.
    if (state.mode === 'link') {
      const user = await store.getAuthUser(Number(state.userId));
      if (!user || user.deleted_at) return finish(res, { error: 'failed', provider });
      if (linked && linked.userId !== user.id) {
        return res.redirect(`${appUrl()}/settings?section=security&linkError=in_use&provider=${provider}`);
      }
      if (!linked) {
        await accounts.linkOAuthAccount({ provider, providerUserId: profile.id, userId: user.id, email: profile.email, displayName: profile.name });
        await accounts.setProviderName(user.id, profile.name);
        await core.log(req, user.id, 'provider_linked', { provider });
        sendInBackground('provider-linked', () => mailer.sendAccountEmail(user.email, 'providerChanged', { provider, linked: true }));
      }
      return res.redirect(`${appUrl()}/settings?section=security&linked=${provider}`);
    }

    const remember = state.remember !== false;
    if (linked) {
      return finish(res, { code: await exchangeCode(linked.userId, { method: provider, remember }) });
    }

    if (!profile.email) return finish(res, { error: 'email_missing', provider });

    const existing = await store.findUserForLogin(profile.email);
    if (existing) {
      if (profile.emailVerified) {
        await accounts.linkOAuthAccount({ provider, providerUserId: profile.id, userId: existing.id, email: profile.email, displayName: profile.name });
        await accounts.setProviderName(existing.id, profile.name);
        if (!existing.email_verified_at) await accounts.markEmailVerified(existing.id);
        await core.log(req, existing.id, 'provider_linked', { provider, automatic: true });
        sendInBackground('provider-linked', () => mailer.sendAccountEmail(existing.email, 'providerChanged', { provider, linked: true }));
        return finish(res, { code: await exchangeCode(existing.id, { method: provider, remember }) });
      }
      // Unverified by the provider: the account's address must confirm.
      const token = randomToken();
      await accounts.createToken({
        tokenHash: hashToken(token),
        purpose: 'oauth_link',
        userId: existing.id,
        email: existing.email,
        payload: { provider, providerUserId: profile.id, name: profile.name, providerEmail: profile.email, remember },
        ttlMs: LINK_CONFIRM_MINUTES * 60 * 1000
      });
      const link = `${appUrl()}/confirm-link?token=${encodeURIComponent(token)}`;
      sendInBackground('oauth-link', () => mailer.sendAccountEmail(existing.email, 'oauthLinkConfirm', { provider, link, minutes: LINK_CONFIRM_MINUTES }));
      return finish(res, { status: 'link_confirmation_sent', provider, email: maskEmail(existing.email) });
    }

    // A new account. Its password is a random value nobody knows, until
    // the user sets one in the settings.
    const randomHash = await bcrypt.hash(randomToken(), BCRYPT_ROUNDS);
    const { id: userId } = await store.insertUser(profile.email, randomHash, { emailVerified: profile.emailVerified, passwordSet: false });
    await accounts.linkOAuthAccount({ provider, providerUserId: profile.id, userId, email: profile.email, displayName: profile.name });
    await accounts.setProviderName(userId, profile.name);
    await accounts.setConsent(userId, 'marketing', false);
    await accounts.updateProfileExtra(userId, { termsPending: true });
    await core.log(req, userId, 'signup', { method: provider });
    if (!profile.emailVerified) await core.sendVerification({ id: userId, email: profile.email });
    return finish(res, { code: await exchangeCode(userId, { method: provider, remember, newUser: true }) });
  }

  // The web app trades the one-time code for what follows: a session, the
  // 2FA step, a restore offer, or verification.
  app.post('/api/auth/oauth/exchange', exchangeLimiter, async (req, res) => {
    const code = req.body && typeof req.body.code === 'string' ? req.body.code : '';
    try {
      const used = code ? await accounts.consumeToken(hashToken(code), 'oauth_exchange') : null;
      const user = used ? await store.getAuthUser(used.userId) : null;
      if (!user) return res.status(400).json({ error: 'הכניסה פגה, נסו שוב' });
      const outcome = await core.loginOutcome(req, res, user, { remember: used.payload.remember !== false, method: used.payload.method });
      return res.json({ ...outcome, newUser: Boolean(used.payload.newUser) });
    } catch (err) {
      if (isBlockedError(err)) return res.status(403).json({ error: BLOCKED_MESSAGE, blocked: true });
      console.error('oauth/exchange', err && err.stack ? err.stack : err);
      return res.status(500).json({ error: 'שגיאת שרת' });
    }
  });

  // From the email sent when a provider's unverified address matched an
  // account: links, and signs in.
  app.post('/api/auth/oauth/confirm-link', exchangeLimiter, async (req, res) => {
    const token = req.body && typeof req.body.token === 'string' ? req.body.token : '';
    try {
      const used = token ? await accounts.consumeToken(hashToken(token), 'oauth_link') : null;
      const user = used ? await store.getAuthUser(used.userId) : null;
      if (!user) return res.status(400).json({ error: 'הקישור אינו תקין, פג תוקפו או שכבר נוצל.' });
      const { provider, providerUserId, name, remember } = used.payload;
      const taken = await accounts.findOAuthAccount(provider, providerUserId);
      if (taken && taken.userId !== user.id) return res.status(409).json({ error: 'החשבון הזה כבר מחובר למשתמש אחר' });
      if (!taken) {
        await accounts.linkOAuthAccount({ provider, providerUserId, userId: user.id, email: used.payload.providerEmail, displayName: name });
        await accounts.setProviderName(user.id, name);
        await core.log(req, user.id, 'provider_linked', { provider, confirmedByEmail: true });
      }
      // The link went to the account's address: it is proven too.
      if (!user.email_verified_at) await accounts.markEmailVerified(user.id);
      const fresh = await store.getAuthUser(user.id);
      return res.json(await core.loginOutcome(req, res, fresh, { remember: remember !== false, method: provider }));
    } catch (err) {
      if (isBlockedError(err)) return res.status(403).json({ error: BLOCKED_MESSAGE, blocked: true });
      console.error('oauth/confirm-link', err && err.stack ? err.stack : err);
      return res.status(500).json({ error: 'שגיאת שרת' });
    }
  });

  // Facebook's Data Deletion Callback: when someone removes the app in
  // their Facebook settings, Facebook posts a signed request naming them.
  // What came from Facebook - the link to their Facebook identity and the
  // name it gave - is deleted; the AfikInvest account itself stays theirs
  // (deleting it is in the settings page). Facebook shows the user the
  // status page with the confirmation code.
  app.post('/api/auth/facebook/data-deletion', express.urlencoded({ extended: false, limit: '20kb' }), async (req, res) => {
    const payload = parseSignedRequest(req.body && req.body.signed_request, process.env.FACEBOOK_APP_SECRET);
    if (!payload || !payload.user_id) return res.status(400).json({ error: 'invalid signed_request' });
    try {
      const linked = await accounts.findOAuthAccount('facebook', String(payload.user_id));
      await accounts.deleteOAuthByProviderUser('facebook', String(payload.user_id));
      if (linked) {
        await store.sql.run('UPDATE user_profiles SET provider_name = NULL WHERE user_id = ?', [linked.userId]);
        await core.log(req, linked.userId, 'provider_data_deleted', { provider: 'facebook' });
      }
      const confirmationCode = crypto.randomBytes(9).toString('base64url');
      await accounts.createToken({
        tokenHash: hashToken(confirmationCode),
        purpose: 'fb_deletion',
        payload: { status: 'deleted', at: new Date().toISOString() },
        ttlMs: 180 * 86400 * 1000,
        replace: false
      });
      return res.json({ url: `${appUrl()}/data-deletion-status?code=${encodeURIComponent(confirmationCode)}`, confirmation_code: confirmationCode });
    } catch (err) {
      console.error('facebook/data-deletion', err && err.stack ? err.stack : err);
      return res.status(500).json({ error: 'server error' });
    }
  });

  app.get('/api/auth/facebook/data-deletion/status', exchangeLimiter, async (req, res) => {
    const code = String(req.query.code || '');
    try {
      const found = code ? await accounts.findToken(hashToken(code), 'fb_deletion') : null;
      return res.json(found ? { status: found.payload.status, at: found.payload.at } : { status: 'unknown' });
    } catch (err) {
      return res.status(500).json({ error: 'שגיאת שרת' });
    }
  });
}

module.exports = { mountOAuthRoutes, normalizeProfile, parseSignedRequest, cookieStateStore, apiPublicUrl };
