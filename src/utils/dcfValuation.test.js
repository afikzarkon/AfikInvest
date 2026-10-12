import { computeDcf, dcfSensitivity, classifyMarginOfSafety, suggestDcfInputs, validateDcfInput, baseFcf } from './dcfValuation';

const input = {
  fcfHistory: [90, 100, 110],
  growthRate: 0.08,
  discountRate: 0.09,
  terminalGrowth: 0.025,
  cash: 200,
  debt: 500,
  sharesDiluted: 100,
  marketPrice: 15
};

test('matches a hand calculation', () => {
  const out = computeDcf(input);
  let pv = 0;
  let f = 100;
  for (let t = 1; t <= 5; t += 1) {
    f *= 1.08;
    pv += f / 1.09 ** t;
  }
  const tv = (f * 1.025) / (0.09 - 0.025);
  const iv = (pv + tv / 1.09 ** 5 + 200 - 500) / 100;
  expect(out.errors).toEqual([]);
  expect(out.baseFcf).toBe(100);
  expect(out.intrinsicPerShare).toBeCloseTo(iv, 10);
  expect(out.intrinsicPerShare).toBeCloseTo(16.92, 2);
  expect(out.pvStage1).toBeCloseTo(486.4, 1);
  expect(out.pvTerminal).toBeCloseTo(1505.9, 1);
  expect(out.marginOfSafety).toBeCloseTo(0.1136, 3);
  expect(out.upside).toBeCloseTo(16.92 / 15 - 1, 3);
  expect(out.verdict).toBe('UNDERVALUED');
  expect(out.projections).toHaveLength(5);
  expect(out.warnings.join()).toMatch(/טרמינל/);
});

test('base FCF: 3-year average or latest', () => {
  expect(baseFcf([1, 90, 100, 110])).toBe(100);
  expect(baseFcf([90, 100, 110], 'latest')).toBe(110);
  expect(computeDcf({ ...input, baseMethod: 'latest' }).baseFcf).toBe(110);
});

test('verdict band is +/-10% by default and configurable', () => {
  expect(classifyMarginOfSafety(0.11)).toBe('UNDERVALUED');
  expect(classifyMarginOfSafety(0.05)).toBe('FAIRLY_VALUED');
  expect(classifyMarginOfSafety(-0.2)).toBe('OVERVALUED');
  expect(classifyMarginOfSafety(0.2, 0.3)).toBe('FAIRLY_VALUED');
  expect(classifyMarginOfSafety(null)).toBe('N/A');
  expect(computeDcf({ ...input, marketPrice: 30 }).verdict).toBe('OVERVALUED');
});

test('guardrails: r must exceed g_inf by 1pp; ranges; negative FCF is refused', () => {
  expect(validateDcfInput({ ...input, discountRate: 0.03 })).toContain('שיעור היוון מחוץ לטווח 4% עד 20%');
  expect(validateDcfInput({ ...input, discountRate: 0.045, terminalGrowth: 0.04 }).join()).toMatch(/נקודת אחוז/);
  expect(validateDcfInput({ ...input, growthRate: 0.5 }).join()).toMatch(/צמיחה/);
  expect(validateDcfInput({ ...input, sharesDiluted: 0 }).join()).toMatch(/מניות/);
  const neg = computeDcf({ ...input, fcfHistory: [-10, -5, 1] });
  expect(neg.errors.join()).toMatch(/אינו חיובי/);
  expect(neg.intrinsicPerShare).toBeUndefined();
});

test('warnings for volatile FCF, short history and heroic growth', () => {
  expect(computeDcf({ ...input, fcfHistory: [10, 100, 300] }).warnings.join()).toMatch(/תנודתי/);
  expect(computeDcf({ ...input, fcfHistory: [100] }).warnings.join()).toMatch(/רק 1 שנות/);
  expect(computeDcf({ ...input, growthRate: 0.3 }).warnings.join()).toMatch(/25%/);
});

test('sensitivity grid around the chosen inputs', () => {
  const s = dcfSensitivity(input);
  expect(s.discountRates.map((x) => +x.toFixed(3))).toEqual([0.08, 0.085, 0.09, 0.095, 0.1]);
  expect(s.growthRates.map((x) => +x.toFixed(2))).toEqual([0.06, 0.07, 0.08, 0.09, 0.1]);
  expect(s.values[2][2]).toBeCloseTo(computeDcf(input).intrinsicPerShare, 10);
  expect(s.values[0][4]).toBeCloseTo(22.71, 2); // r 8%, g 10%
  expect(s.values[4][0]).toBeCloseTo(12.84, 2); // r 10%, g 6%
  // monotone: higher r -> lower value, higher g -> higher value
  expect(s.values[0][2]).toBeGreaterThan(s.values[4][2]);
  expect(s.values[2][4]).toBeGreaterThan(s.values[2][0]);
  // r too close to g_inf -> null
  expect(dcfSensitivity({ ...input, discountRate: 0.035 }).values[0][0]).toBeNull();
});

test('suggested inputs: analyst growth, else history; CAPM discount rate', () => {
  expect(suggestDcfInputs({ analystGrowth5y: 0.12, beta: 1.2, riskFreeRate: 0.04 })).toMatchObject({ growthRate: 0.12, growthSource: 'analysts', discountRate: 0.1 });
  const h = suggestDcfInputs({ fcfHistory: [100, 121], beta: null });
  expect(h.growthSource).toBe('history');
  expect(h.growthRate).toBeCloseTo(0.2, 10); // 21% CAGR clamped to 20%
  expect(h.discountRate).toBeCloseTo(0.093, 10); // 4.3% + 1 * 5%
  expect(suggestDcfInputs({ fcfHistory: [-1, 5] })).toMatchObject({ growthRate: 0.05, growthSource: 'default' });
  expect(suggestDcfInputs({ beta: 3 }).discountRate).toBe(0.15);
});
