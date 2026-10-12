// Store factories for integration tests: always the real SQLite store (in
// memory), plus the real Postgres store when TEST_DATABASE_URL points at a
// throwaway database - e.g.
//   TEST_DATABASE_URL=postgres://test@localhost:5433/stockview_test npm test
// Each Postgres store lives in a throwaway schema; the URL must still name a
// database containing "test".
const { sqliteStore, openSqlite, pgStore } = require('../dataStore');

const pgUrl = process.env.TEST_DATABASE_URL || '';

// Each store gets its own schema (Jest runs test files in parallel, and
// they must not wipe each other's tables), dropped again on close.
async function makePgStore() {
  if (!/test/i.test(pgUrl)) throw new Error('TEST_DATABASE_URL must name a test database');
  process.env.DATABASE_SSL = '0';
  const { Pool } = require('pg');
  const schema = `t_${process.pid}_${Math.random().toString(36).slice(2, 10)}`;
  const admin = new Pool({ connectionString: pgUrl, ssl: false });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const sep = pgUrl.includes('?') ? '&' : '?';
  const store = await pgStore(`${pgUrl}${sep}options=${encodeURIComponent(`-c search_path=${schema}`)}`);
  store.close = async () => {
    await store.pool.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  };
  return store;
}

function makeSqliteStore() {
  const store = sqliteStore(openSqlite(':memory:'));
  store.close = async () => {};
  return store;
}

const STORE_FACTORIES = [['sqlite', makeSqliteStore]];
if (pgUrl) STORE_FACTORIES.push(['postgres', makePgStore]);

module.exports = { STORE_FACTORIES };
