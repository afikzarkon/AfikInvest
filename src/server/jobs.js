// The job handlers the queue (jobRunner.js) knows how to run.
const { runAnomalyScan, runCalendarRefresh, createPriceAlertJobHandlers } = require('./alertEngine');
const { createNewsJobHandlers } = require('./newsJobs');
const { createScannerJobHandlers } = require('./scannerJobs');

function createJobHandlers({ store, features, marketData, newsService, scanner, extra = {} }) {
  return Object.assign(
    {},
    // Material 8-K filings on held US stocks -> one alert per holder.
    createNewsJobHandlers({ store, features, newsService }),
    // User price rules (above / below / % from the previous close), checked
    // in trading hours; each rule rings once.
    createPriceAlertJobHandlers({ store, features }),
    // The daily setup scan over every US-listed stock (needs its store).
    scanner ? createScannerJobHandlers({ store, scanner }) : {},
    {
      'anomaly.scan': (payload) =>
        runAnomalyScan({ store, features, marketData, userIds: Array.isArray(payload.userIds) ? payload.userIds : null }),
      'calendar.refresh': (payload) =>
        runCalendarRefresh({ store, features, marketData, userIds: Array.isArray(payload.userIds) ? payload.userIds : null })
    },
    extra
  );
}

module.exports = { createJobHandlers };
