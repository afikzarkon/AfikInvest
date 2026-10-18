/**
 * @jest-environment node
 */
// End-to-end account flows over HTTP against the real SQLite store and the
// real routes: sign-up and verification, sign-in, devices, password and
// email changes, sign-in links, 2FA with backup codes, deletion and
// restore, the profile, the export and unsubscribing. Only the mailer is a
// fake - each test reads the links and codes it "sent".
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const cookieParser = require('cookie-parser');
const speakeasy = require('speakeasy');
const { mountAuthRoutes } = require('./authRoutes');
const { mountAccountRoutes } = require('./accountRoutes');
const { mountOAuthRoutes } = require('./oauthRoutes');
const { createSessionGuard, crossSiteRequestGuard } = require('./security');
const { requireAuth } = require('./requireAuth');
const { sqliteStore, openSqlite } = require('./dataStore');
const { initFeatureStore } = require('./featureStore');
const { initAccountStore } = require('./accountStore');
const { runAccountMaintenance } = require('./accountJobs');
const { unsubscribeUrlFor } = require('./emailPreferences');
const { listen } = require('./testUtils/http');

function call(baseUrl, method, path, { body, token, headers: extra = {} } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const headers = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0) Chrome/124.0 Safari/537.36', ...extra };
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
const flush = () => new Promise((r) => setTimeout(r, 30));

// The code for the next 30s step (still inside the accepted drift window):
// the step the enable call used is already burnt by the replay guard.
const nextCode = (secret, steps = 1) => speakeasy.totp({ secret, encoding: 'base32', time: Math.floor(Date.now() / 1000) + 30 * steps });

const PASSWORD = 'correct-horse-battery';

describe('account flows', () => {
  let server;
  let baseUrl;
  let store;
  let accounts;
  let features;
  let mailer;

  beforeEach(async () => {
    store = sqliteStore(openSqlite(':memory:'));
    features = await initFeatureStore(store);
    accounts = await initAccountStore(store);
    mailer = {
      send: jest.fn().mockResolvedValue({}),
      sendWelcomeEmail: jest.fn().mockResolvedValue({}),
      sendPasswordResetEmail: jest.fn().mockResolvedValue({}),
      sendAccountEmail: jest.fn().mockResolvedValue({})
    };
    const guard = createSessionGuard();
    guard.setStore(store, accounts);
    const app = express();
    app.use(express.json({ limit: '1mb' }));
    app.use(cookieParser());
    app.use(crossSiteRequestGuard());
    app.use(guard.middleware);
    const auth = mountAuthRoutes(app, store, { mailer, accounts, sessionGuard: guard });
    mountAccountRoutes(app, { store, accounts, features, mailer, auth });
    mountOAuthRoutes(app, { store, accounts, mailer, auth, jwtSecret: 'stockview-dev-secret-change-me' });
    app.get('/api/private', requireAuth, (req, res) => res.json({ id: req.user.id }));
    ({ server, baseUrl } = await listen(app));
  });

  afterEach((done) => {
    server.close(done);
  });

  const api = (method, path, opts) => call(baseUrl, method, path, opts);
  const sent = (template) => mailer.sendAccountEmail.mock.calls.filter((c) => c[1] === template);
  const lastSent = (template) => {
    const calls = sent(template);
    return calls.length ? { to: calls[calls.length - 1][0], ...calls[calls.length - 1][2] } : null;
  };
  const tokenFromLink = (link) => new URL(link).searchParams.get('token');

  async function signup(email = 'user@example.com', password = PASSWORD, extra = {}) {
    const res = await api('POST', '/api/auth/register', { body: { email, password, acceptTerms: true, ...extra } });
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ verificationRequired: true, email });
    await flush();
    return res;
  }

  // Signs up and verifies by code; returns the session.
  async function account(email = 'user@example.com', password = PASSWORD) {
    await signup(email, password);
    const { code } = lastSent('verifyEmail');
    const res = await api('POST', '/api/auth/verify-email/code', { body: { email, code } });
    expect(res.status).toBe(200);
    expect(res.body.token).toBeTruthy();
    await flush();
    return res.body;
  }

  // ----- sign-up and verification -----

  test('sign-up: no session until the address is verified; then a session and the welcome email', async () => {
    await signup('dana@example.com', PASSWORD, { fullName: 'דנה', marketingOptIn: true, referralCode: 'FRIEND-1' });
    const { code, link } = lastSent('verifyEmail');
    expect(code).toMatch(/^\d{6}$/);
    expect(link).toMatch(/\/verify-email\?token=/);

    const early = await api('POST', '/api/auth/login', { body: { email: 'dana@example.com', password: PASSWORD } });
    expect(early.status).toBe(200);
    expect(early.body).toEqual({ verificationRequired: true, email: 'dana@example.com' });
    expect(early.headers['set-cookie']).toBeUndefined();

    const verified = await api('POST', '/api/auth/verify-email', { body: { token: tokenFromLink(link) } });
    expect(verified.status).toBe(200);
    expect(verified.body).toMatchObject({ verified: true, passwordWithheld: false, user: { emailVerified: true, hasPassword: true } });
    expect((await api('GET', '/api/private', { token: verified.body.token })).status).toBe(200);
    await flush();
    expect(mailer.sendWelcomeEmail).toHaveBeenCalledWith('dana@example.com', expect.objectContaining({ name: 'דנה', unsubscribeUrl: expect.stringContaining('/unsubscribe?u=') }));

    const user = await store.findUserForLogin('dana@example.com');
    expect(user.password_hash).toMatch(/^\$2[aby]\$12\$/);
    expect(await accounts.listConsents(user.id)).toMatchObject({ terms: { granted: true }, marketing: { granted: true } });
    expect((await accounts.getProfile(user.id)).extra).toMatchObject({ referralCode: 'FRIEND-1' });
    // The link is single-use.
    expect((await api('POST', '/api/auth/verify-email', { body: { token: tokenFromLink(link) } })).status).toBe(400);
  });

  test('sign-up answers the same for a taken address, and tells only its owner', async () => {
    await account('taken@example.com');
    mailer.sendAccountEmail.mockClear();
    const res = await signup('taken@example.com', 'another-password-1');
    expect(res.body).toEqual({ verificationRequired: true, email: 'taken@example.com' });
    expect(sent('signupAttemptExisting')).toHaveLength(1);
    expect(sent('verifyEmail')).toHaveLength(0);
    // The existing password still works; the new one does not.
    expect((await api('POST', '/api/auth/login', { body: { email: 'taken@example.com', password: PASSWORD } })).body.token).toBeTruthy();
    expect((await api('POST', '/api/auth/login', { body: { email: 'taken@example.com', password: 'another-password-1' } })).status).toBe(401);
  });

  test('sign-up validation: terms required, disposable addresses refused, the honeypot creates nothing', async () => {
    const noTerms = await api('POST', '/api/auth/register', { body: { email: 'a@example.com', password: PASSWORD } });
    expect(noTerms.status).toBe(400);
    expect(noTerms.body.fieldErrors.acceptTerms).toBeTruthy();

    const short = await api('POST', '/api/auth/register', { body: { email: 'a@example.com', password: 'short', acceptTerms: true } });
    expect(short.body.fieldErrors.password).toMatch(/8/);

    const disposable = await api('POST', '/api/auth/register', { body: { email: 'x@mailinator.com', password: PASSWORD, acceptTerms: true } });
    expect(disposable.status).toBe(400);
    expect(disposable.body.fieldErrors.email).toBeTruthy();

    const bot = await api('POST', '/api/auth/register', { body: { email: 'bot@example.com', password: PASSWORD, acceptTerms: true, website: 'http://spam' } });
    expect(bot.status).toBe(202);
    expect(await store.findUserForLogin('bot@example.com')).toBeNull();
  });

  // Someone signs up with the victim's address first. When the owner
  // verifies, neither competing password is trusted.
  test('pre-registration by a stranger cannot leave a known password on the account', async () => {
    await signup('victim@example.com', 'attacker-password-1');
    await signup('victim@example.com', 'victim-password-22');
    const { link } = lastSent('verifyEmail'); // the owner's own (latest) email
    const res = await api('POST', '/api/auth/verify-email', { body: { token: tokenFromLink(link) } });
    expect(res.body).toMatchObject({ verified: true, passwordWithheld: true, user: { hasPassword: false } });
    for (const password of ['attacker-password-1', 'victim-password-22']) {
      expect((await api('POST', '/api/auth/login', { body: { email: 'victim@example.com', password } })).status).toBe(401);
    }
    // The owner, signed in by the link, sets their password with a fresh session.
    const set = await api('POST', '/api/account/password', { token: res.body.token, body: { newPassword: 'owner-chosen-pass' } });
    expect(set.status).toBe(200);
    expect((await api('POST', '/api/auth/login', { body: { email: 'victim@example.com', password: 'owner-chosen-pass' } })).body.token).toBeTruthy();
  });

  test('a verification code dies after five wrong guesses', async () => {
    await signup('guess@example.com');
    const { code } = lastSent('verifyEmail');
    const wrong = code === '000000' ? '111111' : '000000';
    for (let i = 0; i < 5; i += 1) {
      expect((await api('POST', '/api/auth/verify-email/code', { body: { email: 'guess@example.com', code: wrong } })).status).toBe(400);
    }
    expect((await api('POST', '/api/auth/verify-email/code', { body: { email: 'guess@example.com', code } })).status).toBe(400);
  });

  // ----- sign-in and devices -----

  test('sign-in failures say the same for an unknown address and a wrong password', async () => {
    await account();
    const wrong = await api('POST', '/api/auth/login', { body: { email: 'user@example.com', password: 'nope-nope-nope' } });
    const unknown = await api('POST', '/api/auth/login', { body: { email: 'nobody@example.com', password: 'nope-nope-nope' } });
    expect(wrong.status).toBe(401);
    expect(unknown.body).toEqual(wrong.body);
  });

  test('"remember me" off: a browser-session cookie; on: a persistent one', async () => {
    await account();
    const short = await api('POST', '/api/auth/login', { body: { email: 'user@example.com', password: PASSWORD, remember: false } });
    expect(short.headers['set-cookie'][0]).not.toMatch(/Max-Age/i);
    const long = await api('POST', '/api/auth/login', { body: { email: 'user@example.com', password: PASSWORD, remember: true } });
    expect(long.headers['set-cookie'][0]).toMatch(/Max-Age=2592000/);
    expect(long.headers['set-cookie'][0]).toMatch(/HttpOnly/);
  });

  test('devices: listed, one signed out, then every other one', async () => {
    const first = (await account()).token;
    const second = (await api('POST', '/api/auth/login', { body: { email: 'user@example.com', password: PASSWORD } })).body.token;
    const third = (await api('POST', '/api/auth/login', { body: { email: 'user@example.com', password: PASSWORD } })).body.token;

    const list = await api('GET', '/api/account/sessions', { token: first });
    expect(list.body.sessions).toHaveLength(3);
    expect(list.body.sessions.filter((s) => s.current)).toHaveLength(1);
    expect(list.body.sessions[0]).toMatchObject({ browser: 'Chrome', os: 'Windows' });

    const secondId = list.body.sessions.find((s) => !s.current && s.id).id;
    expect((await api('DELETE', `/api/account/sessions/${secondId}`, { token: first })).status).toBe(200);
    const stillUp = await Promise.all([second, third].map((token) => api('GET', '/api/private', { token })));
    expect(stillUp.map((r) => r.status).sort()).toEqual([200, 401]);

    const others = await api('POST', '/api/account/sessions/revoke-others', { token: first });
    expect(others.status).toBe(200);
    expect((await api('GET', '/api/private', { token: third })).status).toBe(401);
    expect((await api('GET', '/api/private', { token: first })).status).toBe(401); // replaced
    expect((await api('GET', '/api/private', { token: others.body.token })).status).toBe(200);
  });

  test('signing out ends this device only', async () => {
    const a = (await account()).token;
    const b = (await api('POST', '/api/auth/login', { body: { email: 'user@example.com', password: PASSWORD } })).body.token;
    await api('POST', '/api/auth/logout', { token: a });
    expect((await api('GET', '/api/private', { token: a })).status).toBe(401);
    expect((await api('GET', '/api/private', { token: b })).status).toBe(200);
  });

  test("a user cannot sign out another user's device", async () => {
    const mine = (await account('me@example.com')).token;
    const theirs = (await account('them@example.com')).token;
    const theirSession = (await api('GET', '/api/account/sessions', { token: theirs })).body.sessions[0].id;
    expect((await api('DELETE', `/api/account/sessions/${theirSession}`, { token: mine })).status).toBe(404);
    expect((await api('GET', '/api/private', { token: theirs })).status).toBe(200);
  });

  // ----- password and email -----

  test('changing the password needs the current one and signs out every other device', async () => {
    const a = (await account()).token;
    const b = (await api('POST', '/api/auth/login', { body: { email: 'user@example.com', password: PASSWORD } })).body.token;
    const wrong = await api('POST', '/api/account/password', { token: a, body: { currentPassword: 'not-it-at-all', newPassword: 'brand-new-pass-1' } });
    expect(wrong.status).toBe(401);
    expect(wrong.body.reauth).toBe('password');

    const ok = await api('POST', '/api/account/password', { token: a, body: { currentPassword: PASSWORD, newPassword: 'brand-new-pass-1' } });
    expect(ok.status).toBe(200);
    expect((await api('GET', '/api/private', { token: b })).status).toBe(401);
    expect((await api('GET', '/api/private', { token: ok.body.token })).status).toBe(200);
    await flush();
    expect(lastSent('passwordChanged')).toMatchObject({ to: 'user@example.com', wasSet: false });
    expect((await api('POST', '/api/auth/login', { body: { email: 'user@example.com', password: 'brand-new-pass-1' } })).body.token).toBeTruthy();
  });

  test('changing the email: confirmed at the new address, cancellable from the old one', async () => {
    const token = (await account('old@example.com')).token;
    const req = await api('POST', '/api/account/email', { token, body: { newEmail: 'new@example.com', currentPassword: PASSWORD } });
    expect(req.status).toBe(200);
    await flush();
    const confirm = lastSent('emailChangeConfirm');
    const notice = lastSent('emailChangeNotice');
    expect(confirm.to).toBe('new@example.com');
    expect(notice).toMatchObject({ to: 'old@example.com', newEmailMasked: 'n***@example.com' });
    // Nothing changes before the confirmation.
    expect(await store.findUserForLogin('old@example.com')).not.toBeNull();

    expect((await api('POST', '/api/account/email/confirm', { body: { token: tokenFromLink(confirm.link) } })).body).toEqual({ ok: true, email: 'new@example.com' });
    expect((await api('POST', '/api/auth/login', { body: { email: 'new@example.com', password: PASSWORD } })).body.token).toBeTruthy();

    // The old address takes the account back, and every device is signed out.
    const cancel = await api('POST', '/api/account/email/cancel', { body: { token: tokenFromLink(notice.cancelLink) } });
    expect(cancel.status).toBe(200);
    expect(await store.findUserForLogin('old@example.com')).not.toBeNull();
    expect((await api('GET', '/api/private', { token })).status).toBe(401);
    await flush();
    expect(lastSent('emailChangeReverted').to).toBe('old@example.com');
  });

  test('changing to a taken address answers as usual and changes nothing', async () => {
    await account('other@example.com');
    const token = (await account('me@example.com')).token;
    const res = await api('POST', '/api/account/email', { token, body: { newEmail: 'other@example.com', currentPassword: PASSWORD } });
    expect(res.status).toBe(200);
    await flush();
    expect(lastSent('emailChangeTaken').to).toBe('other@example.com');
    expect(sent('emailChangeConfirm')).toHaveLength(0);
  });

  // ----- sign-in link and reset -----

  test('sign-in link: same answer for an unknown address; works once for a known one', async () => {
    await account();
    const known = await api('POST', '/api/auth/magic-link', { body: { email: 'user@example.com' } });
    const unknown = await api('POST', '/api/auth/magic-link', { body: { email: 'nobody@example.com' } });
    expect(unknown.body).toEqual(known.body);
    await flush();
    expect(lastSent('magicLinkNoAccount').to).toBe('nobody@example.com');
    const { link } = lastSent('magicLink');
    const first = await api('POST', '/api/auth/magic-link/verify', { body: { token: tokenFromLink(link) } });
    expect(first.body.token).toBeTruthy();
    expect((await api('POST', '/api/auth/magic-link/verify', { body: { token: tokenFromLink(link) } })).status).toBe(400);
  });

  test('a password reset link works once and ends every session', async () => {
    const session = (await account()).token;
    await api('POST', '/api/auth/forgot-password', { body: { email: 'user@example.com' } });
    const unknown = await api('POST', '/api/auth/forgot-password', { body: { email: 'nobody@example.com' } });
    await flush();
    expect(unknown.status).toBe(200);
    expect(mailer.sendPasswordResetEmail).toHaveBeenCalledTimes(1);
    const resetToken = tokenFromLink(mailer.sendPasswordResetEmail.mock.calls[0][1]);
    expect((await api('POST', '/api/auth/reset-password', { body: { token: resetToken, password: 'second-password' } })).status).toBe(200);
    expect((await api('POST', '/api/auth/reset-password', { body: { token: resetToken, password: 'third-password' } })).status).toBe(400);
    expect((await api('GET', '/api/private', { token: session })).status).toBe(401);
    expect((await api('POST', '/api/auth/login', { body: { email: 'user@example.com', password: 'second-password' } })).body.token).toBeTruthy();
  });

  // ----- 2FA -----

  test('2FA: backup codes on enabling; sign-in by code or by a backup code (once); disabling re-authenticates', async () => {
    const token = (await account()).token;
    const { secret } = (await api('POST', '/api/auth/2fa/setup', { token })).body;
    const enable = await api('POST', '/api/auth/2fa/enable', { token, body: { code: speakeasy.totp({ secret, encoding: 'base32' }) } });
    expect(enable.status).toBe(200);
    expect(enable.body.backupCodes).toHaveLength(10);
    expect(enable.body.backupCodes[0]).toMatch(/^[a-z0-9]{5}-[a-z0-9]{5}$/);
    const session = enable.body.token;

    const login = await api('POST', '/api/auth/login', { body: { email: 'user@example.com', password: PASSWORD } });
    expect(login.body.twoFactorRequired).toBe(true);
    const backup = enable.body.backupCodes[3];
    const viaBackup = await api('POST', '/api/auth/login/2fa', { body: { challengeToken: login.body.challengeToken, code: backup.toUpperCase() } });
    expect(viaBackup.status).toBe(200);
    expect(viaBackup.body.backupCodesLeft).toBe(9);
    const again = await api('POST', '/api/auth/login', { body: { email: 'user@example.com', password: PASSWORD } });
    expect((await api('POST', '/api/auth/login/2fa', { body: { challengeToken: again.body.challengeToken, code: backup } })).status).toBe(401);

    const noCode = await api('POST', '/api/auth/2fa/disable', { token: session, body: { password: PASSWORD } });
    expect(noCode.body.reauth).toBe('code');
    const off = await api('POST', '/api/auth/2fa/disable', { token: session, body: { password: PASSWORD, code: nextCode(secret) } });
    expect(off.status).toBe(200);
    expect(off.body.user.twoFactorEnabled).toBe(false);
    expect(await accounts.countUnusedBackupCodes((await store.findUserForLogin('user@example.com')).id)).toBe(0);
  });

  // ----- deletion -----

  test('deleting: confirmed and re-authenticated, restorable in the grace period, purged after it', async () => {
    const token = (await account()).token;
    expect((await api('POST', '/api/account/delete', { token, body: { confirm: 'כן', password: PASSWORD } })).status).toBe(400);
    expect((await api('POST', '/api/account/delete', { token, body: { confirm: 'מחק', password: 'wrong-wrong-1' } })).status).toBe(401);
    const del = await api('POST', '/api/account/delete', { token, body: { confirm: 'מחק', password: PASSWORD, reason: 'not_useful', comment: 'תודה' } });
    expect(del.status).toBe(200);
    expect((await api('GET', '/api/private', { token })).status).toBe(401);
    await flush();
    expect(lastSent('deletionScheduled').to).toBe('user@example.com');
    // The feedback is kept apart, with no way back to the account.
    expect(await store.sql.all('SELECT reason, comment FROM deletion_feedback')).toEqual([{ reason: 'not_useful', comment: 'תודה' }]);

    const login = await api('POST', '/api/auth/login', { body: { email: 'user@example.com', password: PASSWORD } });
    expect(login.body.deletionPending).toBe(true);
    const restored = await api('POST', '/api/auth/restore', { body: { restoreToken: login.body.restoreToken } });
    expect(restored.body.token).toBeTruthy();
    expect((await store.findUserForLogin('user@example.com')).deleted_at).toBeNull();

    // Deleted again; the job leaves it during the grace period, purges after.
    await api('POST', '/api/account/delete', { token: restored.body.token, body: { confirm: 'מחק', password: PASSWORD } });
    const quietMailer = { sendAccountEmail: jest.fn().mockResolvedValue({}) };
    expect((await runAccountMaintenance({ accounts, mailer: quietMailer })).purged).toBe(0);
    const reminder = await runAccountMaintenance({ accounts, mailer: quietMailer, now: () => new Date(Date.now() + 12.5 * 86400 * 1000) });
    expect(reminder.reminded).toBe(1);
    expect((await runAccountMaintenance({ accounts, mailer: quietMailer, now: () => new Date(Date.now() + 12.6 * 86400 * 1000) })).reminded).toBe(0);
    const purge = await runAccountMaintenance({ accounts, mailer: quietMailer, now: () => new Date(Date.now() + 15 * 86400 * 1000) });
    expect(purge.purged).toBe(1);
    expect(await store.findUserForLogin('user@example.com')).toBeNull();
    expect(quietMailer.sendAccountEmail).toHaveBeenCalledWith('user@example.com', 'accountPurged');
  });

  // ----- profile, export, preferences -----

  test('profile: every field optional, cleared with an empty value, validated', async () => {
    const token = (await account()).token;
    const saved = await api('PUT', '/api/account/profile', { token, body: { firstName: 'דנה', phone: '+972 50-123-4567', timezone: 'Asia/Jerusalem' } });
    expect(saved.body.profile).toMatchObject({ firstName: 'דנה', phone: '+972 50-123-4567', timezone: 'Asia/Jerusalem' });
    expect((await api('PUT', '/api/account/profile', { token, body: { phone: '' } })).body.profile.phone).toBe('');
    const bad = await api('PUT', '/api/account/profile', { token, body: { birthDate: '2999-01-01', phone: 'abc' } });
    expect(bad.status).toBe(400);
    expect(Object.keys(bad.body.fieldErrors).sort()).toEqual(['birthDate', 'phone']);
    expect((await api('PUT', '/api/account/profile', { token, body: { isAdmin: true } })).status).toBe(400);
  });

  test('avatar: a real image is stored; anything else is refused', async () => {
    const token = (await account()).token;
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4c30000000049454e44ae426082', 'hex');
    expect((await api('PUT', '/api/account/avatar', { token, body: { dataUrl: `data:image/png;base64,${png.toString('base64')}` } })).status).toBe(200);
    expect((await api('GET', '/api/account/avatar', { token })).body.dataUrl).toMatch(/^data:image\/png;base64,/);
    const fake = Buffer.from('<svg onload=alert(1)>').toString('base64');
    expect((await api('PUT', '/api/account/avatar', { token, body: { dataUrl: `data:image/png;base64,${fake}` } })).status).toBe(400);
    expect((await api('DELETE', '/api/account/avatar', { token })).status).toBe(200);
    expect((await api('GET', '/api/account/avatar', { token })).body.dataUrl).toBeNull();
  });

  test('the export holds the account data and no secrets', async () => {
    const token = (await account()).token;
    await api('PUT', '/api/account/profile', { token, body: { firstName: 'דנה' } });
    const res = await api('GET', '/api/account/export', { token });
    expect(res.status).toBe(200);
    expect(res.headers['content-disposition']).toMatch(/afikinvest-export-/);
    expect(res.body).toMatchObject({ app: 'AfikInvest', account: { email: 'user@example.com' }, profile: { firstName: 'דנה' } });
    const text = JSON.stringify(res.body);
    expect(text).not.toMatch(/password_hash|\$2[aby]\$|totp_secret|token_hash/);
    const csv = await api('GET', '/api/account/export/transactions.csv', { token });
    expect(csv.status).toBe(200);
    expect(csv.headers['content-type']).toMatch(/text\/csv/);
  });

  test('unsubscribing by the signed link; a forged one is refused', async () => {
    await account();
    const user = await store.findUserForLogin('user@example.com');
    await features.setPreferences(user.id, 'notifications', { reminders: true, product_updates: true });
    const link = new URL(unsubscribeUrlFor(user.id, 'all'));
    const q = Object.fromEntries(link.searchParams);
    expect((await api('POST', '/api/email/unsubscribe', { body: { ...q, s: 'forged' } })).status).toBe(400);
    expect((await api('POST', '/api/email/unsubscribe', { body: { ...q, u: String(user.id + 1) } })).status).toBe(400);
    expect((await api('POST', '/api/email/unsubscribe', { body: q })).status).toBe(200);
    expect(await features.getPreferences(user.id, 'notifications')).toMatchObject({ reminders: false, product_updates: false });
  });

  test('the last way in cannot be disconnected', async () => {
    const token = (await account()).token;
    const user = await store.findUserForLogin('user@example.com');
    await accounts.linkOAuthAccount({ provider: 'google', providerUserId: 'g-1', userId: user.id, email: 'user@example.com' });
    // With a password, unlinking Google is fine.
    expect((await api('DELETE', '/api/account/providers/google', { token })).status).toBe(200);
    // An account opened through Google has no password: its only provider stays.
    const { id: oauthUser } = await store.insertUser('g@example.com', 'random', { emailVerified: true, passwordSet: false });
    await accounts.linkOAuthAccount({ provider: 'google', providerUserId: 'g-2', userId: oauthUser, email: 'g@example.com' });
    await api('POST', '/api/auth/magic-link', { body: { email: 'g@example.com' } });
    await flush();
    const session = (await api('POST', '/api/auth/magic-link/verify', { body: { token: tokenFromLink(lastSent('magicLink').link) } })).body.token;
    const refused = await api('DELETE', '/api/account/providers/google', { token: session });
    expect(refused.status).toBe(400);
    expect(await accounts.listOAuthAccounts(oauthUser)).toHaveLength(1);
  });

  // ----- sign-in providers -----

  test('a provider sign-in completes through a one-time exchange code', async () => {
    await account();
    const user = await store.findUserForLogin('user@example.com');
    const code = 'exchange-code-1';
    await accounts.createToken({ tokenHash: crypto.createHash('sha256').update(code).digest('hex'), purpose: 'oauth_exchange', userId: user.id, payload: { method: 'google', remember: true }, ttlMs: 60000 });
    const res = await api('POST', '/api/auth/oauth/exchange', { body: { code } });
    expect(res.body.token).toBeTruthy();
    expect((await api('POST', '/api/auth/oauth/exchange', { body: { code } })).status).toBe(400);
  });

  test("Facebook's data deletion callback removes the Facebook link, verified by its signature", async () => {
    process.env.FACEBOOK_APP_SECRET = 'fb-secret';
    try {
      await account();
      const user = await store.findUserForLogin('user@example.com');
      await accounts.linkOAuthAccount({ provider: 'facebook', providerUserId: 'fb-42', userId: user.id });
      const body = Buffer.from(JSON.stringify({ algorithm: 'HMAC-SHA256', user_id: 'fb-42' })).toString('base64url');
      const sig = crypto.createHmac('sha256', 'fb-secret').update(body).digest('base64url');
      const post = (signedRequest) =>
        new Promise((resolve) => {
          const data = `signed_request=${encodeURIComponent(signedRequest)}`;
          const req = http.request(`${baseUrl}/api/auth/facebook/data-deletion`, { method: 'POST', agent: false, headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(data) } }, (res) => {
            let raw = '';
            res.on('data', (c) => (raw += c));
            res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(raw) }));
          });
          req.write(data);
          req.end();
        });
      expect((await post(`${sig.slice(0, -2)}xx.${body}`)).status).toBe(400);
      const ok = await post(`${sig}.${body}`);
      expect(ok.status).toBe(200);
      expect(ok.body.url).toMatch(/\/data-deletion-status\?code=/);
      expect(await accounts.findOAuthAccount('facebook', 'fb-42')).toBeNull();
      const status = await api('GET', `/api/auth/facebook/data-deletion/status?code=${encodeURIComponent(ok.body.confirmation_code)}`);
      expect(status.body.status).toBe('deleted');
    } finally {
      delete process.env.FACEBOOK_APP_SECRET;
    }
  });

  test('state-changing requests from a foreign origin are refused', async () => {
    const res = await api('POST', '/api/auth/login', { body: { email: 'user@example.com', password: PASSWORD }, headers: { Origin: 'https://evil.example' } });
    expect(res.status).toBe(403);
    const local = await api('POST', '/api/auth/login', { body: { email: 'user@example.com', password: PASSWORD }, headers: { Origin: 'http://localhost:3000' } });
    expect(local.status).toBe(401);
  });
});
