// Formatting and small pure helpers used across the app.
// Extracted from App.js — behavior is unchanged, only the location moved.

export const formatDate = (dateString) => {
  const date = new Date(dateString);
  return date.toLocaleDateString('he-IL');
};

export const formatPrice = (price) => {
  if (price === null || price === undefined || isNaN(price)) {
    return '0.00';
  }
  const formattedNumber = price.toFixed(2);
  return parseFloat(formattedNumber).toLocaleString('he-IL', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });
};

// PRIVACY MODE ("הסתר סכומים"): while on, every money amount the UI formats
// through formatPriceWithSign comes out as a mask instead - balances, values,
// profit and loss, transaction sums. Percentages are formatted elsewhere and
// stay visible, so the trend still shows without the money. App.js sets the
// flag from the user's saved preference and re-renders; the Excel/PDF
// export does not use this formatter, so a report always has the numbers.
export const AMOUNT_MASK = '••••';
let amountsHidden = false;
export const setAmountsHidden = (hidden) => {
  amountsHidden = Boolean(hidden);
};
export const areAmountsHidden = () => amountsHidden;

export const formatPriceWithSign = (price) => {
  if (amountsHidden) return AMOUNT_MASK;
  if (price === null || price === undefined || isNaN(price)) {
    return '0.00';
  }
  const formattedNumber = Math.abs(price).toFixed(2);
  const withCommas = parseFloat(formattedNumber).toLocaleString('he-IL', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });
  if (price >= 0) {
    return withCommas;
  } else {
    return `${withCommas}-`;
  }
};

// Normalize Israeli price: if saved in agorot (big number), convert to shekels
// Returns a stock's current price as a plain number (string/null/NaN
// handled gracefully) - it does NOT divide by 100 anymore.
//
// This used to guess "if the value looks like it's over 1000, it must
// still be raw agorot and needs dividing by 100" - but every code path
// that actually SETS stock.currentPrice already converts agorot to
// shekels itself before the value reaches state: the initial fetch in
// App.js's handleSubmit, the live-refresh loop in usePriceRefresh.js, and
// (for data coming back from storage/an older format) the one-time
// migration in normalizeIsraeliStocksFromStorage below, which already
// runs on every portfolio load (see usePortfolioData.js). currentPrice is
// also never a manually-editable field (see IsraeliStocksTable.js's
// editable fields list) - there's no path for a user to type a raw agorot
// value into it either.
//
// That old magnitude-based guess was therefore always wrong for any
// legitimately-priced stock over ~1000 ILS/share - it silently divided an
// already-correct price by 100 a second time (a real ₪2,457/share holding
// would display as ₪24.57, a 100x error), which is exactly what this
// fixes.
export const normalizeIsraeliPrice = (price) => {
  const num = typeof price === 'string' ? parseFloat(price) : price;
  if (num === null || num === undefined || isNaN(num)) return 0;
  return num;
};

export const calculateProfitPercentage = (purchaseValue, currentValue) => {
  if (purchaseValue === 0 || !purchaseValue || !currentValue) return 0;
  return ((currentValue - purchaseValue) / purchaseValue * 100).toFixed(2);
};

// Returns the CSS class for a profit/loss value — the
// `value >= 0 ? 'profit-positive' : 'profit-negative'` check that used to
// be repeated ~36 times across the two stock tables.
export const profitClass = (value) => ((value || 0) >= 0 ? 'profit-positive' : 'profit-negative');

// Formats a daily-change percentage the way both stock tables display it:
// falls back to '0.00' when null/undefined, otherwise 2 decimal places.
export const formatDailyChangePercent = (value) =>
  value !== undefined && value !== null ? value.toFixed(2) : '0.00';

export const toNum = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

// Normalizes an array of Israeli stocks loaded from storage.
//
// IMPORTANT CORRECTION: this used to divide currentPrice by 100 whenever
// it looked "too big" (>1000), on the theory that it was a one-time
// migration for legacy raw-agorot data. That reasoning was wrong in a way
// that mattered: this function runs on EVERY portfolio load (see
// usePortfolioData.js), not once - so for any stock legitimately priced
// above ~1000 ILS/share, it was silently re-dividing an already-correct
// stored price every single time the page loaded or refreshed (a real
// ₪2,457/share holding would load as ₪24.57, every time - the exact bug
// reported in production, which persisted even after fixing
// normalizeIsraeliPrice's identical heuristic, because this is a second,
// separate function with the same flaw).
//
// As established in normalizeIsraeliPrice above: every code path that
// writes stock.currentPrice (the initial fetch in App.js, the live
// refresh loop in usePriceRefresh.js) already converts agorot to shekels
// itself, unconditionally, before the value is ever persisted - so there
// is no legitimate raw-agorot value left for this function to "fix" by
// guessing. It now just coerces types (string/null/NaN handling) without
// dividing, exactly like normalizeIsraeliPrice.
export const normalizeIsraeliStocksFromStorage = (parsed) => {
  if (!Array.isArray(parsed)) return [];
  return parsed.map((stock) => {
    const priceNum =
      typeof stock.currentPrice === 'string' ? parseFloat(stock.currentPrice) : stock.currentPrice;
    const cleanPrice = priceNum === null || priceNum === undefined || isNaN(priceNum) ? 0 : priceNum;
    return {
      ...stock,
      currentPrice: cleanPrice
    };
  });
};
