// The last good answer from each outside data source, kept in the
// database so it outlives the process.
//
// Every cache in front of Yahoo, the exchange and the rest lives in
// memory. On the hosting plan this runs on, the process is put to sleep
// when idle and restarted on deploys, and each time it comes back every
// cache is empty: there is no "last known price" to fall back on, so the
// first request after a wake-up that meets a failing source has nothing to
// show. This is that fallback, in the market_reference table
// (accountStore.js's migration creates it; dcfSnapshot.js's
// createReferenceMemory uses the same table for the 10-year yield).
//
// Keys are namespaced by what they hold: `quote:tase:<id>`,
// `quote:us:<symbol>`, `profile:<symbol>`.
//
// Writes are throttled per key (WRITE_INTERVAL_MS): a quote refreshes
// every minute, and the database copy only has to be recent enough to be
// worth showing after a restart, not current to the minute. Reads are
// memoized per key for the life of the process - the database is only
// consulted for a key the process has never seen, which is exactly the
// after-a-restart case. A database error never fails a request: the
// caller just gets nothing from here, as it would without a database.

const WRITE_INTERVAL_MS = 5 * 60 * 1000;

function createMarketMemory({ now = () => Date.now() } = {}) {
  let sql = null;
  const lastWrite = new Map(); // key -> ms
  const loaded = new Map(); // key -> { value, savedAt } | null

  return {
    attach(sqlHandle) {
      sql = sqlHandle;
    },

    // { value, savedAt (ms) } or null.
    async get(key) {
      if (loaded.has(key)) return loaded.get(key);
      if (!sql) return null;
      let found = null;
      try {
        const row = await sql.get('SELECT value, updated_at FROM market_reference WHERE key = ?', [key]);
        if (row) {
          const savedAt = Date.parse(row.updated_at);
          found = { value: JSON.parse(row.value), savedAt: Number.isFinite(savedAt) ? savedAt : 0 };
        }
      } catch {
        return null; // not memoized: the next call may find the database up
      }
      loaded.set(key, found);
      return found;
    },

    // Fire and forget; resolves once written (or skipped).
    async set(key, value, { force = false } = {}) {
      const t = now();
      loaded.set(key, { value, savedAt: t });
      if (!sql) return;
      if (!force && t - (lastWrite.get(key) || 0) < WRITE_INTERVAL_MS) return;
      lastWrite.set(key, t);
      try {
        await sql.run(
          'INSERT INTO market_reference (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
          [key, JSON.stringify(value), new Date(t).toISOString()]
        );
      } catch {
        lastWrite.delete(key);
      }
    },

    // Test seam.
    _reset() {
      sql = null;
      lastWrite.clear();
      loaded.clear();
    }
  };
}

// The one the app uses; server.js attaches the database after bootstrap.
const marketMemory = createMarketMemory();

module.exports = { marketMemory, createMarketMemory, WRITE_INTERVAL_MS };
