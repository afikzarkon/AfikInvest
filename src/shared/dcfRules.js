// From raw company data to DCF inputs, by rules anyone can redo by hand,
// and the "input card" that carries a valuation out of the site.
//
// Two modes, one engine (dcfEngine.runDcf):
//   auto   - every input derived from a dated, sourced data snapshot by the
//            rules below (constants in DEFAULT_RULES, which is shown and
//            editable). Nothing is capped, floored or tuned.
//   manual - the user's own numbers per year (AVGO_PRESET: DCF_METHOD.md).
//
// AUTO RULES
//   TTM            sum of the last four quarters (revenue, FCF = operating
//                  cash flow - capex, SBC, net income) - not the last
//                  fiscal year
//   rev0           consensus revenue for the current fiscal year (0y);
//                  missing -> TTM revenue, flagged
//   growth[1]      consensus next year (+1y) / rev0 - 1; missing -> TTM
//                  against the TTM before it, flagged; that missing too
//                  -> the last fiscal year against the one before, flagged
//   growth[t]      gT + (growth[t-1] - gT) * k            t = 2..5
//   fcfMargin[t]   fcfMarginTTM * (1 - marginStep * t)    t = 1..5
//   sbcPct[t]      sbcPctTTM * (1 - sbcStep * t)          t = 1..5; always deducted
//   beta           betaWeight * beta_raw + betaConst      (raw shown too)
//   rf             latest 10-year US Treasury yield, dated
//   shares         diluted: weighted average, last quarter; basic: actual,
//                  last report
//   debt           current + long-term debt, WITHOUT lease liabilities;
//                  cash: cash and cash equivalents only
//   scenarios      bear: growth * 0.6, margins - 4 points; bull: growth *
//                  1.15, margins + 2 points (DEFAULT_RULES.scenarios)
//   terminal       Gordon with gT; WACC <= gT is an error, not a number
//
// A missing figure is never filled in silently: the defined fallback is
// used and a flag says so; with no fallback there is no value.
//
// CommonJS without object/array spread - see sharedModules.test.js.

const engine = require('./dcfEngine');

const CARD_VERSION = 1;

const DEFAULT_RULES = {
  years: 5,
  fadeK: 0.5,
  gT: 0.035,
  marginStep: 0.02,
  sbcStep: 0.1,
  betaWeight: 0.67,
  betaConst: 0.33,
  erp: 0.045,
  kd: 0.055,
  tax: 0.15,
  deductSbc: true,
  scenarios: {
    bear: { growthMult: 0.6, marginShift: -0.04 },
    base: { growthMult: 1, marginShift: 0 },
    bull: { growthMult: 1.15, marginShift: 0.02 }
  },
  weights: { bear: 0.25, base: 0.5, bull: 0.25 },
  labelBand: 0.15,
  warn: { tvShareAbove: 0.8, exitBelow: 8, exitAbove: 40, staleDays: 7 },
  // Used only when the figure is missing, and always flagged.
  fallback: { betaRaw: 1, rf: 0.045 }
};

const SCENARIO_LABELS = { bear: 'שמרני', base: 'בסיס', bull: 'אופטימי', conservative: 'שמרני', management: 'יעדי הנהלה' };

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const merge = (a, b) => Object.assign({}, a, b);
const range = (n) => Array.from({ length: n }, (_, i) => i + 1);

// ---------------------------------------------------------------------------
// The rules as small functions, each checked against hand-computed vectors.

function fadeGrowth(g1, gT, k, years) {
  const out = [g1];
  for (let t = 2; t <= (years || 5); t += 1) out.push(gT + (out[t - 2] - gT) * k);
  return out;
}

function marginSchedule(ttmMargin, step, years) {
  return range(years || 5).map((t) => ttmMargin * (1 - step * t));
}

function sbcSchedule(ttmSbcPct, step, years) {
  return range(years || 5).map((t) => ttmSbcPct * (1 - step * t));
}

function adjustBeta(raw, weight, constant) {
  return weight * raw + constant;
}

// ---------------------------------------------------------------------------
// Snapshot -> derived figures

const lastN = (rows, n) => rows.slice(Math.max(0, rows.length - n));

// Sum of a field over the last four quarters, or null unless all four have it.
function ttmOf(quarters, field, offset) {
  const end = quarters.length - (offset || 0);
  if (end < 4) return null;
  const four = quarters.slice(end - 4, end);
  if (!four.every((q) => isNum(q[field]))) return null;
  return four.reduce((s, q) => s + q[field], 0);
}

const fcfOfRow = (row) => (isNum(row.operatingCashFlow) && isNum(row.capex) ? row.operatingCashFlow - Math.abs(row.capex) : null);

function latestWith(rows, field) {
  for (let i = rows.length - 1; i >= 0; i -= 1) if (isNum(rows[i][field])) return rows[i];
  return null;
}

const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);

// Banks, insurers and REITs are valued on other bases (book value, payout),
// and a negative trailing FCF gives the model nothing to grow.
function unsuitableReason(snapshot, fcfTtm) {
  const profile = snapshot.profile || {};
  const industry = String(profile.industry || '');
  if (/bank/i.test(industry)) return 'בנק - מודל DCF על תזרים חופשי אינו מתאים לבנקים';
  if (/insurance/i.test(industry)) return 'חברת ביטוח - מודל DCF על תזרים חופשי אינו מתאים לחברות ביטוח';
  if (/reit/i.test(industry)) return 'קרן ריט (REIT) - מודל DCF על תזרים חופשי אינו מתאים';
  if (snapshot.currency && snapshot.financialCurrency && snapshot.currency !== snapshot.financialCurrency) {
    return `הדוחות במטבע ${snapshot.financialCurrency} והמחיר ב-${snapshot.currency} - השוואה בין השווי למחיר לא תהיה במטבע אחד`;
  }
  if (isNum(fcfTtm) && fcfTtm <= 0) return 'תזרים מזומנים חופשי שלילי ב-12 החודשים האחרונים - אין בסיס חיובי לצמיחה';
  return null;
}

// Every figure the auto model uses, with where it came from. Each entry:
// { value, basis, fallback } - fallback true when the primary source was
// missing and the defined fallback was used (and `flags` says so).
function deriveAuto(snapshot, rules) {
  const R = rules || DEFAULT_RULES;
  const quarters = snapshot.quarters || [];
  const annual = snapshot.annual || [];
  const flags = [];
  const missing = [];
  const d = {};
  const lastQ = quarters.length ? quarters[quarters.length - 1] : null;
  const lastFy = annual.length ? annual[annual.length - 1] : null;
  const prevFy = annual.length > 1 ? annual[annual.length - 2] : null;
  const ttmLabel = (q) => (q.length ? `4 הרבעונים שהסתיימו ב-${q[q.length - 1].periodEnd}` : '');
  const four = lastN(quarters, 4);

  // TTM figures, the last fiscal year as the defined fallback.
  const withFcf = quarters.map((q) => merge(q, { fcf: fcfOfRow(q) }));
  const ttmField = (field, label) => {
    const v = ttmOf(withFcf, field, 0);
    if (isNum(v)) return { value: v, basis: `TTM - ${ttmLabel(four)}`, fallback: false };
    const fy = field === 'fcf' ? (lastFy ? fcfOfRow(lastFy) : null) : lastFy && lastFy[field];
    if (isNum(fy)) {
      flags.push(`${label}: אין 4 רבעונים מלאים - נעשה שימוש בשנת הכספים ${lastFy.periodEnd}`);
      return { value: fy, basis: `שנת כספים ${lastFy.periodEnd} (חלופה)`, fallback: true };
    }
    missing.push(label);
    return { value: null, basis: 'חסר', fallback: true };
  };
  d.revenueTtm = ttmField('revenue', 'הכנסות 12 חודשים');
  d.fcfTtm = ttmField('fcf', 'תזרים חופשי 12 חודשים');
  d.sbcTtm = ttmField('sbc', 'SBC 12 חודשים');
  d.netIncomeTtm = ttmField('netIncome', 'רווח נקי 12 חודשים');
  if (!isNum(d.sbcTtm.value) && isNum(d.revenueTtm.value)) {
    flags.push('SBC לא דווח - לא הופחת דבר (הניחו 0)');
    d.sbcTtm = { value: 0, basis: 'חסר - 0', fallback: true };
  }

  d.fcfMarginTtm = { value: isNum(d.fcfTtm.value) && d.revenueTtm.value > 0 ? d.fcfTtm.value / d.revenueTtm.value : null, basis: 'FCF TTM / הכנסות TTM', fallback: d.fcfTtm.fallback || d.revenueTtm.fallback };
  d.sbcPctTtm = { value: isNum(d.sbcTtm.value) && d.revenueTtm.value > 0 ? d.sbcTtm.value / d.revenueTtm.value : null, basis: 'SBC TTM / הכנסות TTM', fallback: d.sbcTtm.fallback };

  // rev0 and the first year's growth.
  const c = snapshot.consensus || {};
  const rev0y = c.rev0y && isNum(c.rev0y.value) ? c.rev0y : null;
  const rev1y = c.rev1y && isNum(c.rev1y.value) ? c.rev1y : null;
  if (rev0y) d.rev0 = { value: rev0y.value, basis: `קונצנזוס שנה נוכחית (0y, ${rev0y.periodEnd || ''}, ${rev0y.analysts || '?'} אנליסטים)`, fallback: false };
  else {
    flags.push('אין קונצנזוס הכנסות לשנה הנוכחית - הבסיס הוא הכנסות 12 החודשים האחרונים');
    d.rev0 = { value: d.revenueTtm.value, basis: 'הכנסות TTM (חלופה)', fallback: true };
  }
  if (rev1y && isNum(d.rev0.value) && d.rev0.value > 0) {
    d.growth1 = { value: rev1y.value / d.rev0.value - 1, basis: `קונצנזוס שנה הבאה (+1y, ${rev1y.periodEnd || ''}) / בסיס - 1`, fallback: false };
  } else {
    const prior = ttmOf(quarters, 'revenue', 4);
    if (isNum(prior) && prior > 0 && isNum(d.revenueTtm.value) && !d.revenueTtm.fallback) {
      flags.push('אין קונצנזוס לשנה הבאה - צמיחת השנה הראשונה היא TTM מול TTM קודם');
      d.growth1 = { value: d.revenueTtm.value / prior - 1, basis: 'הכנסות TTM / TTM קודם - 1 (חלופה)', fallback: true };
    } else if (lastFy && prevFy && isNum(lastFy.revenue) && prevFy.revenue > 0) {
      flags.push(`אין קונצנזוס לשנה הבאה ואין 8 רבעונים - צמיחת השנה הראשונה היא שנת ${lastFy.periodEnd} מול השנה שלפניה`);
      d.growth1 = { value: lastFy.revenue / prevFy.revenue - 1, basis: `הכנסות שנת ${lastFy.periodEnd} / שנה קודמת - 1 (חלופה שנייה)`, fallback: true };
    } else {
      missing.push('צמיחת השנה הראשונה');
      d.growth1 = { value: null, basis: 'חסר', fallback: true };
    }
  }

  // Discount-rate inputs.
  if (snapshot.betaRaw && isNum(snapshot.betaRaw.value)) d.betaRaw = { value: snapshot.betaRaw.value, basis: snapshot.betaRaw.source || 'Yahoo', fallback: false };
  else {
    flags.push(`בטא חסרה - נעשה שימוש ב-${R.fallback.betaRaw} (בטא השוק)`);
    d.betaRaw = { value: R.fallback.betaRaw, basis: 'חסר - בטא שוק (חלופה)', fallback: true };
  }
  d.beta = { value: adjustBeta(d.betaRaw.value, R.betaWeight, R.betaConst), basis: `${R.betaWeight} × בטא גולמית + ${R.betaConst}`, fallback: d.betaRaw.fallback };
  if (snapshot.rf && isNum(snapshot.rf.value)) d.rf = { value: snapshot.rf.value, basis: `${snapshot.rf.source || 'אג"ח ארה"ב 10 שנים'}, ${snapshot.rf.asOf || ''}`, fallback: false };
  else {
    flags.push(`תשואת האג"ח ל-10 שנים חסרה - נעשה שימוש ב-${(R.fallback.rf * 100).toFixed(1)}%`);
    d.rf = { value: R.fallback.rf, basis: 'חסר - ערך חלופי מההגדרות', fallback: true };
  }

  // Shares, debt, cash - from the latest quarter that reports each.
  const qDil = latestWith(quarters, 'dilutedShares');
  const qBasic = latestWith(quarters, 'basicShares');
  if (qBasic) d.basicShares = { value: qBasic.basicShares, basis: `מניות בפועל, דוח ${qBasic.periodEnd}`, fallback: false };
  else if (isNum(snapshot.sharesOutstanding)) {
    flags.push('מספר מניות בסיסי חסר בדוח - נלקח מנתוני הציטוט');
    d.basicShares = { value: snapshot.sharesOutstanding, basis: 'נתוני ציטוט (חלופה)', fallback: true };
  } else {
    missing.push('מספר מניות בסיסי');
    d.basicShares = { value: null, basis: 'חסר', fallback: true };
  }
  if (qDil) d.dilutedShares = { value: qDil.dilutedShares, basis: `ממוצע משוקלל מדולל, רבעון ${qDil.periodEnd}`, fallback: false };
  else if (isNum(d.basicShares.value)) {
    flags.push('מספר מניות מדולל חסר - נעשה שימוש במספר הבסיסי');
    d.dilutedShares = { value: d.basicShares.value, basis: 'מספר בסיסי (חלופה)', fallback: true };
  } else {
    missing.push('מספר מניות מדולל');
    d.dilutedShares = { value: null, basis: 'חסר', fallback: true };
  }
  const debtPart = (field, label) => {
    if (lastQ && isNum(lastQ[field])) return { value: lastQ[field], fallback: false };
    flags.push(`${label} לא דווח ברבעון האחרון - נספר כ-0`);
    return { value: 0, fallback: true };
  };
  const cur = debtPart('currentDebt', 'חוב לזמן קצר');
  const lng = debtPart('longTermDebt', 'חוב לזמן ארוך');
  d.debt = { value: cur.value + lng.value, basis: `חוב קצר + חוב ארוך, ${lastQ ? lastQ.periodEnd : '-'}, בלי התחייבויות חכירה`, fallback: cur.fallback || lng.fallback, parts: { current: cur.value, longTerm: lng.value } };
  if (lastQ && isNum(lastQ.cash)) d.cash = { value: lastQ.cash, basis: `מזומן ושווי מזומן בלבד, ${lastQ.periodEnd}`, fallback: false };
  else {
    flags.push('מזומן לא דווח ברבעון האחרון - נספר כ-0');
    d.cash = { value: 0, basis: 'חסר - 0', fallback: true };
  }

  return { derived: d, flags, missing };
}

// The three auto scenarios, per year.
function autoScenarios(derived, rules) {
  const R = rules || DEFAULT_RULES;
  const g = fadeGrowth(derived.growth1.value, R.gT, R.fadeK, R.years);
  const m = marginSchedule(derived.fcfMarginTtm.value, R.marginStep, R.years);
  const s = sbcSchedule(derived.sbcPctTtm.value, R.sbcStep, R.years);
  return ['bear', 'base', 'bull'].map((key) => {
    const sc = R.scenarios[key];
    return {
      key,
      label: SCENARIO_LABELS[key],
      growth: g.map((x) => x * sc.growthMult),
      fcfMargin: m.map((x) => x + sc.marginShift),
      sbcPct: s.slice()
    };
  });
}

// ---------------------------------------------------------------------------
// One evaluation, either mode: the model (shared inputs + scenarios), every
// scenario's result, the base case's IRR, sensitivity and warnings.
//
// args: { mode: 'auto' | 'manual', snapshot, rules, manual, valuationDate }
//   manual: { base: { price, basicShares, dilutedShares, cash, debt, rev0,
//             rf, beta, betaRaw?, erp, kd, tax, gT, deductSbc,
//             waccOverride? }, scenarios: [{ key, label, growth,
//             fcfMargin, sbcPct }], weights }
function evaluateDcf(args) {
  const mode = args.mode === 'manual' ? 'manual' : 'auto';
  const R = args.rules || DEFAULT_RULES;
  const valuationDate = args.valuationDate || new Date().toISOString().slice(0, 10);
  const out = { mode, valuationDate, rules: R, engineVersion: engine.ENGINE_VERSION, flags: [], missing: [], warnings: [], unsuitable: null };

  let model;
  if (mode === 'manual') {
    model = args.manual;
  } else {
    const snap = args.snapshot || {};
    const dv = deriveAuto(snap, R);
    out.derived = dv.derived;
    out.flags = dv.flags;
    out.missing = dv.missing;
    out.unsuitable = unsuitableReason(snap, dv.derived.fcfTtm.value);
    if (!snap.price || !isNum(snap.price.value)) out.missing.push('מחיר');
    if (out.unsuitable || out.missing.length) return out;
    const d = dv.derived;
    model = {
      base: {
        price: snap.price.value,
        basicShares: d.basicShares.value,
        dilutedShares: d.dilutedShares.value,
        cash: d.cash.value,
        debt: d.debt.value,
        rev0: d.rev0.value,
        rf: d.rf.value,
        betaRaw: d.betaRaw.value,
        beta: d.beta.value,
        erp: R.erp,
        kd: R.kd,
        tax: R.tax,
        gT: R.gT,
        deductSbc: R.deductSbc
      },
      scenarios: autoScenarios(d, R),
      weights: R.weights
    };
  }
  out.model = model;

  const run = engine.runScenarios(model.base, model.scenarios, model.weights);
  out.results = run.results;
  out.weighted = run.weighted;
  const baseKey = model.scenarios.some((s) => s.key === 'base') ? 'base' : model.scenarios[0].key;
  out.baseKey = baseKey;
  const baseScenario = model.scenarios.filter((s) => s.key === baseKey)[0];
  const baseInputs = merge(model.base, { growth: baseScenario.growth, fcfMargin: baseScenario.fcfMargin, sbcPct: baseScenario.sbcPct });
  const main = run.results[baseKey];
  out.main = main;
  if (!main.ok) return out;

  out.irr = engine.impliedReturn(baseInputs);
  out.sensitivity = engine.sensitivity(baseInputs);
  out.labels = {};
  Object.keys(run.results).forEach((k) => {
    out.labels[k] = run.results[k].ok ? engine.valueLabel(run.results[k].upside, R.labelBand) : 'N/A';
  });

  // Warnings: the number stands, and these say how far to trust it.
  const W = R.warn;
  if (main.tvShare > W.tvShareAbove) out.warnings.push(`${Math.round(main.tvShare * 100)}% מהשווי מגיע מהערך הסופי (מעל ${Math.round(W.tvShareAbove * 100)}%) - התוצאה רגישה מאוד להנחות לטווח ארוך`);
  if (isNum(main.impliedExit) && (main.impliedExit < W.exitBelow || main.impliedExit > W.exitAbove)) {
    out.warnings.push(`מכפיל היציאה המשתמע הוא ${main.impliedExit.toFixed(1)}x - מחוץ לטווח הסביר ${W.exitBelow}x-${W.exitAbove}x`);
  }
  if (mode === 'auto') {
    const snap = args.snapshot;
    const c = snap.consensus || {};
    if (!(c.rev0y && isNum(c.rev0y.value)) || !(c.rev1y && isNum(c.rev1y.value))) out.warnings.push('חסר נתון קונצנזוס אנליסטים - חלק מהקלטים מבוססים על חלופה (ראו סימונים)');
    [
      ['מחיר', snap.price],
      ['תשואת אג"ח', snap.rf],
      ['קונצנזוס', c.asOf ? { asOf: c.asOf } : null],
      ['בטא', snap.betaRaw]
    ].forEach((pair) => {
      const asOf = pair[1] && pair[1].asOf;
      if (asOf && daysBetween(asOf, valuationDate) > W.staleDays) out.warnings.push(`${pair[0]}: הנתון מ-${asOf}, יותר מ-${W.staleDays} ימים לפני תאריך ההערכה`);
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// The input card: everything needed to redo the valuation offline.

function buildInputCard(evaluation, snapshot, ticker) {
  const e = evaluation;
  const m = e.model;
  const scenarioResults = {};
  if (e.results) {
    Object.keys(e.results).forEach((k) => {
      const r = e.results[k];
      scenarioResults[k] = r.ok
        ? { perShare: r.perShare, upside: r.upside, marginOfSafety: r.marginOfSafety, label: e.labels ? e.labels[k] : null, tvShare: r.tvShare, impliedExit: r.impliedExit, ev: r.ev, equity: r.equity }
        : { error: r.errors };
    });
  }
  return {
    cardVersion: CARD_VERSION,
    engineVersion: e.engineVersion,
    ticker: ticker || (snapshot && snapshot.ticker) || null,
    valuationDate: e.valuationDate,
    mode: e.mode,
    price: m ? m.base.price : snapshot && snapshot.price ? snapshot.price.value : null,
    priceAsOf: snapshot && snapshot.price ? snapshot.price.asOf : null,
    currency: snapshot ? snapshot.financialCurrency || snapshot.currency || null : null,
    // The raw data exactly as fetched, each figure with its source and date.
    raw: snapshot || null,
    rules: e.rules,
    derived: e.derived || null,
    flags: e.flags,
    missing: e.missing,
    unsuitable: e.unsuitable,
    // The engine's inputs - enough to rerun runDcf with nothing else.
    inputs: m
      ? {
          rf: m.base.rf,
          beta_raw: isNum(m.base.betaRaw) ? m.base.betaRaw : null,
          beta: m.base.beta,
          erp: m.base.erp,
          kd: m.base.kd,
          tax: m.base.tax,
          gT: m.base.gT,
          waccOverride: isNum(m.base.waccOverride) ? m.base.waccOverride : null,
          basicShares: m.base.basicShares,
          dilutedShares: m.base.dilutedShares,
          debt: m.base.debt,
          debtNote: 'חוב קצר + חוב ארוך, ללא התחייבויות חכירה',
          cash: m.base.cash,
          cashNote: 'מזומן ושווי מזומן בלבד',
          rev0: m.base.rev0,
          price: m.base.price,
          deductSbc: m.base.deductSbc !== false,
          scenarios: m.scenarios.map((s) => ({ key: s.key, label: s.label, growth: s.growth, fcfMargin: s.fcfMargin, sbcPct: s.sbcPct })),
          weights: m.weights
        }
      : null,
    results: e.main && e.main.ok
      ? {
          wacc: e.main.wacc,
          ke: e.main.ke,
          wE: e.main.wE,
          baseScenario: e.baseKey,
          scenarios: scenarioResults,
          weighted: e.weighted,
          tvShare: e.main.tvShare,
          impliedExit: e.main.impliedExit,
          irr: e.irr
        }
      : { error: (e.main && e.main.errors) || e.missing },
    warnings: e.warnings
  };
}

// Rebuilds the model from a card alone and reruns the engine - no network.
// Returns the fresh evaluation; compare its numbers with card.results.
function reproduceFromCard(card) {
  const i = card.inputs;
  const manual = {
    base: {
      price: i.price,
      basicShares: i.basicShares,
      dilutedShares: i.dilutedShares,
      cash: i.cash,
      debt: i.debt,
      rev0: i.rev0,
      rf: i.rf,
      betaRaw: i.beta_raw,
      beta: i.beta,
      erp: i.erp,
      kd: i.kd,
      tax: i.tax,
      gT: i.gT,
      deductSbc: i.deductSbc,
      waccOverride: i.waccOverride
    },
    scenarios: i.scenarios,
    weights: i.weights
  };
  const fromInputs = evaluateDcf({ mode: 'manual', manual, rules: card.rules, valuationDate: card.valuationDate });
  // In auto mode, the inputs must also follow from the raw data by the rules.
  const fromRaw = card.mode === 'auto' && card.raw ? evaluateDcf({ mode: 'auto', snapshot: card.raw, rules: card.rules, valuationDate: card.valuationDate }) : null;
  return { fromInputs, fromRaw };
}

// ---------------------------------------------------------------------------
// The manual preset: DCF_METHOD.md's AVGO table (18.10.2026).

const B = 1e9;
const M = 1e6;
const AVGO_PRESET = {
  ticker: 'AVGO',
  asOf: '2026-10-18',
  source: 'DCF_METHOD.md',
  base: {
    price: 328.75,
    basicShares: 4773.6 * M,
    dilutedShares: 4887 * M,
    cash: 24.0 * B,
    debt: 59.419 * B,
    rev0: 105.889 * B,
    rf: 0.052,
    beta: 1.4,
    erp: 0.045,
    kd: 0.055,
    tax: 0.15,
    gT: 0.035,
    deductSbc: true
  },
  scenarios: [
    { key: 'conservative', label: 'שמרני', growth: [0.5, 0.1, -0.05, 0.02, 0.03], fcfMargin: [0.4, 0.38, 0.36, 0.35, 0.35], sbcPct: [0.05, 0.05, 0.05, 0.05, 0.05] },
    { key: 'base', label: 'בסיס', growth: [0.63, 0.33, 0.15, 0.1, 0.07], fcfMargin: [0.43, 0.42, 0.41, 0.4, 0.4], sbcPct: [0.05, 0.05, 0.05, 0.05, 0.05] },
    { key: 'management', label: 'יעדי הנהלה', growth: [0.65, 0.63, 0.2, 0.12, 0.08], fcfMargin: [0.45, 0.44, 0.43, 0.42, 0.42], sbcPct: [0.05, 0.05, 0.05, 0.05, 0.05] }
  ],
  weights: { conservative: 0.25, base: 0.5, management: 0.25 }
};

exports.CARD_VERSION = CARD_VERSION;
exports.DEFAULT_RULES = DEFAULT_RULES;
exports.SCENARIO_LABELS = SCENARIO_LABELS;
exports.AVGO_PRESET = AVGO_PRESET;
exports.fadeGrowth = fadeGrowth;
exports.marginSchedule = marginSchedule;
exports.sbcSchedule = sbcSchedule;
exports.adjustBeta = adjustBeta;
exports.ttmOf = ttmOf;
exports.deriveAuto = deriveAuto;
exports.unsuitableReason = unsuitableReason;
exports.autoScenarios = autoScenarios;
exports.evaluateDcf = evaluateDcf;
exports.buildInputCard = buildInputCard;
exports.reproduceFromCard = reproduceFromCard;
