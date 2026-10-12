// The monthly sync and the reports it produces (see report/reportService.js):
//   GET  /api/monthly-sync?month=YYYY-MM          -> sync status (defaults to the month being synced now)
//   PUT  /api/monthly-sync/:month/excluded         { keys: [...] } accounts not to wait for
//   POST /api/monthly-sync/:month/complete         "Finished monthly update"
//   POST /api/monthly-sync/:month/regenerate       a new report version now (debounced)
//   GET  /api/reports                              -> { reports }
//   GET  /api/reports/:id/download                 -> the PDF (redirect to a 60s signed URL, or the bytes)
//   POST /api/reports/:id/email                    -> mail that report's link to the user now
const { requireAuth } = require('./requireAuth');
const { targetMonthFor, isValidMonth } = require('../shared/monthlySync');
const { dateInTimeZone } = require('./marketCalendar');

function mountMonthlySyncRoutes(app, { reports, features, now = () => new Date() }) {
  // Israel's calendar, not UTC's: just after midnight on the 1st the UTC
  // month is still the previous one, which refused the month that had just
  // started as "in the future".
  const todayIL = () => dateInTimeZone(now(), 'Asia/Jerusalem');

  const monthParam = (req, res) => {
    const month = req.params.month;
    if (!isValidMonth(month)) {
      res.status(400).json({ error: 'month must be YYYY-MM' });
      return null;
    }
    if (month > todayIL().slice(0, 7)) {
      res.status(400).json({ error: 'month cannot be in the future' });
      return null;
    }
    return month;
  };

  app.get('/api/monthly-sync', requireAuth, async (req, res) => {
    const month = req.query.month || targetMonthFor(todayIL());
    if (!isValidMonth(month)) return res.status(400).json({ error: 'month must be YYYY-MM' });
    try {
      return res.json(await reports.getStatus(req.user.id, month));
    } catch (err) {
      console.error('[monthly-sync] status failed', err);
      return res.status(500).json({ error: 'שגיאת שרת' });
    }
  });

  app.put('/api/monthly-sync/:month/excluded', requireAuth, async (req, res) => {
    const month = monthParam(req, res);
    if (!month) return undefined;
    const keys = req.body && Array.isArray(req.body.keys) ? req.body.keys.slice(0, 200) : null;
    if (!keys) return res.status(400).json({ error: 'keys must be an array' });
    try {
      return res.json(await reports.setExcluded(req.user.id, month, keys));
    } catch (err) {
      return res.status(500).json({ error: 'שגיאת שרת' });
    }
  });

  app.post('/api/monthly-sync/:month/complete', requireAuth, async (req, res) => {
    const month = monthParam(req, res);
    if (!month) return undefined;
    try {
      const result = await reports.completeMonth(req.user.id, month, { by: 'user' });
      return res.json({ scheduled: result.scheduled, snapshot: result.snapshot, status: await reports.getStatus(req.user.id, month) });
    } catch (err) {
      console.error('[monthly-sync] complete failed', err);
      return res.status(500).json({ error: 'שגיאת שרת' });
    }
  });

  app.post('/api/monthly-sync/:month/regenerate', requireAuth, async (req, res) => {
    const month = monthParam(req, res);
    if (!month) return undefined;
    try {
      return res.json({ scheduled: await reports.regenerate(req.user.id, month) });
    } catch (err) {
      return res.status(409).json({ error: err.message });
    }
  });

  app.get('/api/reports', requireAuth, async (req, res) => {
    try {
      return res.json({
        reports: await features.listReports(req.user.id),
        // So the page only offers e-mail when the server can actually send it.
        email: reports.emailStatus ? reports.emailStatus() : { enabled: false }
      });
    } catch (err) {
      return res.status(500).json({ error: 'שגיאת שרת' });
    }
  });

  app.post('/api/reports/:id/email', requireAuth, async (req, res) => {
    try {
      return res.json({ ok: true, ...(await reports.emailReport(req.user.id, String(req.params.id))) });
    } catch (err) {
      if (err && err.code === 'EMAIL_DISABLED') return res.status(503).json({ error: err.message });
      if (err && err.code === 'NOT_FOUND') return res.status(404).json({ error: err.message });
      console.error('[reports] email failed', err && err.message);
      return res.status(502).json({ error: `שליחת המייל נכשלה: ${(err && err.message) || 'שגיאה'}` });
    }
  });

  app.get('/api/reports/:id/download', requireAuth, async (req, res) => {
    try {
      const found = await reports.downloadTarget(req.user.id, String(req.params.id));
      if (!found) return res.status(404).json({ error: 'לא נמצא' });
      const { report, target } = found;
      if (target.type === 'redirect') return res.redirect(302, target.url);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="stockview-report-${report.month}-v${report.version}.pdf"`);
      res.setHeader('Cache-Control', 'private, no-store');
      return res.send(target.buffer);
    } catch (err) {
      console.error('[reports] download failed', err);
      return res.status(500).json({ error: 'שגיאת שרת' });
    }
  });
}

module.exports = { mountMonthlySyncRoutes };
