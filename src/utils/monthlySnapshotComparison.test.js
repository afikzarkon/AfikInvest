import {
  compareMonthlySnapshots,
  normalizeCategoryItems,
  isLegacyRollup,
  buildManualCashFlows,
  MONTHLY_CATEGORY_KEYS,
  MONTHLY_CATEGORY_LABELS_HE,
  AUTO_DERIVED_CATEGORIES,
  MANUAL_ENTRY_CATEGORIES,
  snapshotAsOfDate
} from './monthlySnapshotComparison';

const january = {
  month: '2024-01',
  totalValueILS: 100000,
  breakdown: {
    israeli: [{ key: 'TEVA', label: 'TEVA', value: 20000 }],
    american: [
      { key: 'PLTR', label: 'PLTR', value: 12000 },
      { key: 'AAPL', label: 'AAPL', value: 18000 }
    ],
    pension: [{ key: 'קופה א', label: 'קופה א', value: 40000 }],
    cashFunds: [{ key: 'קרן X', label: 'קרן X', value: 5000 }],
    bank: [{ key: 'bank-1', label: 'עו"ש', value: 5000 }]
  }
};

const february = {
  month: '2024-02',
  totalValueILS: 110000,
  breakdown: {
    israeli: [{ key: 'TEVA', label: 'TEVA', value: 22000 }],
    american: [
      { key: 'PLTR', label: 'PLTR', value: 15000 },
      { key: 'AAPL', label: 'AAPL', value: 17000 }
      // note: no new stock added/removed vs. january in this fixture
    ],
    pension: [{ key: 'קופה א', label: 'קופה א', value: 44000 }],
    cashFunds: [{ key: 'קרן X', label: 'קרן X', value: 5000 }],
    bank: [{ key: 'bank-1', label: 'עו"ש', value: 12000 }]
  }
};

describe('normalizeCategoryItems', () => {
  test('passes through the itemized array shape as-is', () => {
    const items = [{ key: 'TEVA', label: 'TEVA', value: 100 }];
    expect(normalizeCategoryItems(items, 'israeli')).toEqual(items);
  });

  test('wraps the legacy flat-number shape (pre-itemized snapshots) as a single item', () => {
    expect(normalizeCategoryItems(5000, 'bank')).toEqual([{ key: 'bank', label: 'עו"ש', value: 5000 }]);
  });

  test('returns an empty array for missing/invalid category data', () => {
    expect(normalizeCategoryItems(undefined, 'bank')).toEqual([]);
    expect(normalizeCategoryItems(null, 'bank')).toEqual([]);
    expect(normalizeCategoryItems('not a number', 'bank')).toEqual([]);
  });
});

describe('isLegacyRollup', () => {
  test('true for the single synthetic item normalizeCategoryItems() produces from a legacy flat number', () => {
    expect(isLegacyRollup(normalizeCategoryItems(5000, 'bank'), 'bank')).toBe(true);
  });

  test('false for a real itemized list, even a single-holding one', () => {
    expect(isLegacyRollup([{ key: 'TEVA', label: 'TEVA', value: 5000 }], 'israeli')).toBe(false);
  });

  test('false for an empty list or multiple items', () => {
    expect(isLegacyRollup([], 'bank')).toBe(false);
    expect(
      isLegacyRollup(
        [
          { key: 'TEVA', label: 'TEVA', value: 1 },
          { key: 'AAPL', label: 'AAPL', value: 2 }
        ],
        'israeli'
      )
    ).toBe(false);
  });
});

describe('compareMonthlySnapshots', () => {
  test('returns one row per category plus a trailing total row', () => {
    const rows = compareMonthlySnapshots(january, february);
    expect(rows.map((r) => r.key)).toEqual([...MONTHLY_CATEGORY_KEYS, 'total']);
    rows.slice(0, -1).forEach((r) => expect(r.label).toBe(MONTHLY_CATEGORY_LABELS_HE[r.key]));
    expect(rows[rows.length - 1].label).toBe('סה"כ תיק');
  });

  test('computes category subtotals (sum of items) and % change', () => {
    const rows = compareMonthlySnapshots(january, february);
    const american = rows.find((r) => r.key === 'american');
    expect(american.baseValue).toBe(30000); // 12000 + 18000
    expect(american.compareValue).toBe(32000); // 15000 + 17000
    expect(american.changePercent).toBeCloseTo(((32000 - 30000) / 30000) * 100, 5);
  });

  test('each category row carries per-item rows matched across the two months by key', () => {
    const rows = compareMonthlySnapshots(january, february);
    const american = rows.find((r) => r.key === 'american');
    const pltr = american.items.find((i) => i.key === 'PLTR');
    expect(pltr.baseValue).toBe(12000);
    expect(pltr.compareValue).toBe(15000);
    expect(pltr.changePercent).toBeCloseTo(25, 5);
    expect(american.items.map((i) => i.key).sort()).toEqual(['AAPL', 'PLTR']);
  });

  test('an item bought since the base month (present only in the compare snapshot) gets a null base value/% change, not 0', () => {
    const febWithNewStock = {
      ...february,
      breakdown: {
        ...february.breakdown,
        american: [...february.breakdown.american, { key: 'NVDA', label: 'NVDA', value: 9000 }]
      }
    };
    const rows = compareMonthlySnapshots(january, febWithNewStock);
    const american = rows.find((r) => r.key === 'american');
    const nvda = american.items.find((i) => i.key === 'NVDA');
    expect(nvda.baseValue).toBeNull();
    expect(nvda.compareValue).toBe(9000);
    expect(nvda.changePercent).toBeNull();
  });

  test('an item sold since the base month (present only in the base snapshot) gets a null compare value/% change, not 0', () => {
    const janWithExtraStock = {
      ...january,
      breakdown: {
        ...january.breakdown,
        american: [...january.breakdown.american, { key: 'MSFT', label: 'MSFT', value: 4000 }]
      }
    };
    const rows = compareMonthlySnapshots(janWithExtraStock, february);
    const american = rows.find((r) => r.key === 'american');
    const msft = american.items.find((i) => i.key === 'MSFT');
    expect(msft.baseValue).toBe(4000);
    expect(msft.compareValue).toBeNull();
    expect(msft.changePercent).toBeNull();
  });

  test('computes the trailing total row from totalValueILS, not a sum of the categories', () => {
    const rows = compareMonthlySnapshots(january, february);
    const total = rows.find((r) => r.key === 'total');
    expect(total.baseValue).toBe(100000);
    expect(total.compareValue).toBe(110000);
    expect(total.changePercent).toBeCloseTo(10, 5);
    expect(total.items).toEqual([]);
  });

  test('a category entirely missing from one snapshot (e.g. no pension funds yet that month) gets null values/change, not 0', () => {
    const noPension = { ...january, breakdown: { ...january.breakdown, pension: [] } };
    const rows = compareMonthlySnapshots(noPension, february);
    const pension = rows.find((r) => r.key === 'pension');
    expect(pension.baseValue).toBeNull();
    expect(pension.compareValue).toBe(44000);
    expect(pension.changePercent).toBeNull();
  });

  test('is backward-compatible with legacy snapshots saved as flat category numbers (pre-itemized) - category totals/% change still work, even though there is no per-stock detail to match against the itemized month', () => {
    const legacyJanuary = {
      month: '2024-01',
      totalValueILS: 100000,
      breakdown: { israeli: 20000, american: 30000, pension: 40000, cashFunds: 5000, bank: 5000 }
    };
    const rows = compareMonthlySnapshots(legacyJanuary, february);
    const israeli = rows.find((r) => r.key === 'israeli');
    expect(israeli.baseValue).toBe(20000);
    expect(israeli.compareValue).toBe(22000);
    expect(israeli.changePercent).toBeCloseTo(10, 5);
    // the legacy side has no per-stock keys to match against, so the
    // itemized TEVA row and the legacy category-as-one-item row both show
    // up, each with the other side null - not silently merged/dropped
    expect(israeli.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: 'TEVA', label: 'TEVA', baseValue: null, compareValue: 22000, changePercent: null }),
        expect.objectContaining({ key: 'israeli', label: 'בורסה ישראלית', baseValue: 20000, compareValue: null, changePercent: null })
      ])
    );
  });

  test('a base value of 0 yields a null % change rather than Infinity/NaN', () => {
    const zeroBank = { ...january, breakdown: { ...january.breakdown, bank: [{ key: 'bank-1', label: 'עו"ש', value: 0 }] } };
    const rows = compareMonthlySnapshots(zeroBank, february);
    const bank = rows.find((r) => r.key === 'bank');
    expect(bank.baseValue).toBe(0);
    expect(bank.changePercent).toBeNull();
  });

  test('returns an empty array when either snapshot is missing', () => {
    expect(compareMonthlySnapshots(null, february)).toEqual([]);
    expect(compareMonthlySnapshots(january, null)).toEqual([]);
    expect(compareMonthlySnapshots(null, null)).toEqual([]);
  });

  describe('contribution adjustment (liveHoldings param)', () => {
    // The exact bug report: a mid-period deposit/purchase must not be
    // counted as investment growth. TEVA (israeli) goes from 20,000 to
    // 32,000 - looks like a huge +60% naive gain, but 10,000 of that is a
    // brand new share purchase mid-month with zero real price movement on
    // top of it (20,000 stayed 20,000, +10,000 fresh purchase = 30,000...
    // here compareValue is 32,000, i.e. a real +2,000/10% gain on the
    // ORIGINAL 20,000 stake, which is what the adjusted % should reflect).
    const febWithMidMonthPurchase = {
      ...february,
      breakdown: { ...february.breakdown, israeli: [{ key: 'TEVA', label: 'TEVA', value: 32000 }] }
    };
    const liveHoldings = {
      israeliStocks: [
        { stockName: 'TEVA', purchaseDate: '2023-06-01', purchasePrice: 100, quantity: 200 }, // pre-existing lot (before january) - not a flow in this period
        { stockName: 'TEVA', purchaseDate: '2024-02-15', purchasePrice: 50, quantity: 200 } // 10,000 mid-february purchase
      ],
      americanStocks: [],
      pensionFunds: [],
      bankSavingsFunds: []
    };

    test('nets a mid-period stock purchase out of the naive % so it is not counted as growth', () => {
      const rows = compareMonthlySnapshots(january, febWithMidMonthPurchase, liveHoldings);
      const israeli = rows.find((r) => r.key === 'israeli');
      expect(israeli.rawChangePercent).toBeCloseTo(60, 5); // (32000/20000-1)*100, the misleading naive figure
      expect(israeli.netCashFlow).toBe(10000);
      expect(israeli.contributionAdjusted).toBe(true);
      // adjusted % should be much closer to the real ~10% growth on the
      // original stake than to the naive 60%
      expect(israeli.changePercent).toBeLessThan(20);
      expect(israeli.changePercent).toBeGreaterThan(0);
    });

    test('per-item rows are adjusted too, matched by the same key as the itemized breakdown', () => {
      const rows = compareMonthlySnapshots(january, febWithMidMonthPurchase, liveHoldings);
      const israeli = rows.find((r) => r.key === 'israeli');
      const teva = israeli.items.find((i) => i.key === 'TEVA');
      expect(teva.netCashFlow).toBe(10000);
      expect(teva.contributionAdjusted).toBe(true);
      expect(teva.changePercent).toBeLessThan(20);
    });

    test('categories without a deposit/purchase ledger (bank, cashFunds) are left with the naive % unchanged', () => {
      const rows = compareMonthlySnapshots(january, february, liveHoldings);
      const bank = rows.find((r) => r.key === 'bank');
      expect(bank.contributionAdjusted).toBe(false);
      expect(bank.changePercent).toBeCloseTo(((12000 - 5000) / 5000) * 100, 5); // unchanged naive %
      expect(bank.netCashFlow).toBe(0);
    });

    test('a pension deposit mid-period is netted out via the fund\'s own deposits ledger', () => {
      const febWithPensionDeposit = {
        ...february,
        breakdown: { ...february.breakdown, pension: [{ key: 'קופה א', label: 'קופה א', value: 54000 }] } // +10,000 vs. naive 44,000
      };
      const holdingsWithPensionDeposit = {
        ...liveHoldings,
        pensionFunds: [
          { fundName: 'קופה א', deposits: [{ date: '2023-06-01', amount: 40000 }, { date: '2024-02-10', amount: 10000 }] }
        ]
      };
      const rows = compareMonthlySnapshots(january, febWithPensionDeposit, holdingsWithPensionDeposit);
      const pension = rows.find((r) => r.key === 'pension');
      expect(pension.netCashFlow).toBe(10000);
      expect(pension.contributionAdjusted).toBe(true);
    });

    test('without liveHoldings, behaves exactly as before (no adjustment fields set to true)', () => {
      const rows = compareMonthlySnapshots(january, febWithMidMonthPurchase);
      const israeli = rows.find((r) => r.key === 'israeli');
      expect(israeli.contributionAdjusted).toBe(false);
      expect(israeli.changePercent).toBeCloseTo(60, 5);
    });

    test('the total row is marked partiallyAdjusted (cash/bank flows are never netted out of it)', () => {
      const rows = compareMonthlySnapshots(january, february, liveHoldings);
      const total = rows.find((r) => r.key === 'total');
      expect(total.partiallyAdjusted).toBe(true);
    });

    // Regression test: a purchase dated *within* the base month itself
    // (not just long before it) must NOT be treated as an in-period flow,
    // even though the base month's own snapshot-save-day is unknown. This
    // was a real bug caught during manual verification: with too-generous
    // a periodStart (base month's own day 1), a lot bought on, say,
    // January 5th - already fully reflected in the January snapshot's
    // value - was wrongly netted out a *second* time, swinging a flat 0%
    // real change into a wildly wrong negative percentage.
    test('a purchase dated within the base month itself (not just before it) is also not double-counted', () => {
      const lotWithinBaseMonth = {
        ...liveHoldings,
        israeliStocks: [{ stockName: 'TEVA', purchaseDate: '2024-01-05', purchasePrice: 100, quantity: 200 }]
      };
      const rows = compareMonthlySnapshots(january, february, lotWithinBaseMonth);
      const israeli = rows.find((r) => r.key === 'israeli');
      expect(israeli.netCashFlow).toBe(0);
      expect(israeli.changePercent).toBeCloseTo(10, 5); // 22000/20000-1, unaffected
    });

    test('a purchase from before the compared period (already reflected in the base value) is not double-counted as a flow', () => {
      const onlyOldLot = {
        ...liveHoldings,
        israeliStocks: [{ stockName: 'TEVA', purchaseDate: '2023-06-01', purchasePrice: 100, quantity: 200 }]
      };
      const rows = compareMonthlySnapshots(january, february, onlyOldLot);
      const israeli = rows.find((r) => r.key === 'israeli');
      // the lot is dated 2023-06-01, well before january - it must not
      // appear as an in-period cash flow
      expect(israeli.netCashFlow).toBe(0);
      expect(israeli.changePercent).toBeCloseTo(10, 5); // 22000/20000-1
    });
  });

  describe('manually-declared cash flows (allSnapshots param) - the only source for עו"ש/קרנות כספיות', () => {
    test('a user-declared bank deposit on the compare snapshot nets out of the naive % for a category with no ledger at all', () => {
      // bank went 5,000 -> 12,000 (naive +140%), but the user declared a
      // 6,000 ILS deposit (not growth) when saving february.
      const februaryWithDeclaredDeposit = {
        ...february,
        breakdown: { ...february.breakdown, cashFlows: { bank: 6000 } }
      };
      const rows = compareMonthlySnapshots(january, februaryWithDeclaredDeposit, null, [january, februaryWithDeclaredDeposit]);
      const bank = rows.find((r) => r.key === 'bank');
      expect(bank.contributionAdjusted).toBe(true);
      expect(bank.netCashFlow).toBe(6000);
      expect(bank.changePercent).toBeLessThan(140);
    });

    test('a negative declared amount (a withdrawal/sale) is netted out symmetrically, for a category that does have a ledger too', () => {
      // TEVA (israeli) went 20,000 -> 22,000 (naive +10%) - the naive
      // number is actually already "real" growth here, but the user also
      // declares a 5,000 sale, meaning the *true* underlying growth is
      // larger than the naive number suggests once the missing 5,000 is
      // accounted for.
      const februaryWithSale = {
        ...february,
        breakdown: { ...february.breakdown, cashFlows: { israeli: -5000 } }
      };
      const rows = compareMonthlySnapshots(january, februaryWithSale, null, [january, februaryWithSale]);
      const israeli = rows.find((r) => r.key === 'israeli');
      expect(israeli.netCashFlow).toBe(-5000);
      expect(israeli.changePercent).toBeGreaterThan(10);
    });

    test('without allSnapshots, declared cashFlows on the snapshots themselves are silently ignored (backward compatible)', () => {
      const februaryWithDeclaredDeposit = {
        ...february,
        breakdown: { ...february.breakdown, cashFlows: { bank: 6000 } }
      };
      const rows = compareMonthlySnapshots(january, februaryWithDeclaredDeposit);
      const bank = rows.find((r) => r.key === 'bank');
      expect(bank.contributionAdjusted).toBe(false);
      expect(bank.changePercent).toBeCloseTo(140, 5);
    });

    test('a flow declared on an intermediate month (not either endpoint) is still picked up for a multi-month comparison', () => {
      const march = {
        month: '2024-03',
        totalValueILS: 90000,
        breakdown: { bank: [{ key: 'bank-1', label: 'עו"ש', value: 7000 }], cashFlows: { bank: -5000 } } // a 5,000 withdrawal declared on March
      };
      const rows = compareMonthlySnapshots(january, march, null, [january, february, march]);
      const bank = rows.find((r) => r.key === 'bank');
      expect(bank.netCashFlow).toBe(-5000);
      expect(bank.contributionAdjusted).toBe(true);
    });

    test('a flow declared on a month outside the compared range (before base or after compare) is not picked up', () => {
      const december2023 = {
        month: '2023-12',
        totalValueILS: 80000,
        breakdown: { bank: [{ key: 'bank-1', label: 'עו"ש', value: 4000 }], cashFlows: { bank: 9999 } }
      };
      const rows = compareMonthlySnapshots(january, february, null, [december2023, january, february]);
      const bank = rows.find((r) => r.key === 'bank');
      expect(bank.netCashFlow).toBe(0);
      expect(bank.contributionAdjusted).toBe(false);
    });

    test('auto-detected and manually-declared flows for the same ledger category are additive, not overridden', () => {
      const liveHoldings = { israeliStocks: [{ stockName: 'TEVA', purchaseDate: '2024-02-10', purchasePrice: 50, quantity: 200 }], americanStocks: [], pensionFunds: [], bankSavingsFunds: [] };
      const februaryWithSale = { ...february, breakdown: { ...february.breakdown, cashFlows: { israeli: -2000 } } };
      const rows = compareMonthlySnapshots(january, februaryWithSale, liveHoldings, [january, februaryWithSale]);
      const israeli = rows.find((r) => r.key === 'israeli');
      // +10,000 auto-detected purchase, -2,000 manually-declared sale -> net 8,000
      expect(israeli.netCashFlow).toBe(8000);
    });

    test('the total row stops being "partiallyAdjusted" once every non-ledger category has declared data for this comparison', () => {
      const februaryFullyDeclared = {
        ...february,
        breakdown: { ...february.breakdown, cashFlows: { bank: 6000, cashFunds: 0 } }
      };
      // cashFunds declared as exactly 0 doesn't count as "has data" (indistinguishable from "not provided") - so this should still be partial
      const rowsStillPartial = compareMonthlySnapshots(january, februaryFullyDeclared, null, [january, februaryFullyDeclared]);
      expect(rowsStillPartial.find((r) => r.key === 'total').partiallyAdjusted).toBe(true);

      const februaryTrulyFullyDeclared = {
        ...february,
        breakdown: { ...february.breakdown, cashFlows: { bank: 6000, cashFunds: 500 } }
      };
      const rows = compareMonthlySnapshots(january, februaryTrulyFullyDeclared, null, [january, februaryTrulyFullyDeclared]);
      expect(rows.find((r) => r.key === 'total').partiallyAdjusted).toBe(false);
    });
  });

  describe('buildManualCashFlows', () => {
    test('collects a declared amount per category from a snapshot strictly after baseMonth and up to/including compareMonth', () => {
      const snap = { month: '2024-02', breakdown: { cashFlows: { bank: 6000, israeli: -1000 } } };
      const flows = buildManualCashFlows([snap], '2024-01', '2024-02');
      // Timing within the period is unknown, so the flow is dated to its
      // middle (half-weighted) - here Feb 1 -> Feb 29, there being no
      // earlier checkpoint to open the period.
      expect(flows.bank).toEqual([{ date: '2024-02-15', amount: 6000 }]);
      expect(flows.israeli).toEqual([{ date: '2024-02-15', amount: -1000 }]);
      expect(flows.pension).toEqual([]);
    });

    test('excludes a snapshot dated on or before baseMonth, or after compareMonth', () => {
      const onBase = { month: '2024-01', breakdown: { cashFlows: { bank: 100 } } };
      const afterCompare = { month: '2024-03', breakdown: { cashFlows: { bank: 200 } } };
      const flows = buildManualCashFlows([onBase, afterCompare], '2024-01', '2024-02');
      expect(flows.bank).toEqual([]);
    });

    test('ignores a zero or missing declared amount, and a snapshot with no cashFlows/breakdown at all', () => {
      const zero = { month: '2024-02', breakdown: { cashFlows: { bank: 0 } } };
      const noCashFlows = { month: '2024-02', breakdown: {} };
      const noBreakdown = { month: '2024-02' };
      const flows = buildManualCashFlows([zero, noCashFlows, noBreakdown], '2024-01', '2024-02');
      expect(flows.bank).toEqual([]);
    });

    test('every category key is always present (empty array), even with no snapshots at all', () => {
      const flows = buildManualCashFlows([], '2024-01', '2024-02');
      MONTHLY_CATEGORY_KEYS.forEach((key) => expect(flows[key]).toEqual([]));
    });

    test('does not throw on missing/malformed input', () => {
      expect(() => buildManualCashFlows(undefined, '2024-01', '2024-02')).not.toThrow();
      expect(() => buildManualCashFlows([null, undefined, {}], '2024-01', '2024-02')).not.toThrow();
    });
  });

  test('handles a snapshot with no breakdown at all (older data, or a failed breakdown save)', () => {
    const noBreakdown = { month: '2024-01', totalValueILS: 100000, breakdown: null };
    const rows = compareMonthlySnapshots(noBreakdown, february);
    MONTHLY_CATEGORY_KEYS.forEach((key) => {
      const row = rows.find((r) => r.key === key);
      expect(row.baseValue).toBeNull();
      expect(row.changePercent).toBeNull();
      // february (the compare side) still has real items in every category,
      // so items isn't empty here - only each item's baseValue is null
      row.items.forEach((item) => expect(item.baseValue).toBeNull());
    });
    const total = rows.find((r) => r.key === 'total');
    expect(total.baseValue).toBe(100000);
  });
});

describe('category split between derived and manually-entered data', () => {
  test('stocks and provident funds are derived; the liquid accounts are entered by hand', () => {
    expect(AUTO_DERIVED_CATEGORIES).toEqual(['israeli', 'american', 'pension']);
    expect(MANUAL_ENTRY_CATEGORIES).toEqual(['cashFunds', 'bank', 'bankSavings']);
  });

  test('every category belongs to exactly one of the two groups', () => {
    expect([...AUTO_DERIVED_CATEGORIES, ...MANUAL_ENTRY_CATEGORIES].sort()).toEqual(
      [...MONTHLY_CATEGORY_KEYS].sort()
    );
    AUTO_DERIVED_CATEGORIES.forEach((key) => expect(MANUAL_ENTRY_CATEGORIES).not.toContain(key));
  });

  // Nothing writes a declared stock/pension flow any more, but months saved
  // while that was possible still carry them - a comparison against one of
  // those months must keep producing the number it always produced.
  test('a legacy declared flow on a now-derived category is still read back', () => {
    const flows = buildManualCashFlows(
      [{ month: '2026-02', breakdown: { cashFlows: { israeli: 5000, bank: 1000 } } }],
      '2026-01',
      '2026-03'
    );
    expect(flows.israeli).toEqual([{ date: '2026-02-15', amount: 5000 }]);
    expect(flows.bank).toEqual([{ date: '2026-02-15', amount: 1000 }]);
  });
});

// The period between two checkpoints is bounded by the dates their figures
// are valid for, not by their month keys.
describe('checkpoint dates (asOfDate)', () => {
  const fund = (deposits) => ({ fundName: 'F', deposits });
  const snap = (month, asOfDate, value) => ({
    month,
    asOfDate,
    totalValueILS: value,
    breakdown: { pension: [{ key: 'F', label: 'F', value }] }
  });
  const pensionRow = (rows) => rows.find((r) => r.key === 'pension');

  test('a deposit after the base checkpoint but in the same month is netted out, not read as growth', () => {
    // Checkpoints on the 10th; ₪20,000 deposited on Sept 20 and no growth.
    const base = snap('2026-09', '2026-09-10', 100000);
    const compare = snap('2026-10', '2026-10-10', 120000);
    const rows = compareMonthlySnapshots(base, compare, { pensionFunds: [fund([{ date: '2026-09-20', amount: 20000 }])] });
    expect(pensionRow(rows).netCashFlow).toBe(20000);
    expect(pensionRow(rows).changePercent).toBeCloseTo(0, 6);
  });

  test('a deposit after the compare checkpoint is not netted out of a value it was never in', () => {
    const base = snap('2026-09', '2026-09-10', 100000);
    const compare = snap('2026-10', '2026-10-10', 105000);
    const rows = compareMonthlySnapshots(base, compare, { pensionFunds: [fund([{ date: '2026-10-25', amount: 50000 }])] });
    expect(pensionRow(rows).netCashFlow).toBe(0);
    expect(pensionRow(rows).changePercent).toBeCloseTo(5, 6);
  });

  test("an undated (legacy) month is valid at its month end - so a flow on the next month's 1st is in the period", () => {
    const base = { ...snap('2026-09', undefined, 100000), asOfDate: undefined };
    const compare = { ...snap('2026-10', undefined, 110000), asOfDate: undefined };
    expect(snapshotAsOfDate(base)).toBe('2026-09-30');
    const rows = compareMonthlySnapshots(base, compare, { pensionFunds: [fund([{ date: '2026-10-01', amount: 10000 }])] });
    expect(pensionRow(rows).netCashFlow).toBe(10000);
  });

  test('reads the date from breakdown.asOfDate as well as the top level', () => {
    expect(snapshotAsOfDate({ month: '2026-09', breakdown: { asOfDate: '2026-09-12' } })).toBe('2026-09-12');
  });
});

// Money-market funds and current accounts record their deposits and
// withdrawals in a dated ledger too.
describe('liquid-account ledgers', () => {
  const base = {
    month: '2026-09',
    asOfDate: '2026-09-30',
    totalValueILS: 50000,
    breakdown: { bank: [{ key: 'bank-1', label: 'עו"ש', value: 50000 }] }
  };
  const compareWith = (cashFlows) => ({
    month: '2026-10',
    asOfDate: '2026-10-31',
    totalValueILS: 40000,
    breakdown: { bank: [{ key: 'bank-1', label: 'עו"ש', value: 40000 }], cashFlows }
  });
  const withdrawal = { bankBalances: [{ deposits: [{ date: '2026-10-15', amount: -10000 }] }] };
  const bankRow = (rows) => rows.find((r) => r.key === 'bank');

  test('a withdrawal recorded in the ledger is netted out automatically', () => {
    const compare = compareWith({});
    const rows = compareMonthlySnapshots(base, compare, withdrawal, [base, compare]);
    expect(bankRow(rows).netCashFlow).toBe(-10000);
    expect(bankRow(rows).changePercent).toBeCloseTo(0, 6);
    expect(bankRow(rows).items[0].netCashFlow).toBe(-10000);
  });

  test('the same withdrawal declared again on the checkpoint is not counted twice', () => {
    const compare = compareWith({ bank: -10000 });
    const rows = compareMonthlySnapshots(base, compare, withdrawal, [base, compare]);
    expect(bankRow(rows).netCashFlow).toBe(-10000);
  });

  test('a declaration still applies to a period the ledger says nothing about', () => {
    const compare = compareWith({ bank: -10000 });
    const rows = compareMonthlySnapshots(base, compare, { bankBalances: [{ deposits: [] }] }, [base, compare]);
    expect(bankRow(rows).netCashFlow).toBe(-10000);
  });
});
