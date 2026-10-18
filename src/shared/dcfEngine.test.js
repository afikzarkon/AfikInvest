/**
 * @jest-environment node
 */
// The engine against DCF_METHOD.md's sanity table (AVGO, 18.10.2026), and the
// properties any DCF must have. The table is the method's own check: a
// mismatch means the formula is wrong, never that an input wants tuning.
const { runDcf, impliedReturn, sensitivity, perShareAt, runScenarios, valueLabel, validateInputs } = require('./dcfEngine');
const { AVGO_PRESET } = require('./dcfRules');

const B = 1e9;
const scenario = (key) => AVGO_PRESET.scenarios.find((s) => s.key === key);
const inputsFor = (key, extra) => Object.assign({}, AVGO_PRESET.base, { growth: scenario(key).growth, fcfMargin: scenario(key).fcfMargin, sbcPct: scenario(key).sbcPct }, extra || {});
// "A deviation of up to $1 is allowed for rounding" - and the table's other
// figures are printed to one decimal.
const near = (actual, expected, tolerance) => expect(Math.abs(actual - expected)).toBeLessThanOrEqual(tolerance);

describe('DCF_METHOD.md sanity table (manual AVGO preset)', () => {
  const base = runDcf(inputsFor('base'));

  test('WACC 11.25%, from a cost of equity of 11.5% and an equity weight of 96.35%', () => {
    expect(base.ok).toBe(true);
    near(base.wacc * 100, 11.25, 0.005);
    near(base.ke * 100, 11.5, 1e-9);
    near(base.wE * 100, 96.35, 0.005);
  });

  test('revenue FY27-FY31: 172.6, 229.6, 264.0, 290.4, 310.7 (B)', () => {
    [172.6, 229.6, 264.0, 290.4, 310.7].forEach((v, i) => near(base.years[i].rev / B, v, 0.05));
  });

  test('FCF after SBC FY27-FY31: 65.6, 84.9, 95.0, 101.7, 108.8 (B)', () => {
    // FY30 computes to 101.64 - the table rounds the year's revenue first.
    [65.6, 84.9, 95.0, 101.7, 108.8].forEach((v, i) => near(base.years[i].adj / B, v, 0.07));
  });

  test('PV of the FCF 326.8B; terminal value 1,452.2B at an implied 13.4x; its PV 852.1B, 72% of EV', () => {
    near(base.sumPv / B, 326.8, 0.05);
    near(base.tv / B, 1452.2, 0.05);
    near(base.impliedExit, 13.4, 0.05);
    near(base.pvTv / B, 852.1, 0.05);
    near(base.tvShare * 100, 72, 0.5);
  });

  test('EV 1,178.9B, equity 1,143.5B', () => {
    near(base.ev / B, 1178.9, 0.05);
    near(base.equity / B, 1143.5, 0.05);
  });

  test('per share: conservative 117 / base 234 / management 326', () => {
    near(runDcf(inputsFor('conservative')).perShare, 117, 1);
    near(base.perShare, 234, 1);
    near(runDcf(inputsFor('management')).perShare, 326, 1);
  });

  test('upside -28.8%, margin of safety -40.5%', () => {
    near(base.upside * 100, -28.8, 0.05);
    near(base.marginOfSafety * 100, -40.5, 0.05);
  });

  test('IRR about 9.1%', () => {
    near(impliedReturn(inputsFor('base')) * 100, 9.1, 0.05);
  });

  test('sensitivity, row g = 3.5%, WACC -2..+2: 321, 271, 234, 206, 183', () => {
    const grid = sensitivity(inputsFor('base'));
    expect(grid.rows[2]).toBeCloseTo(0.035, 12);
    [321, 271, 234, 206, 183].forEach((v, i) => near(grid.values[2][i], v, 1));
  });

  test('exit-multiple method: 15x 255, 20x 321, 25x 386', () => {
    [[15, 255], [20, 321], [25, 386]].forEach(([m, v]) => near(runDcf(inputsFor('base', { terminalMethod: 'exit', exitMultiple: m })).perShare, v, 1));
  });
});

describe('properties', () => {
  const inputs = inputsFor('base');

  test('the value falls as WACC rises', () => {
    const values = [0.08, 0.09, 0.1, 0.11, 0.12, 0.14, 0.17].map((r) => perShareAt(inputs, r));
    values.slice(1).forEach((v, i) => expect(v).toBeLessThan(values[i]));
  });

  test('the value rises with growth, in any year', () => {
    for (let year = 0; year < 5; year += 1) {
      const more = inputs.growth.slice();
      more[year] += 0.05;
      expect(runDcf(Object.assign({}, inputs, { growth: more })).perShare).toBeGreaterThan(runDcf(inputs).perShare);
    }
  });

  test('the centre of the sensitivity grid is the main result, exactly', () => {
    expect(sensitivity(inputs).values[2][2]).toBe(runDcf(inputs).perShare);
  });

  test('at the IRR as the discount rate, the value is the price', () => {
    const irr = impliedReturn(inputs);
    near(perShareAt(inputs, irr), inputs.price, 1e-6);
  });

  // Under Gordon the terminal value grows without bound as the rate nears
  // gT, so "none" is the case of a final-year cash flow at or below zero.
  test('no IRR when even the lowest rate leaves the value under the price', () => {
    const burning = Object.assign({}, inputs, { sbcPct: [0.6, 0.6, 0.6, 0.6, 0.6] });
    expect(runDcf(burning).years[4].adj).toBeLessThan(0);
    expect(impliedReturn(burning)).toBeNull();
  });

  test('WACC at or below gT is an error, not a number', () => {
    const out = runDcf(Object.assign({}, inputs, { waccOverride: 0.035 }));
    expect(out.ok).toBe(false);
    expect(out.perShare).toBeUndefined();
    expect(out.errors[0]).toMatch(/חייב להיות גבוה מהצמיחה הסופית/);
  });

  test('a missing input is named, and nothing is valued', () => {
    const { rev0, ...rest } = inputs;
    expect(validateInputs(rest)).toContain('חסר הכנסות בסיס');
    expect(runDcf(rest).ok).toBe(false);
    expect(runDcf(Object.assign({}, inputs, { sbcPct: [0.05, 0.05] })).ok).toBe(false);
  });

  test('SBC is deducted unless deductSbc is false', () => {
    const without = runDcf(Object.assign({}, inputs, { deductSbc: false }));
    expect(without.perShare).toBeGreaterThan(runDcf(inputs).perShare);
    expect(without.years[0].adj).toBe(without.years[0].fcf);
  });

  test('the same input always gives the same output', () => {
    expect(JSON.stringify(runDcf(inputs))).toBe(JSON.stringify(runDcf(JSON.parse(JSON.stringify(inputs)))));
  });

  test('scenarios side by side, with the 25/50/25 weighted value', () => {
    const { results, weighted } = runScenarios(AVGO_PRESET.base, AVGO_PRESET.scenarios, AVGO_PRESET.weights);
    expect(weighted).toBeCloseTo(0.25 * results.conservative.perShare + 0.5 * results.base.perShare + 0.25 * results.management.perShare, 9);
  });

  test('labels: 15% upside or more is undervalued, 15% downside or more overvalued', () => {
    expect(valueLabel(0.15, 0.15)).toBe('UNDERVALUED');
    expect(valueLabel(0.1, 0.15)).toBe('FAIRLY_VALUED');
    expect(valueLabel(-0.288, 0.15)).toBe('OVERVALUED');
  });
});
