/**
 * @jest-environment node
 */
const express = require('express');
const { initAdminStore } = require('./adminStore');
const { initAccountStore } = require('./accountStore');
const { initFeatureStore } = require('./featureStore');
const { mountAdminRoutes, createFlagGate, csvCell } = require('./adminRoutes');
const { createSystemGate } = require('./systemRoutes');
const { createSessionIssuer } = require('./authSession');
const { installErrorCapture, scrub } = require('./errorLog');
const { request, tokenFor, listen } = require('./testUtils/http');
const { STORE_FACTORIES } = require('./testUtils/stores');

async function enable2fa(store, userId) {
  await store.setPendingTotpSecret(userId, 'secret');
  await store.enableTotp(userId);
}

describe.each(STORE_FACTORIES)('admin API (%s)', (_name, makeStore) => {
  let store;
  let admin;
  let accounts;
  let server;
  let baseUrl;
  let adminToken;
  let userToken;
  let adminId;
  let userId;
  let sentResets;

  beforeEach(async () => {
    store = await makeStore();
    accounts = await initAccountStore(store);
    admin = await initAdminStore(store, { require2fa: true });
    const features = await initFeatureStore(store);
    ({ id: adminId } = await store.insertUser('boss@example.com', 'x', { emailVerified: true }));
    ({ id: userId } = await store.insertUser('user@example.com', 'x', { emailVerified: true }));
    await store.insertUser('unverified@example.com', 'x');
    await admin.bootstrapAdmins(['boss@example.com']);
    await enable2fa(store, adminId);
    adminToken = tokenFor(adminId, 'boss@example.com');
    userToken = tokenFor(userId, 'user@example.com');
    sentResets = [];
    const auth = {
      core: {
        async endAllSessions(id) {
          await accounts.bumpTokenVersion(id);
          await accounts.revokeSessions(id);
        }
      },
      async sendPasswordReset(user) {
        sentResets.push(user.email);
        return true;
      }
    };

    const app = express();
    app.use(express.json());
    const system = createSystemGate();
    system.attach(admin);
    app.use((req, res, next) => system.middleware(req, res, next));
    system.mountStatus(app);
    const gate = createFlagGate();
    gate.attach(admin);
    app.use('/api/valuation', gate.require('valuation'));
    app.get('/api/valuation/x', (req, res) => res.json({ ok: true }));
    app.get('/api/portfolio', (req, res) => res.json({ ok: true }));
    mountAdminRoutes(app, { admin, store, accounts, auth, features });
    ({ server, baseUrl } = await listen(app));
  });
  afterEach(async () => {
    await new Promise((resolve) => server.close(resolve));
    await store.close();
  });

  const asAdmin = (method, path, body) => request(baseUrl, method, path, { token: adminToken, body });

  test('bootstrap grants only verified accounts, once, and logs it', async () => {
    const r = await admin.bootstrapAdmins(['BOSS@example.com', 'unverified@example.com', 'nobody@example.com']);
    expect(r).toEqual({ granted: [], already: ['boss@example.com'], skipped: ['unverified@example.com', 'nobody@example.com'] });
    expect((await admin.listAudit()).filter((e) => e.action === 'admin.grant')).toHaveLength(1);
  });

  test('an admin without 2FA holds the role but cannot use it', async () => {
    await store.disableTotp(adminId);
    const features = await request(baseUrl, 'GET', '/api/features', { token: adminToken });
    expect(features.body).toMatchObject({ isAdmin: true, adminActive: false, needs2fa: true });
    const res = await asAdmin('GET', '/api/admin/flags');
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('admin_2fa_required');
  });

  test('/api/features names only what the caller may see', async () => {
    let res = await request(baseUrl, 'GET', '/api/features');
    expect(res.body).toMatchObject({ isAdmin: false });
    expect(res.body.flags).toEqual(expect.arrayContaining(['valuation', 'alerts']));
    await admin.updateFlag('valuation', { state: 'admin' }, { id: adminId, email: 'boss@example.com' });
    res = await request(baseUrl, 'GET', '/api/features', { token: userToken });
    expect(res.body.flags).not.toContain('valuation');
    res = await request(baseUrl, 'GET', '/api/features', { token: adminToken });
    expect(res.body).toMatchObject({ isAdmin: true, adminActive: true });
    expect(res.body.flags).toContain('valuation');
  });

  test('every admin endpoint: 401 signed out, 403 for an ordinary user', async () => {
    const calls = [
      ['GET', '/api/admin/flags'],
      ['POST', '/api/admin/flags', { key: 'x-new', state: 'all' }],
      ['PATCH', '/api/admin/flags/valuation', { state: 'off' }],
      ['GET', '/api/admin/users'],
      ['POST', `/api/admin/users/${adminId}/block`, {}],
      ['POST', '/api/admin/admins', { email: 'user@example.com' }],
      ['PUT', '/api/admin/settings/maintenance', { enabled: true }],
      ['GET', '/api/admin/stats'],
      ['GET', '/api/admin/errors'],
      ['GET', '/api/admin/export/users.csv'],
      ['GET', '/api/admin/audit']
    ];
    for (const [method, path, body] of calls) {
      expect((await request(baseUrl, method, path, { body })).status).toBe(401);
      expect((await request(baseUrl, method, path, { token: userToken, body })).status).toBe(403);
    }
    expect((await admin.getFlag('valuation')).state).toBe('all');
    expect(await admin.isAdmin(userId)).toBe(false);
    expect((await admin.getSetting('maintenance')).enabled).toBe(false);
  });

  test('flags: create, update, delete - each audited with who and when', async () => {
    let res = await asAdmin('POST', '/api/admin/flags', { key: 'new-dashboard', description: 'לוח חדש', state: 'admin' });
    expect(res.status).toBe(201);
    expect(res.body.flag).toMatchObject({ key: 'new-dashboard', state: 'admin', updatedByEmail: 'boss@example.com', builtIn: false });
    expect((await asAdmin('POST', '/api/admin/flags', { key: 'new-dashboard' })).status).toBe(409);
    expect((await asAdmin('POST', '/api/admin/flags', { key: 'Bad Key!' })).status).toBe(400);
    expect((await asAdmin('PATCH', '/api/admin/flags/new-dashboard', { state: 'maybe' })).status).toBe(400);
    res = await asAdmin('PATCH', '/api/admin/flags/new-dashboard', { state: 'all' });
    expect(res.body.flag.state).toBe('all');
    expect((await asAdmin('DELETE', '/api/admin/flags/valuation')).status).toBe(409);
    expect((await asAdmin('DELETE', '/api/admin/flags/new-dashboard')).status).toBe(200);
    const update = (await admin.listAudit()).find((e) => e.action === 'flag.update');
    expect(update).toMatchObject({ actorUserId: adminId, actorEmail: 'boss@example.com', target: 'flag:new-dashboard' });
    expect([update.before.state, update.after.state]).toEqual(['admin', 'all']);
  });

  test('the flag gate: 404 when off, admins only when admin-only', async () => {
    expect((await request(baseUrl, 'GET', '/api/valuation/x')).status).toBe(200);
    await asAdmin('PATCH', '/api/admin/flags/valuation', { state: 'admin' });
    expect((await request(baseUrl, 'GET', '/api/valuation/x', { token: userToken })).status).toBe(404);
    expect((await request(baseUrl, 'GET', '/api/valuation/x', { token: adminToken })).status).toBe(200);
    await asAdmin('PATCH', '/api/admin/flags/valuation', { state: 'off' });
    expect((await request(baseUrl, 'GET', '/api/valuation/x', { token: adminToken })).status).toBe(404);
  });

  test('users: list shows account status only; block ends sessions and stops sign-in', async () => {
    const sid = await accounts.createSession({ userId, remember: true, authMethod: 'password', ttlMs: 3600000 });
    let res = await asAdmin('GET', '/api/admin/users?q=user@');
    expect(res.body.total).toBe(1);
    const listed = res.body.users[0];
    expect(listed).toMatchObject({ id: userId, email: 'user@example.com', emailVerified: true, activeSessions: 1, blocked: null, isAdmin: false });
    expect(Object.keys(listed)).not.toEqual(expect.arrayContaining(['payload', 'portfolio', 'password_hash', 'totp_secret']));

    expect((await asAdmin('POST', `/api/admin/users/${adminId}/block`, {})).status).toBe(400); // self / admin
    res = await asAdmin('POST', `/api/admin/users/${userId}/block`, { reason: 'ספאם' });
    expect(res.status).toBe(200);
    expect((await accounts.getSession(sid)).revokedAt).not.toBeNull();
    expect(await accounts.isBlocked(userId)).toBe(true);

    // Every sign-in path issues its session through here.
    const issue = createSessionIssuer({ accounts, jwtSecret: 's' });
    const fakeRes = { cookie() {} };
    const fakeReq = { ip: '1.2.3.4', get: () => '', headers: {} };
    await expect(issue(fakeReq, fakeRes, { id: userId, email: 'user@example.com' })).rejects.toMatchObject({ code: 'ACCOUNT_BLOCKED' });

    res = await asAdmin('GET', '/api/admin/users?q=user@');
    expect(res.body.users[0].blocked).toMatchObject({ reason: 'ספאם', by: 'boss@example.com' });
    expect((await asAdmin('POST', `/api/admin/users/${userId}/unblock`)).status).toBe(200);
    expect(await accounts.isBlocked(userId)).toBe(false);

    expect((await asAdmin('POST', `/api/admin/users/${userId}/password-reset`)).status).toBe(200);
    expect(sentResets).toEqual(['user@example.com']);
    expect((await asAdmin('POST', '/api/admin/users/9999/revoke-sessions')).status).toBe(404);

    const actions = (await admin.listAudit()).map((e) => e.action);
    expect(actions).toEqual(expect.arrayContaining(['user.block', 'user.unblock', 'user.password_reset_sent']));
  });

  test('admins: grant by email, never remove the last one', async () => {
    expect((await asAdmin('POST', '/api/admin/admins', { email: 'unverified@example.com' })).status).toBe(404);
    let res = await asAdmin('POST', '/api/admin/admins', { email: 'USER@example.com' });
    expect(res.status).toBe(201);
    expect(res.body.admins.map((a) => a.email)).toEqual(['boss@example.com', 'user@example.com']);
    res = await asAdmin('DELETE', `/api/admin/admins/${userId}`);
    expect(res.status).toBe(200);
    expect((await asAdmin('DELETE', `/api/admin/admins/${adminId}`)).status).toBe(409);
    expect((await admin.listAudit()).map((e) => e.action)).toEqual(expect.arrayContaining(['admin.grant', 'admin.revoke']));
  });

  test('banner: shown when active and not expired; maintenance: 503 for all but active admins', async () => {
    expect((await request(baseUrl, 'GET', '/api/system/status')).body.banner).toBeNull();
    expect((await asAdmin('PUT', '/api/admin/settings/banner', { active: true, text: '', level: 'info' })).status).toBe(400);
    await asAdmin('PUT', '/api/admin/settings/banner', { active: true, text: 'עדכון גרסה הלילה', level: 'warning' });
    let status = (await request(baseUrl, 'GET', '/api/system/status')).body;
    expect(status.banner).toMatchObject({ text: 'עדכון גרסה הלילה', level: 'warning' });
    await asAdmin('PUT', '/api/admin/settings/banner', { active: true, text: 'ישן', level: 'info', expiresAt: '2020-01-01T00:00:00Z' });
    expect((await request(baseUrl, 'GET', '/api/system/status')).body.banner).toBeNull();

    await asAdmin('PUT', '/api/admin/settings/maintenance', { enabled: true, message: 'שדרוג' });
    status = (await request(baseUrl, 'GET', '/api/system/status')).body;
    expect(status.maintenance).toEqual({ enabled: true, message: 'שדרוג' });
    let res = await request(baseUrl, 'GET', '/api/portfolio', { token: userToken });
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ maintenance: true, error: 'שדרוג' });
    expect((await request(baseUrl, 'GET', '/api/portfolio', { token: adminToken })).status).toBe(200);
    expect((await request(baseUrl, 'GET', '/api/features', { token: userToken })).status).toBe(200);

    await asAdmin('PUT', '/api/admin/settings/maintenance', { enabled: false });
    res = await request(baseUrl, 'GET', '/api/portfolio', { token: userToken });
    expect(res.status).toBe(200);
    expect((await admin.listAudit()).map((e) => e.action)).toEqual(expect.arrayContaining(['setting.banner', 'setting.maintenance']));
  });

  test('stats are counts only', async () => {
    const res = await asAdmin('GET', '/api/admin/stats');
    expect(res.body.users).toMatchObject({ total: 3, verified: 2, with2fa: 1, blocked: 0 });
    expect(res.body.signupsLast30Days).toHaveLength(30);
    expect(res.body.signupsLast30Days.reduce((s, d) => s + d.count, 0)).toBe(3);
    expect(JSON.stringify(res.body)).not.toMatch(/@example\.com/);
  });

  test('errors are captured scrubbed; exports are CSV, formula-safe and audited', async () => {
    const target = { error() {} };
    const uninstall = installErrorCapture(admin, { target });
    target.error('auth/login', new Error('boom for someone@example.com with eyJhbGciOiJ.eyJzdWIiOjF9.c2lnbmF0dXJl'));
    await new Promise((r) => setTimeout(r, 50));
    uninstall();
    const res = await asAdmin('GET', '/api/admin/errors');
    expect(res.body.errors[0].label).toBe('auth/login');
    expect(res.body.errors[0].detail).toContain('[email]');
    expect(res.body.errors[0].detail).toContain('[jwt]');
    expect(res.body.errors[0].detail).not.toContain('someone@example.com');

    const csv = await asAdmin('GET', '/api/admin/export/users.csv');
    expect(csv.headers['content-type']).toMatch(/text\/csv/);
    expect(String(csv.body)).toContain('user@example.com');
    expect((await admin.listAudit()).map((e) => e.action)).toContain('export.users');
    expect((await asAdmin('GET', '/api/admin/export/audit.csv')).status).toBe(200);
  });
});

test('csvCell neutralises formulas and quotes separators', () => {
  expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
  expect(csvCell('a,b')).toBe('"a,b"');
  expect(csvCell(null)).toBe('');
  expect(scrub('token abcdefghijklmnopqrstuvwxyz0123456789')).toBe('token [token]');
});
