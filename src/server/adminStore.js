// Storage for administration: who is an admin, the feature flags and the
// audit log of every admin action.
//
// Written once against the portable SQL adapter (sqlAdapter.js), like
// featureStore.js and accountStore.js. Conventions: timestamps are
// ISO-8601 TEXT, structured data JSON TEXT.
//
// The admin role lives here, in the database, and every admin request is
// checked against it on the server (adminRoutes.js). Nothing on the client
// grants anything: hiding the admin link from other users is a courtesy,
// not the protection.
const crypto = require('crypto');
const { FLAG_DEFINITIONS, isFlagState } = require('../shared/featureFlags');

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS user_roles (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    role TEXT NOT NULL,
    granted_at TEXT NOT NULL,
    granted_by TEXT NOT NULL
  )`,
  // updated_by is the admin's user id, kept without a foreign key (and with
  // the address beside it) so the history survives the account.
  `CREATE TABLE IF NOT EXISTS feature_flags (
    key TEXT PRIMARY KEY,
    description TEXT NOT NULL,
    state TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    updated_by INTEGER,
    updated_by_email TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS admin_audit_log (
    id TEXT PRIMARY KEY,
    actor_user_id INTEGER,
    actor_email TEXT,
    action TEXT NOT NULL,
    target TEXT,
    before_value TEXT,
    after_value TEXT,
    ip_prefix TEXT,
    created_at TEXT NOT NULL
  )`,
  'CREATE INDEX IF NOT EXISTS admin_audit_log_created_idx ON admin_audit_log (created_at)',
  // Site-wide settings an admin changes live: the banner, maintenance mode.
  // One JSON document per key.
  `CREATE TABLE IF NOT EXISTS system_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    updated_by_email TEXT
  )`,
  // Server errors captured from console.error (errorLog.js), scrubbed of
  // addresses and tokens before they are written.
  `CREATE TABLE IF NOT EXISTS server_errors (
    id TEXT PRIMARY KEY,
    created_at TEXT NOT NULL,
    label TEXT NOT NULL,
    detail TEXT NOT NULL
  )`,
  'CREATE INDEX IF NOT EXISTS server_errors_created_idx ON server_errors (created_at)'
];

// Admin powers need the role AND two-factor sign-in on the account.
// ADMIN_REQUIRE_2FA=0 lifts the second part, outside production only - for
// local development.
function defaultRequire2fa() {
  return process.env.NODE_ENV === 'production' || process.env.ADMIN_REQUIRE_2FA !== '0';
}

const truthy = (v) => v === true || Number(v) === 1;

// A users.created_at as YYYY-MM-DD: TEXT on SQLite, a Date from Postgres.
const dayOf = (v) => (v instanceof Date ? v.toISOString() : String(v || '')).slice(0, 10);
const isoOf = (v) => (v instanceof Date ? v.toISOString() : v ? String(v).replace(' ', 'T') : null);

const SETTING_DEFAULTS = {
  banner: { active: false, text: '', level: 'info', expiresAt: null },
  maintenance: { enabled: false, message: '' },
  // Outside data providers an admin has switched off (sourceSwitch.js).
  disabled_sources: { disabled: [] }
};
const SETTINGS_CACHE_MS = 5 * 1000;
const ERROR_RETENTION_DAYS = 30;

const ADMIN_ROLE = 'admin';
// How long the flag states are reused before the database is read again.
// Writes in this process clear it at once; another process (the worker, a
// second instance) sees a change within this window.
const FLAG_CACHE_MS = 5 * 1000;

const nowIso = () => new Date().toISOString();

const parseJson = (text) => {
  if (text === null || text === undefined || text === '') return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

function rowToFlag(row) {
  return {
    key: row.key,
    description: row.description,
    state: row.state,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    updatedBy: row.updated_by === null || row.updated_by === undefined ? null : Number(row.updated_by),
    updatedByEmail: row.updated_by_email || null,
    builtIn: FLAG_DEFINITIONS.some((f) => f.key === row.key)
  };
}

function rowToAudit(row) {
  return {
    id: row.id,
    actorUserId: row.actor_user_id === null || row.actor_user_id === undefined ? null : Number(row.actor_user_id),
    actorEmail: row.actor_email || null,
    action: row.action,
    target: row.target || null,
    before: parseJson(row.before_value),
    after: parseJson(row.after_value),
    ipPrefix: row.ip_prefix || null,
    createdAt: row.created_at
  };
}

// actor: { id, email, ipPrefix } - who did it, for the audit log.
async function insertAudit(sql, actor, action, target, before, after) {
  await sql.run(
    `INSERT INTO admin_audit_log (id, actor_user_id, actor_email, action, target, before_value, after_value, ip_prefix, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      crypto.randomUUID(),
      actor && actor.id ? Number(actor.id) : null,
      actor ? actor.email || null : null,
      action,
      target || null,
      before === undefined || before === null ? null : JSON.stringify(before),
      after === undefined || after === null ? null : JSON.stringify(after),
      actor ? actor.ipPrefix || null : null,
      nowIso()
    ]
  );
}

async function initAdminStore(store, { require2fa = defaultRequire2fa() } = {}) {
  const { sql } = store;
  for (const statement of SCHEMA) await sql.exec(statement);

  // The flags the code checks, in their default state, unless already there.
  for (const flag of FLAG_DEFINITIONS) {
    const ts = nowIso();
    await sql.run(
      `INSERT INTO feature_flags (key, description, state, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?) ON CONFLICT (key) DO NOTHING`,
      [flag.key, flag.description, flag.defaultState, ts, ts]
    );
  }

  let flagCache = null; // { states: { key: state }, at }
  const invalidate = () => {
    flagCache = null;
  };
  const settingsCache = new Map(); // key -> { value, at }

  const api = {
    require2fa,

    // ----- roles -----
    // Holds the role (whatever its 2FA) - what the client is told, so the
    // panel can say what is missing.
    async isAdmin(userId) {
      if (!userId) return false;
      const row = await sql.get('SELECT role FROM user_roles WHERE user_id = ?', [Number(userId)]);
      return Boolean(row && row.role === ADMIN_ROLE);
    },
    // May use admin powers now: the role, a live account, and two-factor
    // sign-in turned on (unless require2fa is off). Every server-side admin
    // check goes through this.
    async isActiveAdmin(userId) {
      return (await api.adminStatus(userId)).active;
    },
    // { isAdmin, active, needs2fa }
    async adminStatus(userId) {
      if (!userId) return { isAdmin: false, active: false, needs2fa: false };
      const row = await sql.get(
        `SELECT r.role, u.totp_enabled, u.deleted_at FROM user_roles r JOIN users u ON u.id = r.user_id WHERE r.user_id = ?`,
        [Number(userId)]
      );
      const isAdmin = Boolean(row && row.role === ADMIN_ROLE && !row.deleted_at);
      const has2fa = Boolean(row && truthy(row.totp_enabled));
      const active = isAdmin && (has2fa || !require2fa);
      return { isAdmin, active, needs2fa: isAdmin && !active };
    },
    // Returns true when the role was removed. Refuses (throws) to remove
    // the last admin, so the panel can never be left without one.
    async revokeAdmin(userId, actor) {
      return sql.transaction(async (tx) => {
        const row = await tx.get('SELECT role FROM user_roles WHERE user_id = ?', [Number(userId)]);
        if (!row) return false;
        const count = await tx.get('SELECT COUNT(*) AS n FROM user_roles WHERE role = ?', [ADMIN_ROLE]);
        if (Number(count.n) <= 1) {
          const err = new Error('last admin');
          err.code = 'LAST_ADMIN';
          throw err;
        }
        await tx.run('DELETE FROM user_roles WHERE user_id = ?', [Number(userId)]);
        await insertAudit(tx, actor, 'admin.revoke', `user:${Number(userId)}`, { role: row.role }, null);
        return true;
      });
    },
    async listAdmins() {
      const rows = await sql.all(
        `SELECT r.user_id, u.email, u.totp_enabled, r.granted_at, r.granted_by FROM user_roles r
         JOIN users u ON u.id = r.user_id WHERE r.role = ? ORDER BY r.granted_at ASC`,
        [ADMIN_ROLE]
      );
      return rows.map((r) => ({
        userId: Number(r.user_id),
        email: r.email,
        has2fa: truthy(r.totp_enabled),
        grantedAt: r.granted_at,
        grantedBy: r.granted_by
      }));
    },
    // grantedBy: who granted it, as text ('bootstrap:ADMIN_EMAILS', 'script',
    // or an admin's email). Returns true when the role was newly granted.
    async grantAdmin(userId, grantedBy, actor = null) {
      return sql.transaction(async (tx) => {
        const r = await tx.run(
          `INSERT INTO user_roles (user_id, role, granted_at, granted_by) VALUES (?, ?, ?, ?)
           ON CONFLICT (user_id) DO NOTHING`,
          [Number(userId), ADMIN_ROLE, nowIso(), String(grantedBy)]
        );
        if (r.changes > 0) await insertAudit(tx, actor, 'admin.grant', `user:${Number(userId)}`, null, { role: ADMIN_ROLE, grantedBy });
        return r.changes > 0;
      });
    },

    // Grants the admin role to each listed address that belongs to a
    // verified, live account - the first admin's way in (ADMIN_EMAILS).
    // Idempotent; an address with no such account is skipped and reported.
    async bootstrapAdmins(emails) {
      const result = { granted: [], already: [], skipped: [] };
      for (const raw of emails) {
        const email = String(raw || '').trim().toLowerCase();
        if (!email) continue;
        const user = await store.findUserForLogin(email);
        if (!user || !user.email_verified_at || user.deleted_at) {
          result.skipped.push(email);
          continue;
        }
        const granted = await api.grantAdmin(user.id, 'bootstrap:ADMIN_EMAILS', { id: null, email: 'system' });
        (granted ? result.granted : result.already).push(email);
      }
      return result;
    },

    // ----- feature flags -----
    async listFlags() {
      const rows = await sql.all('SELECT * FROM feature_flags ORDER BY key ASC');
      return rows.map(rowToFlag);
    },
    async getFlag(key) {
      const row = await sql.get('SELECT * FROM feature_flags WHERE key = ?', [key]);
      return row ? rowToFlag(row) : null;
    },
    // { key: state } for every flag, cached briefly - read on every gated
    // request and every client poll.
    async getFlagStates() {
      if (flagCache && Date.now() - flagCache.at < FLAG_CACHE_MS) return flagCache.states;
      const rows = await sql.all('SELECT key, state FROM feature_flags');
      const states = rows.reduce((acc, r) => ({ ...acc, [r.key]: r.state }), {});
      flagCache = { states, at: Date.now() };
      return states;
    },
    // Returns the new flag, or null when the key is taken.
    async createFlag({ key, description, state }, actor) {
      if (!isFlagState(state)) throw new Error(`invalid state ${state}`);
      const created = await sql.transaction(async (tx) => {
        const ts = nowIso();
        const r = await tx.run(
          `INSERT INTO feature_flags (key, description, state, created_at, updated_at, updated_by, updated_by_email)
           VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (key) DO NOTHING`,
          [key, description, state, ts, ts, Number(actor.id), actor.email]
        );
        if (r.changes === 0) return null;
        const flag = rowToFlag(await tx.get('SELECT * FROM feature_flags WHERE key = ?', [key]));
        await insertAudit(tx, actor, 'flag.create', `flag:${key}`, null, { state, description });
        return flag;
      });
      invalidate();
      return created;
    },
    // patch: { state?, description? }. Returns the updated flag, or null
    // when there is no such flag. A patch that changes nothing is not
    // logged.
    async updateFlag(key, patch, actor) {
      if (patch.state !== undefined && !isFlagState(patch.state)) throw new Error(`invalid state ${patch.state}`);
      const updated = await sql.transaction(async (tx) => {
        const beforeRow = await tx.get('SELECT * FROM feature_flags WHERE key = ?', [key]);
        if (!beforeRow) return null;
        const before = { state: beforeRow.state, description: beforeRow.description };
        const after = {
          state: patch.state !== undefined ? patch.state : before.state,
          description: patch.description !== undefined ? patch.description : before.description
        };
        if (after.state === before.state && after.description === before.description) return rowToFlag(beforeRow);
        await tx.run(
          'UPDATE feature_flags SET state = ?, description = ?, updated_at = ?, updated_by = ?, updated_by_email = ? WHERE key = ?',
          [after.state, after.description, nowIso(), Number(actor.id), actor.email, key]
        );
        await insertAudit(tx, actor, 'flag.update', `flag:${key}`, before, after);
        return rowToFlag(await tx.get('SELECT * FROM feature_flags WHERE key = ?', [key]));
      });
      invalidate();
      return updated;
    },
    // Returns true when a flag was deleted.
    async deleteFlag(key, actor) {
      const deleted = await sql.transaction(async (tx) => {
        const beforeRow = await tx.get('SELECT * FROM feature_flags WHERE key = ?', [key]);
        if (!beforeRow) return false;
        await tx.run('DELETE FROM feature_flags WHERE key = ?', [key]);
        await insertAudit(tx, actor, 'flag.delete', `flag:${key}`, { state: beforeRow.state, description: beforeRow.description }, null);
        return true;
      });
      invalidate();
      return deleted;
    },

    // ----- system settings (banner, maintenance) -----
    async getSetting(key) {
      const hit = settingsCache.get(key);
      if (hit && Date.now() - hit.at < SETTINGS_CACHE_MS) return hit.value;
      const row = await sql.get('SELECT value, updated_at, updated_by_email FROM system_settings WHERE key = ?', [key]);
      const stored = row ? parseJson(row.value) : null;
      const value = Object.assign({}, SETTING_DEFAULTS[key] || {}, stored || {}, {
        updatedAt: row ? row.updated_at : null,
        updatedByEmail: row ? row.updated_by_email || null : null
      });
      settingsCache.set(key, { value, at: Date.now() });
      return value;
    },
    async setSetting(key, value, actor) {
      await sql.transaction(async (tx) => {
        const beforeRow = await tx.get('SELECT value FROM system_settings WHERE key = ?', [key]);
        await tx.run(
          `INSERT INTO system_settings (key, value, updated_at, updated_by_email) VALUES (?, ?, ?, ?)
           ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by_email = excluded.updated_by_email`,
          [key, JSON.stringify(value), nowIso(), actor.email]
        );
        await insertAudit(tx, actor, `setting.${key}`, `setting:${key}`, beforeRow ? parseJson(beforeRow.value) : null, value);
      });
      settingsCache.delete(key);
      return api.getSetting(key);
    },

    // ----- server errors -----
    async insertError(label, detail) {
      await sql.run('INSERT INTO server_errors (id, created_at, label, detail) VALUES (?, ?, ?, ?)', [
        crypto.randomUUID(),
        nowIso(),
        String(label).slice(0, 300),
        String(detail).slice(0, 4000)
      ]);
    },
    async pruneErrors(now = Date.now()) {
      const cutoff = new Date(now - ERROR_RETENTION_DAYS * 86400000).toISOString();
      await sql.run('DELETE FROM server_errors WHERE created_at < ?', [cutoff]);
    },
    async listErrors(limit = 100) {
      const n = Math.min(Math.max(Number(limit) || 100, 1), 500);
      const rows = await sql.all('SELECT * FROM server_errors ORDER BY created_at DESC LIMIT ?', [n]);
      return rows.map((r) => ({ id: r.id, createdAt: r.created_at, label: r.label, detail: r.detail }));
    },
    async clearErrors(actor) {
      const r = await sql.run('DELETE FROM server_errors');
      await insertAudit(sql, actor, 'errors.clear', null, { count: r.changes }, null);
      return r.changes;
    },

    // ----- users (account status only - never portfolio contents) -----
    // { users, total }. q matches the address; LIKE's wildcards in it are
    // escaped with '!'.
    async listUsers({ q = '', limit = 50, offset = 0 } = {}) {
      const n = Math.min(Math.max(Number(limit) || 50, 1), 1000);
      const skip = Math.max(Number(offset) || 0, 0);
      const like = `%${String(q).trim().toLowerCase().replace(/[!%_]/g, (c) => `!${c}`)}%`;
      const rows = await sql.all(
        `SELECT u.id, u.email, u.created_at, u.email_verified_at, u.totp_enabled, u.deleted_at, u.password_set,
                b.reason AS block_reason, b.blocked_at, b.blocked_by, r.role,
                (SELECT MAX(s.last_seen_at) FROM user_sessions s WHERE s.user_id = u.id) AS last_seen_at,
                (SELECT COUNT(*) FROM user_sessions s WHERE s.user_id = u.id AND s.revoked_at IS NULL AND s.expires_at > ?) AS active_sessions
         FROM users u
         LEFT JOIN user_blocks b ON b.user_id = u.id
         LEFT JOIN user_roles r ON r.user_id = u.id
         WHERE LOWER(u.email) LIKE ? ESCAPE '!'
         ORDER BY u.id DESC LIMIT ? OFFSET ?`,
        [nowIso(), like, n, skip]
      );
      const total = await sql.get("SELECT COUNT(*) AS n FROM users u WHERE LOWER(u.email) LIKE ? ESCAPE '!'", [like]);
      const ids = rows.map((r) => Number(r.id));
      const providers = {};
      if (ids.length) {
        const links = await sql.all(`SELECT user_id, provider FROM oauth_accounts WHERE user_id IN (${ids.map(() => '?').join(', ')})`, ids);
        links.forEach((l) => {
          const id = Number(l.user_id);
          providers[id] = (providers[id] || []).concat(l.provider);
        });
      }
      return {
        total: Number(total ? total.n : 0),
        users: rows.map((r) => ({
          id: Number(r.id),
          email: r.email,
          createdAt: isoOf(r.created_at),
          emailVerified: Boolean(r.email_verified_at),
          has2fa: truthy(r.totp_enabled),
          hasPassword: r.password_set === null || r.password_set === undefined ? true : truthy(r.password_set),
          providers: providers[Number(r.id)] || [],
          lastSeenAt: r.last_seen_at || null,
          activeSessions: Number(r.active_sessions) || 0,
          isAdmin: r.role === ADMIN_ROLE,
          blocked: r.block_reason !== null && r.block_reason !== undefined ? { reason: r.block_reason, at: r.blocked_at, by: r.blocked_by } : null,
          deletionPending: Boolean(r.deleted_at)
        }))
      };
    },

    // ----- usage statistics: counts only -----
    async getStats(now = Date.now()) {
      const users = await sql.all('SELECT created_at, email_verified_at, totp_enabled, deleted_at FROM users');
      const count = (fn) => users.filter(fn).length;
      const since = (days) => new Date(now - days * 86400000).toISOString();
      const activeSince = async (days) =>
        Number((await sql.get('SELECT COUNT(DISTINCT user_id) AS n FROM user_sessions WHERE last_seen_at >= ?', [since(days)])).n) || 0;

      // Sign-ups per day for the last 30 days, every day present.
      const days = [];
      for (let i = 29; i >= 0; i -= 1) days.push(new Date(now - i * 86400000).toISOString().slice(0, 10));
      const perDay = {};
      days.forEach((d) => {
        perDay[d] = 0;
      });
      users.forEach((u) => {
        const d = dayOf(u.created_at);
        if (d in perDay) perDay[d] += 1;
      });

      const providerRows = await sql.all('SELECT provider, COUNT(DISTINCT user_id) AS n FROM oauth_accounts GROUP BY provider');
      const providers = {};
      providerRows.forEach((r) => {
        providers[r.provider] = Number(r.n);
      });
      const blocked = await sql.get('SELECT COUNT(*) AS n FROM user_blocks');
      const portfolios = await sql.get('SELECT COUNT(*) AS n FROM user_portfolios');
      return {
        users: {
          total: users.length,
          verified: count((u) => u.email_verified_at),
          with2fa: count((u) => truthy(u.totp_enabled)),
          deletionPending: count((u) => u.deleted_at),
          blocked: Number(blocked.n) || 0,
          withSavedPortfolio: Number(portfolios.n) || 0
        },
        active: { day: await activeSince(1), week: await activeSince(7), month: await activeSince(30) },
        signupsLast30Days: days.map((d) => ({ date: d, count: perDay[d] })),
        providers
      };
    },

    // ----- audit log -----
    async logAdminAction(actor, action, target, before = null, after = null) {
      await insertAudit(sql, actor, action, target, before, after);
    },
    // Newest first; `before` (an ISO timestamp) pages back.
    async listAudit({ limit = 100, before = null } = {}) {
      const n = Math.min(Math.max(Number(limit) || 100, 1), 500);
      const rows = before
        ? await sql.all('SELECT * FROM admin_audit_log WHERE created_at < ? ORDER BY created_at DESC LIMIT ?', [String(before), n])
        : await sql.all('SELECT * FROM admin_audit_log ORDER BY created_at DESC LIMIT ?', [n]);
      return rows.map(rowToAudit);
    }
  };
  return api;
}

module.exports = { initAdminStore, ADMIN_ROLE };
