// Portfolio analysis calculation (distributions, top/worst performers, etc.).
// Extracted from App.js's calculatePortfolioAnalysis(). Behavior is unchanged;
// the only difference is that the stock/fund arrays are now explicit
// parameters instead of closed-over component state.

import { calculateAmericanStockMetrics } from './portfolioMath';
import { normalizeIsraeliPrice, toNum } from './formatters';
import { computeBankSavingsFundValue } from './bankSavingsFund';
import { effectiveExchangeForIsraeliStock } from './israeliEtfClassifier';
import { effectiveDailyChangePercent, israelToday } from './marketSession';
import { liquidBalanceOn } from '../shared/liquidBalance';

export const calculatePortfolioAnalysis = (
  israeliStocks,
  americanStocks,
  pensionFunds,
  cashFunds,
  bankBalances,
  bankSavingsFunds = []
) => {
  const now = new Date();
  const daysBetween = (rawDate) => {
    const d = new Date(rawDate);
    if (Number.isNaN(d.getTime())) return 0;
    const days = Math.floor((now - d) / (1000 * 60 * 60 * 24));
    return Math.max(days, 0);
  };

  // Distribution by exchange. Presentation-layer only: an Israeli-listed
  // ETF that tracks a foreign index (see israeliEtfClassifier.js) counts
  // toward the "american"/foreign bucket here even though it's still
  // priced/scraped as a normal TASE security - the israeliStocks array
  // itself is never touched by this reclassification.
  const israeliTotalValue = israeliStocks.reduce((sum, stock) => {
    if (effectiveExchangeForIsraeliStock(stock) !== 'israeli') return sum;
    const normalizedPrice = normalizeIsraeliPrice(stock.currentPrice);
    return sum + (toNum(normalizedPrice) * toNum(stock.quantity));
  }, 0);

  const israeliEtfReclassifiedValueILS = israeliStocks.reduce((sum, stock) => {
    if (effectiveExchangeForIsraeliStock(stock) !== 'american') return sum;
    const normalizedPrice = normalizeIsraeliPrice(stock.currentPrice);
    return sum + (toNum(normalizedPrice) * toNum(stock.quantity));
  }, 0);

  const americanTotalValueILS =
    americanStocks.reduce((sum, stock) => {
      const metrics = calculateAmericanStockMetrics(stock);
      return sum + metrics.totalCurrentValueILS;
    }, 0) + israeliEtfReclassifiedValueILS;

  const pensionTotalValueILS = pensionFunds.reduce(
    (sum, item) => sum + toNum(item.currentValue != null ? item.currentValue : item.amount),
    0
  );
  // Recorded balance + the ledger movements since it (see shared/liquidBalance.js).
  const today = israelToday();
  const cashFundsTotalValueILS = cashFunds.reduce((sum, item) => sum + liquidBalanceOn(item, today), 0);
  const bankTotalValueILS = bankBalances.reduce((sum, item) => sum + liquidBalanceOn(item, today), 0);
  const bankSavingsTotalValueILS = bankSavingsFunds.reduce(
    (sum, fund) => sum + toNum(computeBankSavingsFundValue(fund)),
    0
  );
  const totalValueILS =
    israeliTotalValue +
    americanTotalValueILS +
    pensionTotalValueILS +
    cashFundsTotalValueILS +
    bankTotalValueILS +
    bankSavingsTotalValueILS;

  // Distribution by stock
  const stockDistribution = {};

  const newDistributionEntry = (exchange) => ({
    name: '',
    value: 0,
    percentage: 0,
    exchange,
    profit: 0,
    profitPercentage: 0,
    totalQuantity: 0,
    avgPurchasePrice: 0,
    totalPurchaseValue: 0,
    totalWeightForYears: 0,
    weightedYearsNumerator: 0,
    daysHeld: 0,
    yearsHeld: 0,
    annualizedReturn: 0,
    dailyChange: 0,
    volatility: 0
  });

  // Israeli stocks
  israeliStocks.forEach(stock => {
    const value = toNum(normalizeIsraeliPrice(stock.currentPrice)) * toNum(stock.quantity);
    const purchaseValue = toNum(stock.purchasePrice) * toNum(stock.quantity);
    const profit = value - purchaseValue;

    const daysHeld = daysBetween(stock.purchaseDate);
    const yearsHeld = daysHeld / 365;

    if (!stockDistribution[stock.stockName]) {
      stockDistribution[stock.stockName] = {
        ...newDistributionEntry(effectiveExchangeForIsraeliStock(stock)),
        // `name` stays the raw key every downstream consumer matches on
        // (for an Israeli holding that's its TASE security id). displayName
        // is what a human should see: the security's name AND its number,
        // since the number alone identifies nothing to a reader. Kept as a
        // separate field rather than overwriting `name`, so item keys still
        // line up across monthly checkpoints saved before names existed.
        name: stock.stockName,
        displayName: stock.officialName ? `${stock.officialName} (${stock.stockName})` : stock.stockName
      };
    }

    stockDistribution[stock.stockName].value += value;
    stockDistribution[stock.stockName].profit += profit;
    stockDistribution[stock.stockName].totalQuantity += toNum(stock.quantity);
    stockDistribution[stock.stockName].totalPurchaseValue += purchaseValue;
    stockDistribution[stock.stockName].totalWeightForYears += purchaseValue;
    stockDistribution[stock.stockName].weightedYearsNumerator += yearsHeld * purchaseValue;
    stockDistribution[stock.stockName].daysHeld = Math.max(stockDistribution[stock.stockName].daysHeld, daysHeld);
    stockDistribution[stock.stockName].yearsHeld = Math.max(stockDistribution[stock.stockName].yearsHeld, yearsHeld);
    stockDistribution[stock.stockName].dailyChange = effectiveDailyChangePercent(stock);

    if (yearsHeld > 0 && purchaseValue > 0) {
      const annualizedReturn = Math.pow((value / purchaseValue), (1 / yearsHeld)) - 1;
      stockDistribution[stock.stockName].annualizedReturn = annualizedReturn;
    }
  });

  // American stocks
  americanStocks.forEach(stock => {
    const metrics = calculateAmericanStockMetrics(stock);
    const value = metrics.totalCurrentValueILS;
    const purchaseValue = metrics.totalPurchaseILS;
    const profit = metrics.profitILS;

    const daysHeld = daysBetween(stock.purchaseDate);
    const yearsHeld = daysHeld / 365;

    if (!stockDistribution[stock.stockName]) {
      stockDistribution[stock.stockName] = {
        ...newDistributionEntry('american'),
        name: stock.stockName,
        displayName: stock.stockName
      };
    }

    stockDistribution[stock.stockName].value += value;
    stockDistribution[stock.stockName].profit += profit;
    stockDistribution[stock.stockName].totalQuantity += toNum(stock.quantity);
    stockDistribution[stock.stockName].totalPurchaseValue += purchaseValue;
    stockDistribution[stock.stockName].totalWeightForYears += purchaseValue;
    stockDistribution[stock.stockName].weightedYearsNumerator += yearsHeld * purchaseValue;
    stockDistribution[stock.stockName].daysHeld = Math.max(stockDistribution[stock.stockName].daysHeld, daysHeld);
    stockDistribution[stock.stockName].yearsHeld = Math.max(stockDistribution[stock.stockName].yearsHeld, yearsHeld);
    stockDistribution[stock.stockName].dailyChange = effectiveDailyChangePercent(stock);

    if (yearsHeld > 0 && purchaseValue > 0) {
      const annualizedReturn = Math.pow((value / purchaseValue), (1 / yearsHeld)) - 1;
      stockDistribution[stock.stockName].annualizedReturn = annualizedReturn;
    }
  });

  // Derived per-stock figures
  Object.values(stockDistribution).forEach(stock => {
    stock.percentage = totalValueILS > 0 ? (stock.value / totalValueILS) * 100 : 0;
    stock.profitPercentage = stock.totalPurchaseValue > 0 ? (stock.profit / stock.totalPurchaseValue) * 100 : 0;
    stock.avgPurchasePrice = stock.totalQuantity > 0 ? stock.totalPurchaseValue / stock.totalQuantity : 0;
    stock.yearsHeld = stock.totalWeightForYears > 0
      ? stock.weightedYearsNumerator / stock.totalWeightForYears
      : stock.yearsHeld;
    stock.daysHeld = Math.round(stock.yearsHeld * 365);

    if (stock.yearsHeld > 0 && stock.totalPurchaseValue > 0) {
      stock.annualizedReturn = Math.pow((stock.value / stock.totalPurchaseValue), (1 / stock.yearsHeld)) - 1;
    }

    // Simplistic volatility approximation
    stock.volatility = Math.abs(stock.dailyChange) * 1.5;
  });

  // Distribution by purchase date
  const monthlyDistribution = {};
  const yearlyDistribution = {};

  const addDateBucket = (stock, value) => {
    const date = new Date(stock.purchaseDate);
    if (Number.isNaN(date.getTime())) return;
    const month = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
    const year = date.getFullYear();
    if (!monthlyDistribution[month]) {
      monthlyDistribution[month] = { value: 0, count: 0 };
    }
    monthlyDistribution[month].value += value;
    monthlyDistribution[month].count += 1;

    if (!yearlyDistribution[year]) {
      yearlyDistribution[year] = { value: 0, count: 0 };
    }
    yearlyDistribution[year].value += value;
    yearlyDistribution[year].count += 1;
  };

  israeliStocks.forEach((stock) => {
    const value = toNum(normalizeIsraeliPrice(stock.currentPrice)) * toNum(stock.quantity);
    addDateBucket(stock, value);
  });
  americanStocks.forEach((stock) => {
    const metrics = calculateAmericanStockMetrics(stock);
    addDateBucket(stock, metrics.totalCurrentValueILS);
  });
  // Accounts with a deposit ledger are bucketed PER DEPOSIT, at the date
  // each deposit was actually made, rather than as one lump at whatever
  // date the account's value was last updated.
  //
  // This is what the "פיזור לפי תאריכי קנייה" breakdown is for: it answers
  // "when did I put money in, and how much". A provident fund's whole
  // balance landing on its last-updated date answered a different question
  // and hid every contribution the user had recorded - a fund paid into
  // monthly for five years showed up as a single entry in the current
  // month. Now each deposit sits in the month it was made, right alongside
  // the stock purchases, which is exactly the comparison this section is
  // meant to support.
  //
  // Amounts are the deposits themselves (money in at that date), not a
  // share of today's value - the same basis as a stock purchase lot's
  // entry. An account with no ledger at all still falls back to its single
  // value at its update date, so nothing disappears from the breakdown.
  const addLedgerBuckets = (account, fallbackValue, fallbackDate) => {
    const deposits = Array.isArray(account.deposits) ? account.deposits : [];
    const dated = deposits.filter((d) => d && d.date);
    if (dated.length === 0) {
      addDateBucket({ purchaseDate: fallbackDate }, toNum(fallbackValue));
      return;
    }
    dated.forEach((deposit) => {
      addDateBucket({ purchaseDate: deposit.date }, toNum(deposit.amount));
    });
  };

  pensionFunds.forEach((item) => {
    addLedgerBuckets(item, item.currentValue != null ? item.currentValue : item.amount, item.currentValueDate || item.updateDate);
  });
  cashFunds.forEach((item) => {
    addLedgerBuckets(item, item.amount, item.currentValueDate || item.updateDate);
  });
  bankBalances.forEach((item) => {
    addLedgerBuckets(item, item.amount, item.currentValueDate || item.updateDate);
  });
  bankSavingsFunds.forEach((fund) => {
    addLedgerBuckets(fund, computeBankSavingsFundValue(fund), null);
  });

  const stockList = Object.values(stockDistribution);

  // Detailed reports
  const topPerformers = [...stockList]
    .filter((s) => s.profit > 0)
    .sort((a, b) => b.profit - a.profit)
    .slice(0, 5);

  const worstPerformers = [...stockList]
    .filter((s) => s.profit < 0)
    .sort((a, b) => a.profit - b.profit)
    .slice(0, 5);

  const largestPositions = [...stockList]
    .sort((a, b) => b.value - a.value)
    .slice(0, 5);

  const totalPurchaseILS = stockList.reduce((sum, stock) => sum + stock.totalPurchaseValue, 0);
  const totalProfitILS = stockList.reduce((sum, stock) => sum + stock.profit, 0);
  // TODAY'S CHANGE, ON TWO BASES - and they are not the same number.
  //
  // The shekels are the stocks' alone: provident funds, money-market funds
  // and current accounts have no daily price. As a percentage, the home
  // page divides them by the stocks' value (dailyChangeStocksPercent, the
  // same figure as portfolioSummary.js's weightedDailyChange), while
  // weightedDailyChangePercent divides them by the whole portfolio, so
  // those still balances dilute it. With most of a portfolio in provident
  // funds the two differ by a factor of three (+0.88% vs +0.32%), and
  // shown under the same caption they read as a contradiction. The
  // analysis page now leads with the stocks' figure, matching home, and
  // states the whole-portfolio one as what it is.
  const dailyChangeILS = stockList.reduce((sum, stock) => sum + (stock.dailyChange / 100) * stock.value, 0);
  const stocksValueILS = stockList.reduce((sum, stock) => sum + stock.value, 0);
  const dailyChangeStocksPercent = stocksValueILS > 0 ? (dailyChangeILS / stocksValueILS) * 100 : 0;
  const weightedDailyChangePercent = totalValueILS > 0 ? (dailyChangeILS / totalValueILS) * 100 : 0;
  const weightedAnnualizedReturnPercent = totalPurchaseILS > 0
    ? stockList.reduce((sum, stock) => sum + ((stock.annualizedReturn || 0) * stock.totalPurchaseValue), 0) /
      totalPurchaseILS * 100
    : 0;
  const concentrationTop3Percent = stockList
    .slice()
    .sort((a, b) => b.value - a.value)
    .slice(0, 3)
    .reduce((sum, stock) => sum + stock.percentage, 0);
  const averageHoldingDays = stockList.length
    ? Math.round(stockList.reduce((sum, stock) => sum + stock.daysHeld, 0) / stockList.length)
    : 0;
  const americanFxImpactILS = americanStocks.reduce((sum, stock) => {
    const metrics = calculateAmericanStockMetrics(stock);
    return sum + metrics.exchangeRateImpact;
  }, 0);
  const israeliPositions = stockList.filter((s) => s.exchange === 'israeli').length;
  const americanPositions = stockList.filter((s) => s.exchange === 'american').length;
  const nonStockTotalValueILS =
    pensionTotalValueILS + cashFundsTotalValueILS + bankTotalValueILS + bankSavingsTotalValueILS;

  return {
    // Distribution by exchange
    exchangeDistribution: {
      israeli: {
        value: israeliTotalValue,
        percentage: totalValueILS > 0 ? (israeliTotalValue / totalValueILS) * 100 : 0
      },
      american: {
        value: americanTotalValueILS,
        percentage: totalValueILS > 0 ? (americanTotalValueILS / totalValueILS) * 100 : 0
      },
      pension: {
        value: pensionTotalValueILS,
        percentage: totalValueILS > 0 ? (pensionTotalValueILS / totalValueILS) * 100 : 0
      },
      cashFunds: {
        value: cashFundsTotalValueILS,
        percentage: totalValueILS > 0 ? (cashFundsTotalValueILS / totalValueILS) * 100 : 0
      },
      bank: {
        value: bankTotalValueILS,
        percentage: totalValueILS > 0 ? (bankTotalValueILS / totalValueILS) * 100 : 0
      },
      bankSavings: {
        value: bankSavingsTotalValueILS,
        percentage: totalValueILS > 0 ? (bankSavingsTotalValueILS / totalValueILS) * 100 : 0
      },
      total: totalValueILS
    },

    // Distribution by stock
    stockDistribution: [...stockList].sort((a, b) => b.value - a.value),

    // Distribution by date
    monthlyDistribution: Object.entries(monthlyDistribution)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([month, data]) => ({ month, ...data })),

    yearlyDistribution: Object.entries(yearlyDistribution)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([year, data]) => ({ year, ...data })),

    // Detailed reports
    reports: {
      topPerformers,
      worstPerformers,
      largestPositions
    },
    summaryMetrics: {
      positionsCount:
        stockList.length + pensionFunds.length + cashFunds.length + bankBalances.length + bankSavingsFunds.length,
      israeliPositions,
      americanPositions,
      pensionPositions: pensionFunds.length,
      cashFundsPositions: cashFunds.length,
      bankPositions: bankBalances.length,
      bankSavingsPositions: bankSavingsFunds.length,
      totalPurchaseILS,
      totalProfitILS,
      weightedDailyChangePercent,
      dailyChangeStocksPercent,
      dailyChangeILS,
      stocksValueILS,
      weightedAnnualizedReturnPercent,
      concentrationTop3Percent,
      averageHoldingDays,
      americanFxImpactILS,
      pensionTotalValueILS,
      cashFundsTotalValueILS,
      bankTotalValueILS,
      bankSavingsTotalValueILS,
      nonStockTotalValueILS,
      overallTotalValueILS: totalValueILS
    }
  };
};
