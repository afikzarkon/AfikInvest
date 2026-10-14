import { indexedCostBasis, calculateLinkedRealResult } from './cpiTax';
import { calculateModifiedDietzReturn } from './modifiedDietz';
import { israelToday } from './marketSession';

export const TAX_RATE = 0.25;

// מס רווח הון על מניה אמריקאית (נייר ערך זר): שער החליפין דולר/שקל
// משמש בדיוק כמו "מדד" עבור נייר ערך צמוד מדד - העלות בשקלים מותאמת
// לפי שינוי השער, והמס (25%) חל רק על הרווח שנשאר אחרי ההתאמה (הרווח
// הריאלי). זה מעוגן בחוק: פטור ממס על ה"סכום האינפלציוני" ברווח הון
// ממכירת נייר ערך זר (תקנות מס הכנסה, שיעור המס על רווח הון במכירת
// נייר ערך זר), כשההתאמה לניירות במטבע חוץ נעשית לפי שינוי שער המטבע
// (לא לפי מדד המחירים לצרכן).
//
// בפועל: adjustedCostBasisILS = indexedCostBasis(totalPurchaseILS, שער-קנייה, שער-היום)
//                              = totalPurchaseUSD * שער-היום
// כלומר: בדיוק שווה ערך למיסוי הרווח בדולר בלבד ואז המרתו לשקלים לפי
// שער היום - זו בדיוק הנוסחה שהייתה כאן קודם (profitUSD * currentExchangeRate),
// רק עכשיו כתובה במפורש דרך אותו מנגנון הצמדה כמו קופות גמל ומניות ישראליות,
// כדי שיהיה עקבי, ברור, וניתן לאימות.
export const calculateAmericanStockMetrics = (stock, taxRate = TAX_RATE) => {
  const totalPurchaseUSD = (stock.purchasePrice || 0) * (stock.quantity || 0);
  const totalPurchaseILS = totalPurchaseUSD * (stock.exchangeRate || 0);
  const totalCurrentValueUSD = (stock.currentPrice || 0) * (stock.quantity || 0);
  const currentExchangeRate = stock.currentExchangeRate || stock.exchangeRate || 0;
  const totalCurrentValueILS = totalCurrentValueUSD * currentExchangeRate;
  const profitUSD = totalCurrentValueUSD - totalPurchaseUSD;
  // רווח נומינלי אמיתי בש"ח: כמה יותר/פחות שקלים יש לך בפועל היום לעומת
  // מה ששילמת - זה "כמה כסף באמת הרווחת/הפסדת", לא רק ביצועי המניה.
  // (בעבר השדה הזה חושב כ-profitUSD*currentExchangeRate, שזה בעצם
  // "הרווח הריאלי" ולא הרווח הנומינלי - ראו realGainILS למטה. זה היה
  // מטעה כשמוצג תחת התווית "רווח/הפסד" סתם, כי במקרה שהדולר נחלש
  // משמעותית זה יכול להראות "רווח" בזמן שבפועל יש הפסד נומינלי בשקלים.)
  const profitILS = totalCurrentValueILS - totalPurchaseILS;

  // עלות מותאמת לשער החליפין (מקביל ל-indexedCostBasis של CPI), והרווח/הפסד
  // הריאלי המתקבל ממנה לפי הכלל האסימטרי מפסק דין מוזס (ע"א 3555/15) -
  // ראו calculateLinkedRealResult ב-cpiTax.js להסבר המלא על 4 המקרים.
  const adjustedCostBasisILS = indexedCostBasis(totalPurchaseILS, stock.exchangeRate, currentExchangeRate);
  const { realGain: realGainILS, tax: taxILS } = calculateLinkedRealResult({
    originalCost: totalPurchaseILS,
    currentValue: totalCurrentValueILS,
    adjustedCostBasis: adjustedCostBasisILS,
    taxRate
  });
  // הפרש בין הנומינלי לריאלי - חיובי כשמדובר ב"סכום אינפלציוני" פטור,
  // שלילי כשמדובר בחלק הפסד שאינו בר-קיזוז.
  const currencyExemptGainILS = profitILS - realGainILS;

  const taxUSD = currentExchangeRate > 0 ? taxILS / currentExchangeRate : 0;
  const afterTaxUSD = profitUSD - taxUSD;
  // רווח/הפסד נומינלי אמיתי אחרי מס: כמה שקלים נשארו לך בפועל, אחרי
  // ניכוי המס שחל על הרווח הריאלי (גם אם יש הפסד נומינלי, יכול עדיין
  // לחול מס - ראו הערה למעלה).
  const afterTaxILS = profitILS - taxILS;
  // FX impact is measured on today's position value in USD:
  // (current stock price * quantity * current USDILS) - (current stock price * quantity * buy USDILS)
  const exchangeRateImpact = totalCurrentValueUSD * (currentExchangeRate - (stock.exchangeRate || 0));

  return {
    totalPurchaseUSD,
    totalPurchaseILS,
    totalCurrentValueUSD,
    currentExchangeRate,
    totalCurrentValueILS,
    profitUSD,
    profitILS,
    adjustedCostBasisILS,
    realGainILS,
    currencyExemptGainILS,
    taxUSD,
    taxILS,
    afterTaxUSD,
    afterTaxILS,
    exchangeRateImpact
  };
};

// מחזיר את כל ההפקדות (מתוך פנקס ההפקדות) שבוצעו בטווח התאריכים
// (fromDateExclusive, toDateInclusive] - כלומר אחרי העדכון הקודם ועד
// (כולל) העדכון הנוכחי. אם fromDateExclusive חסר, כל ההפקדות עד
// toDateInclusive נכללות (מקרה של קופה חדשה בלי עדכון קודם). primitive
// משותף ל-sumDepositsInRange (סכום בלבד) ול-calculatePensionPeriodReturn
// (שצריך גם את התאריך המדויק של כל הפקדה, לשם השקלול לפי Modified Dietz).
export const filterDepositsInRange = (deposits, fromDateExclusive, toDateInclusive) => {
  if (!Array.isArray(deposits)) return [];
  return deposits.filter((d) => {
    if (!d || !d.date) return false;
    if (fromDateExclusive && d.date <= fromDateExclusive) return false;
    if (toDateInclusive && d.date > toDateInclusive) return false;
    return true;
  });
};

export const sumDepositsInRange = (deposits, fromDateExclusive, toDateInclusive) =>
  filterDepositsInRange(deposits, fromDateExclusive, toDateInclusive).reduce((sum, d) => sum + (d.amount || 0), 0);

// "סוגר תקופה" לפריט מבוסס-ledger (קופת גמל, כספית שקלית, עו"ש - כל
// ישות עם "שווי נוכחי" שהמשתמש מזין ידנית ופנקס הפקדות/משיכות משלה):
// השווי הנוכחי מתעדכן לערך ולתאריך החדשים שהמשתמש הזין, והשווי הקודם
// עובר לערך/לתאריך שהיו קודם. הפקדות/משיכות מנוהלות בנפרד כפנקס
// מתוארך (deposits), בדיוק כמו רכישות מניה. חישוב התשואה (לא כאן - ראו
// calculateLedgerPeriodReturn למטה) מזהה אוטומטית לפי התאריכים אילו
// הפקדות נופלו בתוך התקופה ומנטרל אותן.
export const applyLedgerValueUpdate = (item, newCurrentValue, newCurrentValueDate) => {
  const oldCurrentValue = item.currentValue ?? item.amount ?? 0;
  const oldCurrentValueDate = item.currentValueDate || '';
  // A value the ledger made (the sum of the deposits, before any statement
  // - see transactionLedger.js's syncLedgerValue) becomes the previous
  // value marked as such, and the account's value is the statement's from
  // now on.
  const { valueFromLedger, previousValueFromLedger, ...rest } = item;
  return {
    ...rest,
    previousValue: oldCurrentValue,
    previousValueDate: oldCurrentValueDate,
    ...(valueFromLedger ? { previousValueFromLedger: true } : {}),
    currentValue: newCurrentValue,
    currentValueDate: newCurrentValueDate,
    amount: newCurrentValue
  };
};

// Entry point for the table's "שווי נוכחי" edit UI (FinancialAccountsTables).
// The UI asks for the value and date together in one action, so payload is
// normally { value, date }. A bare number is accepted too, defaulting to
// today's date, purely as a defensive fallback for any other caller.
export const applyLedgerValueEditPayload = (item, payload) => {
  const hasDate = payload && typeof payload === 'object' && payload.date;
  const newValue = hasDate ? payload.value : payload;
  const newDate = hasDate ? payload.date : israelToday();
  return applyLedgerValueUpdate(item, newValue, newDate);
};

// תשואת התקופה (מעדכון קודם לעדכון נוכחי), מנוטרלת מהפקדות/משיכות
// שבוצעו בתקופה הזו לפי Modified Dietz (ראו modifiedDietz.js): הפקדה
// שנופלת באמצע התקופה משוקללת לפי חלק התקופה שבו הכסף באמת היה מושקע,
// ולא נחשבת - כמו בגרסה הישנה - כאילו הייתה מושקעת מתחילת התקופה
// (ולכן "מנפחת" את בסיס ההשוואה ומדגישה תשואה קטנה מהאמיתית). לדוגמה:
// הפקדה ב-1 לחודש בתקופה חודשית מקבלת משקל מלא (~1) כמו קודם; הפקדה
// ב-25 לחודש מקבלת משקל חלקי בלבד (~0.17) ולא מלא - ולכן משפיעה הרבה
// פחות על adjustedPreviousValue מהחישוב השטוח הישן. משיכה (amount שלילי)
// מטופלת בדיוק באותה נוסחה - הנוסחה agnostic לסימן.
export const calculateLedgerPeriodReturn = (item) => {
  const currentValue = item.currentValue ?? item.amount ?? 0;
  const previousValue = item.previousValue ?? 0;
  const deposits = Array.isArray(item.deposits) ? item.deposits : [];
  const periodDeposits = filterDepositsInRange(deposits, item.previousValueDate, item.currentValueDate);
  const { netCashFlow: depositsInPeriod, percent: dietzPercent } = calculateModifiedDietzReturn({
    beginningValue: previousValue,
    endingValue: currentValue,
    cashFlows: periodDeposits,
    periodStart: item.previousValueDate,
    periodEnd: item.currentValueDate
  });
  const adjustedPreviousValue = previousValue + depositsInPeriod;
  // dietzPercent is null when the Modified Dietz denominator (previousValue
  // + weighted deposits) is exactly 0 - a brand-new item with no previous
  // value yet, where "period return" isn't a meaningful number anyway.
  const percent = dietzPercent ?? 0;
  return { adjustedPreviousValue, depositsInPeriod, percent };
};

// Detects a ledger item whose "previous" and "current" value snapshots
// share the same date - a degenerate, zero-length period that's a strong
// signal something went wrong during data entry, not a real edge case to
// silently accept.
//
// Why this matters: the table's "שווי נוכחי" edit dialog asks for the date
// together with the value (see applyLedgerValueEditPayload above), which
// closes the main way this used to happen - but nothing stops a user from
// still entering the same date on purpose, or old data imported before that
// fix. A same-day period can't produce a meaningful return - and worse, ANY
// deposit made before that shared date, no matter how long before, is
// silently excluded from "since previous update" - which is exactly the
// bug this flag is meant to surface before it produces a wrong number.
export const hasAmbiguousLedgerPeriod = (item) => {
  const prev = item?.previousValueDate;
  const curr = item?.currentValueDate;
  if (!prev || !curr) return false;
  return prev === curr;
};

// Thin pension-named aliases - kept so existing call sites/imports (App.js,
// FinancialAccountsTables.js, tests) don't all need renaming just because
// the underlying logic is now shared with cashFunds/bankBalances too.
export const applyPensionValueUpdate = applyLedgerValueUpdate;
export const applyPensionValueEditPayload = applyLedgerValueEditPayload;
export const calculatePensionPeriodReturn = calculateLedgerPeriodReturn;
export const hasAmbiguousPensionPeriod = hasAmbiguousLedgerPeriod;

