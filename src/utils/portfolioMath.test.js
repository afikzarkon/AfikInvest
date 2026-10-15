import {
  TAX_RATE,
  calculateAmericanStockMetrics,
  applyPensionValueUpdate,
  applyPensionValueEditPayload,
  sumDepositsInRange,
  calculatePensionPeriodReturn,
  hasAmbiguousPensionPeriod,
  applyLedgerValueUpdate,
  calculateLedgerPeriodReturn,
  applyAccountFieldEdit
} from './portfolioMath';
import { liquidBalanceOn, recordedBalances } from '../shared/liquidBalance';

describe('calculateAmericanStockMetrics', () => {
  const baseStock = {
    purchasePrice: 100,
    quantity: 10,
    exchangeRate: 3.5,       // rate at purchase time
    currentPrice: 150,
    currentExchangeRate: 3.7 // rate today
  };

  test('computes USD purchase/current values from price * quantity', () => {
    const m = calculateAmericanStockMetrics(baseStock);
    expect(m.totalPurchaseUSD).toBe(1000);
    expect(m.totalCurrentValueUSD).toBe(1500);
  });

  test('converts to ILS using the exchange rate at each point in time', () => {
    const m = calculateAmericanStockMetrics(baseStock);
    expect(m.totalPurchaseILS).toBe(1000 * 3.5); // 3500
    expect(m.totalCurrentValueILS).toBe(1500 * 3.7); // 5550
  });

  test('profit in USD is current minus purchase; profit in ILS is the true nominal shekel gain', () => {
    const m = calculateAmericanStockMetrics(baseStock);
    expect(m.profitUSD).toBe(500);
    // רווח נומינלי אמיתי = שווי היום בש"ח פחות עלות הקנייה בש"ח
    // (5550 - 3500), לא profitUSD*currentExchangeRate (שזה הרווח הריאלי)
    expect(m.profitILS).toBe(m.totalCurrentValueILS - m.totalPurchaseILS); // 2050
  });

  test('tax only applies to positive profit, at TAX_RATE', () => {
    const m = calculateAmericanStockMetrics(baseStock);
    expect(m.taxUSD).toBeCloseTo(500 * TAX_RATE, 5); // 125
    expect(m.taxILS).toBeCloseTo(125 * 3.7, 5);
  });

  test('no tax is charged on a loss', () => {
    const losingStock = { ...baseStock, currentPrice: 50 }; // below purchase price
    const m = calculateAmericanStockMetrics(losingStock);
    expect(m.profitUSD).toBeLessThan(0);
    expect(m.taxUSD).toBe(0);
    expect(m.taxILS).toBe(0);
  });

  test('afterTax = profit - tax, in both currencies', () => {
    const m = calculateAmericanStockMetrics(baseStock);
    expect(m.afterTaxUSD).toBeCloseTo(m.profitUSD - m.taxUSD, 5);
    expect(m.afterTaxILS).toBeCloseTo(m.profitILS - m.taxILS, 5);
  });

  test('falls back to purchase exchangeRate when currentExchangeRate is missing', () => {
    const stockWithoutCurrentRate = { ...baseStock, currentExchangeRate: undefined };
    const m = calculateAmericanStockMetrics(stockWithoutCurrentRate);
    expect(m.currentExchangeRate).toBe(baseStock.exchangeRate);
  });

  test('exchangeRateImpact isolates the FX-only gain/loss on the current position', () => {
    const m = calculateAmericanStockMetrics(baseStock);
    // (current price * qty) * (currentRate - purchaseRate)
    const expected = 150 * 10 * (3.7 - 3.5);
    expect(m.exchangeRateImpact).toBeCloseTo(expected, 5);
  });

  test('exchangeRateImpact is 0 when the rate hasn\'t moved', () => {
    const stableStock = { ...baseStock, currentExchangeRate: baseStock.exchangeRate };
    const m = calculateAmericanStockMetrics(stableStock);
    expect(m.exchangeRateImpact).toBe(0);
  });

  test('handles missing/zero fields without throwing (defensive defaults)', () => {
    expect(() => calculateAmericanStockMetrics({})).not.toThrow();
    const m = calculateAmericanStockMetrics({});
    expect(m.totalPurchaseUSD).toBe(0);
    expect(m.totalCurrentValueUSD).toBe(0);
    expect(m.profitUSD).toBe(0);
  });

  test('accepts a custom tax rate override', () => {
    const m = calculateAmericanStockMetrics(baseStock, 0.1);
    expect(m.taxUSD).toBeCloseTo(500 * 0.1, 5);
  });

  test('exposes the real vs. currency-exempt breakdown, mirroring the CPI-linked stock formula', () => {
    // קניתי ב-1000$ (מדד/שער=3.5), היום שווה 1000$ (מדד/שער=4.2) - אין
    // שינוי במחיר המניה עצמה, כל הרווח בשקלים נובע רק משינוי השער ולכן
    // כולו פטור (רווח ריאלי = 0, אין מס).
    const stableStock = { purchasePrice: 100, quantity: 10, exchangeRate: 3.5, currentPrice: 100, currentExchangeRate: 4.2 };
    const m = calculateAmericanStockMetrics(stableStock);
    expect(m.realGainILS).toBeCloseTo(0, 5);
    expect(m.taxILS).toBe(0);
    expect(m.currencyExemptGainILS).toBeCloseTo(1000 * (4.2 - 3.5), 5); // 700
    // הריאלי + הפטור מהמטבע = הרווח הנומינלי המלא בשקלים
    expect(m.realGainILS + m.currencyExemptGainILS).toBeCloseTo(m.totalCurrentValueILS - m.totalPurchaseILS, 5);
  });

  test('taxes only the real gain, which can differ from the (now nominal) profitILS', () => {
    const m = calculateAmericanStockMetrics(baseStock); // price 100->150, rate 3.5->3.7
    // profitILS הוא עכשיו הנומינלי (2050), realGainILS הוא מה שחייב במס (500*3.7=1850)
    expect(m.realGainILS).toBeCloseTo(500 * 3.7, 5);
    expect(m.taxILS).toBeCloseTo(m.realGainILS * 0.25, 5);
    // ולוודא שהפירוק תמיד מסתכם לנומינלי
    expect(m.realGainILS + m.currencyExemptGainILS).toBeCloseTo(m.profitILS, 5);
  });

  test('can owe tax even when the true nominal ILS result is a loss (large currency depreciation)', () => {
    // בדיוק הדוגמה שנבדקה בשיחה: מניה שנקנתה ב-192$ בשער 3.7, נמכרה
    // ב-213.05$ בשער 2.96 - רווח דולרי אמיתי, אבל הפסד נומינלי בשקלים.
    const stock = { purchasePrice: 192, quantity: 1, exchangeRate: 3.7, currentPrice: 213.05, currentExchangeRate: 2.96 };
    const m = calculateAmericanStockMetrics(stock);
    expect(m.profitILS).toBeLessThan(0); // הפסד נומינלי אמיתי
    expect(m.realGainILS).toBeGreaterThan(0); // אבל יש רווח ריאלי
    expect(m.taxILS).toBeGreaterThan(0); // ולכן כן חייבים במס
    expect(m.afterTaxILS).toBeLessThan(m.profitILS); // אחרי מס המצב גרוע עוד יותר
  });

  test('Moses case example 3 pattern: nominal loss with currency appreciation is recognized in full, not enlarged', () => {
    // מחיר המניה ירד (הפסד דולרי אמיתי) והשקל נחלש מולה - שני הגורמים
    // "מסכימים" על הפסד, אבל אסור "להגדיל" את ההפסד לפי הצמדה נוחה.
    const stock = { purchasePrice: 100, quantity: 1, exchangeRate: 5, currentPrice: 50, currentExchangeRate: 7 };
    const m = calculateAmericanStockMetrics(stock); // purchase=500, current=350, nominal=-150
    expect(m.profitILS).toBe(-150);
    expect(m.realGainILS).toBe(-150); // לא -350 (מוגדל לפי הצמדה)
    expect(m.taxILS).toBe(0);
  });

  test('Moses case example 4 pattern: nominal gain with currency depreciation is fully taxable, no relief', () => {
    const stock = { purchasePrice: 100, quantity: 1, exchangeRate: 5, currentPrice: 200, currentExchangeRate: 3 };
    const m = calculateAmericanStockMetrics(stock); // purchase=500, current=600, nominal=100
    expect(m.profitILS).toBe(100);
    expect(m.realGainILS).toBe(100); // לא 300 (currentValue-adjustedCost הגולמי)
    expect(m.taxILS).toBeCloseTo(25, 5);
  });
});

describe('sumDepositsInRange', () => {
  const deposits = [
    { date: '2020-01-10', amount: 90000 },
    { date: '2024-03-05', amount: 10000 },
    { date: '2024-04-20', amount: 5000 }
  ];

  test('sums only deposits strictly after fromDateExclusive and up to (including) toDateInclusive', () => {
    expect(sumDepositsInRange(deposits, '2020-01-10', '2024-04-20')).toBe(15000); // הראשונה לא נכללת (בדיוק בגבול)
  });

  test('includes everything up to toDateInclusive when fromDateExclusive is missing', () => {
    expect(sumDepositsInRange(deposits, null, '2024-03-05')).toBe(100000);
  });

  test('returns 0 for a range with no deposits', () => {
    expect(sumDepositsInRange(deposits, '2024-04-20', '2024-05-01')).toBe(0);
  });

  test('handles missing/non-array deposits without throwing', () => {
    expect(sumDepositsInRange(undefined, '2020-01-01', '2024-01-01')).toBe(0);
    expect(sumDepositsInRange([{ amount: 100 }], '2020-01-01', '2024-01-01')).toBe(0); // אין תאריך - מדלגים
  });
});

describe('applyPensionValueUpdate', () => {
  test('rolls the old currentValue/currentValueDate into previousValue/previousValueDate', () => {
    const fund = { currentValue: 100000, currentValueDate: '2024-03-31' };
    const updated = applyPensionValueUpdate(fund, 111000, '2024-06-30');
    expect(updated.previousValue).toBe(100000);
    expect(updated.previousValueDate).toBe('2024-03-31');
    expect(updated.currentValue).toBe(111000);
    expect(updated.currentValueDate).toBe('2024-06-30');
  });

  test('falls back to amount/empty date when currentValue/currentValueDate are missing (first-ever update)', () => {
    const fund = { amount: 50000 };
    const updated = applyPensionValueUpdate(fund, 55000, '2024-01-15');
    expect(updated.previousValue).toBe(50000);
    expect(updated.previousValueDate).toBe('');
    expect(updated.amount).toBe(55000);
  });

  test('no longer touches deposits, initialInvestment, or a lastDeposit field at all', () => {
    const fund = { currentValue: 100000, currentValueDate: '2024-03-31', deposits: [{ date: '2024-02-01', amount: 10000 }] };
    const updated = applyPensionValueUpdate(fund, 111000, '2024-06-30');
    expect(updated.deposits).toEqual(fund.deposits); // ללא שינוי - נשאר בדיוק אותו מערך
    expect(updated.lastDeposit).toBeUndefined();
  });
});

describe('applyPensionValueEditPayload', () => {
  test('uses the date supplied in the { value, date } payload, not today', () => {
    const fund = { currentValue: 100000, currentValueDate: '2024-03-31' };
    const updated = applyPensionValueEditPayload(fund, { value: 111000, date: '2024-06-30' });
    expect(updated.currentValue).toBe(111000);
    expect(updated.currentValueDate).toBe('2024-06-30');
    expect(updated.previousValue).toBe(100000);
    expect(updated.previousValueDate).toBe('2024-03-31');
  });

  test('falls back to a bare number and defaults to today only as a defensive fallback', () => {
    const fund = { currentValue: 100000, currentValueDate: '2024-03-31' };
    const updated = applyPensionValueEditPayload(fund, 111000);
    const today = new Date().toISOString().slice(0, 10);
    expect(updated.currentValue).toBe(111000);
    expect(updated.currentValueDate).toBe(today);
  });
});

describe('calculatePensionPeriodReturn', () => {
  test('nets out a deposit made during the period so it is not counted as profit, time-weighted by Modified Dietz (a mid-period deposit gets partial, not full, credit toward the adjusted base)', () => {
    // מקרה מהשיחה: previousValue=100,000 (בתאריך 2024-01-01), הפקדה של
    // 10,000 בתאריך 2024-02-15 (מדויק באמצע התקופה 2024-01-01..2024-03-31,
    // משקל 0.5), שווי חדש=111,000 בתאריך 2024-03-31 - רווח אמיתי של 1,000
    // בלבד, לא 11,000. adjustedPreviousValue (100,000 + מלוא ה-10,000,
    // שקוללה כ"נטו" בלי משקל) עדיין 110,000 - זה שדה עזר לתצוגה בלבד
    // (updateProfitLoss ב-FinancialAccountsTables.js); ה-percent עצמו
    // הוא זה שמשתמש בפועל בשקלול: המכנה הוא 100,000 + (10,000*0.5)=105,000,
    // לא 110,000 כמו בגרסה הישנה (השטוחה) - ולכן 1,000/105,000 = 0.952%,
    // גבוה יותר מ-1,000/110,000 = 0.909% הישן, כי הפקדה שהייתה מושקעת רק
    // חצי מהתקופה לא אמורה "לספוג" חצי מהמכנה כאילו הייתה שם מההתחלה.
    const fund = {
      previousValue: 100000,
      previousValueDate: '2024-01-01',
      currentValue: 111000,
      currentValueDate: '2024-03-31',
      deposits: [{ date: '2024-02-15', amount: 10000 }]
    };
    const result = calculatePensionPeriodReturn(fund);
    expect(result.depositsInPeriod).toBe(10000);
    expect(result.adjustedPreviousValue).toBe(110000);
    expect(result.percent).toBeCloseTo(0.952, 3);
  });

  test('a deposit the day right after the period starts gets near-full weight - close to the old flat-add approximation', () => {
    // הפקדה יום אחד בלבד לאחר previousValueDate (משקל ~0.989, כי הייתה
    // מושקעת כל התקופה בפועל, פרט ליום אחד) - המכנה קרוב מאוד לגרסה
    // השטוחה הישנה (100,000+10,000=110,000), כי כאן אין בפועל "אמצע
    // תקופה" משמעותי לשקלל. (הפקדה בתאריך previousValueDate עצמו
    // מוחרגת כליל - ראו "ignores a deposit made before the period" -
    // כאילו הייתה כבר חלק מהשווי הקודם שנרשם.)
    const fund = {
      previousValue: 100000,
      previousValueDate: '2024-01-01',
      currentValue: 111000,
      currentValueDate: '2024-03-31',
      deposits: [{ date: '2024-01-02', amount: 10000 }]
    };
    const result = calculatePensionPeriodReturn(fund);
    expect(result.percent).toBeCloseTo(0.91, 2);
  });

  test('a deposit right at the end of the period gets almost no weight - barely affects the denominator', () => {
    // הפקדה ביום האחרון של התקופה (משקל ~0, כמעט לא הייתה מושקעת בפועל) -
    // המכנה נשאר קרוב ל-100,000 המקורי, לא ל-110,000.
    const fund = {
      previousValue: 100000,
      previousValueDate: '2024-01-01',
      currentValue: 111000,
      currentValueDate: '2024-03-31',
      deposits: [{ date: '2024-03-31', amount: 10000 }]
    };
    const result = calculatePensionPeriodReturn(fund);
    expect(result.percent).toBeCloseTo(1, 2); // 1000 / ~100000 ≈ 1%, not 0.909%
  });

  test('ignores a deposit made before the period (already accounted for in a prior update)', () => {
    const fund = {
      previousValue: 100000,
      previousValueDate: '2024-01-01',
      currentValue: 105000,
      currentValueDate: '2024-03-31',
      deposits: [{ date: '2023-06-01', amount: 50000 }] // לפני previousValueDate
    };
    const result = calculatePensionPeriodReturn(fund);
    expect(result.depositsInPeriod).toBe(0);
    expect(result.percent).toBeCloseTo(5, 5);
  });

  test('ignores a deposit made after the period (belongs to the next period)', () => {
    const fund = {
      previousValue: 100000,
      previousValueDate: '2024-01-01',
      currentValue: 105000,
      currentValueDate: '2024-03-31',
      deposits: [{ date: '2024-04-15', amount: 20000 }] // אחרי currentValueDate
    };
    const result = calculatePensionPeriodReturn(fund);
    expect(result.depositsInPeriod).toBe(0);
    expect(result.percent).toBeCloseTo(5, 5);
  });

  test('returns 0% when there is no previous value yet (brand-new fund)', () => {
    const fund = { previousValue: 0, currentValue: 50000, deposits: [] };
    const result = calculatePensionPeriodReturn(fund);
    expect(result.percent).toBe(0);
  });
});

describe('hasAmbiguousPensionPeriod', () => {
  // Regression coverage for a real reported scenario: a fund with
  // previousValueDate === currentValueDate (both 2026-08-26) had a
  // ₪35,000 deposit dated 2026-07-01 silently excluded from the "since
  // previous update" calculation, inflating the shown return - because
  // the date that was supposed to mark the *start* of a real elapsed
  // period actually equalled the *end* date, a degenerate zero-length
  // period.
  test('flags the exact reported case: previousValueDate equals currentValueDate', () => {
    const fund = { previousValueDate: '2026-08-26', currentValueDate: '2026-08-26' };
    expect(hasAmbiguousPensionPeriod(fund)).toBe(true);
  });

  test('does not flag a fund with a real elapsed period between the two dates', () => {
    const fund = { previousValueDate: '2026-06-01', currentValueDate: '2026-08-26' };
    expect(hasAmbiguousPensionPeriod(fund)).toBe(false);
  });

  test('does not flag when either date is missing (nothing to compare yet)', () => {
    expect(hasAmbiguousPensionPeriod({ previousValueDate: '', currentValueDate: '2026-08-26' })).toBe(false);
    expect(hasAmbiguousPensionPeriod({ previousValueDate: '2026-08-26', currentValueDate: '' })).toBe(false);
    expect(hasAmbiguousPensionPeriod({})).toBe(false);
  });

  test('handles undefined/null input gracefully without throwing', () => {
    expect(hasAmbiguousPensionPeriod(undefined)).toBe(false);
    expect(hasAmbiguousPensionPeriod(null)).toBe(false);
  });
});

// Generic ledger helpers (applyLedgerValueUpdate/calculateLedgerPeriodReturn)
// power cashFunds and bankBalances too now, not just pension funds - the
// pension-named exports above are thin aliases for these same functions
// (see portfolioMath.js), so this just confirms the generic entry points
// work identically for a non-pension item, and that a withdrawal
// (negative deposit amount) nets out correctly.
describe('applyLedgerValueUpdate / calculateLedgerPeriodReturn (cash fund / checking account use)', () => {
  test('applyLedgerValueUpdate rolls the old current value into previous, for any ledger item', () => {
    const cashFund = { id: 1, fundName: 'כספית', currentValue: 5000, currentValueDate: '2024-01-01', amount: 5000 };
    const updated = applyLedgerValueUpdate(cashFund, 5200, '2024-02-01');
    expect(updated.previousValue).toBe(5000);
    expect(updated.previousValueDate).toBe('2024-01-01');
    expect(updated.currentValue).toBe(5200);
    expect(updated.currentValueDate).toBe('2024-02-01');
  });

  test('a withdrawal (negative deposit amount) in-period reduces the adjusted base instead of inflating it', () => {
    // עו"ש: יתרה קודמת 10,000, משיכה של 3,000 באמצע התקופה, יתרה נוכחית
    // 7,500 - הרווח/הפסד האמיתי הוא +500 (לא -2,500), כי חלק מהירידה
    // הוא כסף שהמשתמש הוציא בכוונה, לא הפסד השקעה.
    const account = {
      previousValue: 10000,
      previousValueDate: '2024-01-01',
      currentValue: 7500,
      currentValueDate: '2024-01-31',
      deposits: [{ date: '2024-01-15', amount: -3000 }]
    };
    const result = calculateLedgerPeriodReturn(account);
    expect(result.depositsInPeriod).toBe(-3000);
    expect(result.adjustedPreviousValue).toBe(7000);
    expect(result.percent).toBeGreaterThan(0); // real gain, not a loss
  });
});

// A movement removed or corrected outside the transactions ledger used to
// leave the account anchored to the figure that movement had produced:
// the balance stayed where the deleted withdrawal had put it, and the
// deleted movement's date still read as the last activity, because
// liquidBalance.js measures from the latest RECORDED balance and nothing
// had recomputed it.
describe('applyAccountFieldEdit: a ledger-derived value follows its ledger', () => {
  // An account opened through the ledger: 4,000 on 01/10, then 2,000
  // withdrawn on 14/10, which is what syncLedgerValue had recorded.
  const afterWithdrawal = () => ({
    id: 1,
    valueFromLedger: true,
    currentValue: 2000,
    amount: 2000,
    currentValueDate: '2026-10-14',
    updateDate: '2026-10-14',
    previousValue: 0,
    previousValueDate: '',
    deposits: [
      { date: '2026-10-01', amount: 4000, txId: 'tx-open' },
      { date: '2026-10-14', amount: -2000, txId: 'tx-wd' }
    ]
  });

  test('deleting the withdrawal puts the balance and the date back', () => {
    const account = afterWithdrawal();
    const kept = account.deposits.filter((d) => d.txId !== 'tx-wd');
    const next = applyAccountFieldEdit(account, 'deposits', kept);

    expect(liquidBalanceOn(next, '2026-10-15')).toBe(4000);
    expect(recordedBalances(next)).toEqual([{ date: '2026-10-01', value: 4000 }]);
    expect(next.currentValueDate).toBe('2026-10-01');
    expect(next.updateDate).toBe('2026-10-01');
  });

  test('correcting a movement amount re-derives the balance', () => {
    const account = afterWithdrawal();
    const corrected = account.deposits.map((d) => (d.txId === 'tx-wd' ? { ...d, amount: -500 } : d));
    const next = applyAccountFieldEdit(account, 'deposits', corrected);

    expect(liquidBalanceOn(next, '2026-10-15')).toBe(3500);
    expect(next.currentValueDate).toBe('2026-10-14');
  });

  // A value the USER recorded from a statement is a measurement, not a sum:
  // a movement is added on top of it, never rewrites it (liquidBalance.js).
  test('a recorded statement value is left alone', () => {
    const account = { ...afterWithdrawal(), valueFromLedger: undefined, currentValue: 2000, currentValueDate: '2026-10-14' };
    const kept = account.deposits.filter((d) => d.txId !== 'tx-wd');
    const next = applyAccountFieldEdit(account, 'deposits', kept);

    expect(next.currentValue).toBe(2000);
    expect(next.currentValueDate).toBe('2026-10-14');
  });

  test('a plain field is still a plain write', () => {
    expect(applyAccountFieldEdit({ id: 1, fundName: 'a' }, 'fundName', 'b').fundName).toBe('b');
  });
});
