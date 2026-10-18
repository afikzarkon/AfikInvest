// server.js
require('dotenv').config();
const express = require('express');
const cookieParser = require('cookie-parser');
const { bootstrapServices } = require('./server/bootstrap');
const { mountAuthRoutes, getJwtSecret } = require('./server/authRoutes');
const { mountAccountRoutes } = require('./server/accountRoutes');
const { mountOAuthRoutes } = require('./server/oauthRoutes');
const { createEmailService } = require('./server/emailService');
const {
  corsMiddleware,
  helmetMiddleware,
  crossSiteRequestGuard,
  createSessionGuard,
  warnAboutConfiguration
} = require('./server/security');
const { mountPortfolioRoutes } = require('./server/portfolioRoutes');
const { mountQuotesRoutes } = require('./server/quotesRoutes');
const { mountCpiRoutes } = require('./server/cpiRoutes');
const { mountSnapshotRoutes } = require('./server/snapshotRoutes');
const { mountMonthlySnapshotRoutes } = require('./server/monthlySnapshotRoutes');
const { mountBenchmarkRoutes } = require('./server/benchmarkRoutes');
const { mountSectorRoutes } = require('./server/sectorRoutes');
const { mountAnalystRoutes } = require('./server/analystRoutes');
const { mountRebalanceRoutes } = require('./server/rebalanceRoutes');
const { mountDividendRoutes } = require('./server/dividendRoutes');
const { mountStockSearchRoutes } = require('./server/stockSearchRoutes');
const { mountHistoricalPricesRoutes } = require('./server/historicalPricesRoutes');
const { mountTransactionRoutes } = require('./server/transactionRoutes');
const { mountAlertRoutes } = require('./server/alertRoutes');
const { mountInternalJobRoutes } = require('./server/internalJobRoutes');
const { mountPreferenceRoutes } = require('./server/preferenceRoutes');
const { mountValuationRoutes } = require('./server/valuationRoutes');
const { createValuationService, createDefaultSources } = require('./server/valuationService');

const app = express();
app.set('trust proxy', 1);
// Security headers, the CORS allowlist (APP_URL / CORS_ORIGINS) and the
// cross-site request check run ahead of every route - see server/security.js.
app.use(helmetMiddleware());
app.use(corsMiddleware());
app.use(express.json({ limit: '10mb' }));
app.use(cookieParser());
app.use(crossSiteRequestGuard());
// Registered here so it precedes every route; it gets the store to check
// sessions against once bootstrap finishes.
const sessionGuard = createSessionGuard();
app.use(sessionGuard.middleware);
warnAboutConfiguration();

mountQuotesRoutes(app);
mountCpiRoutes(app);
mountBenchmarkRoutes(app);
mountSectorRoutes(app);
mountAnalystRoutes(app);
mountDividendRoutes(app);
mountStockSearchRoutes(app);
mountHistoricalPricesRoutes(app);
mountValuationRoutes(app, { valuation: createValuationService({ sources: createDefaultSources() }) });

const PORT = Number(process.env.PORT) || 5000;

bootstrapServices()
  .then(({ store, features, accounts, marketData, runner }) => {
    sessionGuard.setStore(store, accounts);
    const mailer = createEmailService();
    const auth = mountAuthRoutes(app, store, { sessionGuard, accounts, mailer });
    mountAccountRoutes(app, { store, accounts, features, mailer, auth });
    mountOAuthRoutes(app, { store, accounts, mailer, auth, jwtSecret: getJwtSecret() });
    mountPortfolioRoutes(app, store);
    mountSnapshotRoutes(app, store);
    mountMonthlySnapshotRoutes(app, store);
    mountRebalanceRoutes(app, store);
    mountTransactionRoutes(app, store);
    mountAlertRoutes(app, { store, features, marketData });
    mountInternalJobRoutes(app, { features, runner });
    mountPreferenceRoutes(app, { features });
    // Drains due jobs while the process is up; the external scheduler covers
    // the time the host is asleep. JOBS_POLL=0 turns the poller off - e.g.
    // when a separate worker (src/worker.js) runs the jobs instead.
    if (process.env.JOBS_POLL !== '0') runner.start();
    console.log(`DB: ${store.kind === 'postgres' ? 'PostgreSQL (DATABASE_URL)' : 'SQLite local file'}`);
    app.listen(PORT, () => {
      console.log(`AfikInvest API http://localhost:${PORT}`);
    });
  })
  .catch((err) => {
    console.error('Failed to init database:', err);
    process.exit(1);
  });
