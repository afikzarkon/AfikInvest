/**
 * @jest-environment node
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const { sqliteStore, openSqlite } = require('./dataStore');
const { initAccountStore, MIGRATIONS } = require('./accountStore');

async function freshStores() {
  const store = sqliteStore(openSqlite(':memory:'));
  const accounts = await initAccountStore(store);
  return { store, accounts };
}

describe('migrations', () => {
  test('an existing database keeps its users, who count as verified', async () => {
    const file = path.join(os.tmpdir(), `afikinvest-migration-${process.pid}-${Date.now()}.db`);
    // The users table as it was before this change.
    const old = new Database(file);
    old.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL UNIQUE COLLATE NOCASE,
      password_hash TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')))`);
    old.prepare("INSERT INTO users (email, password_hash, created_at) VALUES ('old@example.com', 'h', '2025-01-02 03:04:05')").run();
    old.close();
    const db = openSqlite(file);
    try {
      const store = sqliteStore(db);
      await initAccountStore(store);
      const user = await store.findUserForLogin('old@example.com');
      expect(user).toMatchObject({ email: 'old@example.com', password_hash: 'h', password_set: true, deleted_at: null });
      expect(user.email_verified_at).toBe('2025-01-02 03:04:05');
      // A new account starts unverified.
      const { id } = await store.insertUser('new@example.com', 'h2');
      expect((await store.getAuthUser(id)).email_verified_at).toBeNull();
      // Running again changes nothing and records each migration once.
      await initAccountStore(store);
      const applied = await store.sql.all('SELECT id FROM schema_migrations');
      expect(applied.map((r) => r.id)).toEqual(MIGRATIONS.map((m) => m.id));
    } finally {
      db.close();
      fs.rmSync(file, { force: true });
      fs.rmSync(`${file}-wal`, { force: true });
      fs.rmSync(`${file}-shm`, { force: true });
    }
  });

  test('the market reference table is created, empty, and the reference memory reads and writes it', async () => {
    const { store } = await freshStores();
    expect(await store.sql.all('SELECT key FROM market_reference')).toEqual([]);
    const { createReferenceMemory } = require('./dcfSnapshot');
    const memory = createReferenceMemory();
    memory.attach(store.sql);
    await memory.set('rf', { value: 0.0512, asOf: '2026-10-16' });
    expect(await store.sql.get('SELECT value FROM market_reference WHERE key = ?', ['rf'])).toEqual({ value: JSON.stringify({ value: 0.0512, asOf: '2026-10-16' }) });
  });

  test('insertUser records a provider-verified address and an account without a password', async () => {
    const { store } = await freshStores();
    const { id } = await store.insertUser('g@example.com', 'random', { emailVerified: true, passwordSet: false });
    const user = await store.getAuthUser(id);
    expect(user.email_verified_at).toMatch(/^\d{4}-\d\d-\d\dT/);
    expect(user.password_set).toBe(false);
  });
});

describe('account store', () => {
  test('sessions: create, list, revoke one, revoke the others', async () => {
    const { store, accounts } = await freshStores();
    const { id: userId } = await store.insertUser('s@example.com', 'h');
    const base = { userId, remember: true, authMethod: 'password', userAgent: 'UA', ipPrefix: '1.2.3.0', ttlMs: 60000 };
    const a = await accounts.createSession(base);
    const b = await accounts.createSession(base);
    const c = await accounts.createSession(base);
    expect((await accounts.listActiveSessions(userId)).map((s) => s.id).sort()).toEqual([a, b, c].sort());
    expect(await accounts.revokeSession(999, a)).toBe(false); // not the owner
    expect(await accounts.revokeSession(userId, a)).toBe(true);
    expect((await accounts.revokeSessions(userId, b)).sort()).toEqual([c]);
    expect((await accounts.listActiveSessions(userId)).map((s) => s.id)).toEqual([b]);
  });

  test('one-time tokens are single-use, expire, and a new one replaces the old', async () => {
    const { store, accounts } = await freshStores();
    const { id: userId } = await store.insertUser('t@example.com', 'h');
    await accounts.createToken({ tokenHash: 'h1', purpose: 'verify_email', userId, ttlMs: 60000 });
    await accounts.createToken({ tokenHash: 'h2', purpose: 'verify_email', userId, ttlMs: 60000 });
    expect(await accounts.findToken('h1', 'verify_email')).toBeNull(); // replaced
    expect(await accounts.findToken('h2', 'other')).toBeNull(); // wrong purpose
    expect((await accounts.consumeToken('h2', 'verify_email')).userId).toBe(userId);
    expect(await accounts.consumeToken('h2', 'verify_email')).toBeNull(); // used
    await accounts.createToken({ tokenHash: 'h3', purpose: 'magic_link', email: 'x@example.com', ttlMs: -1 });
    expect(await accounts.consumeToken('h3', 'magic_link')).toBeNull(); // expired
  });

  test('profile: optional fields, clearing one, extras, avatar', async () => {
    const { store, accounts } = await freshStores();
    const { id: userId } = await store.insertUser('p@example.com', 'h');
    expect(await accounts.getProfile(userId)).toMatchObject({ firstName: '', hasAvatar: false });
    await accounts.updateProfile(userId, { firstName: 'דנה', phone: '050' });
    await accounts.updateProfile(userId, { phone: '' });
    await accounts.setProviderName(userId, 'Dana G');
    await accounts.setProviderName(userId, 'Other'); // only the first sticks
    await accounts.updateProfileExtra(userId, { goal: 'retirement', dismissed: true });
    await accounts.updateProfileExtra(userId, { dismissed: null });
    await accounts.setAvatar(userId, 'aGVsbG8=', 'image/png');
    expect(await accounts.getProfile(userId)).toMatchObject({
      firstName: 'דנה',
      phone: '',
      providerName: 'Dana G',
      hasAvatar: true,
      extra: { goal: 'retirement' }
    });
    expect(await accounts.getAvatar(userId)).toMatchObject({ base64: 'aGVsbG8=', mimeType: 'image/png' });
    await accounts.deleteAvatar(userId);
    expect(await accounts.getAvatar(userId)).toBeNull();
  });

  test('backup codes are used once', async () => {
    const { store, accounts } = await freshStores();
    const { id: userId } = await store.insertUser('b@example.com', 'h');
    await accounts.replaceBackupCodes(userId, ['c1', 'c2']);
    expect(await accounts.consumeBackupCode(userId, 'c1')).toBe(true);
    expect(await accounts.consumeBackupCode(userId, 'c1')).toBe(false);
    expect(await accounts.countUnusedBackupCodes(userId)).toBe(1);
  });

  test('changing to an address another account has is refused', async () => {
    const { store, accounts } = await freshStores();
    const { id: a } = await store.insertUser('a@example.com', 'h');
    await store.insertUser('taken@example.com', 'h');
    expect(await accounts.changeEmail(a, 'taken@example.com')).toBe(false);
    expect(await accounts.changeEmail(a, 'fresh@example.com')).toBe(true);
    expect((await store.getAuthUser(a)).email).toBe('fresh@example.com');
  });

  test('purging removes every row the user had, and only theirs', async () => {
    const { store, accounts } = await freshStores();
    const { id: gone } = await store.insertUser('gone@example.com', 'h');
    const { id: kept } = await store.insertUser('kept@example.com', 'h');
    for (const userId of [gone, kept]) {
      await store.upsertPortfolio(userId, '{}');
      await accounts.createSession({ userId, remember: true, authMethod: 'password', ttlMs: 1000 });
      await accounts.logEvent(userId, 'login');
      await accounts.linkOAuthAccount({ provider: 'google', providerUserId: `g${userId}`, userId });
      await accounts.updateProfile(userId, { firstName: 'x' });
    }
    expect(await accounts.purgeUser(gone)).toBe(false); // not marked for deletion
    await accounts.markDeleted(gone, new Date(Date.now() - 1000).toISOString());
    expect((await accounts.listUsersDueForPurge()).map((u) => u.id)).toEqual([gone]);
    expect(await accounts.purgeUser(gone)).toBe(true);

    const count = async (table, userId) => Number((await store.sql.get(`SELECT COUNT(*) AS n FROM ${table} WHERE user_id = ?`, [userId])).n);
    for (const table of ['user_portfolios', 'user_sessions', 'auth_events', 'oauth_accounts', 'user_profiles']) {
      expect(await count(table, gone)).toBe(0);
      expect(await count(table, kept)).toBe(1);
    }
    expect(await store.getAuthUser(gone)).toBeNull();
  });
});
