/**
 * @jest-environment node
 */
// The auto rules, on the vectors computed by hand, then on a recorded AVGO
// snapshot (fixtures/dcf-snapshot-avgo.json): every derived input, every
// fallback and flag, the cases a DCF does not fit, the warnings, and the
// input card's offline reproduction.
const rules = require('./dcfRules');
const { runDcf } = require('./dcfEngine');
const avgo = require('./fixtures/dcf-snapshot-avgo.json');

const { fadeGrowth, marginSchedule, sbcSchedule, adjustBeta, deriveAuto, evaluateDcf, buildInputCard, reproduceFromCard, DEFAULT_RULES, AVGO_PRESET } = rules;
const B = 1e9;
const DATE = '2026-10-18';
const clone = (x) => JSON.parse(JSON.stringify(x));
const closeAll = (actual, expected) => {
  expect(actual).toHaveLength(expected.length);
  expected.forEach((v, i) => expect(actual[i]).toBeCloseTo(v, 12));
};

describe('rule vectors', () => {
  test('fade(g1=0.63, gT=0.035, k=0.5)', () => closeAll(fadeGrowth(0.63, 0.035, 0.5, 5), [0.63, 0.3325, 0.18375, 0.109375, 0.0721875]));
  test('margins(ttm=0.442)', () => closeAll(marginSchedule(0.442, 0.02, 5), [0.43316, 0.42432, 0.41548, 0.40664, 0.3978]));
  test('sbc(ttm=0.08)', () => closeAll(sbcSchedule(0.08, 0.1, 5), [0.072, 0.064, 0.056, 0.048, 0.04]));
  test('beta_adj(1.24) = 1.1608, beta_adj(2.0) = 1.67', () => {
    expect(adjustBeta(1.24, 0.67, 0.33)).toBeCloseTo(1.1608, 12);
    expect(adjustBeta(2.0, 0.67, 0.33)).toBeCloseTo(1.67, 12);
  });
});

describe('deriving AVGO from its snapshot', () => {
  const { derived: d, flags, missing } = deriveAuto(avgo, DEFAULT_RULES);

  test('TTM is the last four quarters, not the fiscal year', () => {
    expect(d.revenueTtm.value / B).toBeCloseTo(89.104, 3);
    expect(d.fcfTtm.value / B).toBeCloseTo(39.403, 3);
    expect(d.sbcTtm.value / B).toBeCloseTo(8.482, 3);
    expect(d.revenueTtm.basis).toMatch(/2026-07-31/);
    expect(d.fcfMarginTtm.value).toBeCloseTo(39.403 / 89.104, 4);
  });

  test('rev0 and growth[1] from the consensus', () => {
    expect(d.rev0.value).toBe(avgo.consensus.rev0y.value);
    expect(d.growth1.value).toBeCloseTo(avgo.consensus.rev1y.value / avgo.consensus.rev0y.value - 1, 12);
    expect(d.rev0.fallback || d.growth1.fallback).toBe(false);
  });

  test('beta adjusted from the raw beta; rf dated', () => {
    expect(d.betaRaw.value).toBe(1.476);
    expect(d.beta.value).toBeCloseTo(0.67 * 1.476 + 0.33, 12);
    expect(d.rf.value).toBe(avgo.rf.value);
    expect(d.rf.basis).toMatch(avgo.rf.asOf);
  });

  test('debt = current + long-term (no leases); cash only; diluted and basic shares from the last report', () => {
    expect(d.debt.value / B).toBeCloseTo(59.419, 3);
    expect(d.debt.basis).toMatch(/בלי התחייבויות חכירה/);
    expect(d.cash.value / B).toBeCloseTo(23.975, 3);
    expect(d.dilutedShares.value / 1e6).toBeCloseTo(4887, 0);
    expect(d.basicShares.value / 1e6).toBeCloseTo(4773.6, 0);
  });

  test('nothing missing, nothing filled in', () => {
    expect(flags).toEqual([]);
    expect(missing).toEqual([]);
  });

  test('scenarios: bear growth x0.6 and margins -4 points, bull x1.15 and +2 points, SBC unchanged', () => {
    const [bear, base, bull] = rules.autoScenarios(rules.baseSchedules(d, DEFAULT_RULES, rules.EMPTY_OVERRIDES), DEFAULT_RULES);
    closeAll(base.growth, fadeGrowth(d.growth1.value, 0.035, 0.5, 5));
    closeAll(bear.growth, base.growth.map((g) => g * 0.6));
    closeAll(bull.growth, base.growth.map((g) => g * 1.15));
    closeAll(bear.fcfMargin, base.fcfMargin.map((m) => m - 0.04));
    closeAll(bull.fcfMargin, base.fcfMargin.map((m) => m + 0.02));
    closeAll(bear.sbcPct, base.sbcPct);
    closeAll(base.sbcPct, sbcSchedule(d.sbcPctTtm.value, 0.1, 5));
  });

  test('the evaluation runs the engine on exactly these inputs', () => {
    const e = evaluateDcf({ mode: 'auto', snapshot: avgo, valuationDate: DATE });
    const base = e.model.scenarios.find((s) => s.key === 'base');
    const direct = runDcf(Object.assign({}, e.model.base, { growth: base.growth, fcfMargin: base.fcfMargin, sbcPct: base.sbcPct }));
    expect(e.main.perShare).toBe(direct.perShare);
    expect(e.model.base).toMatchObject({ erp: 0.045, kd: 0.055, tax: 0.15, gT: 0.035, deductSbc: true });
    // The rules are not DCF_METHOD.md's hand-made scenarios: no 234 expected.
    expect(Math.abs(e.main.perShare - 234)).toBeGreaterThan(1);
  });
});

describe('missing data: the defined fallback, and a flag', () => {
  test('no consensus: rev0 = TTM revenue, and the first growth from the fiscal years', () => {
    const snap = clone(avgo);
    snap.consensus = { rev0y: null, rev1y: null, asOf: DATE, source: 'x' };
    const e = evaluateDcf({ mode: 'auto', snapshot: snap, valuationDate: DATE });
    expect(e.derived.rev0).toMatchObject({ value: e.derived.revenueTtm.value, fallback: true });
    expect(e.derived.growth1.fallback).toBe(true);
    const last = snap.annual[snap.annual.length - 1];
    const prev = snap.annual[snap.annual.length - 2];
    expect(e.derived.growth1.value).toBeCloseTo(last.revenue / prev.revenue - 1, 12);
    expect(e.flags.join(' ')).toMatch(/אין קונצנזוס/);
    expect(e.warnings.join(' ')).toMatch(/חסר נתון קונצנזוס/);
    expect(e.main.ok).toBe(true);
  });

  test('with eight quarters, the first growth is TTM against the TTM before it', () => {
    const snap = clone(avgo);
    snap.consensus.rev1y = null;
    const older = [1, 2, 3, 4].map((i) => ({ periodEnd: `2024-0${i}-30`, revenue: 10 * B }));
    snap.quarters = older.concat(snap.quarters.slice(-4));
    const e = evaluateDcf({ mode: 'auto', snapshot: snap, valuationDate: DATE });
    expect(e.derived.growth1.value).toBeCloseTo(e.derived.revenueTtm.value / (40 * B) - 1, 12);
    expect(e.derived.growth1.basis).toMatch(/TTM קודם/);
  });

  test('beta falls back to the market beta, flagged', () => {
    const snap = clone(avgo);
    snap.betaRaw = null;
    const e = evaluateDcf({ mode: 'auto', snapshot: snap, valuationDate: DATE });
    expect(e.derived.betaRaw).toMatchObject({ value: 1, fallback: true });
    expect(e.derived.beta.value).toBeCloseTo(1, 12);
    expect(e.flags.join(' ')).toMatch(/בטא חסרה/);
  });

  test('no yield today: the last one saved, clearly flagged - never a constant', () => {
    const snap = clone(avgo);
    snap.rf = null;
    snap.rfLastSaved = { value: 0.0507, asOf: '2026-10-14', source: 'x' };
    const e = evaluateDcf({ mode: 'auto', snapshot: snap, valuationDate: DATE });
    expect(e.derived.rf).toMatchObject({ value: 0.0507, fallback: true });
    expect(e.flags.join(' ')).toMatch(/בערך האחרון שנשמר \(2026-10-14\)/);
    expect(e.main.ok).toBe(true);
  });

  test('no yield and none saved: no value, and a request to enter it', () => {
    const snap = clone(avgo);
    snap.rf = null;
    snap.rfLastSaved = null;
    const e = evaluateDcf({ mode: 'auto', snapshot: snap, valuationDate: DATE });
    expect(e.main).toBeUndefined();
    expect(e.missing.join(' ')).toMatch(/ריבית חסרת סיכון.*הזינו/);
    // Entered by hand, it is used - and said to be.
    const entered = evaluateDcf({ mode: 'auto', snapshot: snap, overrides: { rf: { value: 0.051, source: 'הוזן ידנית', asOf: DATE } }, valuationDate: DATE });
    expect(entered.derived.rf).toMatchObject({ value: 0.051, fallback: true });
    expect(entered.flags.join(' ')).toMatch(/הוזן ידנית/);
    expect(entered.main.ok).toBe(true);
  });

  test('no quarters and no fiscal years: no value, and what is missing is named', () => {
    const snap = clone(avgo);
    snap.quarters = [];
    snap.annual = [];
    const e = evaluateDcf({ mode: 'auto', snapshot: snap, valuationDate: DATE });
    expect(e.model).toBeUndefined();
    expect(e.missing).toEqual(expect.arrayContaining(['הכנסות 12 חודשים', 'תזרים חופשי 12 חודשים']));
  });
});

describe('not a DCF company: a reason, no number', () => {
  const unsuitable = (patch) => {
    const snap = Object.assign(clone(avgo), patch);
    const e = evaluateDcf({ mode: 'auto', snapshot: snap, valuationDate: DATE });
    expect(e.main).toBeUndefined();
    return e.unsuitable;
  };
  test('banks', () => expect(unsuitable({ profile: { sector: 'Financial Services', industry: 'Banks - Diversified' } })).toMatch(/בנק/));
  test('insurers', () => expect(unsuitable({ profile: { sector: 'Financial Services', industry: 'Insurance - Life' } })).toMatch(/ביטוח/));
  test('REITs', () => expect(unsuitable({ profile: { sector: 'Real Estate', industry: 'REIT - Industrial' } })).toMatch(/REIT/));
  test('negative trailing FCF', () => {
    const quarters = clone(avgo.quarters).map((q) => Object.assign(q, { operatingCashFlow: -1 * B }));
    expect(unsuitable({ quarters })).toMatch(/תזרים מזומנים חופשי שלילי/);
  });
  test('statements in one currency and the price in another', () => expect(unsuitable({ currency: 'USD', financialCurrency: 'TWD' })).toMatch(/TWD/));
});

describe('warnings: the number stands, with a caveat', () => {
  test('terminal value over 80% of EV, and an implied exit multiple outside 8x-40x', () => {
    const manual = clone({ base: AVGO_PRESET.base, scenarios: AVGO_PRESET.scenarios, weights: AVGO_PRESET.weights });
    manual.base.waccOverride = 0.045;
    const e = evaluateDcf({ mode: 'manual', manual, valuationDate: DATE });
    expect(e.main.tvShare).toBeGreaterThan(0.8);
    expect(e.warnings.join(' ')).toMatch(/מהערך הסופי/);
    expect(e.warnings.join(' ')).toMatch(/מכפיל היציאה המשתמע/);
  });

  test('data more than 7 days older than the valuation date', () => {
    const e = evaluateDcf({ mode: 'auto', snapshot: avgo, valuationDate: '2026-10-30' });
    expect(e.warnings.join(' ')).toMatch(/מחיר: הנתון מ-2026-10-16/);
    expect(evaluateDcf({ mode: 'auto', snapshot: avgo, valuationDate: DATE }).warnings.join(' ')).not.toMatch(/ימים לפני תאריך ההערכה/);
  });
});

describe('the manual AVGO preset', () => {
  test('117 / 234 / 326 at a WACC of 11.25%', () => {
    const e = evaluateDcf({ mode: 'manual', manual: AVGO_PRESET, valuationDate: DATE });
    expect(Math.round(e.results.conservative.perShare)).toBe(117);
    expect(Math.round(e.results.base.perShare)).toBe(234);
    expect(Math.round(e.results.management.perShare)).toBe(326);
    expect(e.main.wacc * 100).toBeCloseTo(11.25, 2);
    expect(AVGO_PRESET.scenarios.every((s) => s.sbcPct.every((x) => x === 0.05))).toBe(true);
  });
});

describe('the input card', () => {
  test('carries every input, and reproduces every result offline - from the inputs and from the raw data', () => {
    const e = evaluateDcf({ mode: 'auto', snapshot: avgo, valuationDate: DATE });
    const card = JSON.parse(JSON.stringify(buildInputCard(e, avgo, 'AVGO')));
    expect(card).toMatchObject({ ticker: 'AVGO', valuationDate: DATE, mode: 'auto', price: 328.75, engineVersion: expect.any(String) });
    expect(card.raw.price).toMatchObject({ value: 328.75, asOf: '2026-10-16', source: expect.any(String) });
    expect(Object.keys(card.inputs)).toEqual(expect.arrayContaining(['rf', 'beta_raw', 'beta', 'erp', 'kd', 'tax', 'gT', 'basicShares', 'dilutedShares', 'debt', 'cash', 'scenarios']));
    card.inputs.scenarios.forEach((s) => ['growth', 'fcfMargin', 'sbcPct'].forEach((k) => expect(s[k]).toHaveLength(5)));
    expect(Object.keys(card.results)).toEqual(expect.arrayContaining(['wacc', 'scenarios', 'tvShare', 'impliedExit', 'irr']));

    const { fromInputs, fromRaw } = reproduceFromCard(card);
    ['bear', 'base', 'bull'].forEach((k) => {
      expect(fromInputs.results[k].perShare).toBe(card.results.scenarios[k].perShare);
      expect(fromRaw.results[k].perShare).toBe(card.results.scenarios[k].perShare);
    });
    expect(fromInputs.main.wacc).toBe(card.results.wacc);
    expect(fromInputs.irr).toBe(card.results.irr);
  });

  test('a manual card reproduces too', () => {
    const e = evaluateDcf({ mode: 'manual', manual: AVGO_PRESET, valuationDate: DATE });
    const card = JSON.parse(JSON.stringify(buildInputCard(e, null, 'AVGO')));
    expect(reproduceFromCard(card).fromInputs.results.base.perShare).toBe(card.results.scenarios.base.perShare);
  });
});

// ---------------------------------------------------------------------------
// Rules v2, on NOW (fixtures/dcf-snapshot-now.json, 18.10.2026).
const nowSnap = require('./fixtures/dcf-snapshot-now.json');
const { LEGACY_RULES, NOW_PRESET, impliedConstantGrowth } = rules;
const { impliedReturn, sensitivity } = require('./dcfEngine');
const within = (actual, expected, tolerance) => expect(Math.abs(actual - expected)).toBeLessThanOrEqual(tolerance);
const perShare = (e) => ['bear', 'base', 'bull'].map((k) => e.results[k].perShare);

describe('regression: the legacy rules reproduce the first version, the engine untouched', () => {
  const legacy = evaluateDcf({ mode: 'auto', snapshot: nowSnap, rules: LEGACY_RULES, valuationDate: DATE });

  test('NOW, cash 2.503: 44.65 / 67.85 / 79.95, IRR 6.43%, terminal value 78.5%', () => {
    expect(legacy.model.base.cash / B).toBeCloseTo(2.503, 6);
    [44.65, 67.85, 79.95].forEach((v, i) => within(perShare(legacy)[i], v, 0.05));
    within(legacy.irr * 100, 6.43, 0.005);
    within(legacy.main.tvShare * 100, 78.5, 0.05);
  });

  test('the same with cash 6.707 alone: 71.9', () => {
    const base = legacy.model.scenarios.find((s) => s.key === 'base');
    within(runDcf(Object.assign({}, legacy.model.base, base, { cash: 6.707 * B })).perShare, 71.9, 0.05);
  });

  test('the new rules without added figures differ from legacy only by the cash: 71.9 again', () => {
    const v2 = evaluateDcf({ mode: 'auto', snapshot: nowSnap, valuationDate: DATE });
    within(v2.main.perShare, 71.9, 0.05);
    expect(v2.model.scenarios.map((s) => s.growth)).toEqual(legacy.model.scenarios.map((s) => s.growth));
  });
});

describe('cash: cash + short-term investments + long-term marketable securities', () => {
  test('NOW: 2.503 + 2.161 + 2.043 = 6.707, each part shown', () => {
    const { derived: d, warnings } = deriveAuto(nowSnap, DEFAULT_RULES);
    expect(d.cash.value / B).toBeCloseTo(6.707, 6);
    [['cash', 2.503], ['shortTermInvestments', 2.161], ['longTermMarketable', 2.043]].forEach(([k, v]) => expect(d.cash.parts[k] / B).toBeCloseTo(v, 6));
    expect(d.cash.basis).toMatch(/בלי השקעות אסטרטגיות/);
    expect(warnings.join(' ')).not.toMatch(/מזומן ללא/);
  });

  test('strategic (equity-method) investments are not cash', () => {
    const snap = clone(nowSnap);
    snap.quarters[snap.quarters.length - 1].longTermEquityInvestment = 1.743 * B;
    expect(deriveAuto(snap, DEFAULT_RULES).derived.cash.value / B).toBeCloseTo(6.707, 6);
  });

  test('a component not reported counts as 0, with the warning', () => {
    const { derived: d, warnings } = deriveAuto(avgo, DEFAULT_RULES);
    expect(d.cash.value / B).toBeCloseTo(23.975, 6);
    expect(d.cash.parts.longTermMarketable).toBeNull();
    expect(warnings.join(' ')).toMatch(/מזומן ללא ניירות ערך סחירים/);
  });

  test('available-for-sale + held-to-maturity when the combined line is missing', () => {
    expect(rules.cashComponents({ cash: 1, shortTermInvestments: 2, availableForSale: 3, heldToMaturity: 4 }).longTerm.value).toBe(7);
    expect(rules.cashComponents({ cash: 1, cashAndShortTerm: 5 }).shortTerm.value).toBe(4);
  });
});

describe('FCF margins: guidance first, the generic fade only as the fallback', () => {
  const guidance = (values) => ({ fcfMargin: values.map((v) => (v === null ? null : { value: v, source: 'הנחיית החברה', asOf: '2026-07-23' })) });

  test('guided years use the guidance; later years hold the last one, without fading', () => {
    const e = evaluateDcf({ mode: 'auto', snapshot: nowSnap, overrides: guidance([0.36, 0.37, null, null, null]), valuationDate: DATE });
    const base = e.model.scenarios.find((s) => s.key === 'base');
    closeAll(base.fcfMargin, [0.36, 0.37, 0.37, 0.37, 0.37]);
    expect(e.schedules.marginSources.map((s) => s.kind)).toEqual(['guidance', 'guidance', 'held', 'held', 'held']);
    expect(e.schedules.marginSources[0].text).toMatch(/הנחיית החברה, 2026-07-23/);
    expect(e.warnings.join(' ')).not.toMatch(/אין הנחיית שוליים/);
    // The scenario shifts still apply on top.
    closeAll(e.model.scenarios.find((s) => s.key === 'bear').fcfMargin, [0.32, 0.33, 0.33, 0.33, 0.33]);
  });

  test('without any: the generic rule, and the warning', () => {
    const e = evaluateDcf({ mode: 'auto', snapshot: nowSnap, valuationDate: DATE });
    closeAll(e.model.scenarios.find((s) => s.key === 'base').fcfMargin, marginSchedule(e.derived.fcfMarginTtm.value, 0.02, 5));
    expect(e.warnings).toContain('אין הנחיית שוליים, הדעיכה היא כלל גנרי');
  });

  test('two FCF bases: operating cash flow - capex (default), and the normalized one when entered', () => {
    const normalizedFcfTtm = { value: 4.92 * B, source: 'FCF מנורמל, דוח רבעון 2', asOf: '2026-07-23' };
    const plain = evaluateDcf({ mode: 'auto', snapshot: nowSnap, overrides: { normalizedFcfTtm }, valuationDate: DATE });
    expect(plain.derived.fcfBasis).toBe('reported');
    expect(plain.derived.fcfTtm.value / B).toBeCloseTo(4.571, 3);
    within(plain.derived.fcfMarginTtm.value * 100, 31.0, 0.05);
    const normal = evaluateDcf({ mode: 'auto', snapshot: nowSnap, overrides: { normalizedFcfTtm, fcfBasis: 'normalized' }, valuationDate: DATE });
    expect(normal.derived.fcfBasis).toBe('normalized');
    within(normal.derived.fcfMarginTtm.value * 100, 33.4, 0.05);
    expect(normal.main.perShare).toBeGreaterThan(plain.main.perShare);
  });
});

describe('growth: consensus years first, the fade after them', () => {
  const consensus = (values) => ({ growth: values.map((v) => (v === null ? null : { value: v, source: 'קונצנזוס', asOf: '2026-10-17' })) });

  test('FY+2 and FY+3 from the consensus; the fade starts after them', () => {
    const e = evaluateDcf({ mode: 'auto', snapshot: nowSnap, overrides: consensus([null, 0.186, 0.165, null, null]), valuationDate: DATE });
    const g = e.model.scenarios.find((s) => s.key === 'base').growth;
    expect(g[0]).toBeCloseTo(e.derived.growth1.value, 12);
    expect(g[1]).toBe(0.186);
    expect(g[2]).toBe(0.165);
    expect(g[3]).toBeCloseTo(0.035 + (0.165 - 0.035) * 0.5, 12);
    expect(g[4]).toBeCloseTo(0.035 + (g[3] - 0.035) * 0.5, 12);
    expect(e.schedules.growthSources.map((s) => s.kind)).toEqual(['consensus', 'consensus', 'consensus', 'rule', 'rule']);
    expect(e.warnings.join(' ')).not.toMatch(/FY\+2 אינה מקונצנזוס/);
  });

  test('no FY+2 figure: the warning; k is a visible rule, 0.5 by default', () => {
    const e = evaluateDcf({ mode: 'auto', snapshot: nowSnap, valuationDate: DATE });
    expect(e.warnings).toContain('צמיחה ב-FY+2 אינה מקונצנזוס - היא נגזרת מכלל הדעיכה');
    expect(DEFAULT_RULES.fadeK).toBe(0.5);
    const slower = evaluateDcf({ mode: 'auto', snapshot: nowSnap, rules: Object.assign({}, DEFAULT_RULES, { fadeK: 0.8 }), valuationDate: DATE });
    expect(slower.model.scenarios[1].growth[1]).toBeCloseTo(0.035 + (e.derived.growth1.value - 0.035) * 0.8, 12);
  });
});

describe('the manual NOW preset', () => {
  const e = evaluateDcf({ mode: 'manual', manual: NOW_PRESET, valuationDate: DATE });
  const keys = ['bear', 'base', 'bull'];
  const withInputs = (key, extra) => Object.assign({}, NOW_PRESET.base, NOW_PRESET.scenarios.find((s) => s.key === key), extra || {});

  test('WACC 9.33%', () => within(e.main.wacc * 100, 9.33, 0.005));
  test('per share 60.1 / 127.4 / 166.5, weighted 120.3', () => {
    [60.1, 127.4, 166.5].forEach((v, i) => within(perShare(e)[i], v, 1));
    within(e.weighted, 120.3, 1);
  });
  test('IRR 6.0% / 8.8% / 10.3%', () => [6.0, 8.8, 10.3].forEach((v, i) => within(impliedReturn(withInputs(keys[i])) * 100, v, 0.05)));
  test('terminal value share 76% / 81% / 82%', () => [76, 81, 82].forEach((v, i) => within(e.results[keys[i]].tvShare * 100, v, 0.5)));
  test('exit multiple 20x: 66 / 140 / 184; 25x: 79 / 170 / 223', () => {
    [
      [20, [66, 140, 184]],
      [25, [79, 170, 223]]
    ].forEach(([m, values]) => values.forEach((v, i) => within(runDcf(withInputs(keys[i], { terminalMethod: 'exit', exitMultiple: m })).perShare, v, 1)));
  });
  test('sensitivity, base, gT 3.5%, WACC -2..+2: 198 / 155 / 127 / 108 / 93', () => {
    [198, 155, 127, 108, 93].forEach((v, i) => within(sensitivity(withInputs('base')).values[2][i], v, 1));
  });
});

describe('implied growth (reverse DCF)', () => {
  test('one constant growth rate for all five years that gives back the price', () => {
    const e = evaluateDcf({ mode: 'auto', snapshot: nowSnap, valuationDate: DATE });
    const inputs = Object.assign({}, e.model.base, e.model.scenarios.find((s) => s.key === 'base'));
    const g = impliedConstantGrowth(inputs);
    within(runDcf(Object.assign({}, inputs, { growth: [g, g, g, g, g] })).perShare, inputs.price, 1e-6);
    expect(e.impliedGrowth).toBe(g);
  });
});

describe('the input card, v2', () => {
  test('cash parts, the FCF basis, per-year sources, the added figures and the warnings - and it still reproduces', () => {
    const overrides = {
      growth: [null, { value: 0.186, source: 'קונצנזוס', asOf: '2026-10-17' }, null, null, null],
      fcfMargin: [{ value: 0.36, source: 'הנחיה', asOf: '2026-07-23' }, null, null, null, null],
      normalizedFcfTtm: { value: 4.92 * B, source: 'דוח החברה', asOf: '2026-07-23' },
      fcfBasis: 'reported'
    };
    const e = evaluateDcf({ mode: 'auto', snapshot: nowSnap, overrides, valuationDate: DATE });
    const card = JSON.parse(JSON.stringify(buildInputCard(e, nowSnap, 'NOW')));
    [['cash', 2.503], ['shortTermInvestments', 2.161], ['longTermMarketable', 2.043]].forEach(([k, v]) => expect(card.cash.parts[k] / B).toBeCloseTo(v, 6));
    expect(card.fcfBasis.chosen).toBe('reported');
    expect(card.fcfBasis.normalized.value).toBe(4.92 * B);
    expect(card.sources.growth.map((s) => s.kind)).toEqual(['consensus', 'consensus', 'rule', 'rule', 'rule']);
    expect(card.sources.fcfMargin.map((s) => s.kind)).toEqual(['guidance', 'held', 'held', 'held', 'held']);
    expect(card.overrides.growth[1].value).toBe(0.186);
    expect(card.warnings).toEqual(e.warnings);
    expect(card.notes.join(' ')).toMatch(/החלק שנותר מהשנה הנוכחית/);
    const { fromInputs, fromRaw } = reproduceFromCard(card);
    ['bear', 'base', 'bull'].forEach((k) => {
      expect(fromInputs.results[k].perShare).toBe(card.results.scenarios[k].perShare);
      expect(fromRaw.results[k].perShare).toBe(card.results.scenarios[k].perShare);
    });
  });
});
