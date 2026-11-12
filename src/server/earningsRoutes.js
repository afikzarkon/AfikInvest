// Ported from day-trader-skill (MIT, Jake Schincariol)
//
// Earnings as filed with the SEC (see earningsService.js):
//   GET /api/earnings/:symbol -> { symbol, name, cik, quarters, ttm, latest8k,
//                                  latestReport, staleNote, summary,
//                                  nextEarningsDate, secConfigured }
// US tickers only. Without SEC_USER_AGENT nothing is fetched and the answer
// is { secConfigured: false } with a message, never an invented contact.
const { requireAuth } = require('./requireAuth');
const { createRateLimiter } = require('./rateLimit');
const { createEarningsService } = require('./earningsService');
const { buildEarningsSummary } = require('../shared/earningsSummary');

// AAPL, BRK.B, BRK-B, BF.A - letters only, an optional share-class suffix.
const SYMBOL_RE = /^[A-Z]{1,5}([.-][A-Z]{1,2})?$/;
const NEXT_EARNINGS_TTL_MS = 6 * 60 * 60 * 1000;
const NEXT_EARNINGS_TIMEOUT_MS = 6000;

// Yahoo's announced (or estimated) next report date, through the same
// calendarEvents read the event calendar uses. Best effort: null on failure.
async function defaultNextEarningsDate(symbol) {
  const { fetchYahooCalendar } = require('./yahooQuotes');
  const { eventsFromYahooCalendar } = require('../shared/eventCalendar');
  const cal = await fetchYahooCalendar(symbol);
  const ev = eventsFromYahooCalendar(Object.assign({ symbol }, cal)).find((e) => e.eventType === 'EARNINGS');
  return ev ? { date: ev.eventDate, dateEnd: ev.eventDateEnd || null, status: ev.status } : null;
}

function mountEarningsRoutes(app, { service = createEarningsService(), getNextEarningsDate = defaultNextEarningsDate, now = () => new Date() } = {}) {
  const limiter = createRateLimiter({
    windowMs: 5 * 60 * 1000,
    max: 30,
    message: 'יותר מדי בקשות לנתוני דוחות, נסו שוב בעוד כמה דקות',
    keyFn: (req) => `earnings:${req.ip}`
  });
  const nextCache = new Map(); // symbol -> { at, value }

  async function nextEarnings(symbol) {
    if (!getNextEarningsDate) return null;
    const hit = nextCache.get(symbol);
    if (hit && Date.now() - hit.at < (hit.value ? NEXT_EARNINGS_TTL_MS : NEXT_EARNINGS_TTL_MS / 12)) return hit.value;
    let value = null;
    let timer = null;
    try {
      value = await Promise.race([
        Promise.resolve().then(() => getNextEarningsDate(symbol)),
        new Promise((resolve) => {
          timer = setTimeout(() => resolve(null), NEXT_EARNINGS_TIMEOUT_MS);
        })
      ]);
    } catch {
      value = null;
    } finally {
      clearTimeout(timer);
    }
    const today = now().toISOString().slice(0, 10);
    if (value && (value.dateEnd || value.date) < today) value = null; // a past report is not "next"
    nextCache.set(symbol, { at: Date.now(), value });
    if (nextCache.size > 500) nextCache.delete(nextCache.keys().next().value);
    return value;
  }

  app.get('/api/earnings/:symbol', requireAuth, limiter, async (req, res) => {
    const symbol = String(req.params.symbol || '').trim().toUpperCase();
    if (!SYMBOL_RE.test(symbol)) {
      return res.status(400).json({ error: 'סימול לא תקין. יש להזין סימול של מניה אמריקאית, למשל AAPL' });
    }
    if (!service.configured) {
      return res.json({
        symbol,
        secConfigured: false,
        quarters: [],
        ttm: null,
        latest8k: null,
        message: 'נתוני הדוחות מ-SEC אינם מוגדרים בשרת (חסר SEC_USER_AGENT).'
      });
    }
    try {
      const [r, next] = await Promise.all([service.getEarnings(symbol), nextEarnings(symbol)]);
      const body = {
        symbol,
        name: r.entity,
        cik: r.cik,
        quarters: r.rows,
        ttm: r.ttm,
        latest8k: r.filings ? r.filings.earnings8k : null,
        latestReport: r.filings ? r.filings.report : null,
        staleNote: r.staleNote || null,
        concepts: r.concepts,
        nextEarningsDate: next ? next.date : null,
        nextEarnings: next,
        secConfigured: true,
        source: 'SEC EDGAR XBRL company facts'
      };
      body.summary = buildEarningsSummary(body);
      return res.json(body);
    } catch (err) {
      if (err && err.code === 'NOT_FOUND') {
        return res.status(404).json({ error: `לא נמצאו דוחות ב-SEC עבור ${symbol} (ייתכן שזו קרן סל או חברה זרה שאינה מגישה XBRL)` });
      }
      if (err && err.code === 'NO_DATA') {
        return res.status(404).json({ error: `אין נתוני הכנסות או רווח רבעוניים בדוחות של ${symbol}` });
      }
      if (err && err.code === 'UPSTREAM') {
        return res.status(502).json({ error: 'מקור הנתונים של SEC אינו זמין כרגע, נסו שוב מאוחר יותר' });
      }
      console.error('[earnings] failed', err);
      return res.status(500).json({ error: 'שגיאת שרת' });
    }
  });
}

module.exports = { mountEarningsRoutes, SYMBOL_RE, defaultNextEarningsDate };
