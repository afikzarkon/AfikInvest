// Every number the portfolio review is built on, in one place.
//
// The review (utils/portfolioReview.js) is a set of rules, and a rule is
// only as honest as its thresholds. They live here rather than inside the
// scoring code so that changing a weight, a tax rate or a "too
// concentrated" line is a one-line edit that every category, every text
// and the "how the score was computed" panel then follow - nothing reads a
// bare number of its own.
//
// None of these is a claim about what is good investing in general. They
// are deliberately round reference points for a self-consistent scale, the
// same stance utils/portfolioHealthScore.js takes.

// ---------------------------------------------------------------------------
// Weights of each category in the overall score.
//
// A category without enough data is left out and the remaining weights are
// rescaled to sum to 100% (see combineCategoryScores), so these are
// relative weights, not percentages that must add up. The goal weighs the
// most when the user set one: progress toward their own target is the
// question the rest of the review serves. Dividends are information, not a
// grade (an investor who prefers growth is not doing worse), so they show
// figures but take no part in the overall score.
export const CATEGORY_WEIGHTS = {
  volume: 9,
  comparison: 5,
  success: 7,
  diversification: 15,
  discipline: 10,
  riskAdjusted: 9,
  decisions: 9,
  activity: 7,
  costs: 6,
  tax: 5,
  benchmark: 8,
  cash: 6,
  goal: 16,
  dividends: 0
};

// The order categories are listed in, and the "core" set that the spec
// puts first.
export const CATEGORY_ORDER = [
  'volume',
  'comparison',
  'success',
  'diversification',
  'discipline',
  'riskAdjusted',
  'decisions',
  'activity',
  'costs',
  'tax',
  'benchmark',
  'cash',
  'goal',
  'dividends'
];

export const CORE_CATEGORIES = ['volume', 'comparison', 'success', 'diversification'];

export const CATEGORY_LABELS_HE = {
  volume: 'היקף ההשקעה החודש',
  comparison: 'השוואה לחודשים קודמים',
  success: 'הצלחת ההשקעות החודש',
  diversification: 'פיזור וסיכון',
  discipline: 'משמעת והתמדה',
  riskAdjusted: 'תשואה מותאמת סיכון',
  decisions: 'איכות ההחלטות',
  activity: 'פעילות מול סבלנות',
  costs: 'עלויות',
  tax: 'יעילות מס',
  benchmark: 'השוואה למדד',
  cash: 'מזומן חופשי',
  goal: 'התקדמות מול יעד',
  dividends: 'דיבידנדים והכנסה פסיבית'
};

// Below this many scored categories the overall score is withheld: an
// average of one or two numbers would be presented as a verdict on the
// whole portfolio.
export const MIN_CATEGORIES_FOR_OVERALL = 3;

// The verbal rating beside the overall score. Checked top-down.
export const RATING_BANDS = [
  { min: 85, label: 'מצוין' },
  { min: 70, label: 'טוב מאוד' },
  { min: 55, label: 'טוב' },
  { min: 40, label: 'בינוני' },
  { min: 0, label: 'טעון שיפור' }
];

// ---------------------------------------------------------------------------
// History windows

export const HISTORY_MONTHS = 12; // how far back the trend chart and the comparisons reach
export const SHORT_AVG_MONTHS = 3;
export const LONG_AVG_MONTHS = 6;

// ---------------------------------------------------------------------------
// Thresholds, per category. Each `points` list is a piecewise-linear map
// from the metric to a 0-100 score (see scoreFromPoints): between two
// points the score is interpolated, beyond the ends it stays at the end
// value.

export const THRESHOLDS = {
  volume: {
    // this month's investment / the 3-month average
    amountVsAvgPoints: [[0, 10], [0.5, 55], [0.9, 90], [1, 100]],
    // share of this month's money that went into the single largest
    // individual stock (funds and ETFs are diversified on their own)
    singleStockSharePoints: [[0.3, 100], [0.6, 65], [1, 30]],
    // coefficient of variation of monthly investment over 6 months
    consistencyCvPoints: [[0.3, 100], [0.8, 60], [1.5, 20]],
    // a month this many times the average reads as a one-off spike
    spikeRatio: 2.5,
    // ...and below this share of the average as a sharp drop
    dropRatio: 0.5
  },
  comparison: {
    // 6-month time-weighted return, in percent
    returnTrendPoints: [[-15, 10], [0, 50], [15, 100]],
    // last 3 months' average investment / the 3 months before
    contributionTrendPoints: [[0, 20], [0.5, 50], [1, 100]],
    // score change per month that counts as improving / eroding
    trendSlopePerMonth: 1.5
  },
  success: {
    // this month's portfolio return, in percent
    monthReturnPoints: [[-8, 0], [0, 50], [5, 100]]
  },
  diversification: {
    // largest single stock, % of the invested portfolio
    largestPositionPoints: [[10, 100], [20, 75], [40, 0]],
    largestPositionAlertPct: 20,
    // largest sector among the stock holdings, %
    topSectorPoints: [[25, 100], [50, 55], [80, 0]],
    topSectorAlertPct: 50,
    // largest currency of the whole portfolio, %
    currencyPoints: [[65, 100], [85, 70], [100, 35]],
    currencyAlertPct: 85,
    // Israel's share of the equity holdings, %. Both ends are penalized:
    // all of it at home is concentration in one small market, none of it
    // is not a problem in itself but leaves every shekel exposed to FX.
    homeBiasPoints: [[0, 80], [10, 100], [50, 100], [80, 50], [100, 20]],
    homeBiasAlertPct: 80
  },
  discipline: {
    fullStreakMonths: 6, // a streak this long scores 100
    regularityWindowMonths: 12,
    minMonthsForScore: 3
  },
  riskAdjusted: {
    volatilityPoints: [[10, 100], [20, 70], [35, 0]],
    drawdownPoints: [[5, 100], [15, 70], [40, 0]],
    sharpePoints: [[0, 20], [0.5, 60], [1, 100]],
    minMonthsForScore: 3
  },
  decisions: {
    profitFactorPoints: [[0.5, 10], [1, 50], [2, 100]],
    payoffRatioPoints: [[0.5, 20], [1, 60], [1.5, 100]],
    minClosedTrades: 3,
    biasPenaltyPerCase: 15,
    biasScoreFloor: 20,
    biasLookbackMonths: 12,
    // Disposition effect: a winner sold within this many days...
    dispositionWinnerMaxDays: 120,
    // ...while another holding sat at this loss (%) for longer.
    dispositionLoserMinLossPct: 10,
    // Chasing: a purchase after the price rose this much (%)...
    chasingRisePct: 15,
    // ...over this many calendar days before it.
    chasingWindowDays: 30,
    // Panic selling: a sale at a loss after a fall this deep (%)...
    panicDropPct: 15,
    panicWindowDays: 30
  },
  activity: {
    // annual turnover, % of the average portfolio value
    turnoverPoints: [[20, 100], [60, 70], [150, 20]],
    // average holding period, days
    holdingDaysPoints: [[30, 30], [180, 70], [365, 100]],
    longTermDays: 365
  },
  costs: {
    // trading fees over the last 12 months as % of the portfolio value
    feesPctPoints: [[0.1, 100], [0.5, 70], [1, 10]],
    lowFeeBadgePct: 0.5
  },
  tax: {
    // share of this year's tax that unused losses could have offset
    unusedOffsetPoints: [[0, 100], [0.25, 60], [1, 10]]
  },
  benchmark: {
    // (portfolio - same money in the index) / the index result, %
    excessPoints: [[-20, 10], [0, 60], [10, 100]]
  },
  cash: {
    // bank + money-market share of the portfolio, %
    cashSharePoints: [[15, 100], [40, 40], [80, 10]],
    idleAlertPct: 25
  },
  goal: {
    // average monthly investment / the monthly amount the goal needs
    paceRatioPoints: [[0, 0], [0.5, 40], [1, 100]]
  }
};

// ---------------------------------------------------------------------------
// Tax. Update here when the law changes; nothing else hard-codes a rate.
//
// Israeli capital-gains tax on securities for an individual: 25% of the
// REAL gain (CPI-indexed for shekel securities, FX-indexed for foreign
// ones). The higher rate for a "substantial shareholder" and the surtax on
// high incomes are not modelled. There is no lower rate for a long holding
// period: what time changes is the indexation, not the rate.
export const TAX_CONFIG = {
  capitalGainsRate: 0.25,
  dividendRate: 0.25,
  // US withholding on dividends for an Israeli resident with a W-8BEN
  // under the US-Israel treaty.
  usDividendWithholdingRate: 0.25,
  holdingPeriodNoteHe:
    'בישראל שיעור המס על רווח הון ליחיד אינו יורד עם תקופת ההחזקה. מה שמשתנה עם הזמן הוא ההצמדה: המס מוטל על הרווח הריאלי (בניכוי אינפלציה או שינוי שער), ולכן החזקה ארוכה בתקופת אינפלציה מקטינה את הרווח החייב.'
};

// ---------------------------------------------------------------------------
// Risk-adjusted return

// Annual risk-free rate for the simple Sharpe ratio. An approximation of
// the Bank of Israel rate - UPDATE when it changes.
export const RISK_FREE_RATE_ANNUAL_PCT = 4.0;

// ---------------------------------------------------------------------------
// Benchmarks the "simple alternative" can be measured against. Keys match
// server/benchmarkRoutes.js.
export const REVIEW_BENCHMARKS = [
  { key: 'sp500', label: 'S&P 500', currency: 'USD' },
  { key: 'ta125', label: 'תל אביב 125', currency: 'ILS' }
];

// ---------------------------------------------------------------------------
// Ideas engine (utils/investmentIdeas.js). Every rule is a gap or a
// concentration in the portfolio; nothing here looks at past returns.

export const IDEAS_CONFIG = {
  // Share of the next deposit the "what it changes" simulation moves.
  simulatedDepositShare: 0.1,
  maxSimilar: 3,
  maxComplement: 5,
  // A world fund counts toward the US by this share and toward the rest of
  // the world by the remainder - roughly the US weight in world indices.
  // An approximation, said so on the page.
  globalFundUsShare: 0.6,
  rules: {
    // Single stocks of one sector, as a share of the securities...
    sectorStocksPct: 20,
    // ...in at least this many stocks, or one stock of at least this size.
    sectorStocksMinCount: 2,
    sectorSingleStockPct: 15,
    // Single stocks of one market against broad funds on the same market.
    regionStocksPct: 40,
    // Bonds and deposits below this share of the invested portfolio.
    fixedIncomeMinPct: 5,
    // US share at or above, with the rest of the world (not Israel) below.
    usHeavyPct: 60,
    exUsMinPct: 10,
    // Israel share at or above.
    homeHeavyPct: 70,
    // Israel below this with the portfolio mostly in dollars.
    homeMinPct: 3,
    dollarHeavyPct: 85,
    // The largest sector at or above.
    sectorHeavyPct: 40,
    // Single stocks at or above this share of the invested portfolio.
    singleStocksHeavyPct: 60,
    // Real estate / commodities are suggested only above this portfolio size.
    minPortfolioForSatellitesILS: 20000
  },
  // Rule priorities: the bigger the gap a rule describes, the higher.
  priority: {
    noFixedIncome: 90,
    homeBias: 85,
    singleStocksHeavy: 80,
    usConcentration: 75,
    sectorGap: 70,
    sectorStocksToEtf: 65,
    noHome: 60,
    regionStocksToBroad: 55,
    sameExposureLocal: 45,
    noRealEstate: 30,
    noCommodity: 25
  }
};

export const HORIZON_LABELS_HE = { short: 'עד שנתיים', medium: '2 עד 5 שנים', long: '5 שנים ומעלה' };
export const RISK_LABELS_HE = { low: 'נמוכה', medium: 'בינונית', high: 'גבוהה' };

// ---------------------------------------------------------------------------
// Fixed copy

export const REVIEW_DISCLAIMER_HE = 'הניתוח הוא כלי עזר למעקב ולהבנה ואינו מהווה ייעוץ השקעות.';
export const IDEAS_DISCLAIMER_HE =
  'רעיונות להעשרה ולהבנה בלבד, אינם מהווים ייעוץ או המלצה, ויש להתייעץ עם איש מקצוע מוסמך לפני כל החלטה.';
export const NO_DATA_LABEL_HE = 'אין מספיק נתונים';
