import { calculatePortfolioSummary } from './portfolioSummary';

describe('calculatePortfolioSummary', () => {
  test('returns all-zero summary for an empty portfolio', () => {
    const summary = calculatePortfolioSummary([], [], [], [], []);
    expect(summary.capitalTotalILS).toBe(0);
    expect(summary.totalProfitILS).toBe(0);
    expect(summary.totalProfitAfterTaxILS).toBe(0);
  });

  test('aggregates a single profitable Israeli stock correctly', () => {
    const israeliStocks = [
      { stockName: 'TEVA', quantity: 100, purchasePrice: 30, currentPrice: 35, dailyChangePercent: 1.2, purchaseDate: '2023-01-15' }
    ];
    const summary = calculatePortfolioSummary(israeliStocks, [], [], [], []);
    // currentPrice is always already in shekels (see formatters.js:normalizeIsraeliPrice) - no conversion here.
    expect(summary.israeliOnlyPurchaseILS).toBe(3000);
    expect(summary.israeliOnlyCurrentValueILS).toBe(3500);
    expect(summary.israeliOnlyProfitILS).toBe(500);
    expect(summary.israeliOnlyTaxILS).toBeCloseTo(500 * 0.25, 5);
  });

  test('does not tax an Israeli stock at a loss', () => {
    const israeliStocks = [
      { stockName: 'TEVA', quantity: 100, purchasePrice: 50, currentPrice: 35, dailyChangePercent: 0, purchaseDate: '2023-01-15' }
    ];
    const summary = calculatePortfolioSummary(israeliStocks, [], [], [], []);
    expect(summary.israeliOnlyProfitILS).toBeLessThan(0);
    expect(summary.israeliOnlyTaxILS).toBe(0);
  });

  test('includes American stocks converted to ILS in the combined totals', () => {
    const americanStocks = [
      { stockName: 'AAPL', quantity: 10, purchasePrice: 150, currentPrice: 190, exchangeRate: 3.6, currentExchangeRate: 3.7, dailyChangePercent: 0.8, purchaseDate: '2022-03-01' }
    ];
    const summary = calculatePortfolioSummary([], americanStocks, [], [], []);
    expect(summary.totalPurchaseUSD).toBe(1500);
    expect(summary.totalCurrentValueUSD).toBe(1900);
    expect(summary.capitalAmericanILS).toBeCloseTo(1900 * 3.7, 5);
  });

  test('American stock tax is exempt on the currency-driven portion of the ILS gain, matching Israeli law for foreign securities', () => {
    // מחיר המניה לא זז (150->150), רק השער עלה - כל הרווח בשקלים הוא
    // רק בגלל השער, ולכן פטור לגמרי ממס.
    const americanStocks = [
      { stockName: 'AAPL', quantity: 10, purchasePrice: 150, currentPrice: 150, exchangeRate: 3.6, currentExchangeRate: 3.9, dailyChangePercent: 0, purchaseDate: '2022-03-01' }
    ];
    const summary = calculatePortfolioSummary([], americanStocks, [], [], []);
    expect(summary.americanOnlyRealGainILS).toBeCloseTo(0, 5);
    expect(summary.americanOnlyTaxILS).toBe(0);
    expect(summary.americanOnlyCurrencyExemptGainILS).toBeCloseTo(1500 * (3.9 - 3.6), 5); // 450
  });

  test('includes pension, cash fund, and bank balances in capitalTotalILS', () => {
    const pensionFunds = [{ deposits: [{ date: '2020-01-01', amount: 10000 }], currentValue: 12000, previousValue: 11500 }];
    const cashFunds = [{ amount: 5000 }];
    const bankBalances = [{ amount: 20000 }];
    const summary = calculatePortfolioSummary([], [], pensionFunds, cashFunds, bankBalances);
    expect(summary.capitalPensionILS).toBe(12000);
    expect(summary.capitalCashFundsILS).toBe(5000);
    expect(summary.capitalBankILS).toBe(20000);
    expect(summary.capitalTotalILS).toBe(12000 + 5000 + 20000);
  });

  test('capitalTotalILS sums every category together for a mixed portfolio', () => {
    const israeliStocks = [{ stockName: 'A', quantity: 10, purchasePrice: 10, currentPrice: 1200, dailyChangePercent: 0, purchaseDate: '2023-01-01' }];
    const americanStocks = [{ stockName: 'B', quantity: 5, purchasePrice: 100, currentPrice: 120, exchangeRate: 3.5, currentExchangeRate: 3.5, dailyChangePercent: 0, purchaseDate: '2023-01-01' }];
    const pensionFunds = [{ initialInvestment: 1000, currentValue: 1100, previousValue: 1050 }];
    const cashFunds = [{ amount: 500 }];
    const bankBalances = [{ amount: 2000 }];

    const summary = calculatePortfolioSummary(israeliStocks, americanStocks, pensionFunds, cashFunds, bankBalances);
    const expectedTotal =
      summary.capitalIsraeliILS +
      summary.capitalAmericanILS +
      summary.capitalCashFundsILS +
      summary.capitalPensionILS +
      summary.capitalBankILS;
    expect(summary.capitalTotalILS).toBeCloseTo(expectedTotal, 5);
  });

  test('does not throw on missing/undefined numeric fields', () => {
    const israeliStocks = [{ stockName: 'A' }];
    const americanStocks = [{ stockName: 'B' }];
    expect(() => calculatePortfolioSummary(israeliStocks, americanStocks, [], [], [])).not.toThrow();
  });

  describe('bank savings funds (bankSavingsFunds param)', () => {
    test('a bank savings fund not linked to the index is taxed 15% flat on the nominal gain, and included in capitalTotalILS', () => {
      const bankSavingsFunds = [
        { fundName: 'חיסכון א', interestRate: 0, isLinkedToIndex: false, deposits: [{ date: '2023-01-01', amount: 10000 }] }
      ];
      const summary = calculatePortfolioSummary([], [], [], [], [], {}, bankSavingsFunds);
      // 0% interest -> current value stays 10000 -> no gain, no tax
      expect(summary.bankSavingsCurrentValueILS).toBeCloseTo(10000, 5);
      expect(summary.bankSavingsTaxILS).toBe(0);
      expect(summary.capitalBankSavingsILS).toBeCloseTo(10000, 5);
      expect(summary.capitalTotalILS).toBeCloseTo(10000, 5);
    });

    test('a bank savings fund linked to the index uses the 25% real-gain rate when CPI data is available', () => {
      const bankSavingsFunds = [
        { fundName: 'חיסכון ב', interestRate: 0, isLinkedToIndex: true, deposits: [{ date: '2020-01-01', amount: 10000 }] }
      ];
      const cpi = { currentIndex: 110, indexByMonth: { '2020-01': 100 } };
      // 0% interest -> current value stays 10000. Index rose 10% -> adjusted
      // cost basis 11000 > current value -> nominal loss, real gain 0, no tax.
      const summary = calculatePortfolioSummary([], [], [], [], [], cpi, bankSavingsFunds);
      expect(summary.bankSavingsRealGainILS).toBeLessThanOrEqual(0);
      expect(summary.bankSavingsTaxILS).toBe(0);
    });

    test('capitalTotalILS includes bank savings funds alongside every other category', () => {
      const pensionFunds = [{ initialInvestment: 1000, currentValue: 1100, previousValue: 1050 }];
      const cashFunds = [{ amount: 500 }];
      const bankBalances = [{ amount: 2000 }];
      const bankSavingsFunds = [{ fundName: 'X', interestRate: 0, deposits: [{ date: '2024-01-01', amount: 3000 }] }];

      const summary = calculatePortfolioSummary([], [], pensionFunds, cashFunds, bankBalances, {}, bankSavingsFunds);
      const expectedTotal =
        summary.capitalPensionILS +
        summary.capitalCashFundsILS +
        summary.capitalBankILS +
        summary.capitalBankSavingsILS;
      expect(summary.capitalTotalILS).toBeCloseTo(expectedTotal, 5);
      expect(summary.capitalBankSavingsILS).toBeCloseTo(3000, 5);
    });

    test('omitting bankSavingsFunds entirely (backward compatible call) does not throw and treats it as empty', () => {
      const summary = calculatePortfolioSummary([], [], [], [], []);
      expect(summary.capitalBankSavingsILS).toBe(0);
      expect(summary.bankSavingsTaxILS).toBe(0);
    });
  });

  describe('CPI-linked real capital gains tax (when the cpi param is provided)', () => {
    const cpi = { currentIndex: 130, indexByMonth: { '2020-01': 100, '2023-01': 115 } };

    test('taxes an Israeli stock on its real gain (inflation-adjusted), not the full nominal gain', () => {
      // קניתי ב-1,000 (מדד=100), היום שווה 1,300 (מדד=130) - זו בדיוק
      // אינפלציה, אין רווח ריאלי, ולכן אין מס - למרות שהרווח הנומינלי 300.
      const israeliStocks = [
        { stockName: 'A', quantity: 100, purchasePrice: 10, currentPrice: 13, dailyChangePercent: 0, purchaseDate: '2020-01-15' }
      ];
      const summary = calculatePortfolioSummary(israeliStocks, [], [], [], [], cpi);
      expect(summary.israeliOnlyProfitILS).toBe(300); // נומינלי, לא משתנה
      expect(summary.israeliOnlyTaxILS).toBeCloseTo(0, 5); // אבל בלי מס, כי אין רווח ריאלי
    });

    test('falls back to the flat nominal tax for an Israeli stock when its purchase month has no CPI data', () => {
      const israeliStocks = [
        { stockName: 'A', quantity: 100, purchasePrice: 10, currentPrice: 13, dailyChangePercent: 0, purchaseDate: '1999-06-15' }
      ];
      const summary = calculatePortfolioSummary(israeliStocks, [], [], [], [], cpi);
      expect(summary.israeliOnlyTaxILS).toBeCloseTo(300 * 0.25, 5);
    });

    test('pension fund: always 25% on the real gain, each deposit indexed by its own date (no flat-nominal mode anymore)', () => {
      const pensionFunds = [
        {
          currentValue: 95000,
          deposits: [{ date: '2020-01-10', amount: 50000 }, { date: '2023-01-10', amount: 20000 }]
        }
      ];
      const summary = calculatePortfolioSummary([], [], pensionFunds, [], [], cpi);
      const adjustedCost = 50000 * (130 / 100) + 20000 * (130 / 115);
      expect(summary.pensionTaxILS).toBeCloseTo(Math.max(0, 95000 - adjustedCost) * 0.25, 5);
    });

    test('without a cpi param at all, pension tax falls back to the old flat 25% on nominal profit', () => {
      const pensionFunds = [{ deposits: [{ date: '2020-01-01', amount: 10000 }], currentValue: 12000, previousValue: 11500 }];
      const summary = calculatePortfolioSummary([], [], pensionFunds, [], []);
      expect(summary.pensionTaxILS).toBeCloseTo(2000 * 0.25, 5);
    });

    test('exposes the real vs. inflationary breakdown for an Israeli stock, so the tax math can be audited', () => {
      // רווח נומינלי 300 (1300-1000), אינפלציה 30% -> אין רווח ריאלי,
      // כל ה-300 הוא רכיב אינפלציוני פטור.
      const israeliStocks = [
        { stockName: 'A', quantity: 100, purchasePrice: 10, currentPrice: 13, dailyChangePercent: 0, purchaseDate: '2020-01-15' }
      ];
      const summary = calculatePortfolioSummary(israeliStocks, [], [], [], [], cpi);
      expect(summary.israeliOnlyRealGainILS).toBeCloseTo(0, 5);
      expect(summary.israeliOnlyInflationaryGainILS).toBeCloseTo(300, 5);
      // הנומינלי = ריאלי + אינפלציוני, תמיד
      expect(summary.israeliOnlyRealGainILS + summary.israeliOnlyInflationaryGainILS)
        .toBeCloseTo(summary.israeliOnlyProfitILS, 5);
    });

    test('exposes the real vs. inflationary breakdown for a pension fund', () => {
      const pensionFunds = [
        {
          currentValue: 95000,
          deposits: [{ date: '2020-01-10', amount: 50000 }, { date: '2023-01-10', amount: 20000 }]
        }
      ];
      const summary = calculatePortfolioSummary([], [], pensionFunds, [], [], cpi);
      const adjustedCost = 50000 * (130 / 100) + 20000 * (130 / 115);
      const totalDeposited = 70000;
      expect(summary.pensionInflationaryGainILS).toBeCloseTo(adjustedCost - totalDeposited, 5);
      expect(summary.pensionRealGainILS).toBeCloseTo(95000 - adjustedCost, 5);
      // הנומינלי (currentValue - deposits) = ריאלי + אינפלציוני, תמיד
      expect(summary.pensionRealGainILS + summary.pensionInflationaryGainILS)
        .toBeCloseTo(95000 - totalDeposited, 5);
    });

    test('regression: real+inflationary always sum to nominal even when the index moved down (Moses case example 4 pattern)', () => {
      // מדד ירד בין הקנייה להיום (130 -> 100) - הצמדה כלפי מטה, רווח.
      // לפי הכלל האסימטרי: כל הרווח הנומינלי חייב במס, אין רכיב פטור.
      const downIndexCpi = { currentIndex: 100, indexByMonth: { '2020-01': 130 } };
      const israeliStocks = [
        { stockName: 'A', quantity: 10, purchasePrice: 50, currentPrice: 60, dailyChangePercent: 0, purchaseDate: '2020-01-15' }
      ];
      const summary = calculatePortfolioSummary(israeliStocks, [], [], [], [], downIndexCpi);
      expect(summary.israeliOnlyProfitILS).toBe(100); // (60-50)*10
      expect(summary.israeliOnlyRealGainILS).toBe(100); // כל הרווח חייב, בלי הקלה
      expect(summary.israeliOnlyInflationaryGainILS).toBe(0); // לא שלילי!
      expect(summary.israeliOnlyRealGainILS + summary.israeliOnlyInflationaryGainILS)
        .toBeCloseTo(summary.israeliOnlyProfitILS, 5);
    });

    test('combined totalRealGainILS/totalInflationaryGainILS sum real and inflationary gain across all three categories', () => {
      const israeliStocks = [
        { stockName: 'A', quantity: 10, purchasePrice: 10, currentPrice: 13, dailyChangePercent: 0, purchaseDate: '2020-01-15' }
      ];
      const americanStocks = [
        { stockName: 'B', quantity: 1, purchasePrice: 100, exchangeRate: 5, currentPrice: 150, currentExchangeRate: 3.7 }
      ];
      const pensionFunds = [
        { currentValue: 95000, deposits: [{ date: '2020-01-10', amount: 50000 }, { date: '2023-01-10', amount: 20000 }] }
      ];
      const summary = calculatePortfolioSummary(israeliStocks, americanStocks, pensionFunds, [], [], cpi);
      const expectedReal = summary.israeliOnlyRealGainILS + summary.americanOnlyRealGainILS + summary.pensionRealGainILS;
      const expectedInflationary = summary.israeliOnlyInflationaryGainILS + summary.americanOnlyCurrencyExemptGainILS + summary.pensionInflationaryGainILS;
      expect(summary.totalRealGainILS).toBeCloseTo(expectedReal, 5);
      expect(summary.totalInflationaryGainILS).toBeCloseTo(expectedInflationary, 5);
    });
  });

  describe('pension fund period return (auto deposit-in-range detection)', () => {
    test('nets out a deposit made between previousValueDate and currentValueDate automatically', () => {
      const pensionFunds = [{
        previousValue: 100000,
        previousValueDate: '2024-01-01',
        currentValue: 111000,
        currentValueDate: '2024-03-31',
        deposits: [
          { date: '2024-01-01', amount: 90000 }, // עוד לפני הכל, לא רלוונטי לתקופה הזו
          { date: '2024-02-15', amount: 10000 }  // בתוך התקופה - צריך להתנטרל
        ]
      }];
      const summary = calculatePortfolioSummary([], [], pensionFunds, [], []);
      expect(summary.pensionPreviousProfitPercent).toBeCloseTo(0.909, 2); // לא 11%
    });
  });
});

describe('money-market fund returns', () => {
  test('summed over the accounts that have one, against what each is measured from', () => {
    const cashFunds = [
      {
        previousValue: 10000,
        previousValueDate: '2026-10-06',
        currentValue: 12000,
        currentValueDate: '2026-11-06',
        deposits: [{ date: '2026-10-01', amount: 10000 }, { date: '2026-10-20', amount: 1000 }]
      },
      { valueFromLedger: true, currentValue: 3000, currentValueDate: '2026-10-01', deposits: [{ date: '2026-10-01', amount: 3000 }] }
    ];
    const s = calculatePortfolioSummary([], [], [], cashFunds, [], {}, [], { today: '2026-11-15' });
    expect(s.cashFundsPeriodProfitILS).toBe(1000);
    // The second fund has no update to measure from. The 1,000 of 20/10 was
    // invested for 17 of the period's 31 days.
    expect(s.cashFundsPeriodReturnPercent).toBeCloseTo((1000 / (10000 + (1000 * 17) / 31)) * 100, 10);
    expect(s.cashFundsTotalProfitILS).toBe(1000); // 15,000 held on 14,000 paid in
    expect(s.cashFundsTotalReturnPercent).toBeCloseTo((1000 / 14000) * 100, 10);
  });
});
