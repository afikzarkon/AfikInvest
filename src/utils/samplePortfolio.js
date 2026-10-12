// A ready-made demo portfolio, loaded from the empty home screen's
// "טען תיק לדוגמה" button.
//
// It exists so a first-time visitor can see every page working - live
// prices, real-tax figures, the benchmark comparison, the monthly tracker -
// within seconds and without typing anything, let alone their own figures
// (the beta notice asks for dummy data only). Everything here is invented.
//
// The shapes mirror exactly what App.js's add-item form writes for each
// item type, so nothing downstream can tell a sample row from a typed one.
// Stocks carry a placeholder currentPrice only so the figures are not all
// zero before the first live refresh (usePriceRefresh.js) replaces it.
//
// Purchase dates are fixed real dates, with purchase prices and USD/ILS
// rates close to the actual ones on those days, so the historical
// performance chart has sensible prices behind it. The ledger accounts'
// "current value" dates are relative to `today`, so they always read as
// recently updated rather than aging with the app. Their `amount` equals
// currentValue, as it does after any value update (applyLedgerValueUpdate
// in portfolioMath.js) - the summary totals read `amount`.

function isoDate(date) {
  return date.toISOString().slice(0, 10);
}

// The first day of the month `monthsBack` months before `today`.
function monthStart(today, monthsBack) {
  return isoDate(new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - monthsBack, 1)));
}

function israeliLot(id, stockId, officialName, branch, purchaseDate, purchasePrice, quantity, currentPrice) {
  return {
    id,
    stockName: stockId,
    officialName,
    purchaseDate,
    purchasePrice,
    quantity,
    exchangeRate: null,
    currentPrice,
    dailyChangePercent: 0,
    securityType: 'מניות',
    securitySubType: '',
    branch,
    isFund: false,
    isForeignETF: false
  };
}

function americanLot(id, symbol, purchaseDate, purchasePrice, quantity, exchangeRate, currentPrice) {
  return {
    id,
    stockName: symbol,
    officialName: '',
    purchaseDate,
    purchasePrice,
    quantity,
    exchangeRate,
    currentPrice,
    dailyChangePercent: 0
  };
}

export function buildSamplePortfolio(today = new Date()) {
  const currentValueDate = monthStart(today, 0);
  const previousValueDate = monthStart(today, 1);

  return {
    israeliStocks: [
      // Two lots of the same share at different prices - the per-lot
      // profit breakdown is one of the things the demo is there to show.
      israeliLot(9000001, '604611', 'לאומי', 'בנקים', '2023-05-02', 26.1, 400, 50),
      israeliLot(9000002, '604611', 'לאומי', 'בנקים', '2024-09-02', 38, 200, 50),
      israeliLot(9000003, '629014', 'טבע', 'הייטק-ביומד-פארמה', '2023-11-01', 33.5, 150, 65),
      israeliLot(9000004, '1081124', 'אלביט מערכות', 'תעשייה-ביטחוניות', '2024-02-01', 780, 10, 1500)
    ],
    americanStocks: [
      americanLot(9000101, 'AAPL', '2023-03-15', 152, 20, 3.66, 230),
      americanLot(9000102, 'AAPL', '2024-08-05', 209, 10, 3.8, 230),
      americanLot(9000103, 'MSFT', '2023-06-01', 332, 10, 3.74, 500),
      americanLot(9000104, 'NVDA', '2024-01-10', 54, 60, 3.72, 175),
      americanLot(9000105, 'SPY', '2023-10-02', 427, 8, 3.83, 640)
    ],
    pensionFunds: [
      {
        id: 9000201,
        fundName: 'קופת גמל להשקעה - מסלול מניות',
        currentValue: 118000,
        currentValueDate,
        previousValue: 114500,
        previousValueDate,
        deposits: [
          { date: '2023-01-15', amount: 50000 },
          { date: '2024-01-15', amount: 20000 },
          { date: '2025-01-15', amount: 20000 }
        ],
        amount: 118000
      }
    ],
    bankBalances: [
      {
        id: 9000301,
        updateDate: '2024-01-01',
        currentValue: 18000,
        currentValueDate,
        previousValue: 16500,
        previousValueDate,
        deposits: [{ date: '2024-01-01', amount: 16500 }],
        amount: 18000
      }
    ],
    cashFunds: [
      {
        id: 9000401,
        fundName: 'קרן כספית שקלית',
        securityId: '',
        currentValue: 31500,
        currentValueDate,
        previousValue: 31300,
        previousValueDate,
        deposits: [{ date: '2025-06-01', amount: 30000 }],
        amount: 31500
      }
    ],
    bankSavingsFunds: [
      {
        id: 9000501,
        fundName: 'פיקדון חיסכון',
        investmentTrack: 'מסלול שקלי',
        interestRate: 4,
        isLinkedToIndex: false,
        deposits: [{ date: '2024-03-01', amount: 25000 }]
      }
    ]
  };
}
