// Tax-loss harvesting: a portfolio-wide view of which currently-held
// positions have a real (CPI/currency-adjusted) loss right now, and what
// realizing that loss could be worth in tax terms if offset against real
// gains elsewhere in the portfolio this tax year.
//
// This deliberately reuses the exact same per-position real gain/tax
// functions already used throughout the app (calculateStockRealGainTax,
// calculateAmericanStockMetrics, calculatePensionRealGainTax) rather than
// recomputing anything independently - so a number shown here always
// matches what the same position shows in its own table row, instead of
// risking two slightly-different "real gain" calculations drifting apart.
//
// Not tax advice: offsetting rules (same tax year, carry-forward,
// matching asset classes) are more complex than "loss cancels gain" and
// vary by situation - see cpiTax.js's own disclaimer. This surfaces
// candidates and an estimate, not a recommendation to sell.

import { calculateStockRealGainTax, calculatePensionRealGainTax, calculateBankSavingsFundTax, monthKeyFromDate } from './cpiTax';
import { calculateAmericanStockMetrics } from './portfolioMath';
import { normalizeIsraeliPrice } from './formatters';
import { computeBankSavingsFundValue } from './bankSavingsFund';
import { israeliStockDisplayName } from './israeliEtfClassifier';

const buildIsraeliPosition = (stock, cpi) => {
  // currentPrice is always already in shekels by the time it reaches here
  // (see formatters.js:normalizeIsraeliPrice for the full explanation) -
  // still routed through normalizeIsraeliPrice for consistency with every
  // other place this value is displayed/calculated, and for graceful
  // string/null/NaN handling, not because it performs any conversion.
  const displayCurrentPrice = normalizeIsraeliPrice(stock.currentPrice);
  const totalCurrentValue = (displayCurrentPrice || 0) * (stock.quantity || 0);
  const currentIndex = cpi ? cpi.currentIndex : null;
  const indexAtPurchase = cpi && cpi.indexByMonth ? cpi.indexByMonth[monthKeyFromDate(stock.purchaseDate)] : null;

  let realGain;
  if (currentIndex && indexAtPurchase) {
    realGain = calculateStockRealGainTax({
      purchasePrice: stock.purchasePrice,
      quantity: stock.quantity,
      currentValue: totalCurrentValue,
      indexAtPurchase,
      currentIndex
    }).realGain;
  } else {
    // Same fallback as IsraeliStocksTable.js when CPI data isn't
    // available yet: flat nominal gain, no linkage adjustment.
    realGain = totalCurrentValue - (stock.purchasePrice || 0) * (stock.quantity || 0);
  }

  return {
    id: stock.id,
    name: stock.stockName,
    // stockName is the TASE security number; this is what a person reads.
    displayName: israeliStockDisplayName(stock),
    groupKey: `israeli:${stock.stockName}`,
    category: 'israeli',
    categoryLabel: 'בורסה ישראלית',
    realGain,
    taxRate: 0.25
  };
};

const buildAmericanPosition = (stock) => {
  const metrics = calculateAmericanStockMetrics(stock);
  return {
    id: stock.id,
    name: stock.stockName,
    displayName: stock.stockName,
    groupKey: `american:${stock.stockName}`,
    category: 'american',
    categoryLabel: 'בורסה אמריקאית',
    realGain: metrics.realGainILS,
    taxRate: 0.25
  };
};

const buildPensionPosition = (fund, cpi) => {
  const deposits = Array.isArray(fund.deposits) ? fund.deposits : [];
  const fundCurrentValue = fund.currentValue ?? fund.amount ?? 0;
  const currentIndex = cpi ? cpi.currentIndex : null;
  const indexByMonth = cpi && cpi.indexByMonth ? cpi.indexByMonth : {};

  let gain;
  const taxRate = 0.25; // קופות גמל תמיד ממוסות על הרווח הריאלי (25%)
  if (currentIndex) {
    gain = calculatePensionRealGainTax({
      deposits,
      currentValue: fundCurrentValue,
      currentIndex,
      indexByMonth
    }).gain;
  } else {
    const totalDeposited = deposits.reduce((sum, d) => sum + (d.amount || 0), 0);
    gain = fundCurrentValue - totalDeposited;
  }

  return {
    id: fund.id,
    name: fund.fundName,
    displayName: fund.fundName,
    groupKey: `pension:${fund.id}`,
    category: 'pension',
    categoryLabel: 'קופת גמל',
    realGain: gain,
    taxRate
  };
};

const buildBankSavingsPosition = (fund, cpi) => {
  const deposits = Array.isArray(fund.deposits) ? fund.deposits : [];
  const currentValue = computeBankSavingsFundValue(fund);
  const currentIndex = cpi ? cpi.currentIndex : null;
  const indexByMonth = cpi && cpi.indexByMonth ? cpi.indexByMonth : {};

  const result = calculateBankSavingsFundTax({
    deposits,
    currentValue,
    isLinkedToIndex: !!fund.isLinkedToIndex,
    currentIndex,
    indexByMonth
  });

  return {
    id: fund.id,
    name: fund.fundName,
    displayName: fund.fundName,
    groupKey: `bankSavings:${fund.id}`,
    category: 'bankSavings',
    categoryLabel: 'קופת חיסכון בבנק',
    realGain: result.gain,
    taxRate: fund.isLinkedToIndex && currentIndex ? 0.25 : 0.15
  };
};

// One row per holding rather than per purchase. Three lots of the same
// share bought at different prices are one decision - whether to sell that
// share - so listing them as three positions repeated the name and split
// one figure into parts the reader had to add up.
//
// A row's loss is the sum of its losing lots: the same total as before,
// just gathered. A holding whose other lots are in profit says so
// (gainInSameHolding), because selling the whole holding realises those
// gains too and they offset the loss before it can offset anything else.
// Funds are one position each and simply carry over as their own row.
const groupLossPositions = (positions) => {
  const groups = new Map();
  positions.forEach((p) => {
    const g = groups.get(p.groupKey) || {
      key: p.groupKey,
      name: p.displayName || p.name,
      category: p.category,
      categoryLabel: p.categoryLabel,
      lots: 0,
      lossLots: 0,
      harvestableLoss: 0,
      taxValue: 0,
      gainInSameHolding: 0
    };
    g.lots += 1;
    if (p.realGain < 0) {
      g.lossLots += 1;
      g.harvestableLoss += -p.realGain;
      g.taxValue += -p.realGain * p.taxRate;
    } else if (p.realGain > 0) {
      g.gainInSameHolding += p.realGain;
    }
    groups.set(p.groupKey, g);
  });
  return [...groups.values()]
    .filter((g) => g.harvestableLoss > 0)
    .map((g) => ({ ...g, netIfSoldAll: g.gainInSameHolding - g.harvestableLoss }))
    .sort((a, b) => b.harvestableLoss - a.harvestableLoss);
};

export const computeTaxLossHarvestingOpportunities = (
  israeliStocks = [],
  americanStocks = [],
  pensionFunds = [],
  cpi = null,
  bankSavingsFunds = []
) => {
  const positions = [
    ...israeliStocks.map((s) => buildIsraeliPosition(s, cpi)),
    ...americanStocks.map((s) => buildAmericanPosition(s)),
    ...pensionFunds.map((f) => buildPensionPosition(f, cpi)),
    ...bankSavingsFunds.map((f) => buildBankSavingsPosition(f, cpi))
  ];

  const lossPositions = positions
    .filter((p) => p.realGain < 0)
    .map((p) => ({ ...p, harvestableLoss: -p.realGain, taxValue: -p.realGain * p.taxRate }))
    .sort((a, b) => b.harvestableLoss - a.harvestableLoss);

  const gainPositions = positions
    .filter((p) => p.realGain > 0)
    .map((p) => ({ ...p, taxValue: p.realGain * p.taxRate }))
    .sort((a, b) => b.realGain - a.realGain);

  const lossGroups = groupLossPositions(positions);

  const totalHarvestableLoss = lossPositions.reduce((sum, p) => sum + p.harvestableLoss, 0);
  const totalPotentialTaxValue = lossPositions.reduce((sum, p) => sum + p.taxValue, 0);
  const totalCurrentGains = gainPositions.reduce((sum, p) => sum + p.realGain, 0);
  const totalGainsTax = gainPositions.reduce((sum, p) => sum + p.taxValue, 0);

  return {
    lossPositions,
    lossGroups,
    gainPositions,
    totalHarvestableLoss,
    totalPotentialTaxValue,
    totalCurrentGains,
    totalGainsTax,
    hasLossPositions: lossPositions.length > 0,
    hasGainPositions: gainPositions.length > 0
  };
};
