// Endpoints for the external scheduler (see .github/workflows/scheduled-jobs.yml).
//
//   POST /api/internal/jobs/:name   header X-Cron-Secret: <CRON_SECRET>
//       Enqueues job `name` (idempotent per UTC day for the daily scans, so
//       a retried or duplicated cron call does not run a scan twice) and then
//       drains every due job - the request keeps a sleeping host awake for
//       as long as the work takes.
//
// Disabled (503) until CRON_SECRET is configured.
const crypto = require('crypto');

const SCHEDULABLE = {
  'anomaly.scan': { dailyKey: true },
  'calendar.refresh': { dailyKey: true },
  // Only drains the queue (e.g. reports whose debounce has expired).
  drain: { enqueue: false }
};

function secretMatches(given, expected) {
  const a = Buffer.from(String(given || ''));
  const b = Buffer.from(String(expected || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function mountInternalJobRoutes(app, { features, runner, getSecret = () => process.env.CRON_SECRET, now = () => new Date() }) {
  app.post('/api/internal/jobs/:name', async (req, res) => {
    const secret = getSecret();
    if (!secret) return res.status(503).json({ error: 'scheduled jobs are disabled (CRON_SECRET not set)' });
    if (!secretMatches(req.get('X-Cron-Secret'), secret)) return res.status(401).json({ error: 'unauthorized' });

    const name = String(req.params.name);
    const spec = SCHEDULABLE[name];
    if (!spec) return res.status(404).json({ error: `unknown job ${name}` });

    try {
      let job = null;
      if (spec.enqueue !== false) {
        const day = now().toISOString().slice(0, 10);
        // `force=1` bypasses the once-a-day key (manual re-run).
        const key = spec.dailyKey && req.query.force !== '1' ? `${name}:${day}` : null;
        job = await features.enqueueJob(name, req.body || {}, { idempotencyKey: key });
      }
      const results = await runner.runDue({ max: 50 });
      return res.json({ enqueued: job, results });
    } catch (err) {
      console.error('[internal-jobs] failed', err);
      return res.status(500).json({ error: String(err && err.message) });
    }
  });
}

module.exports = { mountInternalJobRoutes, secretMatches };
