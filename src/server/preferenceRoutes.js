// Per-user preference documents, one per namespace:
//   GET /api/preferences/:namespace  -> { value }   (null when never saved)
//   PUT /api/preferences/:namespace  -> { value }
//
// Each namespace has a validator that keeps only known keys with sane
// values, so a client cannot store arbitrary data here.
const { requireAuth } = require('./requireAuth');

const RULE_IDS = ['drift', 'concentration', 'profit-taking', 'tax-loss-harvest', 'cash-drag'];

function numberIn(value, lo, hi, name) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < lo || n > hi) throw new Error(`${name} must be between ${lo} and ${hi}`);
  return n;
}

const VALIDATORS = {
  reports(input) {
    const src = input && typeof input === 'object' ? input : {};
    const out = {};
    if (src.emailOnReady !== undefined) out.emailOnReady = Boolean(src.emailOnReady);
    return out;
  },
  recommendations(input) {
    const src = input && typeof input === 'object' ? input : {};
    const out = {};
    if (src.driftAbsPp !== undefined) out.driftAbsPp = numberIn(src.driftAbsPp, 0.5, 50, 'driftAbsPp');
    if (src.driftRel !== undefined) out.driftRel = numberIn(src.driftRel, 0.05, 2, 'driftRel');
    if (src.positionCapPct !== undefined) out.positionCapPct = numberIn(src.positionCapPct, 1, 100, 'positionCapPct');
    if (src.profitTakePct !== undefined) out.profitTakePct = numberIn(src.profitTakePct, 1, 10000, 'profitTakePct');
    if (src.tlhMinLossILS !== undefined) out.tlhMinLossILS = numberIn(src.tlhMinLossILS, 0, 10000000, 'tlhMinLossILS');
    if (src.minTradeILS !== undefined) out.minTradeILS = numberIn(src.minTradeILS, 0, 10000000, 'minTradeILS');
    if (src.maxItems !== undefined) out.maxItems = Math.round(numberIn(src.maxItems, 1, 50, 'maxItems'));
    if (src.lotMethod !== undefined) {
      if (!['FIFO', 'LIFO', 'HIFO', 'SPECIFIC'].includes(src.lotMethod)) throw new Error('lotMethod must be FIFO, LIFO, HIFO or SPECIFIC');
      out.lotMethod = src.lotMethod;
    }
    if (src.usTaxResident !== undefined) out.usTaxResident = Boolean(src.usTaxResident);
    if (src.enabledRules !== undefined) {
      if (!Array.isArray(src.enabledRules) || src.enabledRules.some((r) => !RULE_IDS.includes(r))) {
        throw new Error(`enabledRules must be a subset of ${RULE_IDS.join(', ')}`);
      }
      out.enabledRules = [...new Set(src.enabledRules)];
    }
    return out;
  }
};

function mountPreferenceRoutes(app, { features }) {
  const lookup = (req, res) => {
    const validate = VALIDATORS[req.params.namespace];
    if (!validate) {
      res.status(404).json({ error: 'unknown preferences namespace' });
      return null;
    }
    return validate;
  };

  app.get('/api/preferences/:namespace', requireAuth, async (req, res) => {
    if (!lookup(req, res)) return undefined;
    try {
      return res.json({ value: await features.getPreferences(req.user.id, req.params.namespace) });
    } catch (err) {
      return res.status(500).json({ error: 'שגיאת שרת' });
    }
  });

  app.put('/api/preferences/:namespace', requireAuth, async (req, res) => {
    const validate = lookup(req, res);
    if (!validate) return undefined;
    let value;
    try {
      value = validate(req.body);
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
    try {
      await features.setPreferences(req.user.id, req.params.namespace, value);
      return res.json({ value });
    } catch (err) {
      return res.status(500).json({ error: 'שגיאת שרת' });
    }
  });
}

module.exports = { mountPreferenceRoutes, VALIDATORS };
