// Storage for the daily market scanner (scannerService.js): one row per scan
// run, newest kept, older pruned (the last KEEP_RUNS). Written against the
// portable SQL adapter (sqlAdapter.js) like featureStore.js: TEXT ids, ISO
// timestamps as TEXT, JSON in TEXT columns.
const crypto = require('crypto');

const KEEP_RUNS = 10;

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS scanner_runs (
    id TEXT PRIMARY KEY,
    run_date TEXT NOT NULL,
    as_of TEXT,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    universe_size INTEGER NOT NULL DEFAULT 0,
    fetched INTEGER NOT NULL DEFAULT 0,
    scanned INTEGER NOT NULL DEFAULT 0,
    partial INTEGER NOT NULL DEFAULT 0,
    counts TEXT,
    filters TEXT,
    results TEXT NOT NULL
  )`,
  'CREATE INDEX IF NOT EXISTS scanner_runs_started_idx ON scanner_runs (started_at)'
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

function rowToRun(row, withResults) {
  const run = {
    id: row.id,
    runDate: row.run_date,
    asOf: row.as_of || null,
    startedAt: row.started_at,
    finishedAt: row.finished_at || null,
    universeSize: Number(row.universe_size) || 0,
    fetched: Number(row.fetched) || 0,
    scanned: Number(row.scanned) || 0,
    partial: Number(row.partial) === 1 || row.partial === true,
    counts: parseJson(row.counts, {}),
    filters: parseJson(row.filters, {})
  };
  if (withResults) run.results = parseJson(row.results, []);
  return run;
}

const META_COLUMNS = 'id, run_date, as_of, started_at, finished_at, universe_size, fetched, scanned, partial, counts, filters';

async function initScannerStore(store) {
  const { sql } = store;
  for (const statement of SCHEMA) {
    await sql.exec(statement);
  }

  const api = {
    // run: { runDate, asOf, startedAt, finishedAt, universeSize, fetched,
    //        scanned, partial, counts, filters, results }. Returns the id.
    async insertRun(run) {
      const id = run.id || crypto.randomUUID();
      await sql.run(
        `INSERT INTO scanner_runs (id, run_date, as_of, started_at, finished_at, universe_size, fetched, scanned, partial, counts, filters, results)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO NOTHING`,
        [
          id,
          run.runDate,
          run.asOf || null,
          run.startedAt || new Date().toISOString(),
          run.finishedAt || null,
          Number(run.universeSize) || 0,
          Number(run.fetched) || 0,
          Number(run.scanned) || 0,
          run.partial ? 1 : 0,
          JSON.stringify(run.counts || {}),
          JSON.stringify(run.filters || {}),
          JSON.stringify(run.results || [])
        ]
      );
      await api.pruneRuns(run.keep || KEEP_RUNS);
      return id;
    },
    async getLatestRun({ withResults = true } = {}) {
      const row = await sql.get(
        `SELECT ${withResults ? '*' : META_COLUMNS} FROM scanner_runs ORDER BY started_at DESC, id DESC LIMIT 1`
      );
      return row ? rowToRun(row, withResults) : null;
    },
    async getRun(id) {
      const row = await sql.get('SELECT * FROM scanner_runs WHERE id = ?', [id]);
      return row ? rowToRun(row, true) : null;
    },
    // Newest first, without the (large) results.
    async listRuns(limit = KEEP_RUNS) {
      const rows = await sql.all(`SELECT ${META_COLUMNS} FROM scanner_runs ORDER BY started_at DESC, id DESC LIMIT ?`, [
        Math.min(Math.max(Number(limit) || KEEP_RUNS, 1), 100)
      ]);
      return rows.map((r) => rowToRun(r, false));
    },
    async pruneRuns(keep = KEEP_RUNS) {
      const r = await sql.run(
        `DELETE FROM scanner_runs WHERE id NOT IN (
           SELECT id FROM (SELECT id FROM scanner_runs ORDER BY started_at DESC, id DESC LIMIT ?) AS kept
         )`,
        [Math.max(1, Number(keep) || KEEP_RUNS)]
      );
      return r.changes;
    }
  };
  return api;
}

module.exports = { initScannerStore, KEEP_RUNS };
