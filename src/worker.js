// Optional standalone job worker: runs the background job queue (anomaly
// scans, calendar refreshes, monthly PDF reports) in its own process, so
// Chrome's memory use during report rendering never competes with the API.
//
// Use it on a host that offers a background-worker process (e.g. a Render
// Background Worker on a paid plan - see render.yaml), and set JOBS_POLL=0
// on the API so only the worker polls. Without it, the API runs the same
// jobs itself.
require('dotenv').config();
const { bootstrapServices } = require('./server/bootstrap');

const POLL_MS = Number(process.env.WORKER_POLL_MS) || 15000;

bootstrapServices()
  .then(({ runner, store }) => {
    console.log(`StockView worker started (DB: ${store.kind}, poll every ${POLL_MS / 1000}s)`);
    let stopping = false;
    const loop = async () => {
      while (!stopping) {
        try {
          const results = await runner.runDue({ max: 10 });
          if (results.length) console.log('[worker] ran', results.map((r) => `${r.name}:${r.status}`).join(', '));
        } catch (err) {
          console.error('[worker] loop error', err && err.message);
        }
        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
      }
    };
    loop();
    const stop = () => {
      stopping = true;
      setTimeout(() => process.exit(0), 500);
    };
    process.on('SIGTERM', stop);
    process.on('SIGINT', stop);
  })
  .catch((err) => {
    console.error('Worker failed to start:', err);
    process.exit(1);
  });
