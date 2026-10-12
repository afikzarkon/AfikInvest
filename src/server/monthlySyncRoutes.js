// The monthly sync and the reports it produces (see report/reportService.js):
//   GET  /api/monthly-sync?month=YYYY-MM          -> sync status (defaults to the month being synced now)
//   PUT  /api/monthly-sync/:month/excluded         { keys: [...] } accounts not to wait for
//   POST /api/monthly-sync/:month/complete         "Finished monthly update"
//   POST /api/monthly-sync/:month/regenerate       a new report version now (debounced)
//   GET  /api/reports                              -> { reports }
//   GET  /api/reports/:id/download                 -> the PDF (redirect to a 60s signed URL, or the bytes)
const { requireAuth } = require('./requireAuth');
const { targetMonthFor, isValidMonth } = require('../shared/monthlySync');

function mountMonthlySyncRoutes(app, { reports, features, now = () => new Date() }) {
  const monthParam = (req, res) => {
    const month = req.params.month;
    if (!isValidMonth(month)) {
      res.status(400).json({ error: 'month must be YYYY-MM' });
      return null;
    }
    if (month > now().toISOString().slice(0, 7)) {
      res.status(400).json({ error: 'month cannot be in the future' });
      return null;
    }
    return month;
  };

  app.get('/api/monthly-sync', requireAuth, async (req, res) => {
    const month = req.query.month || targetMonthFor(now().toISOString().slice(0, 10));
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
      return res.json({ reports: await features.listReports(req.user.id) });
    } catch (err) {
      return res.status(500).json({ error: 'שגיאת שרת' });
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
