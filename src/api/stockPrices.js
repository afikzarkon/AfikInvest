// Stock/FX price fetching helpers.
// Extracted from App.js — behavior is unchanged, only the location moved.
// These are used both by the price-polling hook and by the stock form
// (when adding/editing a stock, to pull an initial current price).

import { apiUrl } from '../apiBase';

// Get current price + daily change % for an Israeli stock (TASE) via the local server
export const fetchIsraeliStockPrice = async (stockId) => {
  try {
    const response = await fetch(apiUrl(`/api/israeli-stock/${stockId}`), {
      credentials: 'include'
    });
    if (!response.ok) throw new Error('שגיאה בקריאת נתונים מהשרת');
    const json = await response.json();
    return json;
  } catch (error) {
    return null;
  }
};

// Get current price + daily change % for a US stock via Yahoo Finance proxy
export const fetchCurrentPrice = async (stockSymbol) => {
  try {
    const response = await fetch(apiUrl(`/api/american-stock/${encodeURIComponent(stockSymbol)}`), {
      credentials: 'include'
    });
    if (!response.ok) throw new Error('failed to fetch american stock');
    const data = await response.json();
    if (data && data.currentPrice !== null && data.currentPrice !== undefined) return data;
  } catch (error) {
    return null;
  }
  return null;
};

// Get current USD/ILS exchange rate via Yahoo Finance
export const fetchExchangeRate = async () => {
  try {
    const response = await fetch(apiUrl('/api/exchange-rate'), {
      credentials: 'include'
    });
    if (!response.ok) throw new Error('failed to fetch exchange rate');
    const data = await response.json();
    return data && data.rate !== null && data.rate !== undefined ? data.rate : null;
  } catch (error) {
    return null;
  }
};

// USD/ILS rate on a specific past date (the day a US stock was bought) -
// used to auto-fill the stock form's exchange-rate field instead of
// requiring the user to look it up and type it in manually.
export const fetchHistoricalExchangeRate = async (dateStr) => {
  try {
    const response = await fetch(apiUrl(`/api/exchange-rate/${encodeURIComponent(dateStr)}`), {
      credentials: 'include'
    });
    if (!response.ok) throw new Error('failed to fetch historical exchange rate');
    const data = await response.json();
    return data && data.rate !== null && data.rate !== undefined ? data.rate : null;
  } catch (error) {
    return null;
  }
};

// Batched variants of the two functions above - one request for the whole
// portfolio instead of one per holding (see server/quotesRoutes.js's
// /api/israeli-stocks and /api/american-stocks). The browser only opens ~6
// connections per origin, so a 20-holding portfolio previously needed four
// serialized rounds of requests before the last price could even begin
// loading; these need one.
//
// Both degrade to an empty map rather than throwing: a failed refresh must
// leave the last known prices on screen untouched, never blank them.

// ids: string[] of TASE security ids -> { [id]: { currentPrice, changePercent } }
export const fetchIsraeliStockPrices = async (ids) => {
  if (!Array.isArray(ids) || ids.length === 0) return {};
  try {
    const response = await fetch(apiUrl('/api/israeli-stocks'), {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids })
    });
    if (!response.ok) throw new Error('failed to fetch israeli stock quotes');
    const data = await response.json();
    return data && data.quotes ? data.quotes : {};
  } catch (error) {
    return {};
  }
};

// symbols: string[] of US tickers -> { quotes: { [symbol]: {...} }, exchangeRate }
// The USD/ILS rate rides along on the same response, since every American
// holding needs it to convert to ILS anyway.
export const fetchAmericanStockPrices = async (symbols) => {
  if (!Array.isArray(symbols) || symbols.length === 0) return { quotes: {}, exchangeRate: null };
  try {
    const response = await fetch(apiUrl('/api/american-stocks'), {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ symbols })
    });
    if (!response.ok) throw new Error('failed to fetch american stock quotes');
    const data = await response.json();
    return {
      quotes: data && data.quotes ? data.quotes : {},
      exchangeRate: data && data.exchangeRate != null ? data.exchangeRate : null
    };
  } catch (error) {
    return { quotes: {}, exchangeRate: null };
  }
};

// Identity/classification for one TASE security (official name, instrument
// type, the exchange's own branch string, foreign-ETF flag) - see
// server/taseSecurityLookup.js. Returns null when the id doesn't resolve,
// so callers can fall back to whatever the user typed.
export const fetchIsraeliSecurityMeta = async (securityId) => {
  const id = String(securityId || '').trim();
  if (!/^\d+$/.test(id)) return null;
  try {
    const response = await fetch(apiUrl(`/api/israeli-security/${id}`), {
      credentials: 'include'
    });
    if (!response.ok) return null;
    return await response.json();
  } catch (error) {
    return null;
  }
};
