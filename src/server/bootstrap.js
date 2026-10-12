// Builds the services shared by the API (src/server.js) and the optional
// standalone job worker (src/worker.js): the stores, market data and the
// job runner.
const { initDataStore } = require('./dataStore');
const { initFeatureStore } = require('./featureStore');
const { createMarketData } = require('./alertEngine');
const { createJobRunner } = require('./jobRunner');
const { createJobHandlers } = require('./jobs');

async function bootstrapServices() {
  const store = await initDataStore();
  const features = await initFeatureStore(store);
  const marketData = createMarketData();
  const runner = createJobRunner({
    features,
    handlers: createJobHandlers({ store, features, marketData })
  });
  return { store, features, marketData, runner };
}

module.exports = { bootstrapServices };
