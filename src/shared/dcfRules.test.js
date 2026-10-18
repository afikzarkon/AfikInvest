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
    const [bear, base, bull] = rules.autoScenarios(d, DEFAULT_RULES);
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

  test('beta and the risk-free rate fall back to the configured values, flagged', () => {
    const snap = clone(avgo);
    snap.betaRaw = null;
    snap.rf = null;
    const e = evaluateDcf({ mode: 'auto', snapshot: snap, valuationDate: DATE });
    expect(e.derived.betaRaw).toMatchObject({ value: 1, fallback: true });
    expect(e.derived.beta.value).toBeCloseTo(1, 12);
    expect(e.derived.rf).toMatchObject({ value: 0.045, fallback: true });
    expect(e.flags.join(' ')).toMatch(/בטא חסרה/);
    expect(e.flags.join(' ')).toMatch(/10 שנים חסרה/);
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
    expect(evaluateDcf({ mode: 'auto', snapshot: avgo, valuationDate: DATE }).warnings).toEqual([]);
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
