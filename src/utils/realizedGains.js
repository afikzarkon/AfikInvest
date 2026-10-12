// Realized capital gains: what the sales recorded in the transactions ledger
// actually made or lost, before and after the Israeli inflation / currency
// adjustment, and the tax that implies.
//
// The nominal figures per closed lot come from shared/transactionLedger.js
// (realizedLots). This module adds the REAL gain the same way the unrealized
// figures elsewhere in the app are computed, so a position shows the same
// kind of number before and after it is sold:
//
//   * Israeli security - cost basis indexed by the CPI from the purchase
//     month to the sale month (calculateStockRealGainTax's rule).
//   * Foreign security - cost basis indexed by the USD/ILS rate from the
//     purchase to the sale, i.e. the gain measured in dollars and converted
//     at the sale rate (calculateAmericanStockMetrics' rule).
//
// Both go through calculateLinkedRealResult, which applies the asymmetric
// rules for a gain vs. a loss when the index moved up vs. down.
//
// Not tax advice: the annual figure nets gains against losses within one
// calendar year, which is the basic offsetting rule; carry-forward of a net
// loss, dividends offset and other special cases are not modelled.

import { realizedLots } from '../shared/transactionLedger';
import { calculateLinkedRealResult, indexedCostBasis, monthKeyFromDate, STOCK_REAL_GAIN_TAX_RATE } from './cpiTax';

// The CPI published for `monthKey`, or the latest one before it. The index
// for the current month is not published until the middle of the next, so
// a recent sale is indexed to the last known month rather than not at all.
export const indexAtOrBefore = (indexByMonth, monthKey) => {
  if (!indexByMonth || !monthKey) return null;
  if (indexByMonth[monthKey]) return indexByMonth[monthKey];
  const earlier = Object.keys(indexByMonth)
    .filter((key) => key <= monthKey && indexByMonth[key] > 0)
    .sort();
  return earlier.length ? indexByMonth[earlier[earlier.length - 1]] : null;
};

// transactions: ledger rows. indexByMonth: { 'YYYY-MM': cpi } (useCpiIndex).
// Returns { rows, totals, byYear } - rows carry the nominal and real figures
// per closed lot, sorted by sale date.
export const computeRealizedGains = (transactions, { indexByMonth = {}, taxRate = STOCK_REAL_GAIN_TAX_RATE } = {}) => {
  const rows = realizedLots(transactions).map((row) => {
    let adjustedCostILS = row.costILS;
    let indexed = false;
    if (row.assetClass === 'american') {
      if (row.saleFxRate > 0 && row.purchaseFxRate > 0) {
        adjustedCostILS = indexedCostBasis(row.costILS, row.purchaseFxRate, row.saleFxRate);
        indexed = true;
      }
    } else {
      const atPurchase = indexAtOrBefore(indexByMonth, monthKeyFromDate(row.purchaseDate));
      const atSale = indexAtOrBefore(indexByMonth, monthKeyFromDate(row.saleDate));
      if (atPurchase && atSale) {
        adjustedCostILS = indexedCostBasis(row.costILS, atPurchase, atSale);
        indexed = true;
      }
    }
    const { realGain, tax } = calculateLinkedRealResult({
      originalCost: row.costILS,
      currentValue: row.proceedsILS,
      adjustedCostBasis: adjustedCostILS,
      taxRate
    });
    return { ...row, adjustedCostILS, realGainILS: realGain, standaloneTaxILS: tax, indexed };
  });

  const summarize = (list) => {
    const nominalGainILS = list.reduce((s, r) => s + r.nominalGainILS, 0);
    const realGainsILS = list.reduce((s, r) => s + Math.max(0, r.realGainILS), 0);
    const realLossesILS = list.reduce((s, r) => s + Math.min(0, r.realGainILS), 0);
    const netRealGainILS = realGainsILS + realLossesILS;
    return {
      count: list.length,
      proceedsILS: list.reduce((s, r) => s + r.proceedsILS, 0),
      costILS: list.reduce((s, r) => s + r.costILS, 0),
      nominalGainILS,
      realGainsILS,
      realLossesILS,
      netRealGainILS,
      // Losses offset gains within the year; a net loss owes nothing.
      estimatedTaxILS: Math.max(0, netRealGainILS) * taxRate,
      unindexedCount: list.filter((r) => !r.indexed).length
    };
  };

  const years = [...new Set(rows.map((r) => r.saleDate.slice(0, 4)))].sort();
  const byYear = years.reduce((acc, year) => {
    acc[year] = summarize(rows.filter((r) => r.saleDate.startsWith(year)));
    return acc;
  }, {});

  return { rows, totals: summarize(rows), byYear };
};
