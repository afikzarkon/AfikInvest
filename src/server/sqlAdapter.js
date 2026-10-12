// One small query interface over both databases, so the stores added for
// alerts, the event calendar, jobs and reports are written ONCE instead of
// twice (the original dataStore.js keeps its two hand-written copies).
//
// SQL is written with `?` placeholders and portable syntax (TEXT columns,
// ISO-8601 timestamps as text, JSON as text, `ON CONFLICT ... DO ...`,
// `RETURNING`). For Postgres the placeholders are rewritten to $1..$n.
// Where the two databases genuinely differ (row locking for the job queue)
// the caller checks `sql.kind`.

function toPgPlaceholders(text) {
  let n = 0;
  let out = '';
  let inString = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === "'") inString = !inString;
    if (ch === '?' && !inString) {
      n += 1;
      out += `$${n}`;
    } else {
      out += ch;
    }
  }
  return out;
}

function makeSqliteSql(db) {
  return {
    kind: 'sqlite',
    async exec(text) {
      db.exec(text);
    },
    async all(text, params = []) {
      return db.prepare(text).all(...params);
    },
    async get(text, params = []) {
      return db.prepare(text).get(...params) || null;
    },
    async run(text, params = []) {
      const stmt = db.prepare(text);
      if (/\breturning\b/i.test(text)) {
        const rows = stmt.all(...params);
        return { changes: rows.length, rows };
      }
      const r = stmt.run(...params);
      return { changes: r.changes, rows: [] };
    },
    // fn receives an sql object bound to the transaction.
    async transaction(fn) {
      db.exec('BEGIN IMMEDIATE');
      try {
        const result = await fn(this);
        db.exec('COMMIT');
        return result;
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    }
  };
}

function makePgSql(pool, client = null) {
  const target = client || pool;
  return {
    kind: 'postgres',
    async exec(text) {
      await target.query(text);
    },
    async all(text, params = []) {
      const { rows } = await target.query(toPgPlaceholders(text), params);
      return rows;
    },
    async get(text, params = []) {
      const { rows } = await target.query(toPgPlaceholders(text), params);
      return rows[0] || null;
    },
    async run(text, params = []) {
      const r = await target.query(toPgPlaceholders(text), params);
      return { changes: r.rowCount, rows: r.rows || [] };
    },
    async transaction(fn) {
      if (client) return fn(this);
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        const result = await fn(makePgSql(pool, c));
        await c.query('COMMIT');
        return result;
      } catch (err) {
        await c.query('ROLLBACK');
        throw err;
      } finally {
        c.release();
      }
    }
  };
}

module.exports = { makeSqliteSql, makePgSql, toPgPlaceholders };
