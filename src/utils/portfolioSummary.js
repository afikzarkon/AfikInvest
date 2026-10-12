// Overall portfolio summary calculation.
// Extracted from App.js's calculatePortfolioSummary(). Behavior is unchanged;
// the only difference is that the stock/fund arrays are now explicit
// parameters instead of closed-over component state.

import { TAX_RATE, calculateAmericanStockMetrics, calculatePensionPeriodReturn } from './portfolioMath';
import { normalizeIsraeliPrice } from './formatters';
import { calculateStockRealGainTax, calculatePensionRealGainTax, calculateBankSavingsFundTax, monthKeyFromDate } from './cpiTax';
import { computeBankSavingsFundValue } from './bankSavingsFund';
import { effectiveDailyChangePercent, israelToday, marketSessionState } from './marketSession';

// cpi = { currentIndex, indexByMonth } - אופציונלי. כל עוד המדד לא נטען
// (או שהמשיכה נכשלה), נופלים חזרה לחישוב מס שטוח על הרווח הנומינלי
// (כמו קודם), כדי שהאפליקציה תמשיך לעבוד גם בלי תלות ברשת/במדד.
//
// options.today ('YYYY-MM-DD', Israel date) decides which lots' daily
// change counts: only those whose market traded today (see
// utils/marketSession.js). Defaults to the real date; tests pin it.
export const calculatePortfolioSummary = (
  israeliStocks,
  americanStocks,
  pensionFunds,
  cashFunds,
  bankBalances,
  cpi = {},
  bankSavingsFunds = [],
  options = {}
) => {
  const { currentIndex = null, indexByMonth = {} } = cpi;
  const today = options.today || israelToday();
  const dailyPct = (stock) => effectiveDailyChangePercent(stock, today);

  // Israeli stocks
  const israeliSummary = israeliStocks.reduce((acc, stock) => {
    const totalPurchase = (stock.purchasePrice || 0) * (stock.quantity || 0);
    const normalizedPrice = normalizeIsraeliPrice(stock.currentPrice);
    const totalCurrentValue = (normalizedPrice || 0) * (stock.quantity || 0);
    const profit = totalCurrentValue - totalPurchase;

    // מס רווח הון ריאלי (מוצמד למדד לפי תאריך הקנייה) כשהמדד זמין,
    // אחרת נופלים חזרה למס שטוח על הרווח הנומינלי (ההתנהגות הישנה).
    // realGain ו-inflationaryGain נשמרים בנפרד (ולא רק tax) כדי
    // שאפשר יהיה להציג אותם בממשק ולוודא את החישוב.
    const indexAtPurchase = indexByMonth[monthKeyFromDate(stock.purchaseDate)];
    let stockTax;
    let realGain;
    let inflationaryGain;
    if (currentIndex && indexAtPurchase) {
      const result = calculateStockRealGainTax({
        purchasePrice: stock.purchasePrice,
        quantity: stock.quantity,
        currentValue: totalCurrentValue,
        indexAtPurchase,
        currentIndex
      });
      stockTax = result.tax;
      realGain = result.realGain;
      // הרכיב הפטור נגזר כ"מה שנשאר" מהנומינלי אחרי הרווח הריאלי - לא
      // חישוב עצמאי - כדי שתמיד יתאים בדיוק לכלל האסימטרי מפסק דין
      // מוזס (calculateLinkedRealResult), כולל במקרי קצה (הצמדה כלפי
      // מטה, הפסד עם הצמדה כלפי מעלה וכו') שבהם adjustedCost-originalCost
      // הגולמי היה נותן תוצאה שגויה/לא עקבית.
      inflationaryGain = profit - realGain;
    } else {
      // אין מדד לתאריך הקנייה: מתייחסים לכל הרווח כריאלי (אין הצמדה כלל)
      stockTax = profit > 0 ? profit * TAX_RATE : 0;
      realGain = profit;
      inflationaryGain = 0;
    }

    acc.totalPurchaseILS += totalPurchase;
    acc.totalCurrentValueILS += totalCurrentValue;
    acc.totalProfitILS += profit;
    acc.totalTaxILS += stockTax;
    acc.totalRealGainILS += realGain;
    acc.totalInflationaryGainILS += inflationaryGain;
    acc.totalWeight += totalCurrentValue; // weight for daily-change percentage
    acc.dailyChangeSum += dailyPct(stock) * totalCurrentValue;

    return acc;
  }, {
    totalPurchaseILS: 0,
    totalCurrentValueILS: 0,
    totalProfitILS: 0,
    totalTaxILS: 0,
    totalRealGainILS: 0,
    totalInflationaryGainILS: 0,
    totalWeight: 0,
    dailyChangeSum: 0
  });

  // American stocks
  const americanSummary = americanStocks.reduce((acc, stock) => {
    const metrics = calculateAmericanStockMetrics(stock);

    acc.totalPurchaseUSD += metrics.totalPurchaseUSD;
    acc.totalPurchaseILS += metrics.totalPurchaseILS;
    acc.totalCurrentValueUSD += metrics.totalCurrentValueUSD;
    acc.totalCurrentValueILS += metrics.totalCurrentValueILS;
    acc.totalProfitUSD += metrics.profitUSD;
    acc.totalProfitILS += metrics.profitILS;
    acc.totalTaxILS += metrics.taxILS;
    acc.totalTaxUSD += metrics.taxUSD;
    acc.totalRealGainILS += metrics.realGainILS;
    acc.totalCurrencyExemptGainILS += metrics.currencyExemptGainILS;
    acc.totalExchangeImpact += metrics.exchangeRateImpact;
    acc.totalWeight += metrics.totalCurrentValueILS; // weight for daily-change percentage
    acc.dailyChangeSum += dailyPct(stock) * metrics.totalCurrentValueILS;

    return acc;
  }, {
    totalPurchaseUSD: 0,
    totalPurchaseILS: 0,
    totalCurrentValueUSD: 0,
    totalCurrentValueILS: 0,
    totalProfitUSD: 0,
    totalProfitILS: 0,
    totalTaxILS: 0,
    totalTaxUSD: 0,
    totalRealGainILS: 0,
    totalCurrencyExemptGainILS: 0,
    totalExchangeImpact: 0,
    totalWeight: 0,
    dailyChangeSum: 0
  });

  // Weighted daily-change percentage
  const totalWeight = israeliSummary.totalWeight + americanSummary.totalWeight;
  const weightedDailyChange = totalWeight > 0 ?
    (israeliSummary.dailyChangeSum + americanSummary.dailyChangeSum) / totalWeight : 0;

  // Daily profit in ILS and USD
  const dailyProfitILS = (weightedDailyChange / 100) * (israeliSummary.totalCurrentValueILS + americanSummary.totalCurrentValueILS);
  const dailyProfitUSD = (weightedDailyChange / 100) * americanSummary.totalCurrentValueUSD;

  // Daily profit split per exchange
  const israeliDailyProfitILS = israeliStocks.reduce((sum, stock) => {
    const totalCurrentValue = normalizeIsraeliPrice(stock.currentPrice) * (stock.quantity || 0);
    return sum + (dailyPct(stock) / 100) * totalCurrentValue;
  }, 0);

  const americanDailyProfitUSD = americanStocks.reduce((sum, stock) => {
    const totalCurrentValueUSD = (stock.currentPrice || 0) * (stock.quantity || 0);
    return sum + (dailyPct(stock) / 100) * totalCurrentValueUSD;
  }, 0);

  // Total profit percentages per exchange
  const israeliProfitILS = israeliSummary.totalCurrentValueILS - israeliSummary.totalPurchaseILS;
  // מס רווח הון ריאלי כבר חושב per-stock למעלה (מוצמד למדד כשזמין,
  // אחרת שטוח על הרווח הנומינלי) - כאן רק לוקחים את הסכום המצטבר.
  const israeliTaxILS = israeliSummary.totalTaxILS;
  const israeliAfterTaxILS = israeliProfitILS - israeliTaxILS;
  const israeliProfitPercent = israeliSummary.totalPurchaseILS > 0 ? (israeliProfitILS / israeliSummary.totalPurchaseILS) * 100 : 0;
  const israeliDailyPercent = israeliSummary.totalCurrentValueILS > 0 ? (israeliDailyProfitILS / israeliSummary.totalCurrentValueILS) * 100 : 0;

  const americanProfitUSD = americanSummary.totalCurrentValueUSD - americanSummary.totalPurchaseUSD;
  // מס רווח הון על מניות אמריקאיות: כבר חושב per-stock למעלה (מוצמד
  // לשער החליפין כמו "מדד", 25% על הרווח הריאלי בלבד) - כאן רק לוקחים
  // את הסכום המצטבר, במקום לחשב שוב ברמת התיק (שהיה עלול לתת תוצאה
  // מעט שונה אם למניות שונות יש שערי חליפין נוכחיים שונים).
  const americanTaxUSD = americanSummary.totalTaxUSD;
  const americanAfterTaxUSD = americanProfitUSD - americanTaxUSD;
  const americanProfitPercent = americanSummary.totalPurchaseUSD > 0 ? (americanProfitUSD / americanSummary.totalPurchaseUSD) * 100 : 0;
  const americanDailyPercent = americanSummary.totalCurrentValueUSD > 0 ? (americanDailyProfitUSD / americanSummary.totalCurrentValueUSD) * 100 : 0;
  const americanTaxILS = americanSummary.totalTaxILS;

  // Total capital by category
  const cashFundsTotalILS = cashFunds.reduce((sum, item) => sum + (item.amount || 0), 0);
  // סך ההשקעה בקופות גמל נגזר תמיד מפנקס ההפקדות (deposits) - בדיוק
  // כמו "סה\"כ רכישה" במניות שנגזר מרשימת הרכישות, לא שדה שמתעדכן ידנית.
  const pensionInitialInvestmentILS = pensionFunds.reduce((sum, item) => {
    const deposits = Array.isArray(item.deposits) ? item.deposits : [];
    return sum + deposits.reduce((s, d) => s + (d.amount || 0), 0);
  }, 0);
  const pensionCurrentValueILS = pensionFunds.reduce((sum, item) => sum + (item.currentValue ?? item.amount ?? 0), 0);
  const pensionPreviousValueILS = pensionFunds.reduce((sum, item) => sum + (item.previousValue ?? item.amount ?? 0), 0);

  // "רווח מצטבר מול הפקדות" - חלוקת הרווח הכולל בסך כל ההפקדות שבוצעו אי-פעם.
  // שים לב: זהו מדד עזר בלבד ולא תשואה אמיתית, כיוון שהפקדות מתבצעות
  // בתאריכים שונים (למשל הפקדה חודשית) ומתייחסות כאן כאילו כל הכסף
  // הופקד ביום הראשון. לכן ככל שיש הפקדות "טריות" יותר, האחוז הזה
  // מוטה כלפי מטה ואינו משקף נכון את קצב הצמיחה של הקופה.
  const pensionProfitPercent = pensionInitialInvestmentILS > 0 ? ((pensionCurrentValueILS / pensionInitialInvestmentILS) - 1) * 100 : 0;

  // תשואה מעדכון-לעדכון (השווי הקודם מול השווי הנוכחי), מנוטרלת אוטומטית
  // מהפקדות שבוצעו בתקופה: לכל קופה מזהים (לפי תאריכים - ראו
  // calculatePensionPeriodReturn ב-portfolioMath.js) אילו הפקדות בפנקס
  // נופלו בין previousValueDate ל-currentValueDate, ומתאימים את השווי
  // הקודם בהתאם - כדי שהפקדות כסף חדש לא "יתחזו" לרווח.
  const pensionAdjustedPreviousValueILS = pensionFunds.reduce(
    (sum, item) => sum + calculatePensionPeriodReturn(item).adjustedPreviousValue,
    0
  );
  const pensionPreviousProfitPercent = pensionAdjustedPreviousValueILS > 0 ? ((pensionCurrentValueILS / pensionAdjustedPreviousValueILS) - 1) * 100 : (pensionInitialInvestmentILS > 0 ? ((pensionCurrentValueILS / pensionInitialInvestmentILS) - 1) * 100 : 0);
  const pensionTotalProfitILS = pensionCurrentValueILS - pensionInitialInvestmentILS;
  // מס על קופות גמל: תמיד 25% על הרווח הריאלי בלבד (כל הפקדה מוצמדת
  // בנפרד לפי תאריך ההפקדה שלה, ראו cpiTax.js) - אין עוד ברירת מס שטוח
  // על הרווח הנומינלי. כשהמדד לא זמין עדיין (טעינה ראשונית/כשל רשת)
  // נופלים חזרה למס הישן (25% שטוח על כלל קופות הגמל) כדי שהאפליקציה
  // תמשיך לעבוד.
  //
  // pensionRealGainILS / pensionInflationaryGainILS נשמרים בנפרד כדי
  // שאפשר יהיה להציג אותם בממשק ולוודא את החישוב.
  let pensionTaxILS;
  let pensionRealGainILS;
  let pensionInflationaryGainILS;
  if (currentIndex) {
    const perFund = pensionFunds.map((fund) => {
      const deposits = Array.isArray(fund.deposits) ? fund.deposits : [];
      const fundCurrentValue = fund.currentValue ?? fund.amount ?? 0;
      return calculatePensionRealGainTax({
        deposits,
        currentValue: fundCurrentValue,
        currentIndex,
        indexByMonth
      });
    });
    pensionTaxILS = perFund.reduce((sum, r) => sum + r.tax, 0);
    pensionRealGainILS = perFund.reduce((sum, r) => sum + r.gain, 0);
    // רכיב אינפלציוני נגזר כ"מה שנשאר" מהנומינלי אחרי הרווח הריאלי -
    // לא חישוב עצמאי - מאותה סיבה בדיוק כמו למניות ישראליות למעלה.
    const pensionTotalNominalILS = pensionFunds.reduce((sum, fund) => {
      const deposits = Array.isArray(fund.deposits) ? fund.deposits : [];
      const totalDeposited = deposits.reduce((s, d) => s + (d.amount || 0), 0);
      const fundCurrentValue = fund.currentValue ?? fund.amount ?? 0;
      return sum + (fundCurrentValue - totalDeposited);
    }, 0);
    pensionInflationaryGainILS = pensionTotalNominalILS - pensionRealGainILS;
  } else {
    pensionTaxILS = pensionTotalProfitILS > 0 ? pensionTotalProfitILS * TAX_RATE : 0;
    pensionRealGainILS = pensionTotalProfitILS;
    pensionInflationaryGainILS = 0;
  }
  const pensionUpdateProfitILS = pensionCurrentValueILS - pensionPreviousValueILS;

  // קופות חיסכון בבנק: השווי הנוכחי תמיד מחושב (ריבית-דריבית אוטומטית
  // מכל הפקדה, ראו bankSavingsFund.js) - אין שווי ידני לעדכן. המס תלוי
  // בבחירת המסלול (צמוד/לא צמוד למדד) שכל קופה כזו נושאת בעצמה.
  const bankSavingsInitialInvestmentILS = bankSavingsFunds.reduce((sum, fund) => {
    const deposits = Array.isArray(fund.deposits) ? fund.deposits : [];
    return sum + deposits.reduce((s, d) => s + (d.amount || 0), 0);
  }, 0);
  const bankSavingsCurrentValueILS = bankSavingsFunds.reduce(
    (sum, fund) => sum + computeBankSavingsFundValue(fund),
    0
  );
  const bankSavingsTotalProfitILS = bankSavingsCurrentValueILS - bankSavingsInitialInvestmentILS;
  let bankSavingsTaxILS = 0;
  let bankSavingsRealGainILS = 0;
  bankSavingsFunds.forEach((fund) => {
    const deposits = Array.isArray(fund.deposits) ? fund.deposits : [];
    const currentValue = computeBankSavingsFundValue(fund);
    const result = calculateBankSavingsFundTax({
      deposits,
      currentValue,
      isLinkedToIndex: !!fund.isLinkedToIndex,
      currentIndex,
      indexByMonth
    });
    bankSavingsTaxILS += result.tax;
    bankSavingsRealGainILS += result.gain;
  });

  const totalTaxILS = israeliTaxILS + americanTaxILS + pensionTaxILS + bankSavingsTaxILS;
  const totalProfitAfterTaxILS =
    (israeliSummary.totalProfitILS + americanSummary.totalProfitILS + pensionTotalProfitILS + bankSavingsTotalProfitILS) -
    totalTaxILS;
  // פירוק מאוחד לרווח ריאלי/אינפלציוני על פני כל הסוגים יחד (מניות
  // ישראליות + מניות אמריקאיות + קופות גמל + קופות חיסכון בבנק) - סכום
  // פשוט של השדות שכל אחד מהם כבר מחשב לעצמו.
  const totalRealGainILS =
    israeliSummary.totalRealGainILS + americanSummary.totalRealGainILS + pensionRealGainILS + bankSavingsRealGainILS;
  const totalInflationaryGainILS = israeliSummary.totalInflationaryGainILS + americanSummary.totalCurrencyExemptGainILS + pensionInflationaryGainILS;
  const bankBalancesTotalILS = bankBalances.reduce((sum, item) => sum + (item.amount || 0), 0);
  const capitalIsraeliILS = israeliSummary.totalCurrentValueILS;
  const capitalAmericanILS = americanSummary.totalCurrentValueILS;
  const capitalTotalILS =
    capitalIsraeliILS +
    capitalAmericanILS +
    cashFundsTotalILS +
    pensionCurrentValueILS +
    bankBalancesTotalILS +
    bankSavingsCurrentValueILS;

  return {
    // ILS summary
    totalPurchaseILS: israeliSummary.totalPurchaseILS + americanSummary.totalPurchaseILS + pensionInitialInvestmentILS + bankSavingsInitialInvestmentILS,
    totalCurrentValueILS: israeliSummary.totalCurrentValueILS + americanSummary.totalCurrentValueILS + pensionCurrentValueILS + bankSavingsCurrentValueILS,
    totalProfitILS: israeliSummary.totalProfitILS + americanSummary.totalProfitILS + pensionTotalProfitILS + bankSavingsTotalProfitILS,

    // Israeli-only summary
    israeliOnlyPurchaseILS: israeliSummary.totalPurchaseILS,
    israeliOnlyCurrentValueILS: israeliSummary.totalCurrentValueILS,
    israeliOnlyProfitILS: israeliSummary.totalProfitILS,
    israeliOnlyTaxILS: israeliTaxILS,
    israeliOnlyAfterTaxILS: israeliAfterTaxILS,
    israeliOnlyProfitPercent: israeliProfitPercent,
    israeliOnlyDailyPercent: israeliDailyPercent,
    israeliOnlyDailyProfitILS: israeliDailyProfitILS,
    // פירוק הרווח הנומינלי לרכיב ריאלי (חייב במס) ורכיב אינפלציוני (פטור) -
    // כדי שאפשר יהיה לוודא את חישוב מס רווח ההון הריאלי
    israeliOnlyRealGainILS: israeliSummary.totalRealGainILS,
    israeliOnlyInflationaryGainILS: israeliSummary.totalInflationaryGainILS,

    // USD summary
    totalPurchaseUSD: americanSummary.totalPurchaseUSD,
    totalCurrentValueUSD: americanSummary.totalCurrentValueUSD,
    totalProfitUSD: americanSummary.totalProfitUSD,
    americanOnlyTaxUSD: americanTaxUSD,
    americanOnlyTaxILS: americanTaxILS,
    // פירוק הרווח בשקלים לרכיב ריאלי (חייב במס) ורכיב הנובע משינוי שער
    // החליפין (פטור - "הסכום האינפלציוני" המקביל לניירות ערך זרים)
    americanOnlyRealGainILS: americanSummary.totalRealGainILS,
    americanOnlyCurrencyExemptGainILS: americanSummary.totalCurrencyExemptGainILS,
    americanOnlyAfterTaxUSD: americanAfterTaxUSD,
    americanOnlyProfitPercent: americanProfitPercent,
    americanOnlyDailyPercent: americanDailyPercent,
    americanOnlyDailyProfitUSD: americanDailyProfitUSD,

    // Weighted daily-change percentage
    weightedDailyChange: weightedDailyChange,
    // Which markets that figure includes: 'today' (traded today), 'closed'
    // (last session was an earlier day, so it contributes 0) or null (no
    // holdings there) - lets the UI say what the number is made of.
    dailyChangeSessions: {
      israeli: marketSessionState(israeliStocks, today),
      american: marketSessionState(americanStocks, today)
    },

    // Daily profit in ILS and USD
    dailyProfitILS: dailyProfitILS,
    dailyProfitUSD: dailyProfitUSD,
    israeliDailyProfitILS: israeliDailyProfitILS,
    americanDailyProfitUSD: americanDailyProfitUSD,

    // Total FX impact
    totalExchangeImpact: americanSummary.totalExchangeImpact,

    // Capital breakdown
    capitalIsraeliILS,
    capitalAmericanILS,
    capitalCashFundsILS: cashFundsTotalILS,
    capitalPensionILS: pensionCurrentValueILS,
    pensionInitialInvestmentILS,
    pensionCurrentValueILS,
    pensionPreviousValueILS,
    pensionProfitPercent,
    pensionPreviousProfitPercent,
    pensionTotalProfitILS,
    pensionTaxILS,
    // פירוק הרווח לרכיב ריאלי (חייב במס, לפי הכלל שנבחר לכל קופה) ורכיב
    // אינפלציוני (פטור, רק לקופות מוצמדות למדד) - לוידוא החישוב בממשק
    pensionRealGainILS,
    pensionInflationaryGainILS,
    pensionUpdateProfitILS,
    capitalBankILS: bankBalancesTotalILS,
    capitalBankSavingsILS: bankSavingsCurrentValueILS,
    bankSavingsInitialInvestmentILS,
    bankSavingsCurrentValueILS,
    bankSavingsTotalProfitILS,
    bankSavingsTaxILS,
    bankSavingsRealGainILS,
    capitalTotalILS,
    totalTaxILS,
    totalRealGainILS,
    totalInflationaryGainILS,
    totalProfitAfterTaxILS
  };
};
