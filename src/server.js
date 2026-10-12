// server.js
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const { bootstrapServices } = require('./server/bootstrap');
const { mountAuthRoutes } = require('./server/authRoutes');
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
const { mountMonthlySyncRoutes } = require('./server/monthlySyncRoutes');
const { mountValuationRoutes } = require('./server/valuationRoutes');
const { createValuationService, createDefaultSources } = require('./server/valuationService');

const app = express();
app.set('trust proxy', 1);
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '10mb' }));
app.use(cookieParser());

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
  .then(({ store, features, marketData, reports, runner }) => {
    mountAuthRoutes(app, store);
    mountPortfolioRoutes(app, store, { onSaved: (userId) => reports.onPortfolioSaved(userId) });
    mountSnapshotRoutes(app, store);
    mountMonthlySnapshotRoutes(app, store);
    mountRebalanceRoutes(app, store);
    mountTransactionRoutes(app, store, {
      onChanged: (userId, tx) => reports.onPortfolioSaved(userId, { months: tx && tx.date ? [tx.date.slice(0, 7)] : [] })
    });
    mountAlertRoutes(app, { store, features, marketData });
    mountInternalJobRoutes(app, { features, runner });
    mountPreferenceRoutes(app, { features });
    mountMonthlySyncRoutes(app, { reports, features });
    // Drains due jobs while the process is up; the external scheduler covers
    // the time the host is asleep. JOBS_POLL=0 turns the poller off - e.g.
    // when a separate worker (src/worker.js) runs the jobs instead.
    if (process.env.JOBS_POLL !== '0') runner.start();
    console.log(`DB: ${store.kind === 'postgres' ? 'PostgreSQL (DATABASE_URL)' : 'SQLite local file'}`);
    app.listen(PORT, () => {
      console.log(`StockView API http://localhost:${PORT}`);
    });
  })
  .catch((err) => {
    console.error('Failed to init database:', err);
    process.exit(1);
  });
