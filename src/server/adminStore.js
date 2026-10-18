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
  'CREATE INDEX IF NOT EXISTS admin_audit_log_created_idx ON admin_audit_log (created_at)'
];

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

async function initAdminStore(store) {
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

  const api = {
    // ----- roles -----
    async isAdmin(userId) {
      if (!userId) return false;
      const row = await sql.get('SELECT role FROM user_roles WHERE user_id = ?', [Number(userId)]);
      return Boolean(row && row.role === ADMIN_ROLE);
    },
    async listAdmins() {
      const rows = await sql.all(
        `SELECT r.user_id, u.email, r.granted_at, r.granted_by FROM user_roles r
         JOIN users u ON u.id = r.user_id WHERE r.role = ? ORDER BY r.granted_at ASC`,
        [ADMIN_ROLE]
      );
      return rows.map((r) => ({ userId: Number(r.user_id), email: r.email, grantedAt: r.granted_at, grantedBy: r.granted_by }));
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
