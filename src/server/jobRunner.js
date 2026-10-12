// Drains the durable job queue (featureStore jobs table).
//
// Two ways jobs get run, because the API host (Render free plan) sleeps
// when idle and an in-process timer alone would silently miss schedules:
//   1. An external scheduler (the GitHub Actions workflow
//      .github/workflows/scheduled-jobs.yml) calls
//      POST /api/internal/jobs/:name, which enqueues and then drains
//      synchronously - the request itself keeps the host awake.
//   2. While the process is up, a poller drains whatever is due (the report
//      debounce needs this: a job scheduled 10 minutes out).
//
// Handlers: { [jobName]: async (payload, job) => result }.

function createJobRunner({ features, handlers, logger = console, pollMs = 30000 }) {
  let timer = null;
  let draining = false;

  async function runJob(job, now = () => new Date().toISOString()) {
    const handler = handlers[job.name];
    if (!handler) {
      await features.failJob(Object.assign({}, job, { attempts: job.maxAttempts }), new Error(`no handler for job ${job.name}`));
      return { id: job.id, name: job.name, status: 'failed', error: 'no handler' };
    }
    try {
      const result = await handler(job.payload || {}, job);
      await features.completeJob(job.id, result === undefined ? null : result);
      return { id: job.id, name: job.name, status: 'done', result };
    } catch (err) {
      // Backoff is measured from the runner's clock, not the wall clock.
      const outcome = await features.failJob(job, err, new Date(now()));
      logger.error(`[jobs] ${job.name} ${job.id} failed (${outcome})`, err && err.message);
      return { id: job.id, name: job.name, status: outcome, error: String(err && err.message) };
    }
  }

  // Runs due jobs one at a time until none is left or `max` have run.
  async function runDue({ max = 20, names = null, now = () => new Date().toISOString() } = {}) {
    const results = [];
    while (results.length < max) {
      const job = await features.claimNextJob(names, now());
      if (!job) break;
      results.push(await runJob(job, now));
    }
    return results;
  }

  function start() {
    if (timer) return;
    timer = setInterval(async () => {
      if (draining) return;
      draining = true;
      try {
        await runDue();
      } catch (err) {
        logger.error('[jobs] poll failed', err && err.message);
      } finally {
        draining = false;
      }
    }, pollMs);
    if (timer.unref) timer.unref();
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return { runDue, runJob, start, stop };
}

module.exports = { createJobRunner };
