// Ported from day-trader-skill (MIT, Jake Schincariol)
//
// Congress stock trades API (per user; the data itself is public and shared):
//   GET  /api/congress?member=&ticker=&days=90
//        -> { filings, heldTickers, lastScanAt, days }
//           filings: House PTRs filed in the last `days` days, newest first,
//           each with its parsed transaction rows (read from the DB, which
//           the 'congress.scan' job fills - never scraped per request).
//           heldTickers: tickers in those filings that the user holds.
//   POST /api/congress/refresh -> run a scan now (1 per 30 minutes per user)
const { requireAuth } = require('./requireAuth');
const { createRateLimiter } = require('./rateLimit');
const { buildHoldingsIndex, loadPortfolios } = require('./holdingsIndex');
const { runCongressScan, normTicker, createDefaultFetchers } = require('./congressService');

const DAY_MS = 86400000;

function memberFilter(filing, q) {
  if (!q) return true;
  const hay = `${filing.memberName} ${filing.firstName} ${filing.lastName} ${filing.stateDistrict}`.toLowerCase();
  return q
    .toLowerCase()
    .split(/[\s,]+/)
    .filter(Boolean)
    .every((word) => hay.includes(word));
}

const publicFiling = (f) => ({
  docId: f.docId,
  memberName: f.memberName,
  stateDistrict: f.stateDistrict,
  filedDate: f.filedDate,
  pdfUrl: f.pdfUrl,
  parseStatus: f.parseStatus,
  // pending: not read yet; no_text: a scanned image; error: could not be read.
  needsManualRead: f.parseStatus !== 'parsed' || !f.rows.length,
  rows: f.rows
});

function mountCongressRoutes(app, { store, congress, features, fetchers = null, now = () => new Date(), scanOptions = {} }) {
  const refreshLimiter = createRateLimiter({
    windowMs: 30 * 60 * 1000,
    max: 1,
    message: 'אפשר לרענן את דיווחי הקונגרס פעם ב-30 דקות',
    keyFn: (req) => `congress-refresh:${req.user.id}`
  });

  app.get('/api/congress', requireAuth, async (req, res) => {
    const daysRaw = Number(req.query.days);
    const days = Number.isFinite(daysRaw) && daysRaw >= 1 ? Math.min(Math.floor(daysRaw), 365) : 90;
    const member = String(req.query.member || '').trim().slice(0, 80);
    const ticker = normTicker(String(req.query.ticker || '').slice(0, 12));
    try {
      const since = new Date(now().getTime() - days * DAY_MS).toISOString().slice(0, 10);
      const stored = await congress.listFilings({ since, limit: 500 });
      const filings = stored
        .filter((f) => memberFilter(f, member))
        .filter((f) => !ticker || f.rows.some((r) => r.ticker && normTicker(r.ticker) === ticker))
        .map(publicFiling);

      const { byUser } = buildHoldingsIndex(await loadPortfolios(store, [req.user.id]));
      const mine = byUser.get(req.user.id);
      const heldSymbols = new Map(((mine && mine.positions) || []).filter((p) => p.market === 'US').map((p) => [normTicker(p.symbol), p]));
      const held = new Map();
      filings.forEach((f) => {
        f.rows.forEach((r) => {
          const key = r.ticker && normTicker(r.ticker);
          if (!key || !heldSymbols.has(key)) return;
          const entry = held.get(key) || { ticker: heldSymbols.get(key).symbol, name: heldSymbols.get(key).name || r.asset, trades: 0, lastTradeDate: null, members: [] };
          entry.trades += 1;
          if (!entry.lastTradeDate || (r.date && r.date > entry.lastTradeDate)) entry.lastTradeDate = r.date;
          if (!entry.members.includes(f.memberName)) entry.members.push(f.memberName);
          held.set(key, entry);
        });
      });

      return res.json({
        filings,
        heldTickers: [...held.values()].sort((a, b) => b.trades - a.trades || a.ticker.localeCompare(b.ticker)),
        lastScanAt: await congress.getMeta('last-scan-at'),
        days
      });
    } catch (err) {
      console.error('[congress] list failed', err);
      return res.status(500).json({ error: 'שגיאת שרת' });
    }
  });

  app.post('/api/congress/refresh', requireAuth, refreshLimiter, async (req, res) => {
    try {
      // A smaller batch than the scheduled job so the request returns quickly.
      const scan = await runCongressScan(
        Object.assign(
          { store, features, congress, fetchers: fetchers || createDefaultFetchers(), now: now(), maxParse: 5 },
          scanOptions
        )
      );
      return res.json({ scan });
    } catch (err) {
      console.error('[congress] refresh failed', err);
      return res.status(500).json({ error: 'שגיאת שרת' });
    }
  });
}

module.exports = { mountCongressRoutes };
