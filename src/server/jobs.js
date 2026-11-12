// The job handlers the queue (jobRunner.js) knows how to run.
const { runAnomalyScan, runCalendarRefresh } = require('./alertEngine');
const { createNewsJobHandlers } = require('./newsJobs');

function createJobHandlers({ store, features, marketData, newsService, extra = {} }) {
  return Object.assign(
    {},
    // Material 8-K filings on held US stocks -> one alert per holder.
    createNewsJobHandlers({ store, features, newsService }),
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
