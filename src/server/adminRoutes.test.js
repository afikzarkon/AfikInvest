/**
 * @jest-environment node
 */
const express = require('express');
const { initAdminStore } = require('./adminStore');
const { mountAdminRoutes, createFlagGate } = require('./adminRoutes');
const { request, tokenFor, listen } = require('./testUtils/http');
const { STORE_FACTORIES } = require('./testUtils/stores');

describe.each(STORE_FACTORIES)('admin + feature flags API (%s)', (_name, makeStore) => {
  let store;
  let admin;
  let server;
  let baseUrl;
  let adminToken;
  let userToken;
  let adminId;

  beforeEach(async () => {
    store = await makeStore();
    admin = await initAdminStore(store);
    ({ id: adminId } = await store.insertUser('boss@example.com', 'x', { emailVerified: true }));
    const { id: userId } = await store.insertUser('user@example.com', 'x', { emailVerified: true });
    await store.insertUser('unverified@example.com', 'x');
    await admin.bootstrapAdmins(['boss@example.com']);
    adminToken = tokenFor(adminId, 'boss@example.com');
    userToken = tokenFor(userId, 'user@example.com');

    const app = express();
    app.use(express.json());
    const gate = createFlagGate();
    gate.attach(admin);
    app.use('/api/valuation', gate.require('valuation'));
    app.get('/api/valuation/x', (req, res) => res.json({ ok: true }));
    mountAdminRoutes(app, { admin, store });
    ({ server, baseUrl } = await listen(app));
  });
  afterEach(async () => {
    await new Promise((resolve) => server.close(resolve));
    await store.close();
  });

  test('bootstrap grants only verified accounts, once, and logs it', async () => {
    const r = await admin.bootstrapAdmins(['BOSS@example.com', 'unverified@example.com', 'nobody@example.com']);
    expect(r).toEqual({ granted: [], already: ['boss@example.com'], skipped: ['unverified@example.com', 'nobody@example.com'] });
    const entries = await admin.listAudit();
    expect(entries.filter((e) => e.action === 'admin.grant')).toHaveLength(1);
  });

  test('the defined flags are seeded on, and /api/features names only what the caller may see', async () => {
    let res = await request(baseUrl, 'GET', '/api/features');
    expect(res.status).toBe(200);
    expect(res.body.isAdmin).toBe(false);
    expect(res.body.flags).toEqual(expect.arrayContaining(['valuation', 'alerts']));

    await admin.updateFlag('valuation', { state: 'admin' }, { id: adminId, email: 'boss@example.com' });
    res = await request(baseUrl, 'GET', '/api/features', { token: userToken });
    expect(res.body.flags).not.toContain('valuation');
    res = await request(baseUrl, 'GET', '/api/features', { token: adminToken });
    expect(res.body).toMatchObject({ isAdmin: true });
    expect(res.body.flags).toContain('valuation');
  });

  test('admin API: 401 signed out, 403 for an ordinary user on every method', async () => {
    expect((await request(baseUrl, 'GET', '/api/admin/flags')).status).toBe(401);
    expect((await request(baseUrl, 'GET', '/api/admin/flags', { token: userToken })).status).toBe(403);
    expect((await request(baseUrl, 'POST', '/api/admin/flags', { token: userToken, body: { key: 'x-new', state: 'all' } })).status).toBe(403);
    expect((await request(baseUrl, 'PATCH', '/api/admin/flags/valuation', { token: userToken, body: { state: 'off' } })).status).toBe(403);
    expect((await request(baseUrl, 'DELETE', '/api/admin/flags/valuation', { token: userToken })).status).toBe(403);
    expect((await request(baseUrl, 'GET', '/api/admin/audit', { token: userToken })).status).toBe(403);
    // Nothing changed.
    expect((await admin.getFlag('valuation')).state).toBe('all');
  });

  test('an admin creates, updates and deletes flags; each change is audited with who and when', async () => {
    let res = await request(baseUrl, 'POST', '/api/admin/flags', {
      token: adminToken,
      body: { key: 'new-dashboard', description: 'לוח חדש', state: 'admin' }
    });
    expect(res.status).toBe(201);
    expect(res.body.flag).toMatchObject({ key: 'new-dashboard', state: 'admin', updatedByEmail: 'boss@example.com', builtIn: false });

    expect((await request(baseUrl, 'POST', '/api/admin/flags', { token: adminToken, body: { key: 'new-dashboard' } })).status).toBe(409);
    expect((await request(baseUrl, 'POST', '/api/admin/flags', { token: adminToken, body: { key: 'Bad Key!' } })).status).toBe(400);
    expect((await request(baseUrl, 'PATCH', '/api/admin/flags/new-dashboard', { token: adminToken, body: { state: 'maybe' } })).status).toBe(400);
    expect((await request(baseUrl, 'PATCH', '/api/admin/flags/missing', { token: adminToken, body: { state: 'off' } })).status).toBe(404);

    res = await request(baseUrl, 'PATCH', '/api/admin/flags/new-dashboard', { token: adminToken, body: { state: 'all' } });
    expect(res.status).toBe(200);
    expect(res.body.flag.state).toBe('all');

    expect((await request(baseUrl, 'DELETE', '/api/admin/flags/valuation', { token: adminToken })).status).toBe(409);
    expect((await request(baseUrl, 'DELETE', '/api/admin/flags/new-dashboard', { token: adminToken })).status).toBe(200);

    res = await request(baseUrl, 'GET', '/api/admin/audit', { token: adminToken });
    const actions = res.body.entries.map((e) => e.action);
    expect(actions).toEqual(expect.arrayContaining(['flag.create', 'flag.update', 'flag.delete']));
    const update = res.body.entries.find((e) => e.action === 'flag.update');
    expect(update).toMatchObject({ actorUserId: adminId, actorEmail: 'boss@example.com', target: 'flag:new-dashboard' });
    expect(update.before.state).toBe('admin');
    expect(update.after.state).toBe('all');
  });

  test('the gate hides a switched-off API (404), and an admin-only one from everyone but admins', async () => {
    expect((await request(baseUrl, 'GET', '/api/valuation/x')).status).toBe(200);

    await request(baseUrl, 'PATCH', '/api/admin/flags/valuation', { token: adminToken, body: { state: 'admin' } });
    expect((await request(baseUrl, 'GET', '/api/valuation/x')).status).toBe(404);
    expect((await request(baseUrl, 'GET', '/api/valuation/x', { token: userToken })).status).toBe(404);
    expect((await request(baseUrl, 'GET', '/api/valuation/x', { token: adminToken })).status).toBe(200);

    await request(baseUrl, 'PATCH', '/api/admin/flags/valuation', { token: adminToken, body: { state: 'off' } });
    expect((await request(baseUrl, 'GET', '/api/valuation/x', { token: adminToken })).status).toBe(404);
  });
});
