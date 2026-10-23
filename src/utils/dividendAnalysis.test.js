import { computeReceivedDividends } from './dividendAnalysis';

describe('computeReceivedDividends', () => {
  test('sums payments on/after the earliest purchase date, times total quantity held', () => {
    const history = [
      { date: '2023-06-01', amountPerShare: 0.5 }, // before purchase - excluded
      { date: '2024-03-01', amountPerShare: 0.51 },
      { date: '2024-06-01', amountPerShare: 0.51 }
    ];
    const lots = [{ quantity: 10, purchaseDate: '2024-01-01' }];
    // (0.51 + 0.51) * 10 = 10.2
    expect(computeReceivedDividends(history, lots)).toBeCloseTo(10.2, 6);
  });

  test('sums quantity across multiple lots of the same symbol', () => {
    const history = [{ date: '2024-06-01', amountPerShare: 1 }];
    const lots = [
      { quantity: 10, purchaseDate: '2024-01-01' },
      { quantity: 5, purchaseDate: '2024-03-01' }
    ];
    // earliest purchase date is 2024-01-01, so the payment counts; total qty = 15
    expect(computeReceivedDividends(history, lots)).toBe(15);
  });

  test('excludes every payment when the earliest purchase is after all of them', () => {
    const history = [{ date: '2024-01-01', amountPerShare: 1 }];
    const lots = [{ quantity: 10, purchaseDate: '2024-06-01' }];
    expect(computeReceivedDividends(history, lots)).toBe(0);
  });

  test('returns 0 for missing/empty history or lots without throwing', () => {
    expect(computeReceivedDividends([], [{ quantity: 10, purchaseDate: '2024-01-01' }])).toBe(0);
    expect(computeReceivedDividends(null, [{ quantity: 10, purchaseDate: '2024-01-01' }])).toBe(0);
    expect(computeReceivedDividends([{ date: '2024-01-01', amountPerShare: 1 }], [])).toBe(0);
    expect(computeReceivedDividends([{ date: '2024-01-01', amountPerShare: 1 }], null)).toBe(0);
  });

  test('returns 0 when lots have no purchaseDate at all', () => {
    const history = [{ date: '2024-01-01', amountPerShare: 1 }];
    const lots = [{ quantity: 10 }];
    expect(computeReceivedDividends(history, lots)).toBe(0);
  });

  test('a lot bought after a payment is not credited with it', () => {
    const history = [
      { date: '2024-02-01', amountPerShare: 1 },
      { date: '2024-06-01', amountPerShare: 1 }
    ];
    const lots = [
      { quantity: 10, purchaseDate: '2024-01-01' },
      { quantity: 5, purchaseDate: '2024-03-01' }
    ];
    // February: the first lot only; June: both.
    expect(computeReceivedDividends(history, lots)).toBe(10 + 15);
  });

  test('a share bought on the ex-dividend date is not entitled to that payment', () => {
    const history = [{ date: '2024-06-01', amountPerShare: 1 }];
    expect(computeReceivedDividends(history, [{ quantity: 10, purchaseDate: '2024-06-01' }])).toBe(0);
    expect(computeReceivedDividends(history, [{ quantity: 10, purchaseDate: '2024-05-31' }])).toBe(10);
  });
});
