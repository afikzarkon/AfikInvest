// Builds the services shared by the API (src/server.js) and the optional
// standalone job worker (src/worker.js): the stores, market data, the
// monthly report service and the job runner.
const { initDataStore } = require('./dataStore');
const { initFeatureStore } = require('./featureStore');
const { createMarketData } = require('./alertEngine');
const { createJobRunner } = require('./jobRunner');
const { createJobHandlers } = require('./jobs');
const { createReportService, createEmailNotifier } = require('./report/reportService');
const { createReportStorage } = require('./report/reportStorage');
const { createPdfRenderer } = require('./report/pdfRenderer');
const { fetchYahooHistoricalRateForDate, fetchYahooDividendHistory } = require('./yahooQuotes');

async function bootstrapServices() {
  const store = await initDataStore();
  const features = await initFeatureStore(store);
  const marketData = createMarketData();
  const reports = createReportService({
    store,
    features,
    storage: createReportStorage(),
    renderer: createPdfRenderer(),
    notifier: createEmailNotifier(),
    getUsdRate: async (date) => {
      const r = await fetchYahooHistoricalRateForDate('USDILS=X', date);
      return r ? r.rate : null;
    },
    getDividendHistory: (symbol, fromDate) => fetchYahooDividendHistory(symbol, fromDate)
  });
  const runner = createJobRunner({
    features,
    handlers: createJobHandlers({ store, features, marketData, reports })
  });
  return { store, features, marketData, reports, runner };
}

module.exports = { bootstrapServices };
