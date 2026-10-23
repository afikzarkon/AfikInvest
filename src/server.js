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
const { mountMarketDataGate } = require('./server/marketDataAccess');
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
const { mountAdminRoutes, createFlagGate } = require('./server/adminRoutes');
const { createSystemGate } = require('./server/systemRoutes');
const { installErrorCapture } = require('./server/errorLog');
const { createValuationService, createDefaultSources } = require('./server/valuationService');
const { createDcfSnapshotService, createReferenceMemory } = require('./server/dcfSnapshot');
const { marketMemory } = require('./server/marketMemory');

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
// For an uptime pinger (.github/workflows/keep-alive.yml, or an external
// monitor): answers before the maintenance gate and touches nothing - no
// database, no outside source - so pinging it every few minutes costs
// nothing beyond keeping the host from going to sleep.
app.get('/api/health', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ ok: true, uptimeSeconds: Math.round(process.uptime()) });
});
// The banner and maintenance mode (systemRoutes.js): ahead of every route,
// so maintenance answers 503 for all but admins and what they need to sign in.
const systemGate = createSystemGate();
app.use((req, res, next) => systemGate.middleware(req, res, next));
systemGate.mountStatus(app);
warnAboutConfiguration();

// Market data (outside providers' prices and figures) is for signed-in
// users only, at a per-user rate (marketDataAccess.js).
mountMarketDataGate(app);
mountQuotesRoutes(app);
mountCpiRoutes(app);
mountBenchmarkRoutes(app);
mountSectorRoutes(app);
mountAnalystRoutes(app);
mountDividendRoutes(app);
mountStockSearchRoutes(app);
mountHistoricalPricesRoutes(app);
// Feature flags (adminRoutes.js): an API whose feature is switched off
// answers 404. Starts on the defaults and reads the database once it is up.
const flagGate = createFlagGate();
app.use('/api/valuation', flagGate.require('valuation'));
app.use(['/api/alerts', '/api/alert-settings', '/api/calendar'], flagGate.require('alerts'));
// The last 10-year yield, kept for when its source is down; persisted once
// the database is up (attached after bootstrap below).
const referenceMemory = createReferenceMemory();
mountValuationRoutes(app, { valuation: createValuationService({ sources: createDefaultSources() }), dcfSnapshot: createDcfSnapshotService({ memory: referenceMemory }) });

const PORT = Number(process.env.PORT) || 5000;

bootstrapServices()
  .then(async ({ store, features, accounts, admin, marketData, runner }) => {
    sessionGuard.setStore(store, accounts);
    flagGate.attach(admin);
    systemGate.attach(admin);
    // Server errors are also kept for the admin panel, scrubbed (errorLog.js).
    installErrorCapture(admin);
    // The first admin(s): ADMIN_EMAILS names verified accounts to grant the
    // role to. Only ever adds; removing an address here does not revoke.
    const adminEmails = String(process.env.ADMIN_EMAILS || '').split(',').map((e) => e.trim()).filter(Boolean);
    if (adminEmails.length) {
      const r = await admin.bootstrapAdmins(adminEmails);
      if (r.granted.length) console.log(`Admin role granted: ${r.granted.join(', ')}`);
      if (r.skipped.length) console.warn(`ADMIN_EMAILS: no verified account for ${r.skipped.join(', ')} - sign up and verify, then restart`);
    }
    referenceMemory.attach(store.sql);
    // Last good quotes and Yahoo profiles, kept through restarts.
    marketMemory.attach(store.sql);
    const mailer = createEmailService();
    // Says at startup whether email works, in the log and in the admin
    // panel's server errors - rather than at the first sign-up whose
    // verification email silently never arrives.
    mailer
      .checkHealth()
      .then((problems) => {
        if (problems.length) problems.forEach((p) => console.error(`email/health ${p}`));
        else if (mailer.configured) console.log('email: credentials verified');
      })
      .catch((err) => console.error('email/health', err && err.message ? err.message : err));
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
    mountAdminRoutes(app, { admin, store, accounts, auth, features });
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
