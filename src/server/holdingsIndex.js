// Who holds what: the distinct securities across every user's portfolio,
// each with its holders and the size of their position.
//
// Derived by reading the stored portfolios rather than kept as a separate
// table. The scans that need it run a few times a day, and a derived index
// can never fall out of step with the portfolios it comes from (a second
// table would have to be rewritten on every save and every ledger change).
//
// Position weight is an ESTIMATE from the values stored with the portfolio
// (the prices and USD rate the client last saved), which is what alert
// severity weighting needs: "is this a 0.5% or a 20% position".

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

function bankSavingsValue(fund) {
  return (Array.isArray(fund.deposits) ? fund.deposits : []).reduce((s, d) => s + num(d.amount), 0);
}

// Portfolio value in ILS from stored figures. Israeli prices are stored in
// shekels (see formatters.normalizeIsraeliPrice); American ones in USD with
// the lot's current (or purchase) exchange rate.
function estimatePortfolioValueILS(portfolio) {
  const p = portfolio || {};
  let total = 0;
  (p.israeliStocks || []).forEach((lot) => {
    total += num(lot.quantity) * num(lot.currentPrice || lot.purchasePrice);
  });
  (p.americanStocks || []).forEach((lot) => {
    total += num(lot.quantity) * num(lot.currentPrice || lot.purchasePrice) * num(lot.currentExchangeRate || lot.exchangeRate);
  });
  ['pensionFunds', 'cashFunds', 'bankBalances'].forEach((key) => {
    (p[key] || []).forEach((account) => {
      total += num(account.amount !== undefined ? account.amount : account.currentValue);
    });
  });
  (p.bankSavingsFunds || []).forEach((fund) => {
    total += bankSavingsValue(fund);
  });
  return total;
}

function usdRateOf(portfolio) {
  const lot = ((portfolio && portfolio.americanStocks) || []).find((l) => num(l.currentExchangeRate) > 0 || num(l.exchangeRate) > 0);
  return lot ? num(lot.currentExchangeRate) || num(lot.exchangeRate) : null;
}

// portfolios: [{ userId, portfolio }]. Returns
//   { securities: [{ key, symbol, market, name, currency, holders: [{ userId, units, valueILS, weightPct, usdRate }] }],
//     byUser: Map(userId -> { totalValueILS, usdRate, positions: [{ symbol, market, units }] }) }
function buildHoldingsIndex(portfolios) {
  const securities = new Map();
  const byUser = new Map();

  (portfolios || []).forEach(({ userId, portfolio }) => {
    const totalValueILS = estimatePortfolioValueILS(portfolio);
    const usdRate = usdRateOf(portfolio);
    const perSymbol = new Map();

    const addLots = (lots, market) => {
      (lots || []).forEach((lot) => {
        const raw = String(lot.stockName || '').trim();
        if (!raw || !(num(lot.quantity) > 0)) return;
        const symbol = market === 'US' ? raw.toUpperCase() : raw;
        const key = `${market}:${symbol}`;
        const entry = perSymbol.get(key) || { symbol, market, name: '', units: 0, valueILS: 0 };
        entry.units += num(lot.quantity);
        const price = num(lot.currentPrice || lot.purchasePrice);
        entry.valueILS += market === 'US' ? num(lot.quantity) * price * num(lot.currentExchangeRate || lot.exchangeRate) : num(lot.quantity) * price;
        if (!entry.name && lot.officialName) entry.name = lot.officialName;
        perSymbol.set(key, entry);
      });
    };
    addLots(portfolio && portfolio.israeliStocks, 'TASE');
    addLots(portfolio && portfolio.americanStocks, 'US');

    const positions = [];
    perSymbol.forEach((entry, key) => {
      const weightPct = totalValueILS > 0 ? (entry.valueILS / totalValueILS) * 100 : null;
      if (!securities.has(key)) {
        securities.set(key, {
          key,
          symbol: entry.symbol,
          market: entry.market,
          name: entry.name,
          currency: entry.market === 'US' ? 'USD' : 'ILS',
          holders: []
        });
      }
      const sec = securities.get(key);
      if (!sec.name && entry.name) sec.name = entry.name;
      sec.holders.push({ userId, units: entry.units, valueILS: entry.valueILS, weightPct, usdRate });
      positions.push({ symbol: entry.symbol, market: entry.market, units: entry.units, name: entry.name });
    });
    byUser.set(userId, { totalValueILS, usdRate, positions });
  });

  return { securities: [...securities.values()], byUser };
}

// Reads every (or the given) user's stored portfolio.
async function loadPortfolios(store, userIds = null) {
  const ids = userIds || (await store.listUserIds());
  const out = [];
  for (const userId of ids) {
    const raw = await store.getPortfolioPayload(userId);
    if (!raw) continue;
    let portfolio;
    try {
      portfolio = JSON.parse(raw);
    } catch {
      continue;
    }
    out.push({ userId, portfolio });
  }
  return out;
}

module.exports = { buildHoldingsIndex, loadPortfolios, estimatePortfolioValueILS };
