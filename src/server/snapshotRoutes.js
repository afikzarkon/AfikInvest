// Portfolio value snapshots: one row per user per calendar day, storing the
// total portfolio value (ILS) at the time it was saved, plus an optional
// breakdown (by exchange/account type) for future use.
//
// This is the foundation for real historical analysis (equity curve, max
// drawdown, real volatility/Sharpe, benchmark comparison) — the app didn't
// keep any history before this, only "now" vs "purchase price". The frontend
// already computes the total portfolio value client-side (it has the live
// quotes), so this endpoint just persists what the client sends; it does not
// re-derive prices server-side.
const { readAuthUserFromRequest, getJwtSecret } = require('./authRoutes');
const { dateInTimeZone } = require('./marketCalendar');

function requireAuth(req, res, next) {
  try {
    const authUser = readAuthUserFromRequest(req, getJwtSecret());
    if (!authUser) return res.status(401).json({ error: 'נדרשת התחברות' });
    req.user = { id: authUser.id, email: authUser.email };
    next();
  } catch {
    return res.status(401).json({ error: 'פג תוקף או טוקן לא תקין' });
  }
}

// YYYY-MM-DD for "today", so repeated saves on the same day simply update
// the same row (upsert) instead of piling up multiple snapshots per day.
// Israel's calendar day, not UTC's - the users' day ends at local midnight.
function todayDateString() {
  return dateInTimeZone(new Date(), 'Asia/Jerusalem');
}

function isValidDateString(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

function mountSnapshotRoutes(app, store) {
  app.post('/api/portfolio-snapshot', requireAuth, async (req, res) => {
    try {
      const body = req.body || {};
      const totalValueILS = Number(body.totalValueILS);
      if (!Number.isFinite(totalValueILS) || totalValueILS < 0) {
        return res.status(400).json({ error: 'totalValueILS לא תקין' });
      }
      const snapshotDate = isValidDateString(body.date) ? body.date : todayDateString();
      const breakdown =
        body.breakdown && typeof body.breakdown === 'object'
          ? JSON.stringify(body.breakdown)
          : null;

      await store.upsertPortfolioSnapshot(req.user.id, snapshotDate, totalValueILS, breakdown);
      return res.json({ ok: true, date: snapshotDate });
    } catch (err) {
      console.error('[snapshot] failed to save snapshot', err);
      return res.status(500).json({ error: 'שגיאת שרת' });
    }
  });

  app.get('/api/portfolio-snapshots', requireAuth, async (req, res) => {
    try {
      const snapshots = await store.listPortfolioSnapshots(req.user.id);
      return res.json({ snapshots });
    } catch (err) {
      console.error('[snapshot] failed to list snapshots', err);
      return res.status(500).json({ error: 'שגיאת שרת' });
    }
  });
}

module.exports = { mountSnapshotRoutes };
