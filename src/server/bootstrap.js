// Builds the services shared by the API (src/server.js) and the optional
// standalone job worker (src/worker.js): the stores, market data and the
// job runner.
const { initDataStore } = require('./dataStore');
const { initFeatureStore } = require('./featureStore');
const { initAccountStore } = require('./accountStore');
const { initAdminStore } = require('./adminStore');
const { createMarketData } = require('./alertEngine');
const { createJobRunner } = require('./jobRunner');
const { createJobHandlers } = require('./jobs');
const { runAccountMaintenance } = require('./accountJobs');
const { createEmailService } = require('./emailService');
const { sourceSwitch, installSourceSwitch } = require('./sourceSwitch');

async function bootstrapServices() {
  const store = await initDataStore();
  const features = await initFeatureStore(store);
  const accounts = await initAccountStore(store);
  const admin = await initAdminStore(store);
  // Admin off switch for each outside data provider: on the shared axios
  // instance, in the API and the worker alike.
  installSourceSwitch();
  await sourceSwitch.attach(admin);
  const marketData = createMarketData();
  const runner = createJobRunner({
    features,
    handlers: createJobHandlers({
      store,
      features,
      marketData,
      extra: { 'accounts.maintenance': () => runAccountMaintenance({ accounts, mailer: createEmailService() }) }
    })
  });
  return { store, features, accounts, admin, marketData, runner };
}

module.exports = { bootstrapServices };
