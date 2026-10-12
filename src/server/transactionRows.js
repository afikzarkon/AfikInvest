// Mapping between a ledger transaction object (shared/transactionLedger.js)
// and its database row. Shared by the SQLite and Postgres stores so the two
// can never disagree about the columns.
//
// The query-friendly facts get their own columns (type, date, asset, units,
// price, fees, currency, FX rate, amounts); what only the ledger itself
// reads back - the lot allocations a sale made, the lot a purchase created,
// the specific-lot request - is kept as one JSON `details` column.

const TRANSACTIONS_TABLE_SQLITE = `
  CREATE TABLE IF NOT EXISTS transactions (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type TEXT NOT NULL,
    trade_date TEXT NOT NULL,
    trade_time TEXT,
    asset_class TEXT NOT NULL,
    asset_id TEXT NOT NULL,
    units REAL,
    price REAL,
    fees REAL NOT NULL DEFAULT 0,
    currency TEXT NOT NULL,
    fx_rate REAL NOT NULL DEFAULT 1,
    amount REAL,
    tax_withheld REAL NOT NULL DEFAULT 0,
    amount_ils REAL,
    lot_method TEXT,
    details TEXT,
    note TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS transactions_user_date_idx ON transactions (user_id, trade_date);
`;

const TRANSACTIONS_TABLE_PG = `
  CREATE TABLE IF NOT EXISTS transactions (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type TEXT NOT NULL CHECK (type IN ('BUY','SELL','DEPOSIT','WITHDRAWAL','DIVIDEND')),
    trade_date DATE NOT NULL,
    trade_time TEXT,
    asset_class TEXT NOT NULL,
    asset_id TEXT NOT NULL,
    units DOUBLE PRECISION,
    price DOUBLE PRECISION,
    fees DOUBLE PRECISION NOT NULL DEFAULT 0,
    currency TEXT NOT NULL,
    fx_rate DOUBLE PRECISION NOT NULL DEFAULT 1,
    amount DOUBLE PRECISION,
    tax_withheld DOUBLE PRECISION NOT NULL DEFAULT 0,
    amount_ils DOUBLE PRECISION,
    lot_method TEXT,
    details JSONB,
    note TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS transactions_user_date_idx ON transactions (user_id, trade_date);
`;

const COLUMNS = [
  'id',
  'user_id',
  'type',
  'trade_date',
  'trade_time',
  'asset_class',
  'asset_id',
  'units',
  'price',
  'fees',
  'currency',
  'fx_rate',
  'amount',
  'tax_withheld',
  'amount_ils',
  'lot_method',
  'details',
  'note'
];

function txToRow(userId, tx) {
  const details = {
    allocations: tx.allocations || undefined,
    createdLotId: tx.createdLotId !== undefined ? tx.createdLotId : undefined,
    specificLots: tx.specificLots || undefined,
    lotDetails: tx.lotDetails || undefined
  };
  return {
    id: tx.id,
    user_id: userId,
    type: tx.type,
    trade_date: tx.date,
    trade_time: tx.time || null,
    asset_class: tx.assetClass,
    asset_id: String(tx.assetId),
    units: tx.units ?? null,
    price: tx.price ?? null,
    fees: tx.fees || 0,
    currency: tx.currency,
    fx_rate: tx.fxRate || 1,
    amount: tx.amount ?? null,
    tax_withheld: tx.taxWithheld || 0,
    amount_ils: tx.amountILS ?? null,
    lot_method: tx.lotMethod || null,
    details: JSON.stringify(details),
    note: tx.note || null
  };
}

const numOrNull = (v) => (v === null || v === undefined ? null : Number(v));

function rowToTx(row) {
  let details = row.details || {};
  if (typeof details === 'string') {
    try {
      details = JSON.parse(details);
    } catch {
      details = {};
    }
  }
  const date = row.trade_date instanceof Date ? row.trade_date.toISOString().slice(0, 10) : String(row.trade_date).slice(0, 10);
  const tx = {
    id: row.id,
    type: row.type,
    date,
    time: row.trade_time || null,
    assetClass: row.asset_class,
    assetId: row.asset_id,
    units: numOrNull(row.units),
    price: numOrNull(row.price),
    fees: Number(row.fees) || 0,
    currency: row.currency,
    fxRate: Number(row.fx_rate) || 1,
    amount: numOrNull(row.amount),
    taxWithheld: Number(row.tax_withheld) || 0,
    amountILS: numOrNull(row.amount_ils),
    lotMethod: row.lot_method || null,
    note: row.note || null,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at || null
  };
  if (details.allocations) tx.allocations = details.allocations;
  if (details.createdLotId !== undefined) tx.createdLotId = details.createdLotId;
  if (details.specificLots) tx.specificLots = details.specificLots;
  if (details.lotDetails) tx.lotDetails = details.lotDetails;
  return tx;
}

module.exports = { TRANSACTIONS_TABLE_SQLITE, TRANSACTIONS_TABLE_PG, COLUMNS, txToRow, rowToTx };
