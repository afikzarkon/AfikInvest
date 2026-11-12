// Market scanner API (daily setups; the scan itself is the 'scanner.daily'
// job, see scannerJobs.js):
//   GET /api/scanner?setup=&minPrice=&minVolume=
//     -> { run, results, counts, total, filters }
//   run      the latest stored run's metadata (null before the first run)
//   results  its hits, filtered, each with held: true when the user holds it
//   counts   hits per setup after the price/volume filters (for the tabs)
const { requireAuth } = require('./requireAuth');
const { loadPortfolios, buildHoldingsIndex } = require('./holdingsIndex');
const { SETUP_KEYS, countBySetup } = require('./scannerService');

const normSymbol = (s) => String(s || '').trim().toUpperCase().replace(/-/g, '.');

function parseFloor(value) {
  if (value === undefined || value === null || value === '') return { ok: true, value: null };
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return { ok: false };
  return { ok: true, value: n };
}

async function heldSymbolsOf(store, userId) {
  const portfolios = await loadPortfolios(store, [userId]);
  const { byUser } = buildHoldingsIndex(portfolios);
  const mine = byUser.get(userId);
  const out = new Set();
  ((mine && mine.positions) || []).forEach((p) => {
    if (p.market === 'US') out.add(normSymbol(p.symbol));
  });
  return out;
}

function mountScannerRoutes(app, { store, scanner }) {
  app.get('/api/scanner', requireAuth, async (req, res) => {
    const setup = req.query.setup ? String(req.query.setup) : '';
    if (setup && !SETUP_KEYS.includes(setup)) return res.status(400).json({ error: 'סוג תבנית לא מוכר' });
    const minPrice = parseFloor(req.query.minPrice);
    const minVolume = parseFloor(req.query.minVolume);
    if (!minPrice.ok || !minVolume.ok) return res.status(400).json({ error: 'סינון מחיר או מחזור לא תקין' });
    try {
      const latest = await scanner.getLatestRun({ withResults: true });
      const filters = { setup: setup || null, minPrice: minPrice.value, minVolume: minVolume.value };
      if (!latest) {
        return res.json({ run: null, results: [], counts: countBySetup([]), total: 0, filters });
      }
      const held = await heldSymbolsOf(store, req.user.id);
      const floored = (latest.results || []).filter(
        (h) =>
          (minPrice.value === null || (h.close || 0) >= minPrice.value) &&
          (minVolume.value === null || (h.volume || 0) >= minVolume.value)
      );
      const results = floored
        .filter((h) => !setup || (h.setups || []).includes(setup))
        .map((h) => Object.assign({}, h, { held: held.has(normSymbol(h.symbol)) }));
      const { results: _omit, ...run } = latest;
      return res.json({ run, results, counts: countBySetup(floored), total: floored.length, filters });
    } catch (err) {
      console.error('[scanner] read failed', err);
      return res.status(500).json({ error: 'שגיאת שרת' });
    }
  });
}

module.exports = { mountScannerRoutes };
