/**
 * @jest-environment node
 */
// End-to-end auth flows against the real SQLite store: welcome email,
// forgot/reset password, 2FA setup and login, and session revocation.
const http = require('http');
const express = require('express');
const cookieParser = require('cookie-parser');
const speakeasy = require('speakeasy');
const { mountAuthRoutes } = require('./authRoutes');
const { createSessionGuard, crossSiteRequestGuard } = require('./security');
const { requireAuth } = require('./requireAuth');
const { sqliteStore, openSqlite } = require('./dataStore');
const { listen } = require('./testUtils/http');

function call(baseUrl, method, path, { body, token, headers: extra = {} } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const headers = { ...extra };
    if (data !== null) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(data);
    }
    if (token) headers.Authorization = `Bearer ${token}`;
    const req = http.request(`${baseUrl}${path}`, { method, agent: false, headers }, (res) => {
      let raw = '';
      res.on('data', (c) => {
        raw += c;
      });
      res.on('end', () => {
        let parsed = null;
        try {
          parsed = raw ? JSON.parse(raw) : null;
        } catch {
          parsed = raw;
        }
        resolve({ status: res.statusCode, headers: res.headers, body: parsed });
      });
    });
    req.on('error', reject);
    if (data !== null) req.write(data);
    req.end();
  });
}

// The mailer sends in the background; give it a tick to run.
const flush = () => new Promise((r) => setTimeout(r, 20));

// The code for the next 30s step (still inside the accepted drift window):
// the step the enable call used is already burnt by the replay guard.
function nextCode(secret) {
  return speakeasy.totp({ secret, encoding: 'base32', time: Math.floor(Date.now() / 1000) + 30 });
}

describe('auth flows', () => {
  let server;
  let baseUrl;
  let store;
  let mailer;

  beforeEach(async () => {
    store = sqliteStore(openSqlite(':memory:'));
    mailer = { sendWelcomeEmail: jest.fn().mockResolvedValue({}), sendPasswordResetEmail: jest.fn().mockResolvedValue({}) };
    const guard = createSessionGuard();
    guard.setStore(store);
    const app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use(crossSiteRequestGuard());
    app.use(guard.middleware);
    mountAuthRoutes(app, store, { mailer, sessionGuard: guard });
    app.get('/api/private', requireAuth, (req, res) => res.json({ id: req.user.id }));
    ({ server, baseUrl } = await listen(app));
  });

  afterEach((done) => {
    server.close(done);
  });

  async function register(email = 'user@example.com', password = 'first-password') {
    const res = await call(baseUrl, 'POST', '/api/auth/register', { body: { email, password } });
    expect(res.status).toBe(201);
    return res.body;
  }

  test('registration hashes the password and sends a welcome email', async () => {
    const { user, token } = await register();
    await flush();
    expect(mailer.sendWelcomeEmail).toHaveBeenCalledWith('user@example.com');
    expect(user.twoFactorEnabled).toBe(false);
    const row = await store.getAuthUser(user.id);
    expect(row.password_hash).toMatch(/^\$2[aby]\$12\$/);
    expect((await call(baseUrl, 'GET', '/api/private', { token })).status).toBe(200);
  });

  test('rejects non-string credentials instead of passing them to the store', async () => {
    const res = await call(baseUrl, 'POST', '/api/auth/login', {
      body: { email: { $ne: '' }, password: { $ne: '' } }
    });
    expect(res.status).toBe(400);
  });

  test('forgot password always answers the same, and only mails existing accounts', async () => {
    await register();
    const known = await call(baseUrl, 'POST', '/api/auth/forgot-password', { body: { email: 'user@example.com' } });
    const unknown = await call(baseUrl, 'POST', '/api/auth/forgot-password', { body: { email: 'nobody@example.com' } });
    await flush();
    expect(known.status).toBe(200);
    expect(unknown.body).toEqual(known.body);
    expect(mailer.sendPasswordResetEmail).toHaveBeenCalledTimes(1);
  });

  test('a reset link sets a new password once and revokes existing sessions', async () => {
    const { token: oldSession } = await register();
    await call(baseUrl, 'POST', '/api/auth/forgot-password', { body: { email: 'user@example.com' } });
    await flush();
    const link = mailer.sendPasswordResetEmail.mock.calls[0][1];
    const resetToken = new URL(link).searchParams.get('token');

    expect((await call(baseUrl, 'POST', '/api/auth/reset-password/verify', { body: { token: resetToken } })).body).toEqual({ valid: true });
    expect((await call(baseUrl, 'POST', '/api/auth/reset-password', { body: { token: resetToken, password: 'second-password' } })).status).toBe(200);

    // Single use.
    const again = await call(baseUrl, 'POST', '/api/auth/reset-password', { body: { token: resetToken, password: 'third-password' } });
    expect(again.status).toBe(400);

    // The session from before the reset no longer works.
    expect((await call(baseUrl, 'GET', '/api/private', { token: oldSession })).status).toBe(401);

    const oldLogin = await call(baseUrl, 'POST', '/api/auth/login', { body: { email: 'user@example.com', password: 'first-password' } });
    expect(oldLogin.status).toBe(401);
    const newLogin = await call(baseUrl, 'POST', '/api/auth/login', { body: { email: 'user@example.com', password: 'second-password' } });
    expect(newLogin.status).toBe(200);
  });

  test('an expired reset token is refused', async () => {
    const { user } = await register();
    const crypto = require('crypto');
    const raw = 'expired-token';
    await store.createPasswordReset(user.id, crypto.createHash('sha256').update(raw).digest('hex'), Date.now() - 1000);
    const res = await call(baseUrl, 'POST', '/api/auth/reset-password', { body: { token: raw, password: 'second-password' } });
    expect(res.status).toBe(400);
  });

  test('2FA: setup, enable, then login needs a valid, unused code', async () => {
    const { token } = await register();

    const setup = await call(baseUrl, 'POST', '/api/auth/2fa/setup', { token });
    expect(setup.status).toBe(200);
    expect(setup.body.qrCodeDataUrl).toMatch(/^data:image\/png;base64,/);
    const { secret } = setup.body;

    expect((await call(baseUrl, 'POST', '/api/auth/2fa/enable', { token, body: { code: '000000' } })).status).toBe(400);

    const enable = await call(baseUrl, 'POST', '/api/auth/2fa/enable', {
      token,
      body: { code: speakeasy.totp({ secret, encoding: 'base32' }) }
    });
    expect(enable.status).toBe(200);
    expect(enable.body.user.twoFactorEnabled).toBe(true);
    // Turning 2FA on retires the old session but hands this browser a new one.
    expect((await call(baseUrl, 'GET', '/api/private', { token })).status).toBe(401);
    expect((await call(baseUrl, 'GET', '/api/private', { token: enable.body.token })).status).toBe(200);

    // The secret cannot be replaced while 2FA is on.
    expect((await call(baseUrl, 'POST', '/api/auth/2fa/setup', { token: enable.body.token })).status).toBe(409);

    const login = await call(baseUrl, 'POST', '/api/auth/login', { body: { email: 'user@example.com', password: 'first-password' } });
    expect(login.status).toBe(200);
    expect(login.body.twoFactorRequired).toBe(true);
    expect(login.body.token).toBeUndefined();
    expect(login.headers['set-cookie']).toBeUndefined();

    // The challenge token is not a session.
    expect((await call(baseUrl, 'GET', '/api/private', { token: login.body.challengeToken })).status).toBe(401);

    const { challengeToken } = login.body;
    expect((await call(baseUrl, 'POST', '/api/auth/login/2fa', { body: { challengeToken, code: '123456' } })).status).toBe(401);

    const code = nextCode(secret);
    const ok = await call(baseUrl, 'POST', '/api/auth/login/2fa', { body: { challengeToken, code } });
    expect(ok.status).toBe(200);
    expect((await call(baseUrl, 'GET', '/api/private', { token: ok.body.token })).status).toBe(200);

    // The same code cannot be used twice.
    const replay = await call(baseUrl, 'POST', '/api/auth/login/2fa', { body: { challengeToken, code } });
    expect(replay.status).toBe(401);
  });

  test('2FA: disabling needs the password and a code', async () => {
    const { token } = await register();
    const { secret } = (await call(baseUrl, 'POST', '/api/auth/2fa/setup', { token })).body;
    const enable = await call(baseUrl, 'POST', '/api/auth/2fa/enable', {
      token,
      body: { code: speakeasy.totp({ secret, encoding: 'base32' }) }
    });
    const session = enable.body.token;

    const wrongPassword = await call(baseUrl, 'POST', '/api/auth/2fa/disable', {
      token: session,
      body: { password: 'nope-nope', code: nextCode(secret) }
    });
    expect(wrongPassword.status).toBe(401);

    const ok = await call(baseUrl, 'POST', '/api/auth/2fa/disable', {
      token: session,
      body: { password: 'first-password', code: nextCode(secret) }
    });
    expect(ok.status).toBe(200);
    expect(ok.body.user.twoFactorEnabled).toBe(false);
  });

  test('state-changing requests from a foreign origin are refused', async () => {
    const res = await call(baseUrl, 'POST', '/api/auth/login', {
      body: { email: 'user@example.com', password: 'first-password' },
      headers: { Origin: 'https://evil.example' }
    });
    expect(res.status).toBe(403);
    const local = await call(baseUrl, 'POST', '/api/auth/login', {
      body: { email: 'user@example.com', password: 'first-password' },
      headers: { Origin: 'http://localhost:3000' }
    });
    expect(local.status).toBe(401);
  });
});
