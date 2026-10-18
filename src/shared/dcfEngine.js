// The DCF engine: one pure function, runDcf(inputs), used by the valuation
// page, the exported input card and the tests alike. The method is
// DCF_METHOD.md's; nothing here caps, floors or adjusts an input - every
// assumption arrives in `inputs` and is echoed back in the result.
//
//   rev[t]   = rev[t-1] * (1 + growth[t])            rev[0] = base revenue
//   fcf[t]   = rev[t] * fcfMargin[t]
//   sbc[t]   = rev[t] * sbcPct[t]
//   adj[t]   = fcf[t] - (deductSbc ? sbc[t] : 0)
//   df[t]    = 1 / (1 + WACC)^t                      end-of-year discounting
//   pv[t]    = adj[t] * df[t]
//
//   Ke       = rf + beta * erp
//   E        = price * basicShares
//   wE       = E / (E + debt)
//   WACC     = wE * Ke + (1 - wE) * kd * (1 - tax)   (or waccOverride)
//
//   TV       = adj[5] * (1 + gT) / (WACC - gT)        Gordon; WACC must exceed gT
//            | adj[5] * exitMultiple                  the alternative method
//   EV       = sum(pv) + TV * df[5]
//   Equity   = EV - debt + cash
//   perShare = Equity / dilutedShares
//
// Money is in the reporting currency's units and shares are counts, so
// perShare is in currency per share. Years are t = 1..N, N = growth.length.
//
// CommonJS, and free of object/array spread, so the server can require it
// untranspiled and the app's production build can import it (see
// sharedModules.test.js).

const ENGINE_VERSION = '1.0.0';

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const sum = (xs) => xs.reduce((s, x) => s + x, 0);
const merge = (a, b) => Object.assign({}, a, b);

// Everything the input must hold for a number to mean anything. Returned as
// messages; an empty array means the input can be valued.
function validateInputs(inputs) {
  const errors = [];
  const need = (key, label, positive) => {
    const v = inputs[key];
    if (!isNum(v)) errors.push(`חסר ${label}`);
    else if (positive && !(v > 0)) errors.push(`${label} חייב להיות חיובי`);
  };
  need('price', 'מחיר', true);
  need('dilutedShares', 'מספר מניות מדולל', true);
  need('rev0', 'הכנסות בסיס', true);
  need('cash', 'מזומן', false);
  need('debt', 'חוב', false);
  need('gT', 'צמיחה סופית (gT)', false);
  if (!isNum(inputs.waccOverride)) {
    need('basicShares', 'מספר מניות בסיסי', true);
    need('rf', 'ריבית חסרת סיכון', false);
    need('beta', 'בטא', false);
    need('erp', 'פרמיית סיכון שוק', false);
    need('kd', 'עלות חוב', false);
    need('tax', 'שיעור מס', false);
  }
  const years = Array.isArray(inputs.growth) ? inputs.growth.length : 0;
  if (!years) errors.push('חסרה צמיחה שנתית');
  ['growth', 'fcfMargin', 'sbcPct'].forEach((key) => {
    const arr = inputs[key];
    if (!Array.isArray(arr) || arr.length !== years || !arr.every(isNum)) errors.push(`${key}: נדרש ערך לכל אחת מ-${years || 5} השנים`);
  });
  if (inputs.terminalMethod === 'exit' && !isNum(inputs.exitMultiple)) errors.push('חסר מכפיל יציאה');
  return errors;
}

function computeWacc(inputs) {
  if (isNum(inputs.waccOverride)) {
    return { wacc: inputs.waccOverride, overridden: true, ke: null, wE: null, equityValue: null, kdAfterTax: null };
  }
  const ke = inputs.rf + inputs.beta * inputs.erp;
  const equityValue = inputs.price * inputs.basicShares;
  const wE = equityValue / (equityValue + inputs.debt);
  const kdAfterTax = inputs.kd * (1 - inputs.tax);
  return { wacc: wE * ke + (1 - wE) * kdAfterTax, overridden: false, ke, wE, equityValue, kdAfterTax };
}

// The whole calculation, every intermediate step included. On invalid input
// - or a WACC not above gT under Gordon - `ok` is false and there is no
// value, only `errors`.
function runDcf(inputs) {
  const errors = validateInputs(inputs);
  if (errors.length) return { ok: false, errors, engineVersion: ENGINE_VERSION };

  const w = computeWacc(inputs);
  const wacc = w.wacc;
  const method = inputs.terminalMethod === 'exit' ? 'exit' : 'gordon';
  if (method === 'gordon' && !(wacc > inputs.gT)) {
    return {
      ok: false,
      errors: [`שיעור ההיוון (${(wacc * 100).toFixed(2)}%) חייב להיות גבוה מהצמיחה הסופית (${(inputs.gT * 100).toFixed(2)}%) - בלי זה לנוסחת Gordon אין ערך`],
      wacc,
      engineVersion: ENGINE_VERSION
    };
  }

  const deductSbc = inputs.deductSbc !== false;
  const years = [];
  let rev = inputs.rev0;
  for (let i = 0; i < inputs.growth.length; i += 1) {
    const t = i + 1;
    rev *= 1 + inputs.growth[i];
    const fcf = rev * inputs.fcfMargin[i];
    const sbc = rev * inputs.sbcPct[i];
    const adj = fcf - (deductSbc ? sbc : 0);
    const df = 1 / Math.pow(1 + wacc, t);
    years.push({ t, growth: inputs.growth[i], rev, fcfMargin: inputs.fcfMargin[i], fcf, sbcPct: inputs.sbcPct[i], sbc, adj, df, pv: adj * df });
  }
  const last = years[years.length - 1];
  const sumPv = sum(years.map((y) => y.pv));
  const tv = method === 'exit' ? last.adj * inputs.exitMultiple : (last.adj * (1 + inputs.gT)) / (wacc - inputs.gT);
  const pvTv = tv * last.df;
  const ev = sumPv + pvTv;
  const equity = ev - inputs.debt + inputs.cash;
  const perShare = equity / inputs.dilutedShares;

  return {
    ok: true,
    errors: [],
    engineVersion: ENGINE_VERSION,
    wacc,
    waccOverridden: w.overridden,
    ke: w.ke,
    wE: w.wE,
    marketCap: w.equityValue,
    kdAfterTax: w.kdAfterTax,
    terminalMethod: method,
    deductSbc,
    years,
    sumPv,
    tv,
    pvTv,
    ev,
    equity,
    perShare,
    price: inputs.price,
    upside: perShare / inputs.price - 1,
    marginOfSafety: perShare > 0 ? (perShare - inputs.price) / perShare : null,
    impliedExit: last.adj > 0 ? tv / last.adj : null,
    tvShare: ev > 0 ? pvTv / ev : null
  };
}

// The value per share at a given discount rate, everything else unchanged.
function perShareAt(inputs, rate) {
  const out = runDcf(merge(inputs, { waccOverride: rate }));
  return out.ok ? out.perShare : null;
}

// The implied annual return (IRR): the discount rate at which the value
// equals today's price - same growth, margins and terminal method, the
// terminal value recomputed at that rate. Bisection between gT (exclusive,
// where Gordon is defined) and 100%. null when even the lowest rate leaves
// the value under the price ("none"), or the highest leaves it above.
function impliedReturn(inputs, { hi = 1, iterations = 200 } = {}) {
  const lo0 = inputs.terminalMethod === 'exit' ? -0.99 : inputs.gT + 1e-9;
  const at = (r) => perShareAt(inputs, r);
  const vLo = at(lo0);
  const vHi = at(hi);
  if (vLo === null || vHi === null) return null;
  if (vLo < inputs.price || vHi > inputs.price) return null;
  let lo = lo0;
  let up = hi;
  for (let i = 0; i < iterations; i += 1) {
    const mid = (lo + up) / 2;
    if (at(mid) > inputs.price) lo = mid;
    else up = mid;
  }
  return (lo + up) / 2;
}

// Value per share around the result: columns WACC -2..+2 points, rows gT
// -1..+1 point (or, under the exit method, the multiple -10..+10). The
// centre cell is the main result by construction.
function sensitivity(inputs, { waccSteps = [-0.02, -0.01, 0, 0.01, 0.02], gSteps = [-0.01, -0.005, 0, 0.005, 0.01], exitSteps = [-10, -5, 0, 5, 10] } = {}) {
  const base = runDcf(inputs);
  if (!base.ok) return null;
  const exit = base.terminalMethod === 'exit';
  const waccs = waccSteps.map((d) => base.wacc + d);
  const rows = (exit ? exitSteps : gSteps).map((d) => (exit ? inputs.exitMultiple + d : inputs.gT + d));
  return {
    rowKind: exit ? 'exitMultiple' : 'gT',
    waccs,
    rows,
    values: rows.map((rowValue) =>
      waccs.map((rate) => {
        const patch = exit ? { exitMultiple: rowValue, waccOverride: rate } : { gT: rowValue, waccOverride: rate };
        const out = runDcf(merge(inputs, patch));
        return out.ok ? out.perShare : null;
      })
    )
  };
}

// "Undervalued" from +band upside, "overvalued" from -band (DCF_METHOD.md:
// 15% either way by default).
function valueLabel(upside, band) {
  if (!isNum(upside)) return 'N/A';
  if (upside >= band) return 'UNDERVALUED';
  if (upside <= -band) return 'OVERVALUED';
  return 'FAIRLY_VALUED';
}

// Several scenarios on one shared base. scenarios: [{ key, growth,
// fcfMargin, sbcPct }]; weights: { key: weight } for the weighted row.
function runScenarios(baseInputs, scenarios, weights) {
  const results = {};
  scenarios.forEach((s) => {
    results[s.key] = runDcf(merge(baseInputs, { growth: s.growth, fcfMargin: s.fcfMargin, sbcPct: s.sbcPct }));
  });
  let weighted = null;
  if (weights) {
    const keys = Object.keys(weights).filter((k) => results[k] && results[k].ok);
    const total = sum(keys.map((k) => weights[k]));
    if (keys.length === Object.keys(weights).length && total > 0) {
      weighted = sum(keys.map((k) => results[k].perShare * weights[k])) / total;
    }
  }
  return { results, weighted };
}

exports.ENGINE_VERSION = ENGINE_VERSION;
exports.validateInputs = validateInputs;
exports.computeWacc = computeWacc;
exports.runDcf = runDcf;
exports.perShareAt = perShareAt;
exports.impliedReturn = impliedReturn;
exports.sensitivity = sensitivity;
exports.valueLabel = valueLabel;
exports.runScenarios = runScenarios;
