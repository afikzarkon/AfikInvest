// Storage for the features built on top of the portfolio: alerts, the market
// event calendar, per-user alert settings and the background job queue.
// Written once against the portable SQL adapter (sqlAdapter.js), so the same
// code runs on SQLite (local/dev) and Postgres (production).
//
// Conventions: ids are TEXT (UUIDs), timestamps are ISO-8601 TEXT (they sort
// correctly as strings), structured data is JSON in TEXT columns.
const crypto = require('crypto');

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS alerts (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type TEXT NOT NULL,
    severity TEXT NOT NULL,
    symbol TEXT,
    market TEXT,
    session_date TEXT,
    dedup_key TEXT NOT NULL UNIQUE,
    payload TEXT NOT NULL,
    created_at TEXT NOT NULL,
    read_at TEXT
  )`,
  'CREATE INDEX IF NOT EXISTS alerts_user_created_idx ON alerts (user_id, created_at)',
  'CREATE INDEX IF NOT EXISTS alerts_user_symbol_type_idx ON alerts (user_id, symbol, type, created_at)',
  `CREATE TABLE IF NOT EXISTS market_events (
    symbol TEXT NOT NULL,
    market TEXT NOT NULL,
    event_type TEXT NOT NULL,
    event_date TEXT NOT NULL,
    event_date_end TEXT,
    time_of_day TEXT,
    amount_per_share DOUBLE PRECISION,
    currency TEXT,
    status TEXT NOT NULL,
    confidence DOUBLE PRECISION,
    source TEXT NOT NULL,
    fetched_at TEXT NOT NULL,
    PRIMARY KEY (symbol, market, event_type, event_date)
  )`,
  'CREATE INDEX IF NOT EXISTS market_events_date_idx ON market_events (event_date)',
  `CREATE TABLE IF NOT EXISTS alert_settings (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    settings TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS user_preferences (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    namespace TEXT NOT NULL,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (user_id, namespace)
  )`,
  `CREATE TABLE IF NOT EXISTS monthly_sync_status (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    month TEXT NOT NULL,
    state TEXT NOT NULL,
    excluded_accounts TEXT NOT NULL,
    fingerprint TEXT,
    version INTEGER NOT NULL DEFAULT 0,
    completed_at TEXT,
    completed_by TEXT,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (user_id, month)
  )`,
  `CREATE TABLE IF NOT EXISTS reports (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    month TEXT NOT NULL,
    version INTEGER NOT NULL,
    status TEXT NOT NULL,
    storage_key TEXT,
    bytes INTEGER,
    data_hash TEXT,
    reused INTEGER NOT NULL DEFAULT 0,
    error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (user_id, month, version)
  )`,
  'CREATE INDEX IF NOT EXISTS reports_user_idx ON reports (user_id, month)',
  `CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    payload TEXT NOT NULL,
    idempotency_key TEXT UNIQUE,
    run_after TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    max_attempts INTEGER NOT NULL DEFAULT 5,
    status TEXT NOT NULL,
    last_error TEXT,
    result TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  'CREATE INDEX IF NOT EXISTS jobs_ready_idx ON jobs (status, run_after)'
];

const parseJson = (text, fallback) => {
  if (text === null || text === undefined) return fallback;
  if (typeof text === 'object') return text;
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
};

const nowIso = () => new Date().toISOString();

function rowToAlert(row) {
  const payload = parseJson(row.payload, {});
  return Object.assign({}, payload, {
    id: row.id,
    userId: Number(row.user_id),
    type: row.type,
    severity: row.severity,
    createdAt: row.created_at,
    readAt: row.read_at || null,
    dedupKey: row.dedup_key
  });
}

function rowToEvent(row) {
  return {
    symbol: row.symbol,
    market: row.market,
    eventType: row.event_type,
    eventDate: row.event_date,
    eventDateEnd: row.event_date_end || null,
    timeOfDay: row.time_of_day || null,
    amountPerShare: row.amount_per_share === null || row.amount_per_share === undefined ? null : Number(row.amount_per_share),
    currency: row.currency || null,
    status: row.status,
    confidence: row.confidence === null || row.confidence === undefined ? null : Number(row.confidence),
    source: row.source,
    fetchedAt: row.fetched_at
  };
}

function rowToReport(row) {
  return {
    id: row.id,
    userId: Number(row.user_id),
    month: row.month,
    version: Number(row.version),
    status: row.status,
    storageKey: row.storage_key || null,
    bytes: row.bytes === null || row.bytes === undefined ? null : Number(row.bytes),
    dataHash: row.data_hash || null,
    reused: Boolean(Number(row.reused)),
    error: row.error || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function rowToJob(row) {
  return {
    id: row.id,
    name: row.name,
    payload: parseJson(row.payload, {}),
    idempotencyKey: row.idempotency_key || null,
    runAfter: row.run_after,
    attempts: Number(row.attempts),
    maxAttempts: Number(row.max_attempts),
    status: row.status,
    lastError: row.last_error || null,
    result: parseJson(row.result, null),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

async function initFeatureStore(store) {
  const { sql } = store;
  for (const statement of SCHEMA) {
    await sql.exec(statement);
  }

  return {
    // ----- alerts -----
    // Inserts unless an alert with the same dedup key exists. Returns true
    // when a row was written.
    async insertAlert(alert) {
      const id = alert.id || crypto.randomUUID();
      const createdAt = alert.createdAt || nowIso();
      const payload = Object.assign({}, alert, { id, createdAt });
      const r = await sql.run(
        `INSERT INTO alerts (id, user_id, type, severity, symbol, market, session_date, dedup_key, payload, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (dedup_key) DO NOTHING`,
        [
          id,
          alert.userId,
          alert.type,
          alert.severity,
          alert.instrument ? alert.instrument.symbol : null,
          alert.instrument ? alert.instrument.market : null,
          alert.sessionDate || null,
          alert.dedupKey,
          JSON.stringify(payload),
          createdAt
        ]
      );
      return r.changes > 0;
    },
    async listAlerts(userId, { limit = 100, unreadOnly = false } = {}) {
      const rows = await sql.all(
        `SELECT * FROM alerts WHERE user_id = ? ${unreadOnly ? 'AND read_at IS NULL' : ''}
         ORDER BY created_at DESC LIMIT ?`,
        [userId, Math.min(Math.max(Number(limit) || 100, 1), 500)]
      );
      return rows.map(rowToAlert);
    },
    async countUnreadAlerts(userId) {
      const row = await sql.get('SELECT COUNT(*) AS n FROM alerts WHERE user_id = ? AND read_at IS NULL', [userId]);
      return Number(row ? row.n : 0);
    },
    // Alerts for one user+symbol created at or after `sinceIso` - what the
    // cooldown check reads.
    async recentAlerts(userId, symbol, sinceIso) {
      const rows = await sql.all(
        'SELECT * FROM alerts WHERE user_id = ? AND symbol = ? AND created_at >= ? ORDER BY created_at DESC',
        [userId, symbol, sinceIso]
      );
      return rows.map(rowToAlert);
    },
    async markAlertRead(userId, id) {
      const r = await sql.run('UPDATE alerts SET read_at = ? WHERE user_id = ? AND id = ? AND read_at IS NULL', [
        nowIso(),
        userId,
        id
      ]);
      return r.changes > 0;
    },
    async markAllAlertsRead(userId) {
      const r = await sql.run('UPDATE alerts SET read_at = ? WHERE user_id = ? AND read_at IS NULL', [nowIso(), userId]);
      return r.changes;
    },

    // ----- market events -----
    async upsertMarketEvents(events) {
      const fetchedAt = nowIso();
      for (const e of events) {
        await sql.run(
          `INSERT INTO market_events (symbol, market, event_type, event_date, event_date_end, time_of_day,
             amount_per_share, currency, status, confidence, source, fetched_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (symbol, market, event_type, event_date) DO UPDATE SET
             event_date_end = excluded.event_date_end,
             time_of_day = excluded.time_of_day,
             amount_per_share = excluded.amount_per_share,
             currency = excluded.currency,
             status = excluded.status,
             confidence = excluded.confidence,
             source = excluded.source,
             fetched_at = excluded.fetched_at`,
          [
            e.symbol,
            e.market,
            e.eventType,
            e.eventDate,
            e.eventDateEnd || null,
            e.timeOfDay || null,
            e.amountPerShare === undefined ? null : e.amountPerShare,
            e.currency || null,
            e.status,
            e.confidence === undefined ? null : e.confidence,
            e.source,
            fetchedAt
          ]
        );
      }
    },
    // Replaces a symbol's future events with a fresh set, so a projection
    // that an announcement has since superseded (or a moved earnings date)
    // does not linger.
    async replaceFutureMarketEvents(symbol, market, fromDate, events) {
      await sql.run('DELETE FROM market_events WHERE symbol = ? AND market = ? AND event_date >= ?', [symbol, market, fromDate]);
      await this.upsertMarketEvents(events.filter((e) => e.eventDate >= fromDate));
    },
    async listMarketEvents(symbolKeys, fromDate, toDate) {
      if (!symbolKeys.length) return [];
      const rows = await sql.all(
        'SELECT * FROM market_events WHERE event_date >= ? AND event_date <= ? ORDER BY event_date ASC',
        [fromDate, toDate]
      );
      const wanted = new Set(symbolKeys.map((k) => `${k.market}:${k.symbol}`));
      return rows.map(rowToEvent).filter((e) => wanted.has(`${e.market}:${e.symbol}`));
    },

    // ----- alert settings -----
    async getAlertSettings(userId) {
      const row = await sql.get('SELECT settings FROM alert_settings WHERE user_id = ?', [userId]);
      return row ? parseJson(row.settings, null) : null;
    },
    async upsertAlertSettings(userId, settings) {
      await sql.run(
        `INSERT INTO alert_settings (user_id, settings, updated_at) VALUES (?, ?, ?)
         ON CONFLICT (user_id) DO UPDATE SET settings = excluded.settings, updated_at = excluded.updated_at`,
        [userId, JSON.stringify(settings), nowIso()]
      );
    },

    // ----- per-user preferences (one JSON document per namespace) -----
    async getPreferences(userId, namespace) {
      const row = await sql.get('SELECT value FROM user_preferences WHERE user_id = ? AND namespace = ?', [userId, namespace]);
      return row ? parseJson(row.value, null) : null;
    },
    async setPreferences(userId, namespace, value) {
      await sql.run(
        `INSERT INTO user_preferences (user_id, namespace, value, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (user_id, namespace) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        [userId, namespace, JSON.stringify(value), nowIso()]
      );
    },

    // ----- monthly sync status -----
    async getSyncStatus(userId, month) {
      const row = await sql.get('SELECT * FROM monthly_sync_status WHERE user_id = ? AND month = ?', [userId, month]);
      if (!row) return null;
      return {
        month: row.month,
        state: row.state,
        excluded: parseJson(row.excluded_accounts, []),
        fingerprint: row.fingerprint || null,
        version: Number(row.version),
        completedAt: row.completed_at || null,
        completedBy: row.completed_by || null,
        updatedAt: row.updated_at
      };
    },
    async saveSyncStatus(userId, month, status) {
      await sql.run(
        `INSERT INTO monthly_sync_status (user_id, month, state, excluded_accounts, fingerprint, version, completed_at, completed_by, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (user_id, month) DO UPDATE SET
           state = excluded.state, excluded_accounts = excluded.excluded_accounts, fingerprint = excluded.fingerprint,
           version = excluded.version, completed_at = excluded.completed_at, completed_by = excluded.completed_by,
           updated_at = excluded.updated_at`,
        [
          userId,
          month,
          status.state,
          JSON.stringify(status.excluded || []),
          status.fingerprint || null,
          status.version || 0,
          status.completedAt || null,
          status.completedBy || null,
          nowIso()
        ]
      );
    },

    // ----- reports -----
    async upsertReport(report) {
      const ts = nowIso();
      await sql.run(
        `INSERT INTO reports (id, user_id, month, version, status, storage_key, bytes, data_hash, reused, error, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (user_id, month, version) DO UPDATE SET
           status = excluded.status, storage_key = excluded.storage_key, bytes = excluded.bytes,
           data_hash = excluded.data_hash, reused = excluded.reused, error = excluded.error, updated_at = excluded.updated_at`,
        [
          report.id || crypto.randomUUID(),
          report.userId,
          report.month,
          report.version,
          report.status,
          report.storageKey || null,
          report.bytes === undefined ? null : report.bytes,
          report.dataHash || null,
          report.reused ? 1 : 0,
          report.error || null,
          ts,
          ts
        ]
      );
      return this.getReportByVersion(report.userId, report.month, report.version);
    },
    async getReportByVersion(userId, month, version) {
      const row = await sql.get('SELECT * FROM reports WHERE user_id = ? AND month = ? AND version = ?', [userId, month, version]);
      return row ? rowToReport(row) : null;
    },
    async getReport(userId, id) {
      const row = await sql.get('SELECT * FROM reports WHERE user_id = ? AND id = ?', [userId, id]);
      return row ? rowToReport(row) : null;
    },
    async listReports(userId) {
      const rows = await sql.all('SELECT * FROM reports WHERE user_id = ? ORDER BY month DESC, version DESC', [userId]);
      return rows.map(rowToReport);
    },

    // ----- job queue -----
    // Returns the job; with an idempotency key that already exists, returns
    // the existing job instead of creating a second one.
    async enqueueJob(name, payload = {}, { runAfter = nowIso(), idempotencyKey = null, maxAttempts = 5 } = {}) {
      if (idempotencyKey) {
        const existing = await sql.get('SELECT * FROM jobs WHERE idempotency_key = ?', [idempotencyKey]);
        if (existing) return rowToJob(existing);
      }
      const id = crypto.randomUUID();
      const ts = nowIso();
      await sql.run(
        `INSERT INTO jobs (id, name, payload, idempotency_key, run_after, attempts, max_attempts, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 0, ?, 'queued', ?, ?)
         ON CONFLICT (idempotency_key) DO NOTHING`,
        [id, name, JSON.stringify(payload), idempotencyKey, runAfter, maxAttempts, ts, ts]
      );
      const row = idempotencyKey
        ? await sql.get('SELECT * FROM jobs WHERE idempotency_key = ?', [idempotencyKey])
        : await sql.get('SELECT * FROM jobs WHERE id = ?', [id]);
      return rowToJob(row);
    },
    async getJob(id) {
      const row = await sql.get('SELECT * FROM jobs WHERE id = ?', [id]);
      return row ? rowToJob(row) : null;
    },
    async findJobByKey(idempotencyKey) {
      const row = await sql.get('SELECT * FROM jobs WHERE idempotency_key = ?', [idempotencyKey]);
      return row ? rowToJob(row) : null;
    },
    // Moves a still-queued job's run time (the report debounce).
    async rescheduleJob(id, runAfter) {
      const r = await sql.run("UPDATE jobs SET run_after = ?, updated_at = ? WHERE id = ? AND status = 'queued'", [
        runAfter,
        nowIso(),
        id
      ]);
      return r.changes > 0;
    },
    async cancelJob(id) {
      const r = await sql.run("UPDATE jobs SET status = 'cancelled', updated_at = ? WHERE id = ? AND status = 'queued'", [
        nowIso(),
        id
      ]);
      return r.changes > 0;
    },
    // Atomically claims the next due job. One statement on both databases;
    // on Postgres SKIP LOCKED lets several workers drain the queue safely.
    async claimNextJob(names = null, now = nowIso()) {
      const nameFilter = names && names.length ? `AND name IN (${names.map(() => '?').join(', ')})` : '';
      const lock = sql.kind === 'postgres' ? 'FOR UPDATE SKIP LOCKED' : '';
      const rows = (
        await sql.run(
          `UPDATE jobs SET status = 'running', attempts = attempts + 1, updated_at = ?
           WHERE id = (
             SELECT id FROM jobs WHERE status = 'queued' AND run_after <= ? ${nameFilter}
             ORDER BY run_after ASC LIMIT 1 ${lock}
           )
           RETURNING *`,
          [now, now].concat(names && names.length ? names : [])
        )
      ).rows;
      return rows[0] ? rowToJob(rows[0]) : null;
    },
    async completeJob(id, result = null) {
      await sql.run("UPDATE jobs SET status = 'done', result = ?, last_error = NULL, updated_at = ? WHERE id = ?", [
        result === null ? null : JSON.stringify(result),
        nowIso(),
        id
      ]);
    },
    // Retries with exponential backoff (2^attempts minutes) until
    // max_attempts, then marks the job failed.
    async failJob(job, error, now = new Date()) {
      const message = String((error && error.message) || error).slice(0, 2000);
      if (job.attempts >= job.maxAttempts) {
        await sql.run("UPDATE jobs SET status = 'failed', last_error = ?, updated_at = ? WHERE id = ?", [message, nowIso(), job.id]);
        return 'failed';
      }
      const runAfter = new Date(now.getTime() + 2 ** job.attempts * 60 * 1000).toISOString();
      await sql.run("UPDATE jobs SET status = 'queued', last_error = ?, run_after = ?, updated_at = ? WHERE id = ?", [
        message,
        runAfter,
        nowIso(),
        job.id
      ]);
      return 'retry';
    },
    async listJobs({ status = null, limit = 50 } = {}) {
      const rows = await sql.all(
        `SELECT * FROM jobs ${status ? 'WHERE status = ?' : ''} ORDER BY created_at DESC LIMIT ?`,
        status ? [status, limit] : [limit]
      );
      return rows.map(rowToJob);
    }
  };
}

module.exports = { initFeatureStore };
