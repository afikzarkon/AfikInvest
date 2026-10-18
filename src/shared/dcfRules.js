// From raw company data to DCF inputs, by rules anyone can redo by hand,
// and the "input card" that carries a valuation out of the site.
//
// Two modes, one engine (dcfEngine.runDcf, which these rules never change):
//   auto   - every input derived from a dated, sourced data snapshot by the
//            rules below (constants in DEFAULT_RULES, shown and editable),
//            plus the optional per-year figures a person can add with their
//            source (OVERRIDES). Nothing is capped, floored or tuned.
//   manual - the user's own numbers per year (presets: AVGO_PRESET from
//            DCF_METHOD.md, NOW_PRESET).
//
// AUTO RULES
//   TTM            sum of the last four quarters (revenue, FCF = operating
//                  cash flow - capex, SBC, net income) - not the fiscal year
//   FCF basis      (a) operating cash flow - capex, the default; (b) the
//                  company's normalized FCF (one-off acquisition costs added
//                  back), when entered by hand with its source
//   rev0           consensus revenue for the current fiscal year (0y);
//                  missing -> TTM revenue, flagged
//   growth[1]      consensus next year (+1y) / rev0 - 1 (fallbacks: TTM vs
//                  the TTM before it, then fiscal year vs the one before)
//   growth[t]      a consensus / guidance figure for that year when one was
//                  entered; otherwise gT + (growth[t-1] - gT) * k, so the
//                  fade starts after the last such year. No FY+2 figure ->
//                  a warning.
//   fcfMargin[t]   a guidance / consensus margin for that year when entered;
//                  after the last such year the last one is held, no fade;
//                  with none at all: fcfMarginTTM * (1 - marginStep * t),
//                  the generic rule, with a warning
//   sbcPct[t]      sbcPctTTM * (1 - sbcStep * t); always deducted
//   beta           betaWeight * beta_raw + betaConst (raw shown too)
//   rf             today's 10-year Treasury yield; missing -> the last one
//                  saved, flagged; none saved -> no value until entered
//   shares         diluted: weighted average, last quarter; basic: actual
//   debt           current + long-term debt, WITHOUT lease liabilities
//   cash           cash and equivalents + short-term investments + long-term
//                  marketable securities - not strategic / equity-method
//                  investments. A component not reported counts as 0, with
//                  the warning "cash without marketable securities".
//   scenarios      bear: growth * 0.6, margins - 4 points; bull: growth *
//                  1.15, margins + 2 points (DEFAULT_RULES.scenarios)
//   terminal       Gordon with gT; WACC <= gT is an error, not a number
//
// LEGACY (rules.legacy = true) is the first version of these rules, kept to
// prove a change is the rules' and not the engine's: cash and equivalents
// only, growth faded from FY+1, the generic margin rule, no overrides, and
// a 4.5% rate when the yield is missing.
//
// A missing figure is never filled in silently: the defined fallback is
// used and a flag says so; with no fallback there is no value.
//
// Not modelled, in either mode: the free cash flow of what is left of the
// current fiscal year. Year 1 is the next full fiscal year, discounted a
// full year.
//
// CommonJS without object/array spread - see sharedModules.test.js.

const engine = require('./dcfEngine');

const CARD_VERSION = 2;

const DEFAULT_RULES = {
  legacy: false,
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
  fcfBasis: 'reported',
  scenarios: {
    bear: { growthMult: 0.6, marginShift: -0.04 },
    base: { growthMult: 1, marginShift: 0 },
    bull: { growthMult: 1.15, marginShift: 0.02 }
  },
  weights: { bear: 0.25, base: 0.5, bull: 0.25 },
  labelBand: 0.15,
  warn: { tvShareAbove: 0.8, exitBelow: 8, exitAbove: 40, staleDays: 7 },
  // Used only when the figure is missing, and always flagged.
  fallback: { betaRaw: 1 }
};

const LEGACY_RULES = Object.assign({}, DEFAULT_RULES, { legacy: true, fallback: { betaRaw: 1, rf: 0.045 } });

const SCENARIO_LABELS = { bear: 'שמרני', base: 'בסיס', bull: 'אופטימי', conservative: 'שמרני', management: 'יעדי הנהלה' };

// What a person may add to the auto model, each figure with its source:
//   growth[i], fcfMargin[i]   { value, source, asOf } or null, i = 0 for FY+1
//   normalizedFcfTtm          { value, source, asOf } or null
//   fcfBasis                  'reported' | 'normalized'
//   rf                        { value, source, asOf } or null - used only
//                             when today's yield is unavailable, ahead of
//                             the last one saved
const EMPTY_OVERRIDES = { growth: [null, null, null, null, null], fcfMargin: [null, null, null, null, null], normalizedFcfTtm: null, fcfBasis: null, rf: null };

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const merge = (a, b) => Object.assign({}, a, b);
const range = (n) => Array.from({ length: n }, (_, i) => i + 1);
const pctText = (v) => `${(v * 100).toFixed(1)}%`;

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

const entryAt = (list, i) => (Array.isArray(list) && list[i] && isNum(list[i].value) ? list[i] : null);
const sourceText = (entry) => `${entry.source || 'הוזן ידנית'}${entry.asOf ? `, ${entry.asOf}` : ''}`;

// Growth per year: a consensus / guidance figure where one was entered,
// otherwise the fade from the year before. sources[i] says which.
function growthSchedule(g1, g1Basis, overrides, gT, k, years) {
  const values = [];
  const sources = [];
  for (let i = 0; i < (years || 5); i += 1) {
    const entry = entryAt(overrides && overrides.growth, i);
    if (entry) {
      values.push(entry.value);
      sources.push({ kind: 'consensus', text: `קונצנזוס / הנחיה: ${sourceText(entry)}` });
    } else if (i === 0) {
      values.push(g1);
      sources.push({ kind: 'consensus', text: g1Basis });
    } else {
      values.push(gT + (values[i - 1] - gT) * k);
      sources.push({ kind: 'rule', text: `דעיכה לכיוון ${pctText(gT)} (k = ${k})` });
    }
  }
  return { values, sources };
}

// FCF margin per year: a guidance / consensus figure where entered; after
// the last one it is held, without fading; before any, the generic rule.
function marginScheduleWithGuidance(ttmMargin, overrides, step, years) {
  const values = [];
  const sources = [];
  let held = null;
  for (let i = 0; i < (years || 5); i += 1) {
    const entry = entryAt(overrides && overrides.fcfMargin, i);
    if (entry) {
      held = entry.value;
      values.push(entry.value);
      sources.push({ kind: 'guidance', text: `הנחיה / קונצנזוס: ${sourceText(entry)}` });
    } else if (held !== null) {
      values.push(held);
      sources.push({ kind: 'held', text: 'השיעור האחרון מוחזק, בלי דעיכה' });
    } else {
      values.push(ttmMargin * (1 - step * (i + 1)));
      sources.push({ kind: 'rule', text: `כלל גנרי: שולי TTM × (1 - ${step} × ${i + 1})` });
    }
  }
  return { values, sources };
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

// Cash: cash and equivalents + short-term investments + long-term
// marketable securities, from the latest quarter. Short-term investments
// come from their own line, else from the combined "cash and short-term"
// line; long-term marketable securities from InvestmentinFinancialAssets,
// else available-for-sale + held-to-maturity.
function cashComponents(q) {
  const shortTerm = isNum(q.shortTermInvestments)
    ? { value: q.shortTermInvestments, source: 'השקעות לטווח קצר (OtherShortTermInvestments)' }
    : isNum(q.cashAndShortTerm) && isNum(q.cash)
      ? { value: q.cashAndShortTerm - q.cash, source: 'מזומן והשקעות לטווח קצר פחות מזומן' }
      : null;
  const ltParts = [q.availableForSale, q.heldToMaturity].filter(isNum);
  const longTerm = isNum(q.longTermMarketable)
    ? { value: q.longTermMarketable, source: 'ניירות ערך סחירים לטווח ארוך (InvestmentinFinancialAssets)' }
    : ltParts.length
      ? { value: ltParts.reduce((s, x) => s + x, 0), source: 'ניירות ערך זמינים למכירה + מוחזקים לפדיון' }
      : null;
  return { cash: isNum(q.cash) ? { value: q.cash, source: 'מזומן ושווי מזומן (CashAndCashEquivalents)' } : null, shortTerm, longTerm };
}

// Every figure the auto model uses, with where it came from. Each entry:
// { value, basis, fallback } - fallback true when the primary source was
// missing and the defined fallback was used (and `flags` says so).
function deriveAuto(snapshot, rules, overridesIn) {
  const R = rules || DEFAULT_RULES;
  const O = R.legacy ? EMPTY_OVERRIDES : merge(EMPTY_OVERRIDES, overridesIn || {});
  const quarters = snapshot.quarters || [];
  const annual = snapshot.annual || [];
  const flags = [];
  const warnings = [];
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
  d.fcfTtmReported = ttmField('fcf', 'תזרים חופשי 12 חודשים');
  d.sbcTtm = ttmField('sbc', 'SBC 12 חודשים');
  d.netIncomeTtm = ttmField('netIncome', 'רווח נקי 12 חודשים');
  if (!isNum(d.sbcTtm.value) && isNum(d.revenueTtm.value)) {
    flags.push('SBC לא דווח - לא הופחת דבר (הניחו 0)');
    d.sbcTtm = { value: 0, basis: 'חסר - 0', fallback: true };
  }

  // The FCF basis: operating cash flow - capex, or the company's normalized
  // figure when one was entered.
  const normalized = O.normalizedFcfTtm && isNum(O.normalizedFcfTtm.value) ? O.normalizedFcfTtm : null;
  d.fcfTtmNormalized = normalized ? { value: normalized.value, basis: `FCF מנורמל של החברה: ${sourceText(normalized)}`, fallback: false } : null;
  const wantNormalized = (O.fcfBasis || R.fcfBasis) === 'normalized';
  if (wantNormalized && !normalized) flags.push('נבחר FCF מנורמל אך לא הוזן ערך - נעשה שימוש בתזרים תפעולי פחות Capex');
  d.fcfBasis = wantNormalized && normalized ? 'normalized' : 'reported';
  d.fcfTtm = d.fcfBasis === 'normalized'
    ? d.fcfTtmNormalized
    : merge(d.fcfTtmReported, { basis: `תזרים תפעולי פחות Capex, ${d.fcfTtmReported.basis}` });

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
    } else if (!entryAt(O.growth, 0)) {
      missing.push('צמיחת השנה הראשונה');
      d.growth1 = { value: null, basis: 'חסר', fallback: true };
    } else {
      d.growth1 = { value: null, basis: 'חסר - הוזן ידנית', fallback: true };
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
  else if (R.legacy && R.fallback && isNum(R.fallback.rf)) {
    flags.push(`תשואת האג"ח ל-10 שנים חסרה - נעשה שימוש ב-${(R.fallback.rf * 100).toFixed(1)}%`);
    d.rf = { value: R.fallback.rf, basis: 'חסר - ערך חלופי מההגדרות', fallback: true };
  } else if (O.rf && isNum(O.rf.value)) {
    flags.push('תשואת האג"ח ל-10 שנים לא זמינה כרגע - נעשה שימוש בערך שהוזן ידנית');
    d.rf = { value: O.rf.value, basis: `הוזן ידנית: ${sourceText(O.rf)}`, fallback: true };
  } else if (snapshot.rfLastSaved && isNum(snapshot.rfLastSaved.value)) {
    flags.push(`תשואת האג"ח ל-10 שנים לא זמינה כרגע - נעשה שימוש בערך האחרון שנשמר (${snapshot.rfLastSaved.asOf || 'תאריך לא ידוע'})`);
    d.rf = { value: snapshot.rfLastSaved.value, basis: `הערך האחרון שנשמר, ${snapshot.rfLastSaved.asOf || ''} (חלופה)`, fallback: true };
  } else {
    missing.push('ריבית חסרת סיכון - אין ערך עדכני ואין ערך שמור; הזינו אותה במצב ידני');
    d.rf = { value: null, basis: 'חסר', fallback: true };
  }

  // Shares, debt - from the latest quarter that reports each.
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

  // Cash.
  const comp = lastQ ? cashComponents(lastQ) : { cash: null, shortTerm: null, longTerm: null };
  if (!comp.cash) {
    flags.push('מזומן לא דווח ברבעון האחרון - נספר כ-0');
    d.cash = { value: 0, basis: 'חסר - 0', fallback: true, parts: { cash: 0, shortTermInvestments: 0, longTermMarketable: 0 } };
  } else if (R.legacy) {
    d.cash = { value: comp.cash.value, basis: `מזומן ושווי מזומן בלבד, ${lastQ.periodEnd} (legacy)`, fallback: false, parts: { cash: comp.cash.value, shortTermInvestments: null, longTermMarketable: null } };
  } else {
    const notReported = [];
    if (!comp.shortTerm) notReported.push('השקעות לטווח קצר');
    if (!comp.longTerm) notReported.push('ניירות ערך סחירים לטווח ארוך');
    if (notReported.length) warnings.push(`מזומן ללא ניירות ערך סחירים: ${notReported.join(' ו')} לא דווחו ברבעון ${lastQ.periodEnd} - נספרו כ-0`);
    const st = comp.shortTerm ? comp.shortTerm.value : 0;
    const lt = comp.longTerm ? comp.longTerm.value : 0;
    d.cash = {
      value: comp.cash.value + st + lt,
      basis: `מזומן + השקעות לטווח קצר + ניירות ערך סחירים לטווח ארוך, ${lastQ.periodEnd}; בלי השקעות אסטרטגיות`,
      fallback: notReported.length > 0,
      parts: { cash: comp.cash.value, shortTermInvestments: comp.shortTerm ? st : null, longTermMarketable: comp.longTerm ? lt : null },
      partSources: { cash: comp.cash.source, shortTermInvestments: comp.shortTerm ? comp.shortTerm.source : 'לא דווח', longTermMarketable: comp.longTerm ? comp.longTerm.source : 'לא דווח' }
    };
  }

  return { derived: d, flags, warnings, missing, overrides: O };
}

// Per-year schedules of the base case, with each year's source.
function baseSchedules(derived, rules, overrides) {
  const R = rules || DEFAULT_RULES;
  const warnings = [];
  let growth;
  let margin;
  if (R.legacy) {
    growth = { values: fadeGrowth(derived.growth1.value, R.gT, R.fadeK, R.years), sources: range(R.years).map((t) => ({ kind: 'rule', text: t === 1 ? derived.growth1.basis : `דעיכה לכיוון ${pctText(R.gT)} (k = ${R.fadeK})` })) };
    margin = { values: marginSchedule(derived.fcfMarginTtm.value, R.marginStep, R.years), sources: range(R.years).map((t) => ({ kind: 'rule', text: `כלל גנרי: שולי TTM × (1 - ${R.marginStep} × ${t})` })) };
  } else {
    growth = growthSchedule(derived.growth1.value, derived.growth1.basis, overrides, R.gT, R.fadeK, R.years);
    margin = marginScheduleWithGuidance(derived.fcfMarginTtm.value, overrides, R.marginStep, R.years);
    if (R.years > 1 && !entryAt(overrides && overrides.growth, 1)) warnings.push('צמיחה ב-FY+2 אינה מקונצנזוס - היא נגזרת מכלל הדעיכה');
    if (!margin.sources.some((s) => s.kind === 'guidance')) warnings.push('אין הנחיית שוליים, הדעיכה היא כלל גנרי');
  }
  const sbc = sbcSchedule(derived.sbcPctTtm.value, R.sbcStep, R.years);
  return { growth: growth.values, growthSources: growth.sources, fcfMargin: margin.values, marginSources: margin.sources, sbcPct: sbc, warnings };
}

// The three auto scenarios, per year, from the base schedules.
function autoScenarios(schedules, rules) {
  const R = rules || DEFAULT_RULES;
  return ['bear', 'base', 'bull'].map((key) => {
    const sc = R.scenarios[key];
    return {
      key,
      label: SCENARIO_LABELS[key],
      growth: schedules.growth.map((x) => x * sc.growthMult),
      fcfMargin: schedules.fcfMargin.map((x) => x + sc.marginShift),
      sbcPct: schedules.sbcPct.slice()
    };
  });
}

// Reverse DCF: the one constant revenue growth rate, for all five years,
// that - with the same margins, SBC and everything else - makes the value
// equal the price. null when no rate in [-50%, 200%] does.
function impliedConstantGrowth(inputs, { lo = -0.5, hi = 2, iterations = 200 } = {}) {
  const years = inputs.growth.length;
  const at = (g) => {
    const out = engine.runDcf(merge(inputs, { growth: Array.from({ length: years }, () => g) }));
    return out.ok ? out.perShare : null;
  };
  const vLo = at(lo);
  const vHi = at(hi);
  if (vLo === null || vHi === null || !(vLo <= inputs.price && vHi >= inputs.price)) return null;
  let a = lo;
  let b = hi;
  for (let i = 0; i < iterations; i += 1) {
    const mid = (a + b) / 2;
    if (at(mid) < inputs.price) a = mid;
    else b = mid;
  }
  return (a + b) / 2;
}

// ---------------------------------------------------------------------------
// One evaluation, either mode: the model (shared inputs + scenarios), every
// scenario's result, the base case's IRR, implied growth, sensitivity and
// warnings.
//
// args: { mode: 'auto' | 'manual', snapshot, rules, overrides, manual,
//         valuationDate }
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
    const dv = deriveAuto(snap, R, args.overrides);
    out.derived = dv.derived;
    out.overrides = dv.overrides;
    out.flags = dv.flags;
    out.missing = dv.missing;
    out.warnings = dv.warnings.slice();
    out.unsuitable = unsuitableReason(snap, dv.derived.fcfTtm.value);
    if (!snap.price || !isNum(snap.price.value)) out.missing.push('מחיר');
    if (out.unsuitable || out.missing.length) return out;
    const d = dv.derived;
    const schedules = baseSchedules(d, R, dv.overrides);
    out.schedules = { growthSources: schedules.growthSources, marginSources: schedules.marginSources };
    out.warnings = out.warnings.concat(schedules.warnings);
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
      scenarios: autoScenarios(schedules, R),
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
  out.irrByScenario = {};
  model.scenarios.forEach((s) => {
    out.irrByScenario[s.key] = engine.impliedReturn(merge(model.base, { growth: s.growth, fcfMargin: s.fcfMargin, sbcPct: s.sbcPct }));
  });
  out.impliedGrowth = impliedConstantGrowth(baseInputs);
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
      ['תשואת אג"ח', snap.rf || snap.rfLastSaved],
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
  const d = e.derived || null;
  const scenarioResults = {};
  if (e.results) {
    Object.keys(e.results).forEach((k) => {
      const r = e.results[k];
      scenarioResults[k] = r.ok
        ? {
            perShare: r.perShare,
            upside: r.upside,
            marginOfSafety: r.marginOfSafety,
            label: e.labels ? e.labels[k] : null,
            tvShare: r.tvShare,
            impliedExit: r.impliedExit,
            irr: e.irrByScenario ? e.irrByScenario[k] : null,
            ev: r.ev,
            equity: r.equity
          }
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
    // What a person added to the auto model, each with its source.
    overrides: e.overrides || null,
    derived: d,
    cash: d && d.cash ? { total: d.cash.value, parts: d.cash.parts, partSources: d.cash.partSources || null, basis: d.cash.basis } : m ? { total: m.base.cash } : null,
    fcfBasis: d
      ? {
          chosen: d.fcfBasis,
          reported: { value: d.fcfTtmReported.value, margin: d.revenueTtm.value > 0 ? d.fcfTtmReported.value / d.revenueTtm.value : null, basis: 'תזרים תפעולי פחות Capex' },
          normalized: d.fcfTtmNormalized ? { value: d.fcfTtmNormalized.value, margin: d.revenueTtm.value > 0 ? d.fcfTtmNormalized.value / d.revenueTtm.value : null, basis: d.fcfTtmNormalized.basis } : null
        }
      : null,
    // Per year: where the base case's growth and margin came from.
    sources: e.schedules
      ? { growth: e.schedules.growthSources, fcfMargin: e.schedules.marginSources, sbcPct: 'כלל: אחוז SBC מ-TTM × (1 - 0.1 × שנה)' }
      : e.mode === 'manual'
        ? { growth: 'הוזן ידנית', fcfMargin: 'הוזן ידנית', sbcPct: 'הוזן ידנית' }
        : null,
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
          cashNote: 'מזומן + השקעות לטווח קצר + ניירות ערך סחירים לטווח ארוך, ללא השקעות אסטרטגיות',
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
          irr: e.irr,
          impliedGrowth: isNum(e.impliedGrowth) ? e.impliedGrowth : null
        }
      : { error: (e.main && e.main.errors) || e.missing },
    warnings: e.warnings,
    notes: ['החישוב אינו כולל את ה-FCF של החלק שנותר מהשנה הנוכחית; שנה 1 היא שנת הכספים המלאה הבאה.']
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
  const fromRaw =
    card.mode === 'auto' && card.raw ? evaluateDcf({ mode: 'auto', snapshot: card.raw, rules: card.rules, overrides: card.overrides, valuationDate: card.valuationDate }) : null;
  return { fromInputs, fromRaw };
}

// ---------------------------------------------------------------------------
// Manual presets.

const B = 1e9;
const M = 1e6;

// DCF_METHOD.md's AVGO table (18.10.2026).
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

// ServiceNow, checked by hand against the company's reports and the
// consensus (18.10.2026). Cash = 2.503 + 2.161 short-term investments +
// 2.043 long-term marketable securities; basic shares for the market value,
// diluted for the value per share.
const NOW_PRESET = {
  ticker: 'NOW',
  asOf: '2026-10-18',
  source: 'בדיקה ידנית מול דוחות החברה והקונצנזוס',
  base: {
    price: 141.97,
    basicShares: 1033.9 * M,
    dilutedShares: 1034.0 * M,
    cash: 6.707 * B,
    debt: 7.517 * B,
    rev0: 16.218 * B,
    rf: 0.051,
    beta: 0.9933,
    erp: 0.045,
    kd: 0.055,
    tax: 0.15,
    gT: 0.035,
    deductSbc: true
  },
  scenarios: [
    { key: 'bear', label: 'שמרני', growth: [0.15, 0.12, 0.1, 0.08, 0.06], fcfMargin: [0.34, 0.33, 0.32, 0.31, 0.3], sbcPct: [0.15, 0.15, 0.145, 0.14, 0.14] },
    { key: 'base', label: 'בסיס', growth: [0.188, 0.186, 0.165, 0.145, 0.125], fcfMargin: [0.36, 0.37, 0.375, 0.375, 0.375], sbcPct: [0.14, 0.13, 0.12, 0.11, 0.1] },
    { key: 'bull', label: 'אופטימי', growth: [0.195, 0.195, 0.185, 0.175, 0.16], fcfMargin: [0.37, 0.385, 0.4, 0.41, 0.42], sbcPct: [0.135, 0.12, 0.105, 0.095, 0.085] }
  ],
  weights: { bear: 0.25, base: 0.5, bull: 0.25 }
};

const PRESETS = { AVGO: AVGO_PRESET, NOW: NOW_PRESET };

exports.CARD_VERSION = CARD_VERSION;
exports.DEFAULT_RULES = DEFAULT_RULES;
exports.LEGACY_RULES = LEGACY_RULES;
exports.EMPTY_OVERRIDES = EMPTY_OVERRIDES;
exports.SCENARIO_LABELS = SCENARIO_LABELS;
exports.AVGO_PRESET = AVGO_PRESET;
exports.NOW_PRESET = NOW_PRESET;
exports.PRESETS = PRESETS;
exports.fadeGrowth = fadeGrowth;
exports.marginSchedule = marginSchedule;
exports.sbcSchedule = sbcSchedule;
exports.adjustBeta = adjustBeta;
exports.growthSchedule = growthSchedule;
exports.marginScheduleWithGuidance = marginScheduleWithGuidance;
exports.cashComponents = cashComponents;
exports.ttmOf = ttmOf;
exports.deriveAuto = deriveAuto;
exports.baseSchedules = baseSchedules;
exports.unsuitableReason = unsuitableReason;
exports.autoScenarios = autoScenarios;
exports.impliedConstantGrowth = impliedConstantGrowth;
exports.evaluateDcf = evaluateDcf;
exports.buildInputCard = buildInputCard;
exports.reproduceFromCard = reproduceFromCard;
