import {
  computePortfolioValueAtDate,
  computeHistoricalPortfolioSeries,
  computeHistoricalBreakdownAtDate,
  sumHistoricalBreakdown,
  buildSampleDates
} from './historicalPortfolioValue';

describe('computePortfolioValueAtDate', () => {
  test('computes an Israeli-only holding value from the carried-forward close on or before the date', () => {
    const holdings = {
      israeliStocks: [{ stockName: '629014', quantity: 10, purchaseDate: '2024-01-01' }],
      americanStocks: []
    };
    const priceData = {
      taseHistoricalCloses: {
        '629014': [
          { date: '2024-01-01', close: 10000 }, // 100 ILS
          { date: '2024-06-01', close: 11000 } // 110 ILS
        ]
      }
    };
    // 2024-03-15 has no exact close - carries forward the 2024-01-01 close.
    const result = computePortfolioValueAtDate('2024-03-15', holdings, priceData);
    expect(result).toMatchObject({ date: '2024-03-15', valueILS: 1000, isPartial: false }); // 10 * 100
  });

  test('computes an American holding value converted to ILS via the carried-forward FX rate', () => {
    const holdings = {
      israeliStocks: [],
      americanStocks: [{ stockName: 'AAPL', quantity: 5, purchaseDate: '2024-01-01' }]
    };
    const priceData = {
      yahooHistoricalCloses: { AAPL: [{ date: '2024-01-01', close: 150 }] },
      fxHistoricalCloses: [{ date: '2024-01-01', close: 3.6 }]
    };
    const result = computePortfolioValueAtDate('2024-02-01', holdings, priceData);
    expect(result.valueILS).toBeCloseTo(5 * 150 * 3.6, 5); // 2700
    expect(result.isPartial).toBe(false);
  });

  test('sums multiple lots of the same symbol as one combined quantity', () => {
    const holdings = {
      israeliStocks: [
        { stockName: '629014', quantity: 10, purchaseDate: '2024-01-01' },
        { stockName: '629014', quantity: 5, purchaseDate: '2024-02-01' }
      ],
      americanStocks: []
    };
    const priceData = { taseHistoricalCloses: { '629014': [{ date: '2024-01-01', close: 10000 }] } };
    const result = computePortfolioValueAtDate('2024-03-01', holdings, priceData);
    expect(result.valueILS).toBe(1500); // (10+5) * 100
  });

  test('excludes a lot purchased after the requested date - "as of" never counts a future purchase', () => {
    const holdings = {
      israeliStocks: [{ stockName: '629014', quantity: 10, purchaseDate: '2024-06-01' }],
      americanStocks: []
    };
    const priceData = { taseHistoricalCloses: { '629014': [{ date: '2024-01-01', close: 10000 }] } };
    const result = computePortfolioValueAtDate('2024-03-01', holdings, priceData);
    expect(result).toMatchObject({ date: '2024-03-01', valueILS: null, isPartial: false });
  });

  test('flags isPartial and skips a holding with no price data at all on or before the date', () => {
    const holdings = {
      israeliStocks: [{ stockName: '629014', quantity: 10, purchaseDate: '2024-01-01' }],
      americanStocks: [{ stockName: 'AAPL', quantity: 5, purchaseDate: '2024-01-01' }]
    };
    const priceData = {
      taseHistoricalCloses: { '629014': [{ date: '2024-01-01', close: 10000 }] },
      yahooHistoricalCloses: {}, // AAPL missing entirely
      fxHistoricalCloses: [{ date: '2024-01-01', close: 3.6 }]
    };
    const result = computePortfolioValueAtDate('2024-03-01', holdings, priceData);
    expect(result.valueILS).toBe(1000); // Israeli leg still counted
    expect(result.isPartial).toBe(true); // American leg couldn't be priced
  });

  test('returns valueILS null (not 0 or NaN) when there are no holdings at all', () => {
    const result = computePortfolioValueAtDate('2024-03-01', { israeliStocks: [], americanStocks: [] }, {});
    expect(result).toMatchObject({ date: '2024-03-01', valueILS: null, isPartial: false });
  });

  test('handles missing holdings/priceData arguments gracefully', () => {
    expect(computePortfolioValueAtDate('2024-03-01')).toMatchObject({ date: '2024-03-01', valueILS: null, isPartial: false });
  });
});

describe('computeHistoricalPortfolioSeries', () => {
  const holdings = { israeliStocks: [{ stockName: '629014', quantity: 10, purchaseDate: '2024-01-01' }], americanStocks: [] };
  const priceData = { taseHistoricalCloses: { '629014': [{ date: '2024-01-01', close: 10000 }] } };

  test('samples weekly points across the range and always includes the exact toDate as the last point', () => {
    const series = computeHistoricalPortfolioSeries('2024-01-01', '2024-01-20', holdings, priceData);
    const dates = series.map((p) => p.date);
    expect(dates[0]).toBe('2024-01-01');
    expect(dates[dates.length - 1]).toBe('2024-01-20');
    // 2024-01-01, -08, -15 are exactly 7 days apart, then the exact end date is appended
    expect(dates).toEqual(['2024-01-01', '2024-01-08', '2024-01-15', '2024-01-20']);
  });

  test('returns an empty array when fromDate is after toDate, or either is missing/invalid', () => {
    expect(computeHistoricalPortfolioSeries('2024-02-01', '2024-01-01', holdings, priceData)).toEqual([]);
    expect(computeHistoricalPortfolioSeries(null, '2024-01-01', holdings, priceData)).toEqual([]);
    expect(computeHistoricalPortfolioSeries('2024-01-01', 'not-a-date', holdings, priceData)).toEqual([]);
  });

  test('a single-day range returns exactly one point', () => {
    const series = computeHistoricalPortfolioSeries('2024-01-01', '2024-01-01', holdings, priceData);
    expect(series.map((p) => p.date)).toEqual(['2024-01-01']);
  });
});

// Non-traded accounts have no historical close to look up, so they're
// reconstructed from their own value+deposit ledgers instead (see
// ledgerAccountHistory.js). Passing them is opt-in per call, so the
// stocks-only behavior above is unaffected.
describe('computePortfolioValueAtDate with non-traded accounts', () => {
  const priceData = { taseHistoricalCloses: { 629014: [{ date: '2024-01-01', close: 10000 }] } };

  test('includes a provident fund reconstructed from its ledger', () => {
    const result = computePortfolioValueAtDate(
      '2024-03-01',
      {
        israeliStocks: [{ stockName: '629014', quantity: 10, purchaseDate: '2024-01-01' }],
        pensionFunds: [
          {
            fundName: 'קופת גמל',
            currentValue: 50000,
            currentValueDate: '2024-01-01',
            deposits: [{ date: '2024-02-01', amount: 1000 }]
          }
        ]
      },
      priceData
    );
    // 10 shares at 10000 agorot = 1000 ILS, plus 50000 + the 1000 deposit.
    expect(result.valueILS).toBe(1000 + 51000);
  });

  test('compounds a bank savings fund to the requested date rather than to today', () => {
    const fund = { fundName: 'חיסכון', interestRate: 10, deposits: [{ date: '2023-01-01', amount: 1000 }] };
    const oneYear = computePortfolioValueAtDate('2024-01-01', { bankSavingsFunds: [fund] }, {});
    const twoYears = computePortfolioValueAtDate('2025-01-01', { bankSavingsFunds: [fund] }, {});
    expect(twoYears.valueILS).toBeGreaterThan(oneYear.valueILS);
    expect(oneYear.valueILS).toBeCloseTo(1100, 0);
  });

  test('an omitted or empty account category contributes nothing and does not mark the point partial', () => {
    const result = computePortfolioValueAtDate(
      '2024-03-01',
      { israeliStocks: [{ stockName: '629014', quantity: 10, purchaseDate: '2024-01-01' }], pensionFunds: [] },
      priceData
    );
    expect(result.valueILS).toBe(1000);
    expect(result.isPartial).toBe(false);
  });
});

// The engine behind the monthly tracker's automatic fill: every row derived
// from historical closes and the account ledgers, so nothing has to be
// typed in by hand.
describe('computeHistoricalBreakdownAtDate', () => {
  const holdings = {
    israeliStocks: [
      { stockName: '629014', officialName: 'טבע', quantity: 10, purchaseDate: '2024-01-01' },
      { stockName: '629014', officialName: 'טבע', quantity: 5, purchaseDate: '2024-02-01' },
      { stockName: '1159250', officialName: 'איישרס', quantity: 2, purchaseDate: '2024-06-01' }
    ],
    americanStocks: [{ stockName: 'AAPL', quantity: 4, purchaseDate: '2024-01-01' }],
    pensionFunds: [
      { fundName: 'קופת גמל', currentValue: 50000, currentValueDate: '2024-01-01', deposits: [] }
    ],
    bankBalances: [{ amount: 8000, updateDate: '2024-01-01' }]
  };
  const priceData = {
    taseHistoricalCloses: {
      629014: [{ date: '2024-01-01', close: 10000 }],
      1159250: [{ date: '2024-06-01', close: 240000 }]
    },
    yahooHistoricalCloses: { AAPL: [{ date: '2024-01-01', close: 190 }] },
    fxHistoricalCloses: [{ date: '2024-01-01', close: 3.7 }]
  };

  test('produces one row per holding, in the same shape a monthly checkpoint stores', () => {
    const breakdown = computeHistoricalBreakdownAtDate('2024-03-01', holdings, priceData);

    // Only the lots held by that date count: 10 + 5 shares of טבע, and not
    // the Israeli ETF bought in June.
    expect(breakdown.israeli).toEqual([{ key: '629014', label: 'טבע (629014)', value: 1500 }]);
    expect(breakdown.american).toEqual([{ key: 'AAPL', label: 'AAPL', value: 4 * 190 * 3.7 }]);
    expect(breakdown.pension).toEqual([{ key: 'קופת גמל', label: 'קופת גמל', value: 50000 }]);
    expect(breakdown.bank).toEqual([{ key: 'bank-1', label: 'עו"ש', value: 8000 }]);
  });

  test('a TASE-listed fund tracking a foreign index is filed under American stocks, as the live checkpoint files it', () => {
    const withForeignFund = {
      israeliStocks: [
        ...holdings.israeliStocks,
        { stockName: '1183441', officialName: 'קרן מחקה S&P 500', isForeignETF: true, quantity: 3, purchaseDate: '2024-01-01' }
      ]
    };
    const prices = { ...priceData, taseHistoricalCloses: { ...priceData.taseHistoricalCloses, 1183441: [{ date: '2024-01-01', close: 50000 }] } };
    const breakdown = computeHistoricalBreakdownAtDate('2024-03-01', withForeignFund, prices);
    expect(breakdown.israeli.map((i) => i.key)).toEqual(['629014']);
    expect(breakdown.american).toEqual([{ key: '1183441', label: 'קרן מחקה S&P 500 (1183441)', value: 1500 }]);
  });

  test('includes a holding once its purchase date has passed', () => {
    const breakdown = computeHistoricalBreakdownAtDate('2024-07-01', holdings, priceData);
    expect(breakdown.israeli.map((i) => i.key).sort()).toEqual(['1159250', '629014']);
  });

  test('leaves out a holding with no historical close, rather than recording it as worth zero', () => {
    const breakdown = computeHistoricalBreakdownAtDate(
      '2024-03-01',
      holdings,
      { ...priceData, taseHistoricalCloses: {} }
    );
    expect(breakdown.israeli).toEqual([]);
  });

  test('sumHistoricalBreakdown totals every row across every category', () => {
    const breakdown = computeHistoricalBreakdownAtDate('2024-03-01', holdings, priceData);
    expect(sumHistoricalBreakdown(breakdown)).toBeCloseTo(1500 + 4 * 190 * 3.7 + 50000 + 8000, 6);
  });

  test('handles missing holdings/priceData gracefully', () => {
    const breakdown = computeHistoricalBreakdownAtDate('2024-03-01');
    expect(breakdown).toEqual({ israeli: [], american: [], pension: [], cashFunds: [], bank: [], bankSavings: [] });
    expect(sumHistoricalBreakdown(breakdown)).toBe(0);
  });
});

// THE DATE-PICKER FREEZE, at the level it was actually caused.
//
// A date input emits partial values while the year is typed ("0002" before
// "2024"), and a range starting in year 2 used to expand to ~105,000 weekly
// sample points, each pricing every holding. Sampling is now bounded no
// matter what range it is handed.
describe('buildSampleDates', () => {
  test('samples weekly for a normal range, ending exactly on the requested end date', () => {
    const dates = buildSampleDates('2024-01-01', '2024-01-20');
    expect(dates).toEqual(['2024-01-01', '2024-01-08', '2024-01-15', '2024-01-20']);
  });

  test('caps the number of points for an absurdly long range instead of scaling without limit', () => {
    const dates = buildSampleDates('0002-01-01', '2026-09-19');
    expect(dates.length).toBeLessThanOrEqual(401);
    // Weekly sampling over that span would have produced this many.
    expect(dates.length).toBeLessThan(105000);
  });

  test('every half-typed year a date input emits stays bounded', () => {
    ['0002-03-01', '0020-03-01', '0202-03-01', '2024-03-01'].forEach((from) => {
      expect(buildSampleDates(from, '2026-09-19').length).toBeLessThanOrEqual(401);
    });
  });

  test('the end date is always the last point, whatever the step works out to', () => {
    ['2024-01-02', '2024-06-13', '0002-01-01'].forEach((from) => {
      const dates = buildSampleDates(from, '2026-09-19');
      expect(dates[dates.length - 1]).toBe('2026-09-19');
    });
  });

  test('returns nothing for an unparseable date', () => {
    expect(buildSampleDates('not-a-date', '2024-01-01')).toEqual([]);
  });
});

describe('close lookup performance and correctness', () => {
  // The other half of the freeze: the carry-forward lookup used to copy and
  // sort the entire close series on every single call - once per holding,
  // per sampled date.
  const makeCloses = (n) =>
    Array.from({ length: n }, (_, i) => ({
      date: new Date(Date.UTC(2023, 0, 1) + i * 86400000).toISOString().slice(0, 10),
      close: 10000 + i
    }));

  test('carries the last close forward and finds the right one regardless of input order', () => {
    const closes = makeCloses(400);
    const shuffled = [...closes].reverse();
    const holdings = { israeliStocks: [{ stockName: 'X', quantity: 1, purchaseDate: '2023-01-01' }] };

    const sorted = computePortfolioValueAtDate('2023-06-15', holdings, {
      taseHistoricalCloses: { X: closes }
    });
    const unsorted = computePortfolioValueAtDate('2023-06-15', holdings, {
      taseHistoricalCloses: { X: shuffled }
    });
    expect(unsorted.valueILS).toBe(sorted.valueILS);
  });

  test('a date before the first close has no value to carry forward', () => {
    const result = computePortfolioValueAtDate(
      '2022-01-01',
      { israeliStocks: [{ stockName: 'X', quantity: 1, purchaseDate: '2021-01-01' }] },
      { taseHistoricalCloses: { X: makeCloses(10) } }
    );
    expect(result.valueILS).toBeNull();
    expect(result.isPartial).toBe(true);
  });

  test('a long series over a long range completes quickly rather than blocking', () => {
    const israeliStocks = Array.from({ length: 10 }, (_, i) => ({
      stockName: `sym${i}`,
      quantity: 10,
      purchaseDate: '2023-01-01'
    }));
    const taseHistoricalCloses = {};
    israeliStocks.forEach((s) => {
      // Reversed, so an implementation that sorts per lookup pays for it.
      taseHistoricalCloses[s.stockName] = makeCloses(750).reverse();
    });

    const started = Date.now();
    const series = computeHistoricalPortfolioSeries(
      '0002-01-01',
      '2026-09-19',
      { israeliStocks, americanStocks: [] },
      { taseHistoricalCloses }
    );
    const elapsed = Date.now() - started;

    expect(series.length).toBeLessThanOrEqual(401);
    // Generous enough not to be flaky on a loaded CI box, and still orders
    // of magnitude below the tens of seconds this used to take.
    expect(elapsed).toBeLessThan(2000);
  });
});

// COST-BASIS ANCHORING ON DAY 0
//
// A lot is worth what was paid for it on the day it was bought, and the
// market close only from the next day. Valuing day 0 at the close invents
// a gap between what the investor put in and what the portfolio is
// recorded as holding the instant they put it in.
describe('a holding is valued at its cost basis on its purchase date', () => {
  const lot = { stockName: '1159250', purchaseDate: '2026-01-24', purchasePrice: 13, quantity: 14 };
  // TASE closes are in agorot: 232630 = 2,326.30 ILS.
  const priceData = { taseHistoricalCloses: { 1159250: [{ date: '2026-01-24', close: 232630 }] } };

  test('day 0 uses the execution price, not the close on that day', () => {
    const result = computePortfolioValueAtDate('2026-01-24', { israeliStocks: [lot] }, priceData);
    expect(result.valueILS).toBeCloseTo(182, 6); // 13 x 14
  });

  test('the day after, and every day after that, uses the market close', () => {
    const result = computePortfolioValueAtDate('2026-01-25', { israeliStocks: [lot] }, priceData);
    expect(result.valueILS).toBeCloseTo(14 * 2326.3, 6);
  });

  test('a date before the purchase holds nothing', () => {
    const result = computePortfolioValueAtDate('2026-01-23', { israeliStocks: [lot] }, priceData);
    expect(result.valueILS).toBeNull();
  });

  // The realistic case this actually exists for: an intraday fill a
  // fraction of a percent away from the close. Without the anchoring that
  // difference is silently discarded at the start of a series.
  test('captures an ordinary intraday spread rather than rounding it away', () => {
    const intraday = { stockName: 'X', purchaseDate: '2026-01-24', purchasePrice: 99, quantity: 10 };
    const closes = { taseHistoricalCloses: { X: [{ date: '2026-01-24', close: 10000 }] } }; // 100.00 ILS
    expect(
      computePortfolioValueAtDate('2026-01-24', { israeliStocks: [intraday] }, closes).valueILS
    ).toBeCloseTo(990, 6);
    expect(
      computePortfolioValueAtDate('2026-01-25', { israeliStocks: [intraday] }, closes).valueILS
    ).toBeCloseTo(1000, 6);
  });

  // On one date a symbol can hold a lot bought years ago and one bought
  // that morning; the two have to be valued differently in the same sum,
  // which is why this is per lot and not per symbol.
  test('values an old lot at the close and a same-day lot at cost, in one symbol', () => {
    const holdings = {
      israeliStocks: [
        { stockName: 'X', purchaseDate: '2025-01-01', purchasePrice: 50, quantity: 10 },
        { stockName: 'X', purchaseDate: '2026-01-24', purchasePrice: 13, quantity: 14 }
      ]
    };
    const closes = { taseHistoricalCloses: { X: [{ date: '2025-01-01', close: 10000 }] } }; // 100 ILS
    const result = computePortfolioValueAtDate('2026-01-24', holdings, closes);
    // old lot at the carried-forward close (10 x 100) + new lot at cost (14 x 13)
    expect(result.valueILS).toBeCloseTo(1000 + 182, 6);
  });

  test('an American lot uses the ILS actually paid, at the rate paid on the day', () => {
    const holdings = {
      americanStocks: [
        { stockName: 'AAPL', purchaseDate: '2026-01-24', purchasePrice: 100, quantity: 10, exchangeRate: 3.6 }
      ]
    };
    const priceDataUs = {
      yahooHistoricalCloses: { AAPL: [{ date: '2026-01-24', close: 190 }] },
      // A very different rate today - converting the opening value at it
      // would put an FX move into the position that never happened.
      fxHistoricalCloses: [{ date: '2026-01-24', close: 4.5 }]
    };
    const result = computePortfolioValueAtDate('2026-01-24', holdings, priceDataUs);
    expect(result.valueILS).toBeCloseTo(100 * 10 * 3.6, 6);
  });

  // A lot bought today needs no close at all, so the absence of price
  // history that far back is not missing data for it.
  test('a brand-new holding with no price history yet is not reported as partial', () => {
    const result = computePortfolioValueAtDate(
      '2026-01-24',
      { israeliStocks: [lot] },
      { taseHistoricalCloses: {} }
    );
    expect(result.valueILS).toBeCloseTo(182, 6);
    expect(result.isPartial).toBe(false);
  });

  test('a lot that DOES need a close still reports partial when there is none', () => {
    const result = computePortfolioValueAtDate(
      '2026-02-01',
      { israeliStocks: [lot] },
      { taseHistoricalCloses: {} }
    );
    expect(result.isPartial).toBe(true);
  });
});

// The monthly tracker reads the same engine, so a month-end that happens
// to be a purchase date must not report a different figure than the chart
// shows for that same instant.
test('the itemized breakdown anchors day 0 to cost basis too', () => {
  const holdings = {
    israeliStocks: [{ stockName: 'X', officialName: 'נייר', purchaseDate: '2026-01-31', purchasePrice: 13, quantity: 14 }]
  };
  const closes = { taseHistoricalCloses: { X: [{ date: '2026-01-31', close: 232630 }] } };

  const breakdown = computeHistoricalBreakdownAtDate('2026-01-31', holdings, closes);
  expect(breakdown.israeli[0].value).toBeCloseTo(182, 6);

  const curve = computePortfolioValueAtDate('2026-01-31', holdings, closes);
  expect(sumHistoricalBreakdown(breakdown)).toBeCloseTo(curve.valueILS, 6);
});

// "Bought today" and "we know what was paid" are different facts. Anchoring
// a lot with no recorded cost to zero would assert the position was worth
// nothing the day it was opened, then show its full value appearing as a
// gain the next day with no contribution to net against it.
describe('a lot with no usable cost basis falls back to the market close', () => {
  const closes = { taseHistoricalCloses: { X: [{ date: '2026-01-24', close: 10000 }] } }; // 100 ILS

  test.each([
    ['a missing purchase price', { stockName: 'X', purchaseDate: '2026-01-24', quantity: 10 }],
    ['a zero purchase price', { stockName: 'X', purchaseDate: '2026-01-24', purchasePrice: 0, quantity: 10 }],
    ['a negative purchase price', { stockName: 'X', purchaseDate: '2026-01-24', purchasePrice: -5, quantity: 10 }]
  ])('%s is valued at the close, not at zero', (_label, lot) => {
    const result = computePortfolioValueAtDate('2026-01-24', { israeliStocks: [lot] }, closes);
    expect(result.valueILS).toBeCloseTo(1000, 6);
  });

  test('the same applies to an American lot with no exchange rate recorded', () => {
    const holdings = {
      americanStocks: [{ stockName: 'AAPL', purchaseDate: '2026-01-24', purchasePrice: 100, quantity: 10 }]
    };
    const priceDataUs = {
      yahooHistoricalCloses: { AAPL: [{ date: '2026-01-24', close: 190 }] },
      fxHistoricalCloses: [{ date: '2026-01-24', close: 3.7 }]
    };
    // No exchangeRate on the lot, so cost in ILS is unknowable - the close
    // at the day's rate is used rather than reporting the position at 0.
    const result = computePortfolioValueAtDate('2026-01-24', holdings, priceDataUs);
    expect(result.valueILS).toBeCloseTo(10 * 190 * 3.7, 6);
  });
});
