// Two-stage Discounted Cash Flow valuation on Free Cash Flow.
//
//   FCF         = cash from operations - capital expenditure (per fiscal year)
//   FCF_0       = average of the last 3 fiscal years (smooths working-capital
//                 swings), or the latest year - the user's choice
//   stage 1     : FCF_t = FCF_0 * (1+g)^t,  PV_t = FCF_t / (1+r)^t,  t = 1..N (N = 5)
//   terminal    : TV = FCF_N * (1+g_inf) / (r - g_inf),  PV(TV) = TV / (1+r)^N
//   EV          = sum PV_t + PV(TV)
//   equity      = EV + cash & short-term investments - total debt
//   value/share = equity / diluted shares
//   margin of safety = (value - price) / value   (Graham's convention)
//   verdict     : MoS > +band -> UNDERVALUED, < -band -> OVERVALUED, else FAIRLY_VALUED
//                 (band = 10% by default)
//
// A methodological note the page repeats: CFO - capex is after interest,
// so strictly it sits between FCFF and FCFE. Discounting it at a WACC and
// then subtracting net debt is the standard SIMPLIFIED retail DCF - and it
// is shown as that, not as an investment-bank model.
//
// Runs in the browser, so moving a slider recomputes instantly.

export const DCF_DEFAULTS = {
  years: 5,
  terminalGrowth: 0.025,
  baseMethod: 'avg3',
  fairBand: 0.1
};

export const DCF_LIMITS = {
  growth: [-0.2, 0.4],
  discount: [0.04, 0.2],
  terminalGrowth: [0, 0.05],
  minSpread: 0.01 // r - g_inf
};

const mean = (xs) => xs.reduce((s, x) => s + x, 0) / xs.length;
const stdev = (xs) => {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1));
};

// Input problems that make a result meaningless (as opposed to warnings,
// which only lower confidence). Empty array = OK to compute.
export function validateDcfInput(input) {
  const errors = [];
  const { growthRate: g, discountRate: r, terminalGrowth: gT = DCF_DEFAULTS.terminalGrowth, sharesDiluted, fcfHistory, marketPrice } = input;
  if (!Array.isArray(fcfHistory) || fcfHistory.filter(Number.isFinite).length === 0) errors.push('אין היסטוריית תזרים מזומנים חופשי');
  if (!(sharesDiluted > 0)) errors.push('חסר מספר מניות מדולל');
  if (!(marketPrice > 0)) errors.push('חסר מחיר שוק');
  if (!Number.isFinite(g) || g < DCF_LIMITS.growth[0] || g > DCF_LIMITS.growth[1]) errors.push('קצב צמיחה מחוץ לטווח -20% עד 40%');
  if (!Number.isFinite(r) || r < DCF_LIMITS.discount[0] || r > DCF_LIMITS.discount[1]) errors.push('שיעור היוון מחוץ לטווח 4% עד 20%');
  if (!Number.isFinite(gT) || gT < DCF_LIMITS.terminalGrowth[0] || gT > DCF_LIMITS.terminalGrowth[1]) errors.push('צמיחה לטווח ארוך מחוץ לטווח 0% עד 5%');
  if (Number.isFinite(r) && Number.isFinite(gT) && r - gT < DCF_LIMITS.minSpread) errors.push('שיעור ההיוון חייב לעלות על הצמיחה לטווח ארוך בנקודת אחוז לפחות');
  return errors;
}

export function baseFcf(fcfHistory, baseMethod = DCF_DEFAULTS.baseMethod) {
  const clean = (fcfHistory || []).filter(Number.isFinite);
  if (!clean.length) return null;
  return baseMethod === 'latest' ? clean[clean.length - 1] : mean(clean.slice(-3));
}

export function classifyMarginOfSafety(marginOfSafety, fairBand = DCF_DEFAULTS.fairBand) {
  if (marginOfSafety === null || !Number.isFinite(marginOfSafety)) return 'N/A';
  if (marginOfSafety > fairBand) return 'UNDERVALUED';
  if (marginOfSafety < -fairBand) return 'OVERVALUED';
  return 'FAIRLY_VALUED';
}

// Returns the full calculation, or { errors } when the input cannot be
// valued. Warnings never block a result.
export function computeDcf(input) {
  const errors = validateDcfInput(input);
  if (errors.length) return { errors, warnings: [] };

  const {
    fcfHistory,
    growthRate: g,
    discountRate: r,
    terminalGrowth: gT = DCF_DEFAULTS.terminalGrowth,
    years = DCF_DEFAULTS.years,
    cash = 0,
    debt = 0,
    sharesDiluted,
    marketPrice,
    baseMethod = DCF_DEFAULTS.baseMethod,
    fairBand = DCF_DEFAULTS.fairBand
  } = input;

  const warnings = [];
  const clean = fcfHistory.filter(Number.isFinite);
  const recent = clean.slice(-3);
  const base = baseFcf(clean, baseMethod);
  if (base <= 0) {
    return {
      errors: ['תזרים המזומנים החופשי הבסיסי אינו חיובי - מודל DCF מבוסס צמיחה אינו משמעותי לחברה הזו'],
      warnings: [],
      baseFcf: base
    };
  }
  if (recent.length >= 3 && stdev(recent) / Math.abs(mean(recent)) > 0.5) warnings.push('תזרים המזומנים החופשי תנודתי - רמת ביטחון נמוכה');
  if (clean.length < 3) warnings.push(`רק ${clean.length} שנות נתונים - הבסיס פחות יציב`);
  if (g > 0.25) warnings.push('צמיחה של יותר מ-25% בשנה לאורך 5 שנים נדירה מאוד');

  const projections = [];
  let pvStage1 = 0;
  let fcf = base;
  for (let t = 1; t <= years; t += 1) {
    fcf *= 1 + g;
    const discountFactor = 1 / (1 + r) ** t;
    projections.push({ year: t, fcf, discountFactor, pv: fcf * discountFactor });
    pvStage1 += fcf * discountFactor;
  }
  const terminalValue = (fcf * (1 + gT)) / (r - gT);
  const pvTerminal = terminalValue / (1 + r) ** years;
  const enterpriseValue = pvStage1 + pvTerminal;
  const equityValue = enterpriseValue + cash - debt;
  const intrinsicPerShare = equityValue / sharesDiluted;
  const terminalShareOfEv = pvTerminal / enterpriseValue;
  if (terminalShareOfEv > 0.75) warnings.push(`ערך הטרמינל הוא ${Math.round(terminalShareOfEv * 100)}% מהשווי - התוצאה רגישה מאוד לשיעור ההיוון ולצמיחה לטווח ארוך`);
  if (equityValue <= 0) warnings.push('החוב עולה על שווי הפעילות - אין שווי למניה');

  const marginOfSafety = intrinsicPerShare > 0 ? (intrinsicPerShare - marketPrice) / intrinsicPerShare : null;
  return {
    errors: [],
    warnings,
    baseFcf: base,
    projections,
    pvStage1,
    terminalValue,
    pvTerminal,
    enterpriseValue,
    equityValue,
    intrinsicPerShare,
    marketPrice,
    marginOfSafety,
    upside: (intrinsicPerShare - marketPrice) / marketPrice,
    verdict: classifyMarginOfSafety(marginOfSafety, fairBand),
    terminalShareOfEv
  };
}

// Value per share across discount rates (rows) and stage-1 growth rates
// (columns) around the chosen pair. null where r <= g_inf.
export function dcfSensitivity(input, { rSteps = [-0.01, -0.005, 0, 0.005, 0.01], gSteps = [-0.02, -0.01, 0, 0.01, 0.02] } = {}) {
  const gT = input.terminalGrowth ?? DCF_DEFAULTS.terminalGrowth;
  return {
    discountRates: rSteps.map((dr) => input.discountRate + dr),
    growthRates: gSteps.map((dg) => input.growthRate + dg),
    values: rSteps.map((dr) =>
      gSteps.map((dg) => {
        const r = input.discountRate + dr;
        if (r - gT <= 0) return null;
        const out = computeDcf({ ...input, discountRate: r, growthRate: input.growthRate + dg });
        // Outside the input limits the grid still shows the arithmetic.
        if (out.errors.length) {
          const raw = rawValuePerShare({ ...input, discountRate: r, growthRate: input.growthRate + dg, terminalGrowth: gT });
          return raw;
        }
        return out.intrinsicPerShare;
      })
    )
  };
}

function rawValuePerShare({ fcfHistory, growthRate: g, discountRate: r, terminalGrowth: gT, years = DCF_DEFAULTS.years, cash = 0, debt = 0, sharesDiluted, baseMethod = DCF_DEFAULTS.baseMethod }) {
  const base = baseFcf(fcfHistory, baseMethod);
  if (!(base > 0) || !(sharesDiluted > 0) || r - gT <= 0) return null;
  let pv = 0;
  let fcf = base;
  for (let t = 1; t <= years; t += 1) {
    fcf *= 1 + g;
    pv += fcf / (1 + r) ** t;
  }
  const tv = (fcf * (1 + gT)) / (r - gT) / (1 + r) ** years;
  return (pv + tv + cash - debt) / sharesDiluted;
}

// Suggested starting inputs (the user can overwrite them):
//   g: the analysts' 5-year growth estimate, else the historical FCF CAGR,
//      clamped to [0%, 20%];
//   r: CAPM cost of equity  r_f + beta * ERP  (ERP 5%), clamped to [6%, 15%].
export function suggestDcfInputs({ analystGrowth5y = null, fcfHistory = [], beta = null, riskFreeRate = 0.043, equityRiskPremium = 0.05 }) {
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  let growth;
  let growthSource;
  if (Number.isFinite(analystGrowth5y)) {
    growth = clamp(analystGrowth5y, 0, 0.2);
    growthSource = 'analysts';
  } else {
    const clean = fcfHistory.filter(Number.isFinite);
    const first = clean[0];
    const last = clean[clean.length - 1];
    if (clean.length >= 2 && first > 0 && last > 0) {
      growth = clamp((last / first) ** (1 / (clean.length - 1)) - 1, 0, 0.2);
      growthSource = 'history';
    } else {
      growth = 0.05;
      growthSource = 'default';
    }
  }
  const b = Number.isFinite(beta) && beta > 0 ? beta : 1;
  const discount = clamp(riskFreeRate + b * equityRiskPremium, 0.06, 0.15);
  return { growthRate: growth, growthSource, discountRate: discount, beta: b, riskFreeRate, equityRiskPremium };
}
