// The transactions ledger API. Every write goes through
// store.applyLedgerChange, which saves the ledger row and the portfolio it
// changed in one database transaction (see shared/transactionLedger.js for
// what each transaction type does to the portfolio).
//
//   GET    /api/transactions            -> { transactions }
//   POST   /api/transactions/preview    -> { transaction } (dry run: which lots a sale would close)
//   POST   /api/transactions            -> { transaction, portfolio }
//   PUT    /api/transactions/:id        -> { transaction, portfolio } (edit: undo + redo, atomically)
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

const ACCOUNT_KEYS = { pension: 'pensionFunds', cashFunds: 'cashFunds', bank: 'bankBalances', bankSavings: 'bankSavingsFunds' };

const STATUS_BY_CODE = {
  INVALID: 400,
  INSUFFICIENT_UNITS: 409,
  LOT_NOT_FOUND: 409,
  ACCOUNT_NOT_FOUND: 409,
  CANNOT_REVERT: 409
};

const { dateInTimeZone } = require('./marketCalendar');

// Israel's date: a transaction made just after midnight is not "tomorrow".
const todayString = () => dateInTimeZone(new Date(), 'Asia/Jerusalem');

// A lot id the add-stock form could have produced (numeric, time-based),
// bumped past any id already in use so it can never collide.
function nextLotId(portfolio) {
  const used = new Set(
    [
      ...(portfolio.israeliStocks || []),
      ...(portfolio.americanStocks || []),
      ...(portfolio.pensionFunds || []),
      ...(portfolio.cashFunds || []),
      ...(portfolio.bankBalances || []),
      ...(portfolio.bankSavingsFunds || [])
    ].map((item) => String(item.id))
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

function mountTransactionRoutes(app, store, { now = todayString } = {}) {
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
      return res.status(201).json({ transaction: result.insert, portfolio: result.portfolio });
    } catch (err) {
      return sendLedgerError(res, err);
    }
  });

  // Editing a transaction = undoing it and applying the corrected one, in the
  // SAME database transaction: either both happen or neither does. (Doing
  // it as a delete and a separate record could lose the original if the
  // corrected one was refused - e.g. a sale of more units than are held.)
  //
  // An edit keeps what makes the entry the entry it is: the same type, and
  // for a deposit that opened an account, the account it opened.
  app.put('/api/transactions/:id', requireAuth, async (req, res) => {
    try {
      const id = String(req.params.id || '');
      const result = await store.applyLedgerChange(req.user.id, ({ portfolio, transactions }) => {
        const old = transactions.find((t) => t.id === id);
        if (!old) throw new LedgerError('NOT_FOUND', 'transaction not found');
        const body = { ...(req.body || {}) };
        if (String(body.type || '').toUpperCase() !== old.type) {
          throw new LedgerError('INVALID', 'an edit cannot change the transaction type - delete it and record a new one');
        }
        const opened = old.createdAccountId !== undefined && old.createdAccountId !== null;
        const reverted = revertTransaction(portfolio, old);
        let newLotId = nextLotId(reverted);
        if (opened) {
          const key = ACCOUNT_KEYS[old.assetClass];
          const stillThere = (reverted[key] || []).some((a) => String(a.id) === String(old.createdAccountId));
          if (stillThere) {
            // The account has later history, so undoing its opening deposit
            // left it in place: correct the deposit inside it.
            delete body.newAccount;
            body.assetId = String(old.createdAccountId);
          } else {
            // Its only entry: open it again, under the same id, with the
            // corrected deposit (and any corrected details).
            body.newAccount = { ...(old.newAccount || {}), ...(body.newAccount || {}) };
            newLotId = old.createdAccountId;
          }
        }
        const tx = { ...normalizeTransaction(body, { today: now() }), id: crypto.randomUUID() };
        const applied = applyTransaction(reverted, tx, { newLotId });
        if (opened) applied.transaction.createdAccountId = old.createdAccountId;
        return { portfolio: applied.portfolio, insert: applied.transaction, removeId: id };
      });
      return res.json({ transaction: result.insert, portfolio: result.portfolio });
    } catch (err) {
      if (err instanceof LedgerError && err.code === 'NOT_FOUND') {
        return res.status(404).json({ error: err.message, code: err.code });
      }
      return sendLedgerError(res, err);
    }
  });

  app.delete('/api/transactions/:id', requireAuth, async (req, res) => {
    try {
      const id = String(req.params.id || '');
      const result = await store.applyLedgerChange(req.user.id, ({ portfolio, transactions }) => {
        const tx = transactions.find((t) => t.id === id);
        if (!tx) throw new LedgerError('NOT_FOUND', 'transaction not found');
        return { portfolio: revertTransaction(portfolio, tx), removeId: id };
      });
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
