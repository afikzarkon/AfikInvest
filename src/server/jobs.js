// The job handlers the queue (jobRunner.js) knows how to run.
const { runAnomalyScan, runCalendarRefresh } = require('./alertEngine');

function createJobHandlers({ store, features, marketData, extra = {} }) {
  return Object.assign(
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
