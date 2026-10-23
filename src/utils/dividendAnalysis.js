// Dividend metrics built from Yahoo dividend data (server/dividendRoutes.js)
// combined with a portfolio's actual American stock lots. Pure functions,
// separate from the fetching hook, so they're independently testable.

// Total dividends actually received on one stock: for every historical
// payment, amountPerShare times the units of each lot held by then. A
// payment's date is its ex-dividend date, and only a share owned BEFORE
// that day is entitled - one bought on the ex-date is not. Each lot counts
// from its own purchase, so units bought later are not credited with
// earlier payments (it used to multiply every payment since the FIRST
// purchase by the total quantity). Lots are the ones held now; units sold
// since are not counted. Returned in USD - the currency dividends are
// actually paid in, not converted to ILS (that would need the historical FX
// rate on each individual payment date, which isn't data this app has).
export const computeReceivedDividends = (history, lots) => {
  if (!Array.isArray(history) || history.length === 0) return 0;
  if (!Array.isArray(lots) || lots.length === 0) return 0;

  return history.reduce((sum, d) => {
    const held = lots.reduce((q, lot) => (lot.purchaseDate && lot.purchaseDate < d.date ? q + (lot.quantity || 0) : q), 0);
    return sum + (d.amountPerShare || 0) * held;
  }, 0);
};
