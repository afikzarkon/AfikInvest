import { modifiedDietzWeight, calculateModifiedDietzReturn } from './modifiedDietz';

describe('modifiedDietzWeight', () => {
  test('a flow at the very start of the period gets weight 1 (invested for the whole period)', () => {
    expect(modifiedDietzWeight('2024-01-01', '2024-01-31', '2024-01-01')).toBeCloseTo(1, 5);
  });

  test('a flow at the very end of the period gets weight 0 (no time to grow)', () => {
    expect(modifiedDietzWeight('2024-01-01', '2024-01-31', '2024-01-31')).toBeCloseTo(0, 5);
  });

  test('a flow exactly halfway through the period gets weight 0.5', () => {
    expect(modifiedDietzWeight('2024-01-01', '2024-01-31', '2024-01-16')).toBeCloseTo(0.5, 1);
  });

  test('clamps a flow date outside the period to the nearest boundary instead of extrapolating', () => {
    expect(modifiedDietzWeight('2024-01-01', '2024-01-31', '2023-12-01')).toBeCloseTo(1, 5);
    expect(modifiedDietzWeight('2024-01-01', '2024-01-31', '2024-06-01')).toBeCloseTo(0, 5);
  });

  test('returns 0 for an invalid/missing date or a zero-length period, never throws', () => {
    expect(modifiedDietzWeight('2024-01-01', '2024-01-31', 'not-a-date')).toBe(0);
    expect(modifiedDietzWeight('2024-01-01', '2024-01-01', '2024-01-01')).toBe(0);
    expect(modifiedDietzWeight(undefined, '2024-01-31', '2024-01-15')).toBe(0);
  });
});

describe('calculateModifiedDietzReturn', () => {
  test('with no cash flows, reduces to a plain percent change', () => {
    const result = calculateModifiedDietzReturn({
      beginningValue: 100000,
      endingValue: 110000,
      cashFlows: [],
      periodStart: '2024-01-01',
      periodEnd: '2024-01-31'
    });
    expect(result.netCashFlow).toBe(0);
    expect(result.percent).toBeCloseTo(10, 5);
  });

  // This is the exact bug being fixed: a mid-period deposit must not be
  // counted as investment growth. Portfolio starts at 100,000, a 10,000
  // deposit lands exactly halfway through the month with zero real market
  // movement (the deposited cash itself doesn't grow either) - naive
  // (endValue/startValue-1) would wrongly show +10%, the true return is 0%.
  test('a mid-period deposit with zero real growth shows ~0%, not the naive +10%', () => {
    const result = calculateModifiedDietzReturn({
      beginningValue: 100000,
      endingValue: 110000, // 100,000 (unchanged) + 10,000 deposit, no growth
      cashFlows: [{ date: '2024-01-16', amount: 10000 }],
      periodStart: '2024-01-01',
      periodEnd: '2024-01-31'
    });
    expect(result.netCashFlow).toBe(10000);
    expect(result.percent).toBeCloseTo(0, 0);
  });

  test('a deposit on day 1 (weight 1) is fully counted in the denominator, so real growth on top of it is measured correctly', () => {
    // 100,000 + 10,000 deposited immediately, then the whole 110,000 grows 10%.
    const result = calculateModifiedDietzReturn({
      beginningValue: 100000,
      endingValue: 121000, // 110,000 * 1.10
      cashFlows: [{ date: '2024-01-01', amount: 10000 }],
      periodStart: '2024-01-01',
      periodEnd: '2024-01-31'
    });
    expect(result.percent).toBeCloseTo(10, 5);
  });

  test('a deposit on the very last day barely affects the return even though EMV jumped', () => {
    const result = calculateModifiedDietzReturn({
      beginningValue: 100000,
      endingValue: 110500, // 100,000 grew to 100,500 (0.5%) + a same-day 10,000 deposit
      cashFlows: [{ date: '2024-01-31', amount: 10000 }],
      periodStart: '2024-01-01',
      periodEnd: '2024-01-31'
    });
    expect(result.percent).toBeCloseTo(0.5, 1);
  });

  test('a withdrawal (negative cash flow) is netted out symmetrically', () => {
    // 100,000, withdrew 20,000 halfway through, ended at 85,000 -> real
    // growth on the money that stayed invested is +5,000 on a ~90,000 base.
    const result = calculateModifiedDietzReturn({
      beginningValue: 100000,
      endingValue: 85000,
      cashFlows: [{ date: '2024-01-16', amount: -20000 }],
      periodStart: '2024-01-01',
      periodEnd: '2024-01-31'
    });
    expect(result.netCashFlow).toBe(-20000);
    expect(result.gain).toBe(5000); // 85000 - 100000 - (-20000)
    expect(result.percent).toBeGreaterThan(0);
  });

  test('multiple cash flows are each weighted by their own date', () => {
    const result = calculateModifiedDietzReturn({
      beginningValue: 0,
      endingValue: 20000,
      cashFlows: [
        { date: '2024-01-01', amount: 10000 },
        { date: '2024-01-31', amount: 10000 }
      ],
      periodStart: '2024-01-01',
      periodEnd: '2024-01-31'
    });
    expect(result.netCashFlow).toBe(20000);
    // weightedCashFlow ~= 10000*1 + 10000*0 = 10000
    expect(result.weightedCashFlow).toBeCloseTo(10000, 0);
  });

  test('a zero denominator (no beginning value and no early cash flow) returns null instead of Infinity/NaN', () => {
    const result = calculateModifiedDietzReturn({
      beginningValue: 0,
      endingValue: 5000,
      cashFlows: [{ date: '2024-01-31', amount: 5000 }], // weight ~0
      periodStart: '2024-01-01',
      periodEnd: '2024-01-31'
    });
    expect(result.percent).toBeNull();
  });

  test('does not throw on missing/undefined inputs', () => {
    expect(() => calculateModifiedDietzReturn({})).not.toThrow();
  });
});

describe('calculateModifiedDietzReturn - no return over a base at or below zero', () => {
  test('a withdrawal that outweighs the opening value leaves no percent', () => {
    const r = calculateModifiedDietzReturn({
      beginningValue: 1000,
      endingValue: 100,
      cashFlows: [{ date: '2026-01-02', amount: -2000 }],
      periodStart: '2026-01-01',
      periodEnd: '2026-01-31'
    });
    expect(r.percent).toBeNull();
    expect(r.gain).toBeCloseTo(1100, 9);
  });
});
