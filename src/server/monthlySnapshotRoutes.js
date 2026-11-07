// Monthly portfolio-value checkpoints: one row per user per calendar month,
// storing the total portfolio value (ILS) + a per-category breakdown at the
// time the user chose to save it. A deliberate, separate action from the
// daily snapshots in snapshotRoutes.js (which feed the equity curve/
// drawdown/benchmark comparison) - this is for a slower-cadence, explicit
// "checkpoint my portfolio for this month" the user takes on their own
// schedule, then browses/compares later (see PortfolioAnalysisView.js's
// "מעקב חודשי" section).
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

// "YYYY-MM" for "this month" - computed server-side (never trust the client
// for the date, same reasoning as snapshotRoutes.js's todayDateString()) so
// repeated saves within the same calendar month update that one row
// (upsert) instead of creating a new entry per click.
//
// Israel's calendar, not UTC's: toISOString() still reads as last month
// until 02:00/03:00 on the 1st, which filed early-morning saves under the
// wrong month.
function todayString() {
  return dateInTimeZone(new Date(), 'Asia/Jerusalem');
}

function currentMonthString() {
  return todayString().slice(0, 7);
}

const MONTH_KEY_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const DATE_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

// THE DATE A CHECKPOINT IS VALID FOR.
//
// A month key alone says nothing about WHEN in the month the figures were
// taken - a live save on the 3rd and an auto-filled month-end valuation
// both read "2026-09". The comparison needs the real date to know which
// deposits/withdrawals fall between two checkpoints: one made on the 20th
// is inside the period if the checkpoint was the 10th, and already in the
// value if it was the 30th. Getting that wrong counts the deposit as growth,
// or nets it out twice.
//
// Stored as breakdown.asOfDate, next to the breakdown's other reserved key
// (cashFlows), so it needs no schema change. Must fall inside its own month
// and not in the future; anything else is replaced by the latest date the
// month can be valid for (its last day, or today for the current month).
function lastValidDateOfMonth(month) {
  const [year, mm] = month.split('-').map(Number);
  const lastDay = new Date(Date.UTC(year, mm, 0)).toISOString().slice(0, 10);
  const today = todayString();
  return lastDay > today ? today : lastDay;
}

function resolveAsOfDate(month, requested) {
  if (typeof requested === 'string' && DATE_RE.test(requested)) {
    if (requested.slice(0, 7) === month && requested <= todayString()) return requested;
  }
  return lastValidDateOfMonth(month);
}

function serializeBreakdown(rawBreakdown, asOfDate) {
  const breakdown = rawBreakdown && typeof rawBreakdown === 'object' ? { ...rawBreakdown } : {};
  if (asOfDate) breakdown.asOfDate = asOfDate;
  else delete breakdown.asOfDate;
  return JSON.stringify(breakdown);
}

// THE REAL DATE OF A MONTH SAVED BEFORE CHECKPOINTS RECORDED ONE.
//
// Without a date, such a month is read as valid on its last day - but most
// of them are automatic saves, taken the first time the app was opened that
// month, often on the 1st. Read as the 31st, every purchase or deposit made
// in between looked as if it were already inside that month's value, so it
// was never netted out and the next month showed it as a return.
//
// The automatic save writes the day's daily snapshot at the same moment,
// with the same total (hooks/useAutoSnapshot.js). So the daily snapshot in
// that month whose total equals the month's is the day it was taken; the
// earliest such day, if several match. A month no daily snapshot matches
// (one filled in later, valued at its month end) stays undated, and keeps
// reading as its last day.
const SAME_TOTAL_TOLERANCE = 0.01;

function inferAsOfDate(snapshot, dailySnapshots) {
  if (!snapshot || typeof snapshot.month !== 'string') return null;
  const total = Number(snapshot.totalValueILS);
  if (!Number.isFinite(total) || total <= 0) return null;
  const match = (dailySnapshots || [])
    .filter((d) => d && typeof d.date === 'string' && d.date.slice(0, 7) === snapshot.month)
    .filter((d) => Math.abs(Number(d.totalValueILS) - total) <= SAME_TOTAL_TOLERANCE)
    .map((d) => d.date.slice(0, 10))
    .sort()[0];
  return match && DATE_RE.test(match) ? match : null;
}

function withAsOfDates(monthlySnapshots, dailySnapshots) {
  return monthlySnapshots.map((snap) => {
    const recorded = snap.breakdown && snap.breakdown.asOfDate;
    if (recorded) return { ...snap, asOfDate: recorded };
    const inferred = inferAsOfDate(snap, dailySnapshots);
    return inferred ? { ...snap, asOfDate: inferred, asOfDateInferred: true } : { ...snap, asOfDate: null };
  });
}

function mountMonthlySnapshotRoutes(app, store) {
  app.post('/api/portfolio-monthly-snapshot', requireAuth, async (req, res) => {
    try {
      const body = req.body || {};
      const totalValueILS = Number(body.totalValueILS);
      if (!Number.isFinite(totalValueILS) || totalValueILS < 0) {
        return res.status(400).json({ error: 'totalValueILS לא תקין' });
      }
      const snapshotMonth = currentMonthString();
      // The day the saved figures are true for, as picked on the tracker
      // ("הנתונים נכונים לתאריך") - inside the current month and not in the
      // future; today when none (or an invalid one) was sent.
      const requested = body.breakdown && body.breakdown.asOfDate;
      const asOfDate =
        typeof requested === 'string' && DATE_RE.test(requested) && requested.slice(0, 7) === snapshotMonth && requested <= todayString()
          ? requested
          : todayString();
      const breakdown = serializeBreakdown(body.breakdown, asOfDate);

      await store.upsertMonthlySnapshot(req.user.id, snapshotMonth, totalValueILS, breakdown);
      return res.json({ ok: true, month: snapshotMonth, asOfDate });
    } catch (err) {
      console.error('[monthly-snapshot] failed to save snapshot', err);
      return res.status(500).json({ error: 'שגיאת שרת' });
    }
  });

  // Lets a user deliberately backfill a specific past month they forgot to
  // save (the "➕ הוספה ידנית" flow in PortfolioAnalysisView.js) - unlike the
  // route above, the client *does* choose the month here, since that's the
  // whole point of this endpoint. Still can't be used to date a save into
  // the future.
  app.post('/api/portfolio-monthly-snapshot/manual', requireAuth, async (req, res) => {
    try {
      const body = req.body || {};
      const month = body.month;
      if (typeof month !== 'string' || !MONTH_KEY_RE.test(month)) {
        return res.status(400).json({ error: 'פורמט חודש לא תקין' });
      }
      if (month > currentMonthString()) {
        return res.status(400).json({ error: 'לא ניתן להוסיף שמירה לחודש עתידי' });
      }
      const totalValueILS = Number(body.totalValueILS);
      if (!Number.isFinite(totalValueILS) || totalValueILS < 0) {
        return res.status(400).json({ error: 'totalValueILS לא תקין' });
      }
      // A backfilled month is valid for the date its figures were valued
      // at (the client's auto-fill values a month at its last day, or today
      // for the month in progress) - checked to fall inside that month.
      const asOfDate = resolveAsOfDate(month, body.breakdown && body.breakdown.asOfDate);
      const breakdown = serializeBreakdown(body.breakdown, asOfDate);

      await store.upsertMonthlySnapshot(req.user.id, month, totalValueILS, breakdown);
      return res.json({ ok: true, month, asOfDate });
    } catch (err) {
      console.error('[monthly-snapshot] failed to add manual snapshot', err);
      return res.status(500).json({ error: 'שגיאת שרת' });
    }
  });

  app.get('/api/portfolio-monthly-snapshots', requireAuth, async (req, res) => {
    try {
      const monthly = await store.listMonthlySnapshots(req.user.id);
      // Only needed for months saved before checkpoints carried a date.
      const needsInference = monthly.some((snap) => !(snap.breakdown && snap.breakdown.asOfDate));
      let daily = [];
      if (needsInference && typeof store.listPortfolioSnapshots === 'function') {
        try {
          daily = await store.listPortfolioSnapshots(req.user.id);
        } catch (err) {
          console.error('[monthly-snapshot] could not read daily snapshots to date old months', err);
        }
      }
      // asOfDate: recorded, else recovered from the matching daily snapshot,
      // else null (the comparison then reads the month's last day).
      const snapshots = withAsOfDates(monthly, daily);
      return res.json({ snapshots });
    } catch (err) {
      console.error('[monthly-snapshot] failed to list snapshots', err);
      return res.status(500).json({ error: 'שגיאת שרת' });
    }
  });

  // Lets a user correct a month they already saved (see the "ערוך" flow in
  // PortfolioAnalysisView.js's history table) - update-only, on purpose:
  // store.updateMonthlySnapshot() never creates a row. Adding a brand new
  // past month is the manual-add route above, not this one.
  app.put('/api/portfolio-monthly-snapshot/:month', requireAuth, async (req, res) => {
    try {
      const month = req.params.month;
      if (!MONTH_KEY_RE.test(month)) {
        return res.status(400).json({ error: 'פורמט חודש לא תקין' });
      }
      const body = req.body || {};
      const totalValueILS = Number(body.totalValueILS);
      if (!Number.isFinite(totalValueILS) || totalValueILS < 0) {
        return res.status(400).json({ error: 'totalValueILS לא תקין' });
      }
      // An edit carries the date its figures are valid for: unchanged when
      // only a figure was corrected, the valuation date when the month was
      // re-filled automatically. A month that never had one (saved before
      // this existed) stays undated rather than being given a guess.
      const requestedAsOf = body.breakdown && body.breakdown.asOfDate;
      const asOfDate = requestedAsOf ? resolveAsOfDate(month, requestedAsOf) : null;
      const breakdown = serializeBreakdown(body.breakdown, asOfDate);

      const updated = await store.updateMonthlySnapshot(req.user.id, month, totalValueILS, breakdown);
      if (!updated) {
        return res.status(404).json({ error: 'לא נמצאה שמירה חודשית לחודש זה - ניתן לערוך רק חודשים שכבר נשמרו' });
      }
      return res.json({ ok: true, month });
    } catch (err) {
      console.error('[monthly-snapshot] failed to update snapshot', err);
      return res.status(500).json({ error: 'שגיאת שרת' });
    }
  });

  // Lets a user permanently remove a specific saved month (see the "מחק"
  // flow in PortfolioAnalysisView.js's history section).
  app.delete('/api/portfolio-monthly-snapshot/:month', requireAuth, async (req, res) => {
    try {
      const month = req.params.month;
      if (!MONTH_KEY_RE.test(month)) {
        return res.status(400).json({ error: 'פורמט חודש לא תקין' });
      }
      const deleted = await store.deleteMonthlySnapshot(req.user.id, month);
      if (!deleted) {
        return res.status(404).json({ error: 'לא נמצאה שמירה חודשית לחודש זה' });
      }
      return res.json({ ok: true, month });
    } catch (err) {
      console.error('[monthly-snapshot] failed to delete snapshot', err);
      return res.status(500).json({ error: 'שגיאת שרת' });
    }
  });
}

module.exports = { mountMonthlySnapshotRoutes, resolveAsOfDate, serializeBreakdown, inferAsOfDate, withAsOfDates };
