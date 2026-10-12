const { Pool } = require('pg');
const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');
const {
  TRANSACTIONS_TABLE_SQLITE,
  TRANSACTIONS_TABLE_PG,
  COLUMNS: TRANSACTION_COLUMNS,
  txToRow,
  rowToTx
} = require('./transactionRows');
const { makeSqliteSql, makePgSql } = require('./sqlAdapter');

const emptyPortfolioObject = () => ({
  israeliStocks: [],
  americanStocks: [],
  pensionFunds: [],
  bankBalances: [],
  cashFunds: [],
  bankSavingsFunds: []
});

function parsePortfolioPayload(raw) {
  if (!raw) return emptyPortfolioObject();
  let data;
  try {
    data = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    return emptyPortfolioObject();
  }
  const out = emptyPortfolioObject();
  Object.keys(out).forEach((key) => {
    out[key] = Array.isArray(data?.[key]) ? data[key] : [];
  });
  return out;
}

const PG_UNIQUE_VIOLATION = '23505';

function getSqlitePath() {
  if (process.env.DATABASE_PATH) return path.resolve(process.env.DATABASE_PATH);
  return path.join(__dirname, '..', '..', 'data', 'stockview.db');
}

// dbPathOverride: ':memory:' gives the integration tests a throwaway
// database with the real schema.
function openSqlite(dbPathOverride) {
  const dbPath = dbPathOverride || getSqlitePath();
  if (dbPath !== ':memory:') {
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL UNIQUE COLLATE NOCASE,
      password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS user_portfolios (
      user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      payload TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS portfolio_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      snapshot_date TEXT NOT NULL,
      total_value_ils REAL NOT NULL,
      breakdown TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(user_id, snapshot_date)
    );
    CREATE TABLE IF NOT EXISTS portfolio_monthly_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      snapshot_month TEXT NOT NULL,
      total_value_ils REAL NOT NULL,
      breakdown TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(user_id, snapshot_month)
    );
    CREATE TABLE IF NOT EXISTS rebalance_targets (
      user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      targets TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  db.exec(TRANSACTIONS_TABLE_SQLITE);
  return db;
}

function sqliteStore(db) {
  return {
    kind: 'sqlite',
    // Portable query interface used by the newer feature stores
    // (featureStore.js) - see sqlAdapter.js.
    sql: makeSqliteSql(db),
    async listUserIds() {
      return db.prepare('SELECT id FROM users ORDER BY id').all().map((r) => Number(r.id));
    },
    async findUserIdByEmail(email) {
      return db.prepare('SELECT id FROM users WHERE email = ?').get(email) || null;
    },
    async insertUser(email, passwordHash) {
      const r = db.prepare('INSERT INTO users (email, password_hash) VALUES (?, ?)').run(
        email,
        passwordHash
      );
      return { id: Number(r.lastInsertRowid) };
    },
    async findUserForLogin(email) {
      return (
        db.prepare('SELECT id, email, password_hash FROM users WHERE email = ?').get(email) ||
        null
      );
    },
    async getPortfolioPayload(userId) {
      const row = db.prepare('SELECT payload FROM user_portfolios WHERE user_id = ?').get(userId);
      return row && row.payload ? row.payload : null;
    },
    async upsertPortfolio(userId, payloadJson) {
      db.prepare(
        `INSERT INTO user_portfolios (user_id, payload, updated_at)
         VALUES (?, ?, datetime('now'))
         ON CONFLICT(user_id) DO UPDATE SET
           payload = excluded.payload,
           updated_at = datetime('now')`
      ).run(userId, payloadJson);
    },
    async listUsersWithPortfolio() {
      return db
        .prepare(
          `SELECT u.id, u.email, u.created_at,
                  p.updated_at AS portfolio_saved_at
           FROM users u
           LEFT JOIN user_portfolios p ON p.user_id = u.id
           ORDER BY u.id`
        )
        .all();
    },
    async upsertPortfolioSnapshot(userId, snapshotDate, totalValueILS, breakdownJson) {
      db.prepare(
        `INSERT INTO portfolio_snapshots (user_id, snapshot_date, total_value_ils, breakdown)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(user_id, snapshot_date) DO UPDATE SET
           total_value_ils = excluded.total_value_ils,
           breakdown = excluded.breakdown`
      ).run(userId, snapshotDate, totalValueILS, breakdownJson || null);
    },
    async listPortfolioSnapshots(userId) {
      return db
        .prepare(
          `SELECT snapshot_date, total_value_ils, breakdown
           FROM portfolio_snapshots
           WHERE user_id = ?
           ORDER BY snapshot_date ASC`
        )
        .all(userId)
        .map((row) => ({
          date: row.snapshot_date,
          totalValueILS: row.total_value_ils,
          breakdown: row.breakdown ? JSON.parse(row.breakdown) : null
        }));
    },
    async upsertMonthlySnapshot(userId, snapshotMonth, totalValueILS, breakdownJson) {
      db.prepare(
        `INSERT INTO portfolio_monthly_snapshots (user_id, snapshot_month, total_value_ils, breakdown)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(user_id, snapshot_month) DO UPDATE SET
           total_value_ils = excluded.total_value_ils,
           breakdown = excluded.breakdown`
      ).run(userId, snapshotMonth, totalValueILS, breakdownJson || null);
    },
    async listMonthlySnapshots(userId) {
      return db
        .prepare(
          `SELECT snapshot_month, total_value_ils, breakdown
           FROM portfolio_monthly_snapshots
           WHERE user_id = ?
           ORDER BY snapshot_month ASC`
        )
        .all(userId)
        .map((row) => ({
          month: row.snapshot_month,
          totalValueILS: row.total_value_ils,
          breakdown: row.breakdown ? JSON.parse(row.breakdown) : null
        }));
    },
    // Update-only (never creates a row) - used to let a user correct a
    // month they already saved (see PUT /api/portfolio-monthly-snapshot/:month
    // in monthlySnapshotRoutes.js). Deliberately can't create a new month,
    // so it can't be used to backfill arbitrary history in production the
    // way the dev-only mock-seed button can in development.
    async updateMonthlySnapshot(userId, snapshotMonth, totalValueILS, breakdownJson) {
      const result = db
        .prepare(
          `UPDATE portfolio_monthly_snapshots
           SET total_value_ils = ?, breakdown = ?
           WHERE user_id = ? AND snapshot_month = ?`
        )
        .run(totalValueILS, breakdownJson || null, userId, snapshotMonth);
      return result.changes > 0;
    },
    async deleteMonthlySnapshot(userId, snapshotMonth) {
      const result = db
        .prepare('DELETE FROM portfolio_monthly_snapshots WHERE user_id = ? AND snapshot_month = ?')
        .run(userId, snapshotMonth);
      return result.changes > 0;
    },
    async getRebalanceTargets(userId) {
      const row = db.prepare('SELECT targets FROM rebalance_targets WHERE user_id = ?').get(userId);
      return row && row.targets ? JSON.parse(row.targets) : null;
    },
    async upsertRebalanceTargets(userId, targetsJson) {
      db.prepare(
        `INSERT INTO rebalance_targets (user_id, targets, updated_at)
         VALUES (?, ?, datetime('now'))
         ON CONFLICT(user_id) DO UPDATE SET
           targets = excluded.targets,
           updated_at = datetime('now')`
      ).run(userId, targetsJson);
    },
    async listTransactions(userId) {
      return db
        .prepare('SELECT * FROM transactions WHERE user_id = ? ORDER BY trade_date ASC, created_at ASC, rowid ASC')
        .all(userId)
        .map(rowToTx);
    },
    async getTransaction(userId, id) {
      const row = db.prepare('SELECT * FROM transactions WHERE user_id = ? AND id = ?').get(userId, id);
      return row ? rowToTx(row) : null;
    },
    // Reads the portfolio and the ledger, lets `change` decide what to do,
    // and writes the new portfolio plus the inserted/removed transaction in
    // ONE database transaction - the ledger and the lots it describes can
    // never be saved apart. `change` is synchronous and pure:
    //   ({ portfolio, transactions }) => { portfolio, insert?, removeId? }
    async applyLedgerChange(userId, change) {
      const run = db.transaction(() => {
        const row = db.prepare('SELECT payload FROM user_portfolios WHERE user_id = ?').get(userId);
        const portfolio = parsePortfolioPayload(row && row.payload);
        const transactions = db
          .prepare('SELECT * FROM transactions WHERE user_id = ? ORDER BY trade_date ASC, created_at ASC, rowid ASC')
          .all(userId)
          .map(rowToTx);
        const result = change({ portfolio, transactions });
        db.prepare(
          `INSERT INTO user_portfolios (user_id, payload, updated_at)
           VALUES (?, ?, datetime('now'))
           ON CONFLICT(user_id) DO UPDATE SET payload = excluded.payload, updated_at = datetime('now')`
        ).run(userId, JSON.stringify(result.portfolio));
        if (result.insert) {
          const r = txToRow(userId, result.insert);
          db.prepare(
            `INSERT INTO transactions (${TRANSACTION_COLUMNS.join(', ')})
             VALUES (${TRANSACTION_COLUMNS.map(() => '?').join(', ')})`
          ).run(...TRANSACTION_COLUMNS.map((c) => r[c]));
        }
        if (result.removeId) {
          db.prepare('DELETE FROM transactions WHERE user_id = ? AND id = ?').run(userId, result.removeId);
        }
        return result;
      });
      return run();
    }
  };
}

async function pgStore(connectionString) {
  const sslOff = process.env.DATABASE_SSL === '0' || process.env.DATABASE_SSL === 'false';
  const pool = new Pool({
    connectionString,
    ssl: sslOff ? false : { rejectUnauthorized: false }
  });

  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      email VARCHAR(255) NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_portfolios (
      user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      payload TEXT NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS portfolio_snapshots (
      id BIGSERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      snapshot_date DATE NOT NULL,
      total_value_ils DOUBLE PRECISION NOT NULL,
      breakdown JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(user_id, snapshot_date)
    );
  `);
  await pool.query(
    'CREATE INDEX IF NOT EXISTS portfolio_snapshots_user_date_idx ON portfolio_snapshots (user_id, snapshot_date)'
  );
  await pool.query(`
    CREATE TABLE IF NOT EXISTS portfolio_monthly_snapshots (
      id BIGSERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      snapshot_month TEXT NOT NULL,
      total_value_ils DOUBLE PRECISION NOT NULL,
      breakdown JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(user_id, snapshot_month)
    );
  `);
  await pool.query(
    'CREATE INDEX IF NOT EXISTS portfolio_monthly_snapshots_user_month_idx ON portfolio_monthly_snapshots (user_id, snapshot_month)'
  );
  await pool.query(`
    CREATE TABLE IF NOT EXISTS rebalance_targets (
      user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      targets JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await pool.query(TRANSACTIONS_TABLE_PG);
  const portfolioTables = [
    'user_israeli_stocks',
    'user_american_stocks',
    'user_pension_funds',
    'user_bank_balances',
    'user_cash_funds',
    'user_bank_savings_funds'
  ];
  for (const table of portfolioTables) {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ${table} (
        id BIGSERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        sort_index INTEGER NOT NULL DEFAULT 0,
        item JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    await pool.query(
      `CREATE INDEX IF NOT EXISTS ${table}_user_id_sort_idx ON ${table} (user_id, sort_index)`
    );
  }
  // Add query-friendly generated columns per item type while keeping full JSON compatibility.
  await pool.query(`
    ALTER TABLE user_israeli_stocks
      ADD COLUMN IF NOT EXISTS client_item_id BIGINT GENERATED ALWAYS AS (
        CASE
          WHEN (item->>'id') ~ '^-?\\d+$' THEN (item->>'id')::BIGINT
          ELSE NULL
        END
      ) STORED,
      ADD COLUMN IF NOT EXISTS stock_name TEXT GENERATED ALWAYS AS (item->>'stockName') STORED,
      ADD COLUMN IF NOT EXISTS purchase_date TEXT GENERATED ALWAYS AS (item->>'purchaseDate') STORED,
      ADD COLUMN IF NOT EXISTS purchase_price DOUBLE PRECISION GENERATED ALWAYS AS (
        CASE
          WHEN (item->>'purchasePrice') ~ '^-?\\d+(\\.\\d+)?$' THEN (item->>'purchasePrice')::DOUBLE PRECISION
          ELSE NULL
        END
      ) STORED,
      ADD COLUMN IF NOT EXISTS quantity DOUBLE PRECISION GENERATED ALWAYS AS (
        CASE
          WHEN (item->>'quantity') ~ '^-?\\d+(\\.\\d+)?$' THEN (item->>'quantity')::DOUBLE PRECISION
          ELSE NULL
        END
      ) STORED,
      ADD COLUMN IF NOT EXISTS current_price DOUBLE PRECISION GENERATED ALWAYS AS (
        CASE
          WHEN (item->>'currentPrice') ~ '^-?\\d+(\\.\\d+)?$' THEN (item->>'currentPrice')::DOUBLE PRECISION
          ELSE NULL
        END
      ) STORED,
      ADD COLUMN IF NOT EXISTS daily_change_percent DOUBLE PRECISION GENERATED ALWAYS AS (
        CASE
          WHEN (item->>'dailyChangePercent') ~ '^-?\\d+(\\.\\d+)?$' THEN (item->>'dailyChangePercent')::DOUBLE PRECISION
          ELSE NULL
        END
      ) STORED
  `);
  await pool.query('CREATE INDEX IF NOT EXISTS user_israeli_stocks_stock_name_idx ON user_israeli_stocks (user_id, stock_name)');

  await pool.query(`
    ALTER TABLE user_american_stocks
      ADD COLUMN IF NOT EXISTS client_item_id BIGINT GENERATED ALWAYS AS (
        CASE
          WHEN (item->>'id') ~ '^-?\\d+$' THEN (item->>'id')::BIGINT
          ELSE NULL
        END
      ) STORED,
      ADD COLUMN IF NOT EXISTS stock_name TEXT GENERATED ALWAYS AS (item->>'stockName') STORED,
      ADD COLUMN IF NOT EXISTS purchase_date TEXT GENERATED ALWAYS AS (item->>'purchaseDate') STORED,
      ADD COLUMN IF NOT EXISTS purchase_price DOUBLE PRECISION GENERATED ALWAYS AS (
        CASE
          WHEN (item->>'purchasePrice') ~ '^-?\\d+(\\.\\d+)?$' THEN (item->>'purchasePrice')::DOUBLE PRECISION
          ELSE NULL
        END
      ) STORED,
      ADD COLUMN IF NOT EXISTS quantity DOUBLE PRECISION GENERATED ALWAYS AS (
        CASE
          WHEN (item->>'quantity') ~ '^-?\\d+(\\.\\d+)?$' THEN (item->>'quantity')::DOUBLE PRECISION
          ELSE NULL
        END
      ) STORED,
      ADD COLUMN IF NOT EXISTS exchange_rate DOUBLE PRECISION GENERATED ALWAYS AS (
        CASE
          WHEN (item->>'exchangeRate') ~ '^-?\\d+(\\.\\d+)?$' THEN (item->>'exchangeRate')::DOUBLE PRECISION
          ELSE NULL
        END
      ) STORED,
      ADD COLUMN IF NOT EXISTS current_exchange_rate DOUBLE PRECISION GENERATED ALWAYS AS (
        CASE
          WHEN (item->>'currentExchangeRate') ~ '^-?\\d+(\\.\\d+)?$' THEN (item->>'currentExchangeRate')::DOUBLE PRECISION
          ELSE NULL
        END
      ) STORED,
      ADD COLUMN IF NOT EXISTS current_price DOUBLE PRECISION GENERATED ALWAYS AS (
        CASE
          WHEN (item->>'currentPrice') ~ '^-?\\d+(\\.\\d+)?$' THEN (item->>'currentPrice')::DOUBLE PRECISION
          ELSE NULL
        END
      ) STORED,
      ADD COLUMN IF NOT EXISTS daily_change_percent DOUBLE PRECISION GENERATED ALWAYS AS (
        CASE
          WHEN (item->>'dailyChangePercent') ~ '^-?\\d+(\\.\\d+)?$' THEN (item->>'dailyChangePercent')::DOUBLE PRECISION
          ELSE NULL
        END
      ) STORED
  `);
  await pool.query('CREATE INDEX IF NOT EXISTS user_american_stocks_stock_name_idx ON user_american_stocks (user_id, stock_name)');

  await pool.query(`
    ALTER TABLE user_pension_funds
      ADD COLUMN IF NOT EXISTS client_item_id BIGINT GENERATED ALWAYS AS (
        CASE
          WHEN (item->>'id') ~ '^-?\\d+$' THEN (item->>'id')::BIGINT
          ELSE NULL
        END
      ) STORED,
      ADD COLUMN IF NOT EXISTS fund_name TEXT GENERATED ALWAYS AS (item->>'fundName') STORED,
      ADD COLUMN IF NOT EXISTS update_date TEXT GENERATED ALWAYS AS (item->>'updateDate') STORED,
      ADD COLUMN IF NOT EXISTS initial_investment DOUBLE PRECISION GENERATED ALWAYS AS (
        CASE
          WHEN (item->>'initialInvestment') ~ '^-?\\d+(\\.\\d+)?$' THEN (item->>'initialInvestment')::DOUBLE PRECISION
          ELSE NULL
        END
      ) STORED,
      ADD COLUMN IF NOT EXISTS current_value DOUBLE PRECISION GENERATED ALWAYS AS (
        CASE
          WHEN (item->>'currentValue') ~ '^-?\\d+(\\.\\d+)?$' THEN (item->>'currentValue')::DOUBLE PRECISION
          ELSE NULL
        END
      ) STORED,
      ADD COLUMN IF NOT EXISTS previous_value DOUBLE PRECISION GENERATED ALWAYS AS (
        CASE
          WHEN (item->>'previousValue') ~ '^-?\\d+(\\.\\d+)?$' THEN (item->>'previousValue')::DOUBLE PRECISION
          ELSE NULL
        END
      ) STORED,
      ADD COLUMN IF NOT EXISTS amount DOUBLE PRECISION GENERATED ALWAYS AS (
        CASE
          WHEN (item->>'amount') ~ '^-?\\d+(\\.\\d+)?$' THEN (item->>'amount')::DOUBLE PRECISION
          ELSE NULL
        END
      ) STORED
  `);

  await pool.query(`
    ALTER TABLE user_bank_balances
      ADD COLUMN IF NOT EXISTS client_item_id BIGINT GENERATED ALWAYS AS (
        CASE
          WHEN (item->>'id') ~ '^-?\\d+$' THEN (item->>'id')::BIGINT
          ELSE NULL
        END
      ) STORED,
      ADD COLUMN IF NOT EXISTS update_date TEXT GENERATED ALWAYS AS (item->>'updateDate') STORED,
      ADD COLUMN IF NOT EXISTS amount DOUBLE PRECISION GENERATED ALWAYS AS (
        CASE
          WHEN (item->>'amount') ~ '^-?\\d+(\\.\\d+)?$' THEN (item->>'amount')::DOUBLE PRECISION
          ELSE NULL
        END
      ) STORED
  `);

  await pool.query(`
    ALTER TABLE user_cash_funds
      ADD COLUMN IF NOT EXISTS client_item_id BIGINT GENERATED ALWAYS AS (
        CASE
          WHEN (item->>'id') ~ '^-?\\d+$' THEN (item->>'id')::BIGINT
          ELSE NULL
        END
      ) STORED,
      ADD COLUMN IF NOT EXISTS fund_name TEXT GENERATED ALWAYS AS (item->>'fundName') STORED,
      ADD COLUMN IF NOT EXISTS security_id TEXT GENERATED ALWAYS AS (item->>'securityId') STORED,
      ADD COLUMN IF NOT EXISTS update_date TEXT GENERATED ALWAYS AS (item->>'updateDate') STORED,
      ADD COLUMN IF NOT EXISTS amount DOUBLE PRECISION GENERATED ALWAYS AS (
        CASE
          WHEN (item->>'amount') ~ '^-?\\d+(\\.\\d+)?$' THEN (item->>'amount')::DOUBLE PRECISION
          ELSE NULL
        END
      ) STORED
  `);

  await pool.query(`
    ALTER TABLE user_bank_savings_funds
      ADD COLUMN IF NOT EXISTS client_item_id BIGINT GENERATED ALWAYS AS (
        CASE
          WHEN (item->>'id') ~ '^-?\\d+$' THEN (item->>'id')::BIGINT
          ELSE NULL
        END
      ) STORED,
      ADD COLUMN IF NOT EXISTS fund_name TEXT GENERATED ALWAYS AS (item->>'fundName') STORED,
      ADD COLUMN IF NOT EXISTS investment_track TEXT GENERATED ALWAYS AS (item->>'investmentTrack') STORED,
      ADD COLUMN IF NOT EXISTS interest_rate DOUBLE PRECISION GENERATED ALWAYS AS (
        CASE
          WHEN (item->>'interestRate') ~ '^-?\\d+(\\.\\d+)?$' THEN (item->>'interestRate')::DOUBLE PRECISION
          ELSE NULL
        END
      ) STORED,
      ADD COLUMN IF NOT EXISTS is_linked_to_index BOOLEAN GENERATED ALWAYS AS (
        CASE
          WHEN (item->>'isLinkedToIndex') IN ('true', 'false') THEN (item->>'isLinkedToIndex')::BOOLEAN
          ELSE NULL
        END
      ) STORED
  `);

  function normalizeSnapshot(input) {
    const parsed =
      input && typeof input === 'object'
        ? input
        : (() => {
            try {
              return JSON.parse(String(input || '{}'));
            } catch {
              return {};
            }
          })();
    return {
      israeliStocks: Array.isArray(parsed.israeliStocks) ? parsed.israeliStocks : [],
      americanStocks: Array.isArray(parsed.americanStocks) ? parsed.americanStocks : [],
      pensionFunds: Array.isArray(parsed.pensionFunds) ? parsed.pensionFunds : [],
      bankBalances: Array.isArray(parsed.bankBalances) ? parsed.bankBalances : [],
      cashFunds: Array.isArray(parsed.cashFunds) ? parsed.cashFunds : [],
      bankSavingsFunds: Array.isArray(parsed.bankSavingsFunds) ? parsed.bankSavingsFunds : []
    };
  }

  async function readItems(client, table, userId) {
    const { rows } = await client.query(
      `SELECT item FROM ${table} WHERE user_id = $1 ORDER BY sort_index ASC, id ASC`,
      [userId]
    );
    return rows.map((r) => r.item);
  }

  async function writeItems(client, table, userId, items) {
    await client.query(`DELETE FROM ${table} WHERE user_id = $1`, [userId]);
    if (!items.length) return;
    const values = [];
    const placeholders = [];
    items.forEach((item, i) => {
      const base = i * 3;
      placeholders.push(`($${base + 1}, $${base + 2}, $${base + 3}::jsonb)`);
      values.push(userId, i, JSON.stringify(item));
    });
    await client.query(
      `INSERT INTO ${table} (user_id, sort_index, item) VALUES ${placeholders.join(',')}`,
      values
    );
  }

  async function readPayload(client, userId) {
    // Important: do not run concurrent queries on the same pg client.
    const israeliStocks = await readItems(client, 'user_israeli_stocks', userId);
    const americanStocks = await readItems(client, 'user_american_stocks', userId);
    const pensionFunds = await readItems(client, 'user_pension_funds', userId);
    const bankBalances = await readItems(client, 'user_bank_balances', userId);
    const cashFunds = await readItems(client, 'user_cash_funds', userId);
    const bankSavingsFunds = await readItems(client, 'user_bank_savings_funds', userId);
    const normalized = {
      israeliStocks,
      americanStocks,
      pensionFunds,
      bankBalances,
      cashFunds,
      bankSavingsFunds
    };
    const hasNormalizedData = Object.values(normalized).some((arr) => arr.length > 0);
    if (hasNormalizedData) return JSON.stringify(normalized);

    // Backward compatibility: if legacy snapshot exists, return it as-is.
    const { rows } = await client.query('SELECT payload FROM user_portfolios WHERE user_id = $1', [userId]);
    const row = rows[0];
    return row && row.payload != null ? String(row.payload) : null;
  }

  async function writeSnapshot(client, userId, snapshot) {
    await writeItems(client, 'user_israeli_stocks', userId, snapshot.israeliStocks);
    await writeItems(client, 'user_american_stocks', userId, snapshot.americanStocks);
    await writeItems(client, 'user_pension_funds', userId, snapshot.pensionFunds);
    await writeItems(client, 'user_bank_balances', userId, snapshot.bankBalances);
    await writeItems(client, 'user_cash_funds', userId, snapshot.cashFunds);
    await writeItems(client, 'user_bank_savings_funds', userId, snapshot.bankSavingsFunds);
    // Keep legacy snapshot row updated for easy inspection and backward compatibility.
    await client.query(
      `INSERT INTO user_portfolios (user_id, payload, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (user_id) DO UPDATE SET
         payload = EXCLUDED.payload,
         updated_at = NOW()`,
      [userId, JSON.stringify(snapshot)]
    );
  }

  const TX_ORDER = 'ORDER BY trade_date ASC, created_at ASC, id ASC';

  return {
    kind: 'postgres',
    pool,
    sql: makePgSql(pool),
    async listUserIds() {
      const { rows } = await pool.query('SELECT id FROM users ORDER BY id');
      return rows.map((r) => Number(r.id));
    },
    async findUserIdByEmail(email) {
      const { rows } = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
      return rows[0] || null;
    },
    async insertUser(email, passwordHash) {
      const { rows } = await pool.query(
        'INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id',
        [email, passwordHash]
      );
      return { id: Number(rows[0].id) };
    },
    async findUserForLogin(email) {
      const { rows } = await pool.query(
        'SELECT id, email, password_hash FROM users WHERE email = $1',
        [email]
      );
      return rows[0] || null;
    },
    async getPortfolioPayload(userId) {
      const client = await pool.connect();
      try {
        return await readPayload(client, userId);
      } finally {
        client.release();
      }
    },
    async upsertPortfolio(userId, payloadJson) {
      const snapshot = normalizeSnapshot(payloadJson);
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await writeSnapshot(client, userId, snapshot);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    },
    async listUsersWithPortfolio() {
      const { rows } = await pool.query(`
        SELECT u.id, u.email, u.created_at::text AS created_at,
               GREATEST(
                 p.updated_at,
                 (SELECT MAX(updated_at) FROM user_israeli_stocks s WHERE s.user_id = u.id),
                 (SELECT MAX(updated_at) FROM user_american_stocks s WHERE s.user_id = u.id),
                 (SELECT MAX(updated_at) FROM user_pension_funds s WHERE s.user_id = u.id),
                 (SELECT MAX(updated_at) FROM user_bank_balances s WHERE s.user_id = u.id),
                 (SELECT MAX(updated_at) FROM user_cash_funds s WHERE s.user_id = u.id),
                 (SELECT MAX(updated_at) FROM user_bank_savings_funds s WHERE s.user_id = u.id)
               )::text AS portfolio_saved_at
        FROM users u
        LEFT JOIN user_portfolios p ON p.user_id = u.id
        ORDER BY u.id
      `);
      return rows;
    },
    async upsertPortfolioSnapshot(userId, snapshotDate, totalValueILS, breakdownJson) {
      await pool.query(
        `INSERT INTO portfolio_snapshots (user_id, snapshot_date, total_value_ils, breakdown)
         VALUES ($1, $2::date, $3, $4::jsonb)
         ON CONFLICT (user_id, snapshot_date) DO UPDATE SET
           total_value_ils = EXCLUDED.total_value_ils,
           breakdown = EXCLUDED.breakdown`,
        [userId, snapshotDate, totalValueILS, breakdownJson || null]
      );
    },
    async listPortfolioSnapshots(userId) {
      const { rows } = await pool.query(
        `SELECT snapshot_date::text AS snapshot_date, total_value_ils, breakdown
         FROM portfolio_snapshots
         WHERE user_id = $1
         ORDER BY snapshot_date ASC`,
        [userId]
      );
      return rows.map((row) => ({
        date: row.snapshot_date,
        totalValueILS: row.total_value_ils,
        breakdown: row.breakdown || null
      }));
    },
    async upsertMonthlySnapshot(userId, snapshotMonth, totalValueILS, breakdownJson) {
      await pool.query(
        `INSERT INTO portfolio_monthly_snapshots (user_id, snapshot_month, total_value_ils, breakdown)
         VALUES ($1, $2, $3, $4::jsonb)
         ON CONFLICT (user_id, snapshot_month) DO UPDATE SET
           total_value_ils = EXCLUDED.total_value_ils,
           breakdown = EXCLUDED.breakdown`,
        [userId, snapshotMonth, totalValueILS, breakdownJson || null]
      );
    },
    async listMonthlySnapshots(userId) {
      const { rows } = await pool.query(
        `SELECT snapshot_month, total_value_ils, breakdown
         FROM portfolio_monthly_snapshots
         WHERE user_id = $1
         ORDER BY snapshot_month ASC`,
        [userId]
      );
      return rows.map((row) => ({
        month: row.snapshot_month,
        totalValueILS: row.total_value_ils,
        breakdown: row.breakdown || null
      }));
    },
    // Update-only (never creates a row) - see the SQLite version's comment.
    async updateMonthlySnapshot(userId, snapshotMonth, totalValueILS, breakdownJson) {
      const { rowCount } = await pool.query(
        `UPDATE portfolio_monthly_snapshots
         SET total_value_ils = $1, breakdown = $2::jsonb
         WHERE user_id = $3 AND snapshot_month = $4`,
        [totalValueILS, breakdownJson || null, userId, snapshotMonth]
      );
      return rowCount > 0;
    },
    async deleteMonthlySnapshot(userId, snapshotMonth) {
      const { rowCount } = await pool.query(
        'DELETE FROM portfolio_monthly_snapshots WHERE user_id = $1 AND snapshot_month = $2',
        [userId, snapshotMonth]
      );
      return rowCount > 0;
    },
    async getRebalanceTargets(userId) {
      const { rows } = await pool.query('SELECT targets FROM rebalance_targets WHERE user_id = $1', [userId]);
      return rows[0] ? rows[0].targets : null;
    },
    async upsertRebalanceTargets(userId, targetsJson) {
      await pool.query(
        `INSERT INTO rebalance_targets (user_id, targets, updated_at)
         VALUES ($1, $2::jsonb, NOW())
         ON CONFLICT (user_id) DO UPDATE SET
           targets = EXCLUDED.targets,
           updated_at = NOW()`,
        [userId, targetsJson]
      );
    },
    async listTransactions(userId) {
      const { rows } = await pool.query(`SELECT * FROM transactions WHERE user_id = $1 ${TX_ORDER}`, [userId]);
      return rows.map(rowToTx);
    },
    async getTransaction(userId, id) {
      const { rows } = await pool.query('SELECT * FROM transactions WHERE user_id = $1 AND id = $2', [userId, id]);
      return rows[0] ? rowToTx(rows[0]) : null;
    },
    // See the SQLite version. The per-user advisory lock serializes two
    // ledger changes for the same user, so both cannot read the same
    // portfolio and the second overwrite the first.
    async applyLedgerChange(userId, change) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('SELECT pg_advisory_xact_lock($1)', [Number(userId)]);
        const portfolio = parsePortfolioPayload(await readPayload(client, userId));
        const { rows } = await client.query(`SELECT * FROM transactions WHERE user_id = $1 ${TX_ORDER}`, [userId]);
        const result = change({ portfolio, transactions: rows.map(rowToTx) });
        await writeSnapshot(client, userId, normalizeSnapshot(result.portfolio));
        if (result.insert) {
          const r = txToRow(userId, result.insert);
          await client.query(
            `INSERT INTO transactions (${TRANSACTION_COLUMNS.join(', ')})
             VALUES (${TRANSACTION_COLUMNS.map((c, i) => (c === 'details' ? `$${i + 1}::jsonb` : `$${i + 1}`)).join(', ')})`,
            TRANSACTION_COLUMNS.map((c) => r[c])
          );
        }
        if (result.removeId) {
          await client.query('DELETE FROM transactions WHERE user_id = $1 AND id = $2', [userId, result.removeId]);
        }
        await client.query('COMMIT');
        return result;
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    }
  };
}

/**
 * אם DATABASE_URL מוגדר (Supabase / Neon / Render Postgres) → PostgreSQL בשכבה חיצונית (עמיד, לרוב חינם).
 * אחרת → SQLite קובץ מקומי (פיתוח / שרת עם דיסק).
 */
async function initDataStore() {
  const url = process.env.DATABASE_URL && String(process.env.DATABASE_URL).trim();
  if (url) {
    return pgStore(url);
  }
  return sqliteStore(openSqlite());
}

module.exports = { initDataStore, PG_UNIQUE_VIOLATION, sqliteStore, openSqlite, pgStore, parsePortfolioPayload };
