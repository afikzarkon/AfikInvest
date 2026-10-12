const {
  median,
  percentileOf,
  fcfOf,
  adjustSharesForSplits,
  historicalMultiples,
  buildMultiplesTable,
  trailingTwelveMonths
} = require('./valuationMultiples');

const fy = (periodEnd, revenue, netIncome, cfo, capex, shares) => ({ periodEnd, revenue, netIncome, operatingCashFlow: cfo, capex, dilutedShares: shares });

test('median, percentile, FCF', () => {
  expect(median([3, 1, 2])).toBe(2);
  expect(median([4, 1, 2, 3])).toBe(2.5);
  expect(median([])).toBeNull();
  expect(percentileOf([10, 20, 30, 40], 25)).toBe(50);
  expect(percentileOf([], 1)).toBeNull();
  expect(fcfOf({ operatingCashFlow: 100, capex: -30 })).toBe(70);
  expect(fcfOf({ operatingCashFlow: 100, capex: 30 })).toBe(70);
  expect(fcfOf({ freeCashFlow: 5 })).toBe(5);
});

describe('split adjustment', () => {
  test('unrestated counts are multiplied by later splits', () => {
    const years = adjustSharesForSplits(
      [fy('2021-12-31', 1, 1, 1, 0, 100), fy('2022-12-31', 1, 1, 1, 0, 100), fy('2023-12-31', 1, 1, 1, 0, 1000)],
      [{ date: '2023-06-01', ratio: 10 }]
    );
    expect(years.map((y) => y.sharesAdjusted)).toEqual([1000, 1000, 1000]);
  });

  test('counts already restated are left alone', () => {
    const years = adjustSharesForSplits(
      [fy('2021-12-31', 1, 1, 1, 0, 1000), fy('2022-12-31', 1, 1, 1, 0, 1000), fy('2023-12-31', 1, 1, 1, 0, 1000)],
      [{ date: '2023-06-01', ratio: 10 }]
    );
    expect(years.map((y) => y.sharesAdjusted)).toEqual([1000, 1000, 1000]);
  });

  test('a split with no later year to compare against is applied', () => {
    const years = adjustSharesForSplits([fy('2023-12-31', 1, 1, 1, 0, 100)], [{ date: '2024-06-01', ratio: 2 }]);
    expect(years[0].sharesAdjusted).toBe(200);
  });
});

describe('historicalMultiples', () => {
  const annual = [fy('2022-12-31', 1000, 100, 150, -50, 10), fy('2023-12-31', 2000, 200, 300, -100, 10)];
  const closes = [
    { date: '2023-01-31', close: 100 }, // FY2022 not yet published (lag 60d)
    { date: '2023-03-31', close: 100 }, // FY2022: cap 1000 -> PE 10, PS 1, PFCF 10
    { date: '2024-01-31', close: 200 }, // still FY2022: PE 20
    { date: '2024-03-31', close: 200 } // FY2023: cap 2000 -> PE 10, PS 1, PFCF 10
  ];

  test('uses the latest published fiscal year at each month-end', () => {
    const h = historicalMultiples({ annual, monthlyCloses: closes });
    expect(h.totalMonths).toBe(4);
    expect(h.PE).toEqual([10, 20, 10]);
    expect(h.PS).toEqual([1, 2, 1]);
    expect(h.PFCF).toEqual([10, 20, 10]);
    expect(h.samples[0]).toMatchObject({ date: '2023-03-31', fiscalYearEnd: '2022-12-31' });
  });

  test('a loss year is N/M, not a negative multiple', () => {
    const h = historicalMultiples({ annual: [fy('2022-12-31', 1000, -5, 150, -50, 10)], monthlyCloses: closes });
    expect(h.PE).toEqual([]);
    expect(h.PS.length).toBe(3);
  });

  test('respects the from date', () => {
    expect(historicalMultiples({ annual, monthlyCloses: closes, fromDate: '2024-01-01' }).PE).toEqual([20, 10]);
  });
});

test('the table compares current vs 5y avg/median/percentile vs peer median', () => {
  const history = { PE: [10, 20, 30, 40], PS: [1, 2], PFCF: [], totalMonths: 4 };
  const table = buildMultiplesTable({
    current: { marketCap: 3000, ttm: { revenue: 1000, netIncome: 100, operatingCashFlow: 50, capex: -80 } },
    history,
    peers: [{ PE: 20, PS: 2 }, { PE: 25, PS: 4 }, { PE: -3, PS: 3 }, { PE: 1000 }]
  });
  const pe = table.find((r) => r.metric === 'PE');
  expect(pe).toMatchObject({ current: 30, avg5y: 25, median5y: 25, min5y: 10, max5y: 40, percentile5y: 75, samples: 4, sectorMedian: 25, peerCount: 3 });
  expect(pe.vsHistoryPct).toBeCloseTo(20, 10);
  expect(pe.vsSectorPct).toBeCloseTo(20, 10);
  const ps = table.find((r) => r.metric === 'PS');
  expect(ps).toMatchObject({ current: 3, sectorMedian: 3 });
  const pfcf = table.find((r) => r.metric === 'PFCF');
  expect(pfcf).toMatchObject({ current: null, avg5y: null, percentile5y: null }); // FCF negative -> N/M
});

test('trailing twelve months needs four quarters', () => {
  const q = (d, r) => ({ periodEnd: d, revenue: r, netIncome: 1, operatingCashFlow: 2, capex: -1, freeCashFlow: 1 });
  expect(trailingTwelveMonths([q('2025-03-31', 1), q('2025-06-30', 2), q('2025-09-30', 3)])).toBeNull();
  const ttm = trailingTwelveMonths([q('2024-12-31', 9), q('2025-03-31', 1), q('2025-06-30', 2), q('2025-09-30', 3), q('2025-12-31', 4)]);
  expect(ttm).toMatchObject({ periodEnd: '2025-12-31', revenue: 10, netIncome: 4, operatingCashFlow: 8, capex: -4 });
});
