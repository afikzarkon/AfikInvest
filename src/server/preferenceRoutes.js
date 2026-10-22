// Per-user preference documents, one per namespace:
//   GET /api/preferences/:namespace  -> { value }   (null when never saved)
//   PUT /api/preferences/:namespace  -> { value }
//
// Each namespace has a validator that keeps only known keys with sane
// values, so a client cannot store arbitrary data here.
const { requireAuth } = require('./requireAuth');

const RULE_IDS = ['drift', 'concentration', 'profit-taking', 'tax-loss-harvest', 'cash-drag'];

// holdingDetails: a key names one holding ("pension:<id>",
// "israeli:<number>", "american:<TICKER>", ...), and the asset classes are
// the ones utils/investmentIdeas.js weighs.
const HOLDING_KEY_PATTERN = /^[a-zA-Z]{2,24}:[^\s:]{1,64}$/;
const MAX_DETAIL_KEYS = 200;
const PROVIDENT_TRACK_KEYS = ['general', 'equity', 'sp500', 'bonds', 'moneyMarket', 'shariah', 'ageBased'];
const ASSET_CLASS_KEYS = ['equity', 'bond', 'deposit', 'realEstate', 'commodity', 'crypto', 'mixed', 'cash'];

function numberIn(value, lo, hi, name) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < lo || n > hi) throw new Error(`${name} must be between ${lo} and ${hi}`);
  return n;
}

const VALIDATORS = {
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
  },

  // Display: privacy mode hides money amounts across the site.
  display(input) {
    const src = input && typeof input === 'object' ? input : {};
    const out = {};
    if (src.hideAmounts !== undefined) out.hideAmounts = Boolean(src.hideAmounts);
    return out;
  },

  // Investment defaults: the currency headline totals are shown in, and the
  // broker fee the entry form starts a trade with.
  investments(input) {
    const src = input && typeof input === 'object' ? input : {};
    const out = {};
    if (src.mainCurrency !== undefined) {
      if (!['ILS', 'USD', 'EUR'].includes(src.mainCurrency)) throw new Error('mainCurrency must be ILS, USD or EUR');
      out.mainCurrency = src.mainCurrency;
    }
    if (src.defaultFeeIls !== undefined && src.defaultFeeIls !== null && src.defaultFeeIls !== '') {
      out.defaultFeeIls = numberIn(src.defaultFeeIls, 0, 10000, 'defaultFeeIls');
    }
    if (src.defaultFeeUsd !== undefined && src.defaultFeeUsd !== null && src.defaultFeeUsd !== '') {
      out.defaultFeeUsd = numberIn(src.defaultFeeUsd, 0, 10000, 'defaultFeeUsd');
    }
    return out;
  },

  // The portfolio review's goal (utils/portfolioReview.js): an amount to
  // reach by a date. An empty body clears it.
  goals(input) {
    const src = input && typeof input === 'object' ? input : {};
    const out = {};
    // The horizon and risk tolerance the user declares stand on their own;
    // a goal amount is not needed for them.
    if (src.horizonYears !== undefined && src.horizonYears !== null && src.horizonYears !== '') {
      out.horizonYears = numberIn(src.horizonYears, 0.5, 60, 'horizonYears');
    }
    if (src.riskTolerance !== undefined && src.riskTolerance !== null && src.riskTolerance !== '') {
      if (!['low', 'medium', 'high'].includes(src.riskTolerance)) throw new Error('riskTolerance must be low, medium or high');
      out.riskTolerance = src.riskTolerance;
    }
    if (src.targetAmount === undefined && src.targetDate === undefined) return out;
    out.targetAmount = numberIn(src.targetAmount, 1, 1000000000, 'targetAmount');
    const date = String(src.targetDate || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`))) {
      throw new Error('targetDate must be YYYY-MM-DD');
    }
    out.targetDate = date;
    if (src.label !== undefined && src.label !== null && src.label !== '') out.label = String(src.label).slice(0, 60);
    return out;
  },

  // Details about the user's holdings that the portfolio review reads and
  // the holdings themselves do not carry, keyed by holding
  // ("pension:<id>", "israeli:<number>", "american:<TICKER>", ...).
  holdingDetails(input) {
    const src = input && typeof input === 'object' ? input : {};
    const out = {};
    const entries = (obj, name) => {
      if (obj === undefined || obj === null) return [];
      if (typeof obj !== 'object' || Array.isArray(obj)) throw new Error(`${name} must be an object`);
      const list = Object.entries(obj);
      if (list.length > MAX_DETAIL_KEYS) throw new Error(`${name} has too many entries`);
      list.forEach(([key]) => {
        if (!HOLDING_KEY_PATTERN.test(key)) throw new Error(`${name} has an invalid key`);
      });
      return list;
    };
    const tracks = entries(src.providentTracks, 'providentTracks');
    if (tracks.length) {
      out.providentTracks = {};
      tracks.forEach(([key, value]) => {
        if (!PROVIDENT_TRACK_KEYS.includes(value)) throw new Error(`providentTracks values must be one of ${PROVIDENT_TRACK_KEYS.join(', ')}`);
        out.providentTracks[key] = value;
      });
    }
    const fees = entries(src.fees, 'fees');
    if (fees.length) {
      out.fees = {};
      fees.forEach(([key, value]) => {
        const v = value && typeof value === 'object' ? value : {};
        const fee = {};
        if (v.annualPct !== undefined && v.annualPct !== null && v.annualPct !== '') fee.annualPct = numberIn(v.annualPct, 0, 5, 'annualPct');
        if (v.depositPct !== undefined && v.depositPct !== null && v.depositPct !== '') fee.depositPct = numberIn(v.depositPct, 0, 10, 'depositPct');
        if (Object.keys(fee).length) out.fees[key] = fee;
      });
    }
    const brokers = entries(src.brokers, 'brokers');
    if (brokers.length) {
      out.brokers = {};
      brokers.forEach(([key, value]) => {
        const name = String(value || '').trim().slice(0, 40);
        if (name) out.brokers[key] = name;
      });
    }
    const classes = entries(src.assetClasses, 'assetClasses');
    if (classes.length) {
      out.assetClasses = {};
      classes.forEach(([key, value]) => {
        if (!ASSET_CLASS_KEYS.includes(value)) throw new Error(`assetClasses values must be one of ${ASSET_CLASS_KEYS.join(', ')}`);
        out.assetClasses[key] = value;
      });
    }
    return out;
  },

  // Which emails to receive (see emailPreferences.js).
  notifications(input) {
    const { normalizePreferences } = require('./emailPreferences');
    return normalizePreferences(input);
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
