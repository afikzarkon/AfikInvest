// The job handlers the queue (jobRunner.js) knows how to run. Reports
// (Step 3) register theirs here too.
const { runAnomalyScan, runCalendarRefresh } = require('./alertEngine');

function createJobHandlers({ store, features, marketData, reports = null, extra = {} }) {
  return Object.assign(
    {
      'anomaly.scan': (payload) =>
        runAnomalyScan({ store, features, marketData, userIds: Array.isArray(payload.userIds) ? payload.userIds : null }),
      'calendar.refresh': (payload) =>
        runCalendarRefresh({ store, features, marketData, userIds: Array.isArray(payload.userIds) ? payload.userIds : null })
    },
    reports ? { 'report.render': (payload) => reports.renderReport(payload) } : {},
    extra
  );
}

module.exports = { createJobHandlers };
