// "What was my portfolio worth in ILS on date X?" - reconstructs a
// historical value from real historical closing prices, instead of
// relying on a saved snapshot existing for that exact date. Each
// holding's price on the requested date is the most recent trading-day
// close on or before it (carried forward over weekends/holidays) -
// reusing alignBenchmarkClosesToDates (benchmarkComparison.js) per
// holding instead of reimplementing the same carry-forward logic here.
//
// Quantity held as of a date is the sum of lots whose purchaseDate is on
// or before that date and that had not been sold by then. A lot row holds
// only what is STILL owned; the part a sale closed lives in the
// transactions ledger and comes back here as a "closed slice" (see
// shared/transactionLedger.js#expandHoldingsWithClosedLots) carrying a
// soldDate. A slice counts on every date before its sale and on none from
// the sale date on - the day the proceeds leave as a cash flow, so the
// value that disappears is netted against money that really left instead
// of reading as a loss.
//
// Non-traded accounts (provident funds, money-market funds, current
// accounts, bank savings funds) have no historical close to look up, so
// they are reconstructed from their own ledgers instead - see
// ledgerAccountHistory.js and bankSavingsFund.js. They're opt-in per call:
// pass them and they're included, leave them out and the series covers the
// traded holdings only.
//
// WHICH HOLDINGS TO PASS IS THE CALLER'S DECISION, AND IT IS A REAL ONE.
//
// This module values whatever it is given; it has no opinion about what a
// performance figure should cover. utils/portfolioSegments.js holds that
// opinion, and the performance chart asks it: EQUITIES ONLY by default,
// optionally narrowed to one market.
//
// The reason is that the non-equity accounts do not move with the market
// but do sit in both the numerator and the denominator of every sub-period,
// so including them pulls each percentage toward zero. A holding that
// doubled beside an equal balance of idle cash measures +50%, and the
// investor learns nothing about their stock picking. Passing a subset here
// is what keeps the two questions - "how did my shares do" and "how did my
// net worth do" - separately answerable.
import { valueOfLedgerAccountAtDate, valueOfLedgerAccountsAtDate } from './ledgerAccountHistory';
import { computeBankSavingsFundValue } from './bankSavingsFund';

function groupBySymbol(lots) {
  return lots.reduce((acc, lot) => {
    const symbol = lot.stockName;
    if (!acc[symbol]) acc[symbol] = [];
    acc[symbol].push(lot);
    return acc;
  }, {});
}

// Held on `date`: bought on or before it, and (for a closed slice) not yet
// sold. On the sale date itself the units are gone - the matching cash
// flow is dated that day too, and portfolioCashFlows counts a flow dated
// on a period's end as part of that period.
export function isLotHeldOn(lot, date) {
  if (!lot || !lot.purchaseDate || lot.purchaseDate > date) return false;
  return !(lot.soldDate && date >= lot.soldDate);
}

function quantityAsOfDate(lots, date) {
  return lots
    .filter((lot) => isLotHeldOn(lot, date))
    .reduce((sum, lot) => sum + (lot.quantity || 0), 0);
}

// COST-BASIS ANCHORING ON DAY 0
//
// A lot is worth what was actually paid for it on the day it was bought,
// and the market close only from the next day onwards.
//
// Valuing a lot at that day's CLOSE instead silently invents a gap between
// what the investor put in and what the portfolio is recorded as holding
// the moment they put it in. Everywhere in the middle of a series that gap
// is harmless - the contribution is netted out of the sub-period it lands
// in, so the difference between the execution price and the close shows up
// as the gain it is. But at the very START of a series there is no earlier
// point to measure from: the curve simply begins at the close-based value,
// and the entire execution difference vanishes. A holding bought at 182
// that the close valued at 32,568 began life "worth" 32,568, and the
// 182 -> 32,568 move was never anybody's return.
//
// Anchoring day 0 to the cost basis closes that hole, and for an ordinary
// intraday fill - where execution differs from the close by a fraction of
// a percent - it is what makes execution quality part of the measured
// performance rather than a rounding error the engine discards.
//
// Applied PER LOT, not per symbol: on any given date a symbol can hold
// lots bought years ago (market close) alongside one bought that very
// morning (cost basis), and the two have to be valued differently in the
// same sum.
// True only for a lot bought on this exact date AND carrying a usable cost
// basis.
//
// The second half matters: "bought today" and "we know what was paid" are
// different facts. A lot with no purchase price (or a zero one) has no cost
// basis to anchor to, and valuing it at zero would assert the position was
// worth nothing on the day it was opened - then show the full close value
// appearing out of nowhere the next day, as a gain, with no contribution
// to net it against. portfolioCashFlows.js drops a zero-amount flow for
// exactly the same reason, so the two stay consistent: no recorded cost,
// no anchor. Such a lot falls back to the market close, which is the best
// available estimate of what it was worth.
function hasCostBasisOn(lot, date) {
  if (!lot.purchaseDate || lot.purchaseDate !== date) return false;
  const price = Number(lot.purchasePrice);
  return Number.isFinite(price) && price > 0;
}

// Total value of one symbol's lots on `date`, in the security's own price
// units (agorot for TASE, USD for Yahoo - the caller converts).
//
// `close` may be null: a lot bought on `date` is valued from its own
// purchase price and needs no close at all, which is why a brand-new
// holding no longer marks the whole point partial just because its price
// history doesn't reach back to it yet.
//
// Returns null when a lot genuinely needs a close and there is none -
// that, and only that, is missing data.
function valueLotsOnDate(lots, date, close) {
  let total = 0;
  let needsClose = false;

  for (const lot of lots) {
    if (!isLotHeldOn(lot, date)) continue;
    const quantity = lot.quantity || 0;
    if (quantity <= 0) continue;

    if (hasCostBasisOn(lot, date)) {
      total += quantity * (lot.purchasePrice || 0);
    } else {
      needsClose = true;
      if (close === null || close === undefined) continue;
      total += quantity * close;
    }
  }

  if (needsClose && (close === null || close === undefined)) return null;
  return total;
}

// Sorted-once index per close series, so a lookup is a binary search
// instead of a fresh copy-and-sort of the whole series.
//
// This used to delegate to alignBenchmarkClosesToDates(), which sorts a
// copy of the array it's given on every call. That function is built for
// "align a whole list of dates in one pass", and used that way the sort is
// paid once. Calling it with a single date - as this did, once per holding
// per sampled date - made it O(n log n) PER LOOKUP. With three years of
// TASE history (~750 closes), ten holdings and a multi-year chart, that is
// hundreds of thousands of array sorts on the main thread, which is what
// made the date picker freeze the page (measured: ~7.4s per 100k lookups,
// and a half-typed year produced ~1M of them).
//
// Keyed by the array itself, so a series fetched once is indexed once and
// every later lookup against it is free - and the entry disappears with
// the array, no cache invalidation to get wrong.
const closeIndexCache = new WeakMap();

function getCloseIndex(closes) {
  if (!Array.isArray(closes) || closes.length === 0) return null;
  const cached = closeIndexCache.get(closes);
  if (cached) return cached;

  const sorted = [...closes]
    .filter((point) => point && point.date != null && Number.isFinite(Number(point.close)))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const index = { dates: sorted.map((p) => p.date), values: sorted.map((p) => Number(p.close)) };
  closeIndexCache.set(closes, index);
  return index;
}

// The most recent close on or before `date` (carrying the last trading
// day's close forward over weekends/holidays), or null if there's none.
function closeOnOrBefore(date, closes) {
  const index = getCloseIndex(closes);
  if (!index || index.dates.length === 0) return null;

  // Rightmost entry whose date is <= the requested one.
  let lo = 0;
  let hi = index.dates.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (index.dates[mid] <= date) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found === -1 ? null : index.values[found];
}

// priceData shape:
//   taseHistoricalCloses: { [securityId]: [{date, close}] } - close in agorot
//   yahooHistoricalCloses: { [symbol]: [{date, close}] } - close in USD
//   fxHistoricalCloses: [{date, close}] - USD/ILS rate
// `options.anchorLedgerAccountsToFirstRecord` is passed straight through to
// the ledger accounts (see valueOfLedgerAccountAtDate): leave it off for a
// point-in-time reconstruction, turn it on for a performance series, and in
// that case pair it with buildPortfolioCashFlows' matching option.
//
// The returned point also carries `byCategory` - what each asset class
// contributed to the total - and `missingSymbols`, the holdings that could
// not be priced. Neither is used to draw the chart; `missingSymbols` is
// what lets the page name the holdings behind a date it had to skip (see
// summarizePartialPoints in utils/portfolioStats.js).
export const computePortfolioValueAtDate = (
  date,
  {
    israeliStocks = [],
    americanStocks = [],
    pensionFunds = [],
    cashFunds = [],
    bankBalances = [],
    bankSavingsFunds = []
  } = {},
  priceData = {},
  { anchorLedgerAccountsToFirstRecord = false, americanExchangeRate = null } = {}
) => {
  const { taseHistoricalCloses = {}, yahooHistoricalCloses = {}, fxHistoricalCloses = [] } = priceData;

  let totalILS = 0;
  let hasAnyValue = false;
  let isPartial = false;
  const missingSymbols = [];
  const byCategory = { israeli: 0, american: 0, pension: 0, cashFunds: 0, bank: 0, bankSavings: 0 };

  const israeliBySymbol = groupBySymbol(israeliStocks);
  Object.entries(israeliBySymbol).forEach(([symbol, lots]) => {
    if (quantityAsOfDate(lots, date) <= 0) return;
    // Closes are in agorot; purchase prices are entered in shekels, so the
    // close is converted first and both sides of valueLotsOnDate are then
    // in the same unit.
    const priceAgorot = closeOnOrBefore(date, taseHistoricalCloses[symbol]);
    const closeILS = priceAgorot === null ? null : priceAgorot / 100;
    const value = valueLotsOnDate(lots, date, closeILS);
    if (value === null) {
      isPartial = true;
      missingSymbols.push(symbol);
      return;
    }
    totalILS += value;
    byCategory.israeli += value;
    hasAnyValue = true;
  });

  const americanBySymbol = groupBySymbol(americanStocks);
  const hasAmericanHoldings = Object.keys(americanBySymbol).length > 0;

  // ONE RATE FOR EVERY DATE, when the caller supplies one.
  //
  // This is what turns the American curve into a pure dollar return while
  // leaving it denominated in shekels. A constant multiplier cancels out
  // of every ratio the return is built from - value(t2)/value(t1) is
  // identical whether both sides carry the factor or neither does - so
  // what the chart measures is the holdings' own performance, with the
  // currency move removed rather than merely ignored.
  //
  // The lot's own purchase rate is overridden too. Anchoring day 0 to the
  // rate actually paid while pricing every later date at a single fixed
  // rate would leave exactly one FX move in the series, at its very start,
  // where there is no earlier point to measure it against - the one place
  // an FX difference cannot be netted out. Either the whole series carries
  // the currency or none of it does.
  const useFixedFx = Number.isFinite(americanExchangeRate) && americanExchangeRate > 0;
  const fxRate = !hasAmericanHoldings
    ? null
    : useFixedFx
    ? americanExchangeRate
    : closeOnOrBefore(date, fxHistoricalCloses);
  Object.entries(americanBySymbol).forEach(([symbol, lots]) => {
    if (quantityAsOfDate(lots, date) <= 0) return;
    const priceUSD = closeOnOrBefore(date, yahooHistoricalCloses[symbol]);

    // A lot bought today is worth the ILS actually paid: its own purchase
    // price at the rate paid on the day, matching the contribution
    // portfolioCashFlows.js records for it exactly. Converting it at
    // today's rate instead would put an FX move into the position's
    // opening value that the investor never experienced.
    let value = 0;
    let missing = false;
    lots.forEach((lot) => {
      if (!isLotHeldOn(lot, date)) return;
      const quantity = lot.quantity || 0;
      if (quantity <= 0) return;

      // An American lot also needs the rate it was bought at for its cost
      // to be expressible in ILS at all; without one there is no anchor.
      // Under a fixed rate that IS the anchor rate - see useFixedFx above.
      const costBasisRate = useFixedFx ? americanExchangeRate : Number(lot.exchangeRate);
      if (hasCostBasisOn(lot, date) && costBasisRate > 0) {
        value += quantity * lot.purchasePrice * costBasisRate;
        return;
      }
      if (priceUSD === null || fxRate === null) {
        missing = true;
        return;
      }
      value += quantity * priceUSD * fxRate;
    });

    if (missing) {
      isPartial = true;
      missingSymbols.push(symbol);
      return;
    }
    totalILS += value;
    byCategory.american += value;
    hasAnyValue = true;
  });

  // Non-traded accounts, reconstructed from their own ledgers rather than
  // from market prices. A category that's empty (or simply not passed)
  // contributes nothing and never marks the point partial - "no provident
  // fund" is not missing data.
  const ledgerOptions = { anchorToFirstRecord: anchorLedgerAccountsToFirstRecord };
  byCategory.pension = valueOfLedgerAccountsAtDate(pensionFunds, date, ledgerOptions);
  byCategory.cashFunds = valueOfLedgerAccountsAtDate(cashFunds, date, ledgerOptions);
  byCategory.bank = valueOfLedgerAccountsAtDate(bankBalances, date, ledgerOptions);
  byCategory.bankSavings = (bankSavingsFunds || []).reduce(
    (sum, fund) => sum + (computeBankSavingsFundValue(fund, date) || 0),
    0
  );

  const ledgerValue = byCategory.pension + byCategory.cashFunds + byCategory.bank;
  const bankSavingsValue = byCategory.bankSavings;
  if (ledgerValue !== 0 || bankSavingsValue !== 0) {
    totalILS += ledgerValue + bankSavingsValue;
    hasAnyValue = true;
  }

  return {
    date,
    valueILS: hasAnyValue ? totalILS : null,
    isPartial,
    missingSymbols,
    byCategory
  };
};

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;

// Hard ceiling on how many points a series may contain, no matter how long
// the requested range is.
//
// Weekly sampling alone is NOT a bound - it's a bound only if the range is
// short. An <input type="date"> fires onChange on every keystroke while the
// year is being typed, so asking for "2023" walks through 0002, 0020 and
// 0202 first, and a range starting in year 2 is ~105,000 weeks. Each of
// those points prices every holding, so a single keystroke could schedule
// over a million price lookups synchronously on the main thread - the page
// didn't slow down, it stopped responding. (Both halves of that are fixed:
// this cap, and the binary-searched close index above.)
//
// 400 points is comfortably more than a chart a few hundred pixels wide can
// distinguish, and covers ~8 years at weekly resolution before the step
// starts widening at all.
const MAX_SERIES_POINTS = 400;

// Sampling dates across [fromDate, toDate], inclusive of both endpoints.
// Weekly while that fits inside MAX_SERIES_POINTS, then progressively
// coarser so a very long range costs the same as a short one instead of
// scaling without limit. Exported for tests; the series builder below is
// the normal entry point.
export const buildSampleDates = (fromDate, toDate) => {
  const start = new Date(`${fromDate}T00:00:00Z`);
  const end = new Date(`${toDate}T00:00:00Z`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return [];

  const span = end.getTime() - start.getTime();
  // Widen the step if weekly sampling would exceed the cap. Math, not a
  // loop with a break: the step is chosen up front so the walk below can
  // never run long regardless of the span it's given.
  const stepMs = Math.max(WEEK_MS, Math.ceil(span / (MAX_SERIES_POINTS - 1) / DAY_MS) * DAY_MS);

  const dates = [];
  for (let t = start.getTime(); t <= end.getTime(); t += stepMs) {
    dates.push(new Date(t).toISOString().slice(0, 10));
  }
  // The exact end date always gets its own point - it's the one the
  // "value at the end of the period" figure is read from.
  if (dates[dates.length - 1] !== toDate) dates.push(toDate);
  return dates;
};

// Samples points across [fromDate, toDate] (inclusive of both endpoints)
// rather than one point per calendar day - a chart has far fewer visually
// distinct pixels than that many days anyway, and prices only change on
// ~250 trading days a year regardless of how finely it's sampled.
export const computeHistoricalPortfolioSeries = (fromDate, toDate, holdings, priceData, options) => {
  if (!fromDate || !toDate || fromDate > toDate) return [];
  return buildSampleDates(fromDate, toDate).map((date) =>
    computePortfolioValueAtDate(date, holdings, priceData, options)
  );
};

// The itemized "what was each holding/account worth on date X" breakdown,
// in exactly the shape a monthly checkpoint stores (see
// monthlySnapshotBreakdown.js: one { key, label, value } entry per holding,
// grouped by the same category keys).
//
// This is what lets the monthly tracker fill itself in: pick a month, and
// every row is computed from the historical closes for that date and from
// the deposit/value ledgers the user already maintains in the main tables -
// no retyping of figures the app can work out for itself.
//
// Stock rows are keyed by the same name the live breakdown uses
// (stockName), so a generated month lines up row-for-row with a month
// captured live and the two compare item by item.
export const computeHistoricalBreakdownAtDate = (date, holdings = {}, priceData = {}) => {
  const {
    israeliStocks = [],
    americanStocks = [],
    pensionFunds = [],
    cashFunds = [],
    bankBalances = [],
    bankSavingsFunds = []
  } = holdings;
  const { taseHistoricalCloses = {}, yahooHistoricalCloses = {}, fxHistoricalCloses = [] } = priceData;

  const israeli = [];
  Object.entries(groupBySymbol(israeliStocks)).forEach(([symbol, lots]) => {
    if (quantityAsOfDate(lots, date) <= 0) return;
    const priceAgorot = closeOnOrBefore(date, taseHistoricalCloses[symbol]);
    // Same day-0 cost-basis rule as the curve above - a month-end that
    // happens to be a purchase date must not report a different figure
    // here than the chart shows for the same instant.
    const value = valueLotsOnDate(lots, date, priceAgorot === null ? null : priceAgorot / 100);
    if (value === null) return;
    const label = lots.find((lot) => lot.officialName)?.officialName;
    israeli.push({
      key: symbol,
      label: label ? `${label} (${symbol})` : symbol,
      value
    });
  });

  const american = [];
  const americanBySymbol = groupBySymbol(americanStocks);
  const fxRate = Object.keys(americanBySymbol).length ? closeOnOrBefore(date, fxHistoricalCloses) : null;
  Object.entries(americanBySymbol).forEach(([symbol, lots]) => {
    if (quantityAsOfDate(lots, date) <= 0) return;
    const priceUSD = closeOnOrBefore(date, yahooHistoricalCloses[symbol]);

    let value = 0;
    let missing = false;
    lots.forEach((lot) => {
      if (!isLotHeldOn(lot, date)) return;
      const quantity = lot.quantity || 0;
      if (quantity <= 0) return;
      // An American lot also needs the rate it was bought at for its cost
      // to be expressible in ILS at all; without one there is no anchor.
      if (hasCostBasisOn(lot, date) && Number(lot.exchangeRate) > 0) {
        value += quantity * lot.purchasePrice * lot.exchangeRate;
        return;
      }
      if (priceUSD === null || fxRate === null) {
        missing = true;
        return;
      }
      value += quantity * priceUSD * fxRate;
    });

    if (missing) return;
    american.push({ key: symbol, label: symbol, value });
  });

  // Accounts that didn't exist yet on the requested date reconstruct to 0
  // and are left out entirely, rather than showing as a zero row.
  const ledgerItems = (accounts, fallbackLabel, keyPrefix) =>
    (accounts || [])
      .map((account, index) => ({
        key: account.fundName || `${keyPrefix}-${index + 1}`,
        label:
          account.fundName ||
          ((accounts || []).length > 1 ? `${fallbackLabel} #${index + 1}` : fallbackLabel),
        value: valueOfLedgerAccountAtDate(account, date)
      }))
      .filter((item) => item.value !== 0);

  const bankSavings = (bankSavingsFunds || [])
    .map((fund, index) => ({
      key: fund.fundName || `bank-savings-${index + 1}`,
      label: fund.fundName || 'קופת חיסכון בבנק',
      value: computeBankSavingsFundValue(fund, date) || 0
    }))
    .filter((item) => item.value !== 0);

  return {
    israeli,
    american,
    pension: ledgerItems(pensionFunds, 'קופת גמל', 'pension'),
    cashFunds: ledgerItems(cashFunds, 'קרן כספית', 'cash'),
    bank: ledgerItems(bankBalances, 'עו"ש', 'bank'),
    bankSavings
  };
};

// Sum of every item in a breakdown produced above - the totalValueILS a
// monthly checkpoint is saved with.
export const sumHistoricalBreakdown = (breakdown) =>
  Object.values(breakdown || {}).reduce(
    (sum, items) =>
      sum + (Array.isArray(items) ? items.reduce((s, item) => s + (item.value || 0), 0) : 0),
    0
  );
