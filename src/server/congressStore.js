// Ported from day-trader-skill (MIT, Jake Schincariol)
//
// Storage for Congress stock trades (see congressService.js): one row per
// House Periodic Transaction Report from the Clerk's yearly index, with the
// transaction rows read from its PDF once the scan gets to it, plus a small
// key/value table for scan bookkeeping (last scan time, index Last-Modified).
// Written against the portable SQL adapter like featureStore.js: TEXT ids,
// ISO-8601 TEXT timestamps, JSON in TEXT columns.

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS congress_filings (
    doc_id TEXT PRIMARY KEY,
    year INTEGER NOT NULL,
    member_name TEXT NOT NULL,
    first_name TEXT,
    last_name TEXT,
    state_district TEXT,
    filed_date TEXT NOT NULL,
    pdf_url TEXT NOT NULL,
    parse_status TEXT NOT NULL,
    parse_attempts INTEGER NOT NULL DEFAULT 0,
    parse_error TEXT,
    trade_rows TEXT,
    parsed_at TEXT,
    created_at TEXT NOT NULL
  )`,
  'CREATE INDEX IF NOT EXISTS congress_filings_filed_idx ON congress_filings (filed_date)',
  'CREATE INDEX IF NOT EXISTS congress_filings_status_idx ON congress_filings (parse_status, filed_date)',
  `CREATE TABLE IF NOT EXISTS congress_meta (
    key TEXT PRIMARY KEY,
    value TEXT,
    updated_at TEXT NOT NULL
  )`
];

// A filing whose PDF failed to download/read is retried on later scans up to
// this many times; scanned PDFs (no text) are not retried.
const MAX_PARSE_ATTEMPTS = 3;

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

function rowToFiling(row) {
  return {
    docId: row.doc_id,
    year: Number(row.year),
    memberName: row.member_name,
    firstName: row.first_name || '',
    lastName: row.last_name || '',
    stateDistrict: row.state_district || '',
    filedDate: row.filed_date,
    pdfUrl: row.pdf_url,
    parseStatus: row.parse_status,
    parseAttempts: Number(row.parse_attempts || 0),
    parseError: row.parse_error || null,
    rows: parseJson(row.trade_rows, []),
    parsedAt: row.parsed_at || null
  };
}

async function initCongressStore(store) {
  const { sql } = store;
  for (const statement of SCHEMA) {
    await sql.exec(statement);
  }

  return {
    // filings: index entries from congressService.parseIndexArchive. New doc
    // ids are stored as 'pending'; known ones are left alone. Returns how
    // many were new.
    async insertFilings(filings) {
      let added = 0;
      const ts = nowIso();
      for (const f of filings) {
        const r = await sql.run(
          `INSERT INTO congress_filings (doc_id, year, member_name, first_name, last_name, state_district, filed_date,
             pdf_url, parse_status, parse_attempts, trade_rows, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, '[]', ?)
           ON CONFLICT (doc_id) DO NOTHING`,
          [String(f.docId), Number(f.year), f.name || `${f.first || ''} ${f.last || ''}`.trim(), f.first || '', f.last || '', f.district || '', f.filed, f.url, ts]
        );
        added += r.changes > 0 ? 1 : 0;
      }
      return added;
    },

    // The next PDFs to read, newest filing first: never tried, or failed
    // fewer than MAX_PARSE_ATTEMPTS times.
    async listPendingFilings(limit = 15) {
      const rows = await sql.all(
        `SELECT * FROM congress_filings
         WHERE parse_status = 'pending' OR (parse_status = 'error' AND parse_attempts < ?)
         ORDER BY filed_date DESC, doc_id DESC LIMIT ?`,
        [MAX_PARSE_ATTEMPTS, Math.min(Math.max(Number(limit) || 15, 1), 100)]
      );
      return rows.map(rowToFiling);
    },

    // result: { status: 'parsed' | 'no_text' | 'error', rows, error }
    async saveParseResult(docId, result, parsedAt = nowIso()) {
      await sql.run(
        `UPDATE congress_filings SET parse_status = ?, trade_rows = ?, parse_error = ?, parsed_at = ?,
           parse_attempts = parse_attempts + 1
         WHERE doc_id = ?`,
        [result.status, JSON.stringify(result.rows || []), result.error || null, parsedAt, String(docId)]
      );
    },

    async getFiling(docId) {
      const row = await sql.get('SELECT * FROM congress_filings WHERE doc_id = ?', [String(docId)]);
      return row ? rowToFiling(row) : null;
    },

    // Filings filed on or after `since` (YYYY-MM-DD), newest first.
    async listFilings({ since = null, limit = 300 } = {}) {
      const capped = Math.min(Math.max(Number(limit) || 300, 1), 1000);
      const rows = since
        ? await sql.all('SELECT * FROM congress_filings WHERE filed_date >= ? ORDER BY filed_date DESC, doc_id DESC LIMIT ?', [since, capped])
        : await sql.all('SELECT * FROM congress_filings ORDER BY filed_date DESC, doc_id DESC LIMIT ?', [capped]);
      return rows.map(rowToFiling);
    },

    async getMeta(key) {
      const row = await sql.get('SELECT value FROM congress_meta WHERE key = ?', [key]);
      return row ? row.value : null;
    },
    async setMeta(key, value) {
      await sql.run(
        `INSERT INTO congress_meta (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        [key, value === null || value === undefined ? null : String(value), nowIso()]
      );
    }
  };
}

module.exports = { initCongressStore, MAX_PARSE_ATTEMPTS };
