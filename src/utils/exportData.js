// Row-shaping for portfolio export (Excel/PDF) - pure functions, no library
// calls, so they're independently testable and reusable for both formats.
// Reuses the exact same calculations already used in each table's display
// (normalizeIsraeliPrice, calculateAmericanStockMetrics,
// calculatePensionPeriodReturn) rather than recomputing totals a different
// way, to avoid a repeat of the currency-unit bugs (אגורות/₪) that already
// happened more than once in this project.
//
// Every builder returns an array of plain objects keyed by their Hebrew
// column header. That shape is what both exporters consume directly: the
// workbook turns the keys into a header row, and the PDF turns them into a
// table head. Column ORDER is therefore key-insertion order here, and is
// the only place it is decided.
import { normalizeIsraeliPrice } from './formatters';
import { calculateAmericanStockMetrics, calculatePensionPeriodReturn } from './portfolioMath';
import { computeBankSavingsFundValue } from './bankSavingsFund';
import { effectiveDailyChangePercent } from './marketSession';
import { israeliStockDisplayName, effectiveExchangeForIsraeliStock } from './israeliEtfClassifier';
import { computeSectorDistribution } from './sectorAnalysis';
import { sectorLabelHe } from './sectorLabels';

const round2 = (n) => Math.round((n || 0) * 100) / 100;

// A percentage of a base that may legitimately be zero (an account with no
// deposits, a holding recorded at no cost). '' rather than 0 there, so an
// unknown return is never exported as a confident "0.00%".
const percentOf = (part, base) => (base > 0 ? round2((part / base) * 100) : '');

const depositList = (item) => (Array.isArray(item && item.deposits) ? item.deposits : []);

const sumDeposits = (item) => depositList(item).reduce((sum, d) => sum + (d.amount || 0), 0);

// The dates a ledger account's own deposit book spans. Both are exported
// because a fund's headline value means something different depending on
// how long the money has been in it.
const firstDepositDate = (item) => {
  const dates = depositList(item)
    .map((d) => d.date)
    .filter(Boolean)
    .sort();
  return dates[0] || '';
};

const lastDepositDate = (item) => {
  const dates = depositList(item)
    .map((d) => d.date)
    .filter(Boolean)
    .sort();
  return dates[dates.length - 1] || '';
};

// An Israeli holding's `stockName` IS its TASE security number - the name
// lives in `officialName`, and is absent on holdings entered before that
// field existed. Exporting only one of the two would produce a report the
// reader cannot look a holding up from: the number is what identifies it
// at the exchange, the name is what identifies it to a person.
export const buildIsraeliStocksExportRows = (israeliStocks) =>
  (israeliStocks || []).map((stock) => {
    const currentPrice = normalizeIsraeliPrice(stock.currentPrice);
    const quantity = stock.quantity || 0;
    const totalPurchase = (stock.purchasePrice || 0) * quantity;
    const totalCurrentValue = (currentPrice || 0) * quantity;
    const profit = totalCurrentValue - totalPurchase;
    return {
      'שם נייר': israeliStockDisplayName(stock),
      'מספר נייר': String(stock.stockName || ''),
      'סוג נייר': stock.securityType || '',
      'ענף': stock.branch || '',
      'נכס זר': effectiveExchangeForIsraeliStock(stock) === 'american' ? 'כן' : 'לא',
      'תאריך קנייה': stock.purchaseDate || '',
      'מחיר קנייה (₪)': round2(stock.purchasePrice || 0),
      'כמות': quantity,
      'מחיר נוכחי (₪)': round2(currentPrice),
      'שינוי יומי (%)': round2(effectiveDailyChangePercent(stock)),
      'סה"כ רכישה (₪)': round2(totalPurchase),
      'סה"כ שווי נוכחי (₪)': round2(totalCurrentValue),
      'רווח/הפסד (₪)': round2(profit),
      'רווח/הפסד (%)': percentOf(profit, totalPurchase)
    };
  });

export const buildAmericanStocksExportRows = (americanStocks) =>
  (americanStocks || []).map((stock) => {
    const m = calculateAmericanStockMetrics(stock);
    const quantity = stock.quantity || 0;
    const totalPurchaseUSD = (stock.purchasePrice || 0) * quantity;
    return {
      'סימול': stock.stockName || '',
      'תאריך קנייה': stock.purchaseDate || '',
      'מחיר קנייה ($)': round2(stock.purchasePrice || 0),
      'כמות': quantity,
      'מחיר נוכחי ($)': round2(stock.currentPrice || 0),
      'שינוי יומי (%)': round2(effectiveDailyChangePercent(stock)),
      // Both rates, because the gap between them is the whole of the
      // currency effect the last column reports.
      'שער חליפין בקנייה': round2(stock.exchangeRate || 0),
      'שער חליפין נוכחי': round2(stock.currentExchangeRate || stock.exchangeRate || 0),
      'סה"כ רכישה ($)': round2(totalPurchaseUSD),
      'סה"כ רכישה (₪)': round2(m.totalPurchaseILS),
      'סה"כ שווי נוכחי ($)': round2(m.totalCurrentValueUSD),
      'סה"כ שווי נוכחי (₪)': round2(m.totalCurrentValueILS),
      'רווח/הפסד ($)': round2(m.profitUSD),
      'רווח/הפסד (₪)': round2(m.profitILS),
      'רווח/הפסד (%)': percentOf(m.profitUSD, totalPurchaseUSD),
      'השפעת שער חליפין (₪)': round2(m.exchangeRateImpact)
    };
  });

export const buildPensionFundsExportRows = (pensionFunds) =>
  (pensionFunds || []).map((fund) => {
    const currentValue = fund.currentValue ?? fund.amount ?? 0;
    const periodReturn = calculatePensionPeriodReturn(fund);
    const deposits = depositList(fund);
    const totalDeposited = sumDeposits(fund);
    const cumulativeProfit = currentValue - totalDeposited;
    return {
      'שם קופה': fund.fundName || '',
      'סך הפקדות (₪)': round2(totalDeposited),
      'מספר הפקדות': deposits.length,
      'הפקדה ראשונה': firstDepositDate(fund),
      'הפקדה אחרונה': lastDepositDate(fund),
      'שווי נוכחי (₪)': round2(currentValue),
      'תאריך שווי נוכחי': fund.currentValueDate || '',
      'שווי קודם (₪)': round2(fund.previousValue || 0),
      'תאריך שווי קודם': fund.previousValueDate || '',
      // The period return is the like-for-like one between two valuations
      // (deposits in between already neutralized); the cumulative pair
      // below is simply value minus everything paid in.
      'תשואת תקופה (%)': fund.previousValue ? round2(periodReturn.percent) : '',
      'רווח/הפסד מצטבר (₪)': round2(cumulativeProfit),
      'תשואה מצטברת (%)': percentOf(cumulativeProfit, totalDeposited)
    };
  });

export const buildCashFundsExportRows = (cashFunds) =>
  (cashFunds || []).map((fund) => {
    const deposits = depositList(fund);
    const totalDeposited = sumDeposits(fund);
    // `currentValue` is the maintained balance; `amount` is the legacy
    // single-number shape that predates the deposit ledger.
    const currentValue = fund.currentValue ?? fund.amount ?? 0;
    return {
      'שם קרן': fund.fundName || '',
      'מספר נייר': String(fund.securityId || ''),
      'סך הפקדות (₪)': round2(totalDeposited),
      'מספר תנועות': deposits.length,
      'הפקדה ראשונה': firstDepositDate(fund),
      'יתרה נוכחית (₪)': round2(currentValue),
      'תאריך עדכון': fund.currentValueDate || fund.updateDate || '',
      'רווח/הפסד (₪)': round2(currentValue - totalDeposited)
    };
  });

export const buildBankBalancesExportRows = (bankBalances) =>
  (bankBalances || []).map((balance) => {
    const deposits = depositList(balance);
    const totalMovements = sumDeposits(balance);
    const currentValue = balance.currentValue ?? balance.amount ?? 0;
    return {
      'יתרה נוכחית (₪)': round2(currentValue),
      'תאריך עדכון': balance.currentValueDate || balance.updateDate || '',
      'יתרה קודמת (₪)': round2(balance.previousValue || 0),
      'תאריך יתרה קודמת': balance.previousValueDate || '',
      // Net of the whole book, so a withdrawal (a negative row) reduces it
      // rather than being counted as another deposit.
      'סך הפקדות/משיכות (₪)': round2(totalMovements),
      'מספר תנועות': deposits.length
    };
  });

export const buildBankSavingsFundsExportRows = (bankSavingsFunds) =>
  (bankSavingsFunds || []).map((fund) => {
    const deposits = depositList(fund);
    const totalDeposited = sumDeposits(fund);
    const currentValue = computeBankSavingsFundValue(fund);
    const profit = currentValue - totalDeposited;
    return {
      'שם פיקדון': fund.fundName || '',
      'מסלול השקעה': fund.investmentTrack || '',
      'ריבית (%)': round2(fund.interestRate || 0),
      'צמוד למדד': fund.isLinkedToIndex ? 'כן' : 'לא',
      'סך הפקדות (₪)': round2(totalDeposited),
      'מספר הפקדות': deposits.length,
      'הפקדה ראשונה': firstDepositDate(fund),
      'הפקדה אחרונה': lastDepositDate(fund),
      'שווי נוכחי (₪)': round2(currentValue),
      'רווח/הפסד (₪)': round2(profit),
      'רווח/הפסד (%)': percentOf(profit, totalDeposited)
    };
  });

// A compact list of the headline totals from calculatePortfolioSummary
// (portfolioSummary.js) - field names match that module's return shape
// directly rather than remapping every field, since it already has many.
export const buildSummaryExportRows = (summary) => {
  if (!summary) return [];
  return [
    { 'מדד': 'סה"כ שווי תיק (₪)', 'ערך': round2(summary.totalCurrentValueILS) },
    { 'מדד': 'סה"כ השקעה (₪)', 'ערך': round2(summary.totalPurchaseILS) },
    { 'מדד': 'סה"כ רווח/הפסד (₪)', 'ערך': round2(summary.totalProfitILS) },
    { 'מדד': 'שינוי יומי משוקלל (%)', 'ערך': round2(summary.weightedDailyChange) },
    { 'מדד': 'רווח/הפסד יומי (₪)', 'ערך': round2(summary.dailyProfitILS) }
  ];
};

// ---------------------------------------------------------------------
// THE PDF REPORT'S OWN SECTIONS
// ---------------------------------------------------------------------
//
// The builders above answer "give me every row of this asset class" and
// are what the Excel export is made of. A printed report needs the other
// half too: for each asset class, the two or three figures that describe
// it, above the rows that make it up.
//
// They are here rather than in exportReport.js for the same reason as
// everything else in this file - they are arithmetic over the portfolio,
// and arithmetic is testable without a PDF engine. exportReport.js only
// decides how they are drawn.

// The figures the report opens with. Deliberately the same four the
// dashboard leads with, so the document and the screen cannot disagree
// about what the portfolio is worth.
export const buildHeadlineMetrics = (summary) => {
  if (!summary) return [];
  const profitPercent =
    summary.totalPurchaseILS > 0
      ? round2((summary.totalProfitILS / summary.totalPurchaseILS) * 100)
      : null;
  return [
    {
      label: 'שווי תיק כולל',
      value: round2(summary.capitalTotalILS),
      unit: '₪',
      note: 'סך כל הנכסים'
    },
    {
      label: 'רווח/הפסד כולל',
      value: round2(summary.totalProfitILS),
      unit: '₪',
      note: profitPercent == null ? 'אין השקעה רשומה' : `${profitPercent}% מההשקעה`,
      signed: true
    },
    {
      label: 'שינוי יומי',
      value: round2(summary.dailyProfitILS),
      unit: '₪',
      note: `${round2(summary.weightedDailyChange)}% משוקלל`,
      signed: true
    },
    {
      label: 'מס צפוי',
      value: round2(summary.totalTaxILS),
      unit: '₪',
      note: 'על הרווח הריאלי'
    }
  ];
};

// WHAT THE PRINTED TABLE SHOWS, per asset class.
//
// Not the same columns as the spreadsheet, on purpose. An A4 page is 182mm
// of usable width, so the US sheet's sixteen columns come to ~11mm each -
// about five characters before a header wraps, which is a table nobody can
// read holding up a table nobody can read. The spreadsheet is where the
// full record lives and where a column can be widened; the report is a
// statement, and a statement names the holding, what was paid, what it is
// worth and what that came to.
//
// Listed by key rather than by index so a column added to a builder above
// does not silently shift what the report prints. A key that is not in a
// row is skipped, so a projection can safely name a column that only some
// portfolios have.
const REPORT_COLUMNS = {
  'בורסה ישראלית': [
    'שם נייר',
    'מספר נייר',
    'תאריך קנייה',
    'כמות',
    'מחיר קנייה (₪)',
    'מחיר נוכחי (₪)',
    'סה"כ רכישה (₪)',
    'סה"כ שווי נוכחי (₪)',
    'רווח/הפסד (₪)',
    'רווח/הפסד (%)'
  ],
  'בורסה אמריקאית': [
    'סימול',
    'תאריך קנייה',
    'כמות',
    'מחיר קנייה ($)',
    'מחיר נוכחי ($)',
    'שער חליפין נוכחי',
    'סה"כ שווי נוכחי ($)',
    'סה"כ שווי נוכחי (₪)',
    'רווח/הפסד (₪)',
    'רווח/הפסד (%)'
  ],
  'קופות גמל להשקעה': [
    'שם קופה',
    'סך הפקדות (₪)',
    'מספר הפקדות',
    'הפקדה ראשונה',
    'שווי נוכחי (₪)',
    'תאריך שווי נוכחי',
    'תשואת תקופה (%)',
    'רווח/הפסד מצטבר (₪)',
    'תשואה מצטברת (%)'
  ]
};

// A row narrowed to the named columns, keeping the order named here rather
// than the row's own - the report decides its own reading order.
const pickColumns = (rows, keys) => {
  if (!keys) return rows;
  return rows.map((row) =>
    keys.reduce((picked, key) => {
      if (key in row) picked[key] = row[key];
      return picked;
    }, {})
  );
};

// Label/value pairs, one list per asset class, in the order the report
// prints them. `rows` is the itemized detail that goes underneath.
//
// A section with no holdings is still returned, with `isEmpty` set - the
// report says "no holdings in this class" rather than silently omitting a
// heading, so the reader can tell an empty account from a missing one.
export const buildPortfolioReportSections = (data = {}) => {
  const summary = data.summary || {};
  const sections = [];

  const section = (title, metrics, rows, emptyNote) =>
    sections.push({
      title,
      metrics,
      rows: pickColumns(rows || [], REPORT_COLUMNS[title]),
      isEmpty: !rows || rows.length === 0,
      emptyNote
    });

  // A metric pair's optional third element marks it as the section's
  // bottom line - the one figure the rest of the list adds up to, which
  // the report picks out. Explicit rather than "whichever is last":
  // several of these lists end on a tax estimate, and printing that as
  // the section's conclusion says something the section does not mean.
  const TOTAL = true;

  section(
    'מצב ההון - פירוט לפי אפיק',
    [
      ['בורסה ישראלית', round2(summary.capitalIsraeliILS)],
      ['בורסה אמריקאית', round2(summary.capitalAmericanILS)],
      ['קופות גמל להשקעה', round2(summary.capitalPensionILS)],
      ['קרנות כספיות', round2(summary.capitalCashFundsILS)],
      ['עו"ש', round2(summary.capitalBankILS)],
      ['קופת חיסכון בבנק', round2(summary.capitalBankSavingsILS)],
      ['סה"כ מצב ההון', round2(summary.capitalTotalILS), TOTAL]
    ],
    [],
    null
  );

  section(
    'השקעה נטו - שני השווקים יחד',
    [
      ['סה"כ השקעה', round2(summary.totalPurchaseILS)],
      ['סה"כ שווי נוכחי', round2(summary.totalCurrentValueILS)],
      ['רווח ריאלי - חייב במס', round2(summary.totalRealGainILS)],
      ['רווח אינפלציוני - פטור', round2(summary.totalInflationaryGainILS)],
      ['מס צפוי', round2(summary.totalTaxILS)],
      ['רווח נטו אחרי מס', round2(summary.totalProfitAfterTaxILS)],
      ['סה"כ רווח/הפסד', round2(summary.totalProfitILS), TOTAL]
    ],
    [],
    null
  );

  section(
    'בורסה ישראלית',
    [
      ['סך רכישה', round2(summary.israeliOnlyPurchaseILS)],
      ['שווי נוכחי', round2(summary.israeliOnlyCurrentValueILS)],
      ['רווח/הפסד (%)', round2(summary.israeliOnlyProfitPercent)],
      ['רווח ריאלי - חייב במס', round2(summary.israeliOnlyRealGainILS)],
      ['מס צפוי', round2(summary.israeliOnlyTaxILS)],
      ['רווח נטו אחרי מס', round2(summary.israeliOnlyAfterTaxILS)],
      ['רווח/הפסד', round2(summary.israeliOnlyProfitILS), TOTAL]
    ],
    buildIsraeliStocksExportRows(data.israeliStocks),
    'אין ניירות ערך מהבורסה הישראלית בתיק.'
  );

  section(
    'בורסה אמריקאית',
    [
      ['סך רכישה ($)', round2(summary.totalPurchaseUSD)],
      ['שווי נוכחי ($)', round2(summary.totalCurrentValueUSD)],
      ['רווח/הפסד ($)', round2(summary.totalProfitUSD)],
      ['רווח/הפסד (%)', round2(summary.americanOnlyProfitPercent)],
      ['השפעת שער חליפין (₪)', round2(summary.totalExchangeImpact)],
      ['מס צפוי (₪)', round2(summary.americanOnlyTaxILS)],
      ['שווי נוכחי (₪)', round2(summary.capitalAmericanILS), TOTAL]
    ],
    buildAmericanStocksExportRows(data.americanStocks),
    'אין מניות מהבורסה האמריקאית בתיק.'
  );

  section(
    'קופות גמל להשקעה',
    [
      ['סך הפקדות', round2(summary.pensionInitialInvestmentILS)],
      ['רווח/הפסד', round2(summary.pensionTotalProfitILS)],
      ['רווח/הפסד (%)', round2(summary.pensionProfitPercent)],
      ['רווח ריאלי - חייב במס', round2(summary.pensionRealGainILS)],
      ['מס צפוי', round2(summary.pensionTaxILS)],
      ['שווי נוכחי', round2(summary.pensionCurrentValueILS), TOTAL]
    ],
    buildPensionFundsExportRows(data.pensionFunds),
    'אין קופות גמל להשקעה בתיק.'
  );

  section(
    'קרנות כספיות',
    [['סה"כ שווי', round2(summary.capitalCashFundsILS), TOTAL]],
    buildCashFundsExportRows(data.cashFunds),
    'אין קרנות כספיות בתיק.'
  );

  section(
    'עובר ושב (עו"ש)',
    [['סה"כ יתרה', round2(summary.capitalBankILS), TOTAL]],
    buildBankBalancesExportRows(data.bankBalances),
    'אין יתרות עו"ש בתיק.'
  );

  section(
    'קופת חיסכון בבנק',
    [
      ['סך הפקדות', round2(summary.bankSavingsInitialInvestmentILS)],
      ['רווח/הפסד', round2(summary.bankSavingsTotalProfitILS)],
      ['רווח ריאלי - חייב במס', round2(summary.bankSavingsRealGainILS)],
      ['מס צפוי', round2(summary.bankSavingsTaxILS)],
      ['שווי נוכחי', round2(summary.bankSavingsCurrentValueILS), TOTAL]
    ],
    buildBankSavingsFundsExportRows(data.bankSavingsFunds),
    'אין קופות חיסכון בבנק בתיק.'
  );

  return sections;
};

// ---------------------------------------------------------------------
// WHEN THE REPORT IS TRUE FOR
// ---------------------------------------------------------------------
//
// A printed report outlives the screen it came from, so it has to say
// what moment its figures describe - and that is not always the moment it
// was printed. Share prices are as of the last price refresh; provident
// fund values are as of the statements they were typed in from, which can
// be weeks older. Both are stated, so nobody reads a September statement
// as today's balance.

// dd/mm/yyyy, the way dates are written in Israel. Takes 'YYYY-MM-DD'.
export const formatReportDate = (isoDate) => {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(isoDate || ''));
  return match ? `${match[3]}/${match[2]}/${match[1]}` : '';
};

// "dd/mm/yyyy בשעה HH:MM" in Israel time, whatever the device's own zone.
export const formatReportDateTime = (instant) => {
  const date = instant instanceof Date ? instant : new Date(instant);
  if (Number.isNaN(date.getTime())) return '';
  const parts = {};
  new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Jerusalem',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  })
    .formatToParts(date)
    .forEach((p) => {
      parts[p.type] = p.value;
    });
  // "בשעה" between the two, not a space: a date and a time side by side in
  // a Hebrew line can be read in either order, and the hyphen of "ל-"
  // ends up looking attached to the time.
  return `${parts.day}/${parts.month}/${parts.year} בשעה ${parts.hour}:${parts.minute}`;
};

const statementDate = (fund) => String((fund && (fund.currentValueDate || fund.updateDate)) || '').slice(0, 10);

// { asOf, prices, statements, generated } - display strings for the cover.
//   pricesAsOf: when prices were last refreshed live (null: only the
//   prices saved with the portfolio were available).
export const buildReportAsOf = ({ generatedAt = new Date(), pricesAsOf = null, pensionFunds = [] } = {}) => {
  const generated = formatReportDateTime(generatedAt);
  const live = pricesAsOf ? formatReportDateTime(pricesAsOf) : '';
  const dates = (pensionFunds || [])
    .filter((f) => Number(f.currentValue ?? f.amount) > 0)
    .map(statementDate)
    .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
    .sort();
  let statements = '';
  if (dates.length) {
    const first = formatReportDate(dates[0]);
    const last = formatReportDate(dates[dates.length - 1]);
    statements = first === last ? `קופות גמל לפי דוחות מ-${last}` : `קופות גמל לפי דוחות מ-${first} עד ${last}`;
  }
  return {
    asOf: `נכון ל-${live || generated}`,
    prices: live ? `מחירי שוק מ-${live}` : 'מחירי שוק: האחרונים שנשמרו',
    statements,
    generated: `הופק ${generated}`
  };
};

// ---------------------------------------------------------------------
// THE DISTRIBUTION CHARTS
// ---------------------------------------------------------------------
//
// The same two splits the analysis page draws as donuts: by asset class,
// and by sector. Slices with no value are left out - a 0% wedge is
// invisible and its legend row is noise.

const ALLOCATION_SLICES = [
  ['israeli', 'בורסה ישראלית', 'capitalIsraeliILS'],
  ['american', 'בורסה אמריקאית', 'capitalAmericanILS'],
  ['pension', 'קופות גמל', 'capitalPensionILS'],
  ['cashFunds', 'קרנות כספיות', 'capitalCashFundsILS'],
  ['bank', 'עו"ש', 'capitalBankILS'],
  ['bankSavings', 'קופת חיסכון בבנק', 'capitalBankSavingsILS']
];

const withPercents = (slices) => {
  const total = slices.reduce((sum, s) => sum + s.value, 0);
  return slices.map((s) => ({ ...s, percent: total > 0 ? round2((s.value / total) * 100) : 0 }));
};

// By asset class, from the same summary figures as the report's
// "מצב ההון" section, so the chart and the table beside it agree.
export const buildAllocationSlices = (summary) => {
  if (!summary) return [];
  return withPercents(
    ALLOCATION_SLICES.map(([key, label, field]) => ({ key, label, value: round2(summary[field]) })).filter((s) => s.value > 0)
  );
};

// More sectors than this and the small ones are merged into "אחר": a
// donut with fifteen slivers cannot be read, and neither can its legend.
export const MAX_SECTOR_SLICES = 8;

// By sector, over the shares only (a provident fund or a bank balance has
// no sector) - the same calculation as the analysis page's sector donut.
export const buildSectorSlices = ({ americanStocks = [], israeliStocks = [], sectorBySymbol = {} } = {}) => {
  const { sectors } = computeSectorDistribution(americanStocks, sectorBySymbol, israeliStocks);
  const positive = sectors.filter((s) => s.value > 0);
  const kept = positive.length > MAX_SECTOR_SLICES ? positive.slice(0, MAX_SECTOR_SLICES - 1) : positive;
  const slices = kept.map((s) => ({ key: s.sectorKey, label: sectorLabelHe(s.sectorKey), value: round2(s.value) }));
  const rest = positive.slice(kept.length).reduce((sum, s) => sum + s.value, 0);
  if (rest > 0) slices.push({ key: '__other__', label: 'אחר', value: round2(rest) });
  return withPercents(slices);
};
