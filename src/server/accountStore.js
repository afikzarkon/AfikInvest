// Storage for the account lifecycle: device sessions, the security log,
// linked sign-in providers, one-time tokens (email verification, sign-in
// links, email change, ...), 2FA backup codes, the optional profile,
// consents and anonymous exit feedback - plus the account-level updates to
// the users table (verification, email, password, deletion).
//
// Written once against the portable SQL adapter (sqlAdapter.js), like
// featureStore.js. Conventions: ids are random TEXT, timestamps ISO-8601
// TEXT, structured data JSON TEXT.
//
// Schema changes go through MIGRATIONS below: each runs once, in order, and
// is recorded in schema_migrations. They only ever ADD - nothing existing
// is renamed or dropped, so a deploy can never lose data. The users
// table's own new columns are added in dataStore.js, where that table is
// created.
const crypto = require('crypto');

const nowIso = () => new Date().toISOString();
const newId = () => crypto.randomBytes(16).toString('hex');

const parseJson = (text, fallback) => {
  if (text === null || text === undefined || text === '') return fallback;
  if (typeof text === 'object') return text;
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
};

const MIGRATIONS = [
  {
    id: '2026-10-account-v1',
    statements: [
      `CREATE TABLE IF NOT EXISTS user_sessions (
        id TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        remember INTEGER NOT NULL DEFAULT 1,
        auth_method TEXT NOT NULL,
        user_agent TEXT,
        ip_prefix TEXT,
        country TEXT,
        revoked_at TEXT
      )`,
      'CREATE INDEX IF NOT EXISTS user_sessions_user_idx ON user_sessions (user_id)',
      `CREATE TABLE IF NOT EXISTS auth_events (
        id TEXT PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        type TEXT NOT NULL,
        created_at TEXT NOT NULL,
        ip_prefix TEXT,
        user_agent TEXT,
        meta TEXT
      )`,
      'CREATE INDEX IF NOT EXISTS auth_events_user_idx ON auth_events (user_id, created_at)',
      `CREATE TABLE IF NOT EXISTS oauth_accounts (
        provider TEXT NOT NULL,
        provider_user_id TEXT NOT NULL,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        email TEXT,
        display_name TEXT,
        created_at TEXT NOT NULL,
        PRIMARY KEY (provider, provider_user_id)
      )`,
      'CREATE INDEX IF NOT EXISTS oauth_accounts_user_idx ON oauth_accounts (user_id)',
      `CREATE TABLE IF NOT EXISTS one_time_tokens (
        token_hash TEXT PRIMARY KEY,
        purpose TEXT NOT NULL,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        email TEXT,
        payload TEXT,
        attempts INTEGER NOT NULL DEFAULT 0,
        expires_at TEXT NOT NULL,
        used_at TEXT,
        created_at TEXT NOT NULL
      )`,
      'CREATE INDEX IF NOT EXISTS one_time_tokens_user_idx ON one_time_tokens (user_id, purpose)',
      `CREATE TABLE IF NOT EXISTS backup_codes (
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        code_hash TEXT NOT NULL,
        used_at TEXT,
        created_at TEXT NOT NULL,
        PRIMARY KEY (user_id, code_hash)
      )`,
      `CREATE TABLE IF NOT EXISTS user_profiles (
        user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        first_name TEXT,
        last_name TEXT,
        display_name TEXT,
        phone TEXT,
        birth_date TEXT,
        country TEXT,
        timezone TEXT,
        provider_name TEXT,
        avatar TEXT,
        avatar_type TEXT,
        avatar_updated_at TEXT,
        extra TEXT,
        updated_at TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS user_consents (
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        granted INTEGER NOT NULL,
        version TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (user_id, kind)
      )`,
      // Anonymous on purpose: no user id, nothing that leads back to anyone.
      `CREATE TABLE IF NOT EXISTS deletion_feedback (
        id TEXT PRIMARY KEY,
        reason TEXT,
        comment TEXT,
        created_at TEXT NOT NULL
      )`
    ]
  },
  {
    // Market reference figures kept between runs - the last 10-year
    // Treasury yield fetched, for when the source is down (dcfSnapshot.js).
    id: '2026-10-market-reference-v1',
    statements: [
      `CREATE TABLE IF NOT EXISTS market_reference (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`
    ]
  },
  {
    // Accounts an admin has blocked (adminRoutes.js). While a row exists no
    // session can be issued (authSession.js) and the block itself ended the
    // live ones. blocked_by is the admin's address, kept as text.
    id: '2026-10-user-blocks-v1',
    statements: [
      `CREATE TABLE IF NOT EXISTS user_blocks (
        user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        reason TEXT NOT NULL,
        blocked_at TEXT NOT NULL,
        blocked_by TEXT NOT NULL
      )`
    ]
  }
];

async function runMigrations(sql) {
  await sql.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    id TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL
  )`);
  const done = new Set((await sql.all('SELECT id FROM schema_migrations')).map((r) => r.id));
  for (const migration of MIGRATIONS) {
    if (done.has(migration.id)) continue;
    // Each statement is idempotent (IF NOT EXISTS), so a migration that was
    // interrupted part-way is simply run again in full.
    for (const statement of migration.statements) await sql.exec(statement);
    await sql.run('INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?) ON CONFLICT (id) DO NOTHING', [
      migration.id,
      nowIso()
    ]);
  }
}

const isUniqueViolation = (err) =>
  Boolean(err && (err.code === 'SQLITE_CONSTRAINT_UNIQUE' || err.code === 'SQLITE_CONSTRAINT_PRIMARYKEY' || err.code === '23505'));

function rowToSession(row) {
  return {
    id: row.id,
    userId: Number(row.user_id),
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    expiresAt: row.expires_at,
    remember: Number(row.remember) === 1,
    authMethod: row.auth_method,
    userAgent: row.user_agent || '',
    ipPrefix: row.ip_prefix || '',
    country: row.country || '',
    revokedAt: row.revoked_at || null
  };
}

function rowToToken(row) {
  if (!row) return null;
  return {
    tokenHash: row.token_hash,
    purpose: row.purpose,
    userId: row.user_id === null || row.user_id === undefined ? null : Number(row.user_id),
    email: row.email || null,
    payload: parseJson(row.payload, {}),
    attempts: Number(row.attempts) || 0,
    expiresAt: row.expires_at,
    usedAt: row.used_at || null,
    createdAt: row.created_at
  };
}

const PROFILE_FIELDS = ['first_name', 'last_name', 'display_name', 'phone', 'birth_date', 'country', 'timezone'];

function rowToProfile(row) {
  const profile = {
    firstName: '',
    lastName: '',
    displayName: '',
    phone: '',
    birthDate: '',
    country: '',
    timezone: '',
    providerName: '',
    hasAvatar: false,
    avatarUpdatedAt: null,
    extra: {}
  };
  if (!row) return profile;
  return {
    firstName: row.first_name || '',
    lastName: row.last_name || '',
    displayName: row.display_name || '',
    phone: row.phone || '',
    birthDate: row.birth_date || '',
    country: row.country || '',
    timezone: row.timezone || '',
    providerName: row.provider_name || '',
    hasAvatar: Boolean(row.avatar),
    avatarUpdatedAt: row.avatar_updated_at || null,
    extra: parseJson(row.extra, {})
  };
}

async function initAccountStore(store) {
  const { sql } = store;
  await runMigrations(sql);

  // An empty profile row to update, created on first use.
  async function ensureProfile(userId) {
    await sql.run('INSERT INTO user_profiles (user_id, updated_at) VALUES (?, ?) ON CONFLICT (user_id) DO NOTHING', [userId, nowIso()]);
  }

  return {
    // ----- device sessions -----
    async createSession({ userId, remember, authMethod, userAgent, ipPrefix, country, ttlMs }) {
      const id = newId();
      const now = new Date();
      await sql.run(
        `INSERT INTO user_sessions (id, user_id, created_at, last_seen_at, expires_at, remember, auth_method, user_agent, ip_prefix, country)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          userId,
          now.toISOString(),
          now.toISOString(),
          new Date(now.getTime() + ttlMs).toISOString(),
          remember ? 1 : 0,
          authMethod,
          String(userAgent || '').slice(0, 400),
          ipPrefix || '',
          country || ''
        ]
      );
      return id;
    },
    async getSession(id) {
      const row = await sql.get('SELECT * FROM user_sessions WHERE id = ?', [id]);
      return row ? rowToSession(row) : null;
    },
    async touchSession(id, at = nowIso()) {
      await sql.run('UPDATE user_sessions SET last_seen_at = ? WHERE id = ? AND revoked_at IS NULL', [at, id]);
    },
    async listActiveSessions(userId, now = nowIso()) {
      const rows = await sql.all(
        'SELECT * FROM user_sessions WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ? ORDER BY last_seen_at DESC',
        [userId, now]
      );
      return rows.map(rowToSession);
    },
    // Returns whether a live session was revoked - only the owner's.
    async revokeSession(userId, id) {
      const r = await sql.run('UPDATE user_sessions SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL', [
        nowIso(),
        id,
        userId
      ]);
      return r.changes > 0;
    },
    // Every session but exceptId (none spared without it). Returns the
    // revoked ids, for the session guard's cache.
    async revokeSessions(userId, exceptId = null) {
      const rows = await sql.all('SELECT id FROM user_sessions WHERE user_id = ? AND revoked_at IS NULL', [userId]);
      const ids = rows.map((r) => r.id).filter((id) => id !== exceptId);
      for (const id of ids) {
        await sql.run('UPDATE user_sessions SET revoked_at = ? WHERE id = ?', [nowIso(), id]);
      }
      return ids;
    },
    // Old rows: expired or revoked more than `olderThan` ago.
    async pruneSessions(olderThan) {
      const r = await sql.run('DELETE FROM user_sessions WHERE expires_at < ? OR (revoked_at IS NOT NULL AND revoked_at < ?)', [
        olderThan,
        olderThan
      ]);
      return r.changes;
    },

    // ----- security log -----
    // meta must never carry a password, token or code - the callers pass
    // only labels (the provider, a masked address).
    async logEvent(userId, type, { ipPrefix = '', userAgent = '', meta = null } = {}) {
      await sql.run('INSERT INTO auth_events (id, user_id, type, created_at, ip_prefix, user_agent, meta) VALUES (?, ?, ?, ?, ?, ?, ?)', [
        newId(),
        userId,
        type,
        nowIso(),
        ipPrefix,
        String(userAgent || '').slice(0, 400),
        meta ? JSON.stringify(meta) : null
      ]);
    },
    async listEvents(userId, limit = 50) {
      const rows = await sql.all('SELECT * FROM auth_events WHERE user_id = ? ORDER BY created_at DESC LIMIT ?', [userId, limit]);
      return rows.map((r) => ({
        id: r.id,
        type: r.type,
        createdAt: r.created_at,
        ipPrefix: r.ip_prefix || '',
        userAgent: r.user_agent || '',
        meta: parseJson(r.meta, null)
      }));
    },

    // ----- linked sign-in providers -----
    async findOAuthAccount(provider, providerUserId) {
      const row = await sql.get('SELECT * FROM oauth_accounts WHERE provider = ? AND provider_user_id = ?', [provider, String(providerUserId)]);
      return row ? { provider: row.provider, providerUserId: row.provider_user_id, userId: Number(row.user_id), email: row.email || '' } : null;
    },
    async listOAuthAccounts(userId) {
      const rows = await sql.all('SELECT * FROM oauth_accounts WHERE user_id = ? ORDER BY created_at', [userId]);
      return rows.map((r) => ({ provider: r.provider, email: r.email || '', displayName: r.display_name || '', createdAt: r.created_at }));
    },
    async linkOAuthAccount({ provider, providerUserId, userId, email, displayName }) {
      await sql.run(
        `INSERT INTO oauth_accounts (provider, provider_user_id, user_id, email, display_name, created_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (provider, provider_user_id) DO NOTHING`,
        [provider, String(providerUserId), userId, email || null, displayName || null, nowIso()]
      );
    },
    async unlinkOAuthAccount(userId, provider) {
      const r = await sql.run('DELETE FROM oauth_accounts WHERE user_id = ? AND provider = ?', [userId, provider]);
      return r.changes > 0;
    },
    // Facebook's data deletion callback names only its own user id.
    async deleteOAuthByProviderUser(provider, providerUserId) {
      const r = await sql.run('DELETE FROM oauth_accounts WHERE provider = ? AND provider_user_id = ?', [provider, String(providerUserId)]);
      return r.changes > 0;
    },

    // ----- one-time tokens -----
    // Only the hash is stored. replace: drop the user's/email's unused
    // tokens of the same purpose, so only the newest link works.
    async createToken({ tokenHash, purpose, userId = null, email = null, payload = null, ttlMs, replace = true }) {
      if (replace) {
        if (userId !== null) {
          await sql.run('DELETE FROM one_time_tokens WHERE user_id = ? AND purpose = ? AND used_at IS NULL', [userId, purpose]);
        } else if (email) {
          await sql.run('DELETE FROM one_time_tokens WHERE email = ? AND purpose = ? AND user_id IS NULL AND used_at IS NULL', [email, purpose]);
        }
      }
      await sql.run(
        'INSERT INTO one_time_tokens (token_hash, purpose, user_id, email, payload, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [tokenHash, purpose, userId, email, payload ? JSON.stringify(payload) : null, new Date(Date.now() + ttlMs).toISOString(), nowIso()]
      );
    },
    // The live (unused, unexpired) token with this hash and purpose.
    async findToken(tokenHash, purpose, now = nowIso()) {
      const row = await sql.get(
        'SELECT * FROM one_time_tokens WHERE token_hash = ? AND purpose = ? AND used_at IS NULL AND expires_at > ?',
        [tokenHash, purpose, now]
      );
      return rowToToken(row);
    },
    // Marks it used and returns it - exactly once, even under a race.
    async consumeToken(tokenHash, purpose, now = nowIso()) {
      const r = await sql.run(
        'UPDATE one_time_tokens SET used_at = ? WHERE token_hash = ? AND purpose = ? AND used_at IS NULL AND expires_at > ? RETURNING *',
        [now, tokenHash, purpose, now]
      );
      return r.rows && r.rows[0] ? rowToToken(r.rows[0]) : null;
    },
    async latestToken(userId, purpose, now = nowIso()) {
      const row = await sql.get(
        'SELECT * FROM one_time_tokens WHERE user_id = ? AND purpose = ? AND used_at IS NULL AND expires_at > ? ORDER BY created_at DESC LIMIT 1',
        [userId, purpose, now]
      );
      return rowToToken(row);
    },
    async listTokens(userId, purpose, now = nowIso()) {
      const rows = await sql.all(
        'SELECT * FROM one_time_tokens WHERE user_id = ? AND purpose = ? AND used_at IS NULL AND expires_at > ? ORDER BY created_at DESC',
        [userId, purpose, now]
      );
      return rows.map(rowToToken);
    },
    async addTokenAttempt(tokenHash) {
      await sql.run('UPDATE one_time_tokens SET attempts = attempts + 1 WHERE token_hash = ?', [tokenHash]);
    },
    async deleteTokens(userId, purpose) {
      await sql.run('DELETE FROM one_time_tokens WHERE user_id = ? AND purpose = ?', [userId, purpose]);
    },
    async pruneTokens(olderThan) {
      const r = await sql.run('DELETE FROM one_time_tokens WHERE expires_at < ?', [olderThan]);
      return r.changes;
    },

    // ----- 2FA backup codes -----
    async replaceBackupCodes(userId, codeHashes) {
      await sql.transaction(async (tx) => {
        await tx.run('DELETE FROM backup_codes WHERE user_id = ?', [userId]);
        for (const hash of codeHashes) {
          await tx.run('INSERT INTO backup_codes (user_id, code_hash, created_at) VALUES (?, ?, ?)', [userId, hash, nowIso()]);
        }
      });
    },
    async consumeBackupCode(userId, codeHash) {
      const r = await sql.run('UPDATE backup_codes SET used_at = ? WHERE user_id = ? AND code_hash = ? AND used_at IS NULL', [
        nowIso(),
        userId,
        codeHash
      ]);
      return r.changes > 0;
    },
    async countUnusedBackupCodes(userId) {
      const row = await sql.get('SELECT COUNT(*) AS n FROM backup_codes WHERE user_id = ? AND used_at IS NULL', [userId]);
      return row ? Number(row.n) : 0;
    },
    async deleteBackupCodes(userId) {
      await sql.run('DELETE FROM backup_codes WHERE user_id = ?', [userId]);
    },

    // ----- the optional profile -----
    async getProfile(userId) {
      const row = await sql.get(
        `SELECT first_name, last_name, display_name, phone, birth_date, country, timezone, provider_name,
                CASE WHEN avatar IS NULL THEN NULL ELSE 'x' END AS avatar, avatar_updated_at, extra
         FROM user_profiles WHERE user_id = ?`,
        [userId]
      );
      return rowToProfile(row);
    },
    // fields: camelCase keys; '' clears a field (a legal choice).
    async updateProfile(userId, fields) {
      await ensureProfile(userId);
      const map = {
        firstName: 'first_name',
        lastName: 'last_name',
        displayName: 'display_name',
        phone: 'phone',
        birthDate: 'birth_date',
        country: 'country',
        timezone: 'timezone'
      };
      const sets = [];
      const params = [];
      Object.entries(map).forEach(([key, column]) => {
        if (!Object.prototype.hasOwnProperty.call(fields, key)) return;
        if (!PROFILE_FIELDS.includes(column)) return;
        sets.push(`${column} = ?`);
        params.push(fields[key] === '' ? null : fields[key]);
      });
      if (!sets.length) return;
      sets.push('updated_at = ?');
      params.push(nowIso(), userId);
      await sql.run(`UPDATE user_profiles SET ${sets.join(', ')} WHERE user_id = ?`, params);
    },
    // The name a provider gave, used only while the user has set none.
    async setProviderName(userId, name) {
      if (!name) return;
      await ensureProfile(userId);
      await sql.run('UPDATE user_profiles SET provider_name = ? WHERE user_id = ? AND provider_name IS NULL', [String(name).slice(0, 80), userId]);
    },
    // Merges keys into the profile's free-form extras (onboarding answers,
    // dismissed prompts); a null value removes the key.
    async updateProfileExtra(userId, patch) {
      await ensureProfile(userId);
      const row = await sql.get('SELECT extra FROM user_profiles WHERE user_id = ?', [userId]);
      const extra = parseJson(row && row.extra, {});
      Object.entries(patch).forEach(([k, v]) => {
        if (v === null) delete extra[k];
        else extra[k] = v;
      });
      await sql.run('UPDATE user_profiles SET extra = ?, updated_at = ? WHERE user_id = ?', [JSON.stringify(extra), nowIso(), userId]);
      return extra;
    },
    async setAvatar(userId, base64, mimeType) {
      await ensureProfile(userId);
      await sql.run('UPDATE user_profiles SET avatar = ?, avatar_type = ?, avatar_updated_at = ?, updated_at = ? WHERE user_id = ?', [
        base64,
        mimeType,
        nowIso(),
        nowIso(),
        userId
      ]);
    },
    async getAvatar(userId) {
      const row = await sql.get('SELECT avatar, avatar_type, avatar_updated_at FROM user_profiles WHERE user_id = ?', [userId]);
      if (!row || !row.avatar) return null;
      return { base64: row.avatar, mimeType: row.avatar_type || 'image/jpeg', updatedAt: row.avatar_updated_at };
    },
    async deleteAvatar(userId) {
      await sql.run('UPDATE user_profiles SET avatar = NULL, avatar_type = NULL, avatar_updated_at = ?, updated_at = ? WHERE user_id = ?', [
        nowIso(),
        nowIso(),
        userId
      ]);
    },

    // ----- consents -----
    async setConsent(userId, kind, granted, version = null) {
      await sql.run(
        `INSERT INTO user_consents (user_id, kind, granted, version, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (user_id, kind) DO UPDATE SET granted = excluded.granted, version = excluded.version, updated_at = excluded.updated_at`,
        [userId, kind, granted ? 1 : 0, version, nowIso()]
      );
    },
    async listConsents(userId) {
      const rows = await sql.all('SELECT kind, granted, version, updated_at FROM user_consents WHERE user_id = ?', [userId]);
      const out = {};
      rows.forEach((r) => {
        out[r.kind] = { granted: Number(r.granted) === 1, version: r.version || null, updatedAt: r.updated_at };
      });
      return out;
    },

    // ----- the users table: verification, email, password, deletion -----
    async markEmailVerified(userId) {
      await sql.run('UPDATE users SET email_verified_at = ? WHERE id = ? AND email_verified_at IS NULL', [nowIso(), userId]);
    },
    // false when another account already has the address.
    async changeEmail(userId, email) {
      try {
        await sql.run('UPDATE users SET email = ?, email_verified_at = ? WHERE id = ?', [email, nowIso(), userId]);
        return true;
      } catch (err) {
        if (isUniqueViolation(err)) return false;
        throw err;
      }
    },
    // A new password; bump retires every token issued before.
    async setPassword(userId, passwordHash, { bump = true } = {}) {
      await sql.run(
        `UPDATE users SET password_hash = ?, password_set = 1${bump ? ', token_version = token_version + 1' : ''} WHERE id = ?`,
        [passwordHash, userId]
      );
    },
    // A password nobody knows (an account opened through a provider, or one
    // whose competing sign-ups left no trustworthy choice).
    async setUnusablePassword(userId, randomHash) {
      await sql.run('UPDATE users SET password_hash = ?, password_set = 0, token_version = token_version + 1 WHERE id = ?', [randomHash, userId]);
    },
    // ----- blocks (admin) -----
    async isBlocked(userId) {
      return Boolean(await sql.get('SELECT 1 AS x FROM user_blocks WHERE user_id = ?', [Number(userId)]));
    },
    async blockUser(userId, { reason, blockedBy }) {
      await sql.run(
        `INSERT INTO user_blocks (user_id, reason, blocked_at, blocked_by) VALUES (?, ?, ?, ?)
         ON CONFLICT (user_id) DO UPDATE SET reason = excluded.reason, blocked_at = excluded.blocked_at, blocked_by = excluded.blocked_by`,
        [Number(userId), String(reason || ''), nowIso(), String(blockedBy || '')]
      );
    },
    async unblockUser(userId) {
      const r = await sql.run('DELETE FROM user_blocks WHERE user_id = ?', [Number(userId)]);
      return r.changes > 0;
    },
    async bumpTokenVersion(userId) {
      await sql.run('UPDATE users SET token_version = token_version + 1 WHERE id = ?', [userId]);
    },
    async markDeleted(userId, purgeAfter) {
      await sql.run('UPDATE users SET deleted_at = ?, purge_after = ? WHERE id = ?', [nowIso(), purgeAfter, userId]);
    },
    async restoreDeleted(userId) {
      await sql.run('UPDATE users SET deleted_at = NULL, purge_after = NULL WHERE id = ?', [userId]);
    },
    async listUsersDueForPurge(now = nowIso()) {
      const rows = await sql.all('SELECT id, email FROM users WHERE deleted_at IS NOT NULL AND purge_after <= ?', [now]);
      return rows.map((r) => ({ id: Number(r.id), email: r.email }));
    },
    // Accounts whose purge falls between the two instants.
    async listUsersPurgingBetween(from, to) {
      const rows = await sql.all(
        'SELECT id, email, purge_after FROM users WHERE deleted_at IS NOT NULL AND purge_after > ? AND purge_after <= ?',
        [from, to]
      );
      return rows.map((r) => ({ id: Number(r.id), email: r.email, purgeAfter: r.purge_after }));
    },
    // Irreversible. Every per-user table references users(id) with ON
    // DELETE CASCADE (portfolio, transactions, snapshots, preferences,
    // alerts, sessions, tokens, providers, profile and avatar, consents,
    // the security log), so the one delete removes all of it, in one
    // statement.
    async purgeUser(userId) {
      const r = await sql.run('DELETE FROM users WHERE id = ? AND deleted_at IS NOT NULL', [userId]);
      return r.changes > 0;
    },
    async recordDeletionFeedback(reason, comment) {
      await sql.run('INSERT INTO deletion_feedback (id, reason, comment, created_at) VALUES (?, ?, ?, ?)', [
        newId(),
        reason ? String(reason).slice(0, 60) : null,
        comment ? String(comment).slice(0, 1000) : null,
        // Day only: the exact time could match a deletion in the logs.
        nowIso().slice(0, 10)
      ]);
    }
  };
}

module.exports = { initAccountStore, MIGRATIONS, isUniqueViolation };
