// The transactions ledger API. Every write goes through
// store.applyLedgerChange, which saves the ledger row and the portfolio it
// changed in one database transaction (see shared/transactionLedger.js for
// what each transaction type does to the portfolio).
//
//   GET    /api/transactions            -> { transactions }
//   POST   /api/transactions/preview    -> { transaction } (dry run: which lots a sale would close)
//   POST   /api/transactions            -> { transaction, portfolio }
//   DELETE /api/transactions/:id        -> { ok, portfolio }
//
// The client must save any unsaved portfolio edits BEFORE posting: the
// server applies the transaction to the portfolio it has stored, and the
// client then replaces its own copy with the one returned.
const crypto = require('crypto');
const { requireAuth } = require('./requireAuth');
const {
  normalizeTransaction,
  applyTransaction,
  revertTransaction,
  LedgerError
} = require('../shared/transactionLedger');

const STATUS_BY_CODE = {
  INVALID: 400,
  INSUFFICIENT_UNITS: 409,
  LOT_NOT_FOUND: 409,
  ACCOUNT_NOT_FOUND: 409,
  CANNOT_REVERT: 409
};

const todayString = () => new Date().toISOString().slice(0, 10);

// A lot id the add-stock form could have produced (numeric, time-based),
// bumped past any id already in use so it can never collide.
function nextLotId(portfolio) {
  const used = new Set(
    [...(portfolio.israeliStocks || []), ...(portfolio.americanStocks || [])].map((lot) => String(lot.id))
  );
  let id = Date.now();
  while (used.has(String(id))) id += 1;
  return id;
}

function sendLedgerError(res, err) {
  if (err instanceof LedgerError) {
    return res.status(STATUS_BY_CODE[err.code] || 400).json({ error: err.message, code: err.code });
  }
  console.error('[transactions] unexpected failure', err);
  return res.status(500).json({ error: 'שגיאת שרת' });
}

function mountTransactionRoutes(app, store, { now = todayString, onChanged = null } = {}) {
  // Every transaction changes a month's cash flows (and deposits/withdrawals
  // the accounts the monthly sync watches). The transaction is passed along
  // so the report for ITS month can be refreshed.
  const notify = (userId, tx) => {
    if (!onChanged) return;
    Promise.resolve()
      .then(() => onChanged(userId, tx))
      .catch((err) => console.error('[transactions] onChanged hook failed', err && err.message));
  };

  app.get('/api/transactions', requireAuth, async (req, res) => {
    try {
      const transactions = await store.listTransactions(req.user.id);
      return res.json({ transactions });
    } catch (err) {
      return sendLedgerError(res, err);
    }
  });

  app.post('/api/transactions/preview', requireAuth, async (req, res) => {
    try {
      const tx = { ...normalizeTransaction(req.body, { today: now() }), id: 'preview' };
      const portfolio = JSON.parse((await store.getPortfolioPayload(req.user.id)) || '{}');
      const { transaction } = applyTransaction(portfolio, tx, { newLotId: 'preview' });
      return res.json({ transaction });
    } catch (err) {
      return sendLedgerError(res, err);
    }
  });

  app.post('/api/transactions', requireAuth, async (req, res) => {
    try {
      const tx = { ...normalizeTransaction(req.body, { today: now() }), id: crypto.randomUUID() };
      const result = await store.applyLedgerChange(req.user.id, ({ portfolio }) => {
        const applied = applyTransaction(portfolio, tx, { newLotId: nextLotId(portfolio) });
        return { portfolio: applied.portfolio, insert: applied.transaction };
      });
      notify(req.user.id, result.insert);
      return res.status(201).json({ transaction: result.insert, portfolio: result.portfolio });
    } catch (err) {
      return sendLedgerError(res, err);
    }
  });

  app.delete('/api/transactions/:id', requireAuth, async (req, res) => {
    try {
      const id = String(req.params.id || '');
      let removed = null;
      const result = await store.applyLedgerChange(req.user.id, ({ portfolio, transactions }) => {
        const tx = transactions.find((t) => t.id === id);
        if (!tx) throw new LedgerError('NOT_FOUND', 'transaction not found');
        removed = tx;
        return { portfolio: revertTransaction(portfolio, tx), removeId: id };
      });
      notify(req.user.id, removed);
      return res.json({ ok: true, portfolio: result.portfolio });
    } catch (err) {
      if (err instanceof LedgerError && err.code === 'NOT_FOUND') {
        return res.status(404).json({ error: err.message, code: err.code });
      }
      return sendLedgerError(res, err);
    }
  });
}

module.exports = { mountTransactionRoutes };
