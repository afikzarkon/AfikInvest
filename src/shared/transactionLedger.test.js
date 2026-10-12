const {
  normalizeTransaction,
  selectLotsForSale,
  applyTransaction,
  revertTransaction,
  expandHoldingsWithClosedLots,
  ledgerCashFlows,
  realizedLots,
  LedgerError
} = require('./transactionLedger');

const lot = (id, stockName, purchaseDate, purchasePrice, quantity, exchangeRate = null) => ({
  id,
  stockName,
  purchaseDate,
  purchasePrice,
  quantity,
  exchangeRate,
  currentPrice: purchasePrice
});

const portfolio = () => ({
  israeliStocks: [lot(1, '604611', '2023-01-10', 20, 100), lot(2, '604611', '2024-01-10', 30, 50)],
  americanStocks: [
    lot(11, 'AAPL', '2023-03-01', 150, 10, 3.6),
    lot(12, 'AAPL', '2024-03-01', 170, 10, 3.7),
    lot(13, 'AAPL', '2024-06-01', 190, 5, 3.75)
  ],
  pensionFunds: [{ id: 21, fundName: 'גמל', currentValue: 1000, deposits: [{ date: '2023-01-01', amount: 900 }] }],
  bankBalances: [{ id: 31, currentValue: 5000 }],
  cashFunds: [],
  bankSavingsFunds: []
});

const sell = (overrides) =>
  normalizeTransaction({
    type: 'SELL',
    date: '2025-01-15',
    assetClass: 'american',
    assetId: 'aapl',
    units: 12,
    price: 200,
    fees: 6,
    fxRate: 3.65,
    ...overrides
  });

describe('normalizeTransaction', () => {
  test('canonicalizes a USD sale', () => {
    const tx = sell();
    expect(tx).toMatchObject({
      type: 'SELL',
      assetId: 'AAPL',
      currency: 'USD',
      fxRate: 3.65,
      units: 12,
      amount: 2400,
      lotMethod: 'FIFO'
    });
  });

  test.each([
    [{ type: 'SWAP' }, /type must be/],
    [{ date: '2025-02-30' }, /date/],
    [{ date: '2030-01-01' }, /future/],
    [{ units: 0 }, /units/],
    [{ price: -1 }, /price/],
    [{ fxRate: undefined }, /fxRate/],
    [{ fees: -1 }, /fees/],
    [{ lotMethod: 'RANDOM' }, /lotMethod/],
    [{ lotMethod: 'SPECIFIC' }, /specificLots/],
    [{ lotMethod: 'SPECIFIC', specificLots: [{ lotId: 11, units: 5 }] }, /add up/],
    [{ assetClass: 'pension' }, /israeli/]
  ])('rejects %o', (overrides, message) => {
    expect(() =>
      normalizeTransaction(
        { type: 'SELL', date: '2025-01-15', assetClass: 'american', assetId: 'AAPL', units: 12, price: 200, fxRate: 3.65, ...overrides },
        { today: '2026-01-01' }
      )
    ).toThrow(message);
  });

  test('an ILS security needs no FX rate and gets rate 1', () => {
    const tx = normalizeTransaction({ type: 'BUY', date: '2025-01-01', assetClass: 'israeli', assetId: ' 604611 ', units: 5, price: 40 });
    expect(tx).toMatchObject({ currency: 'ILS', fxRate: 1, assetId: '604611' });
  });

  test('a withdrawal targets an account and needs a positive amount', () => {
    expect(() => normalizeTransaction({ type: 'WITHDRAWAL', date: '2025-01-01', assetClass: 'american', assetId: 'x', amount: 5 })).toThrow(/assetClass/);
    expect(() => normalizeTransaction({ type: 'WITHDRAWAL', date: '2025-01-01', assetClass: 'pension', assetId: '21', amount: 0 })).toThrow(/amount/);
  });

  test('dividend tax cannot exceed the gross amount', () => {
    expect(() =>
      normalizeTransaction({ type: 'DIVIDEND', date: '2025-01-01', assetClass: 'american', assetId: 'AAPL', amount: 10, taxWithheld: 11, fxRate: 3.6 })
    ).toThrow(/taxWithheld/);
  });
});

describe('selectLotsForSale', () => {
  const lots = portfolio().americanStocks;
  const base = { assetClass: 'american', assetId: 'AAPL', date: '2025-01-15' };

  test('FIFO takes the oldest lots first', () => {
    const picks = selectLotsForSale(lots, { ...base, units: 12, lotMethod: 'FIFO' });
    expect(picks.map((p) => [p.lot.id, p.units])).toEqual([[11, 10], [12, 2]]);
  });

  test('LIFO takes the newest lots first', () => {
    const picks = selectLotsForSale(lots, { ...base, units: 12, lotMethod: 'LIFO' });
    expect(picks.map((p) => [p.lot.id, p.units])).toEqual([[13, 5], [12, 7]]);
  });

  test('HIFO takes the highest ILS cost per unit first', () => {
    // 13: 190*3.75=712.5, 12: 170*3.7=629, 11: 150*3.6=540
    const picks = selectLotsForSale(lots, { ...base, units: 6, lotMethod: 'HIFO' });
    expect(picks.map((p) => [p.lot.id, p.units])).toEqual([[13, 5], [12, 1]]);
  });

  test('SPECIFIC uses exactly the requested lots', () => {
    const picks = selectLotsForSale(lots, {
      ...base,
      units: 3,
      lotMethod: 'SPECIFIC',
      specificLots: [{ lotId: '12', units: 3 }]
    });
    expect(picks.map((p) => [p.lot.id, p.units])).toEqual([[12, 3]]);
  });

  test('cannot sell more than is held, or lots bought after the sale', () => {
    expect(() => selectLotsForSale(lots, { ...base, units: 26 })).toThrow(LedgerError);
    expect(() => selectLotsForSale(lots, { ...base, date: '2024-05-01', units: 21 })).toThrow(/only 20/);
  });
});

describe('applyTransaction / revertTransaction', () => {
  test('a sale reduces and removes lots, and records what it closed', () => {
    const tx = { ...sell(), id: 't1' };
    const { portfolio: next, transaction } = applyTransaction(portfolio(), tx);

    expect(next.americanStocks.map((l) => [l.id, l.quantity])).toEqual([[12, 8], [13, 5]]);
    expect(transaction.allocations).toHaveLength(2);
    expect(transaction.allocations[0]).toMatchObject({ lotId: 11, units: 10, closedLot: true, feeShare: 5 });
    expect(transaction.allocations[1]).toMatchObject({ lotId: 12, units: 2, closedLot: false, feeShare: 1 });
    expect(transaction.amountILS).toBeCloseTo((2400 - 6) * 3.65, 6);
  });

  test('does not mutate its input', () => {
    const before = portfolio();
    const snapshot = JSON.stringify(before);
    applyTransaction(before, { ...sell(), id: 't1' });
    expect(JSON.stringify(before)).toBe(snapshot);
  });

  test('reverting a sale restores the portfolio exactly (quantities)', () => {
    const start = portfolio();
    const tx = { ...sell(), id: 't1' };
    const applied = applyTransaction(start, tx);
    const reverted = revertTransaction(applied.portfolio, applied.transaction);
    const sortById = (lots) => [...lots].sort((a, b) => a.id - b.id).map((l) => [l.id, l.quantity, l.purchasePrice]);
    expect(sortById(reverted.americanStocks)).toEqual(sortById(start.americanStocks));
  });

  test('a buy creates a lot with fees in its cost basis; reverting removes it', () => {
    const tx = {
      ...normalizeTransaction({ type: 'BUY', date: '2025-02-01', assetClass: 'american', assetId: 'MSFT', units: 4, price: 400, fees: 8, fxRate: 3.6, lotDetails: { officialName: 'Microsoft', junk: 1 } }),
      id: 'b1'
    };
    const { portfolio: next, transaction } = applyTransaction(portfolio(), tx, { newLotId: 99 });
    const created = next.americanStocks.find((l) => l.id === 99);
    expect(created).toMatchObject({ stockName: 'MSFT', quantity: 4, purchasePrice: 402, exchangeRate: 3.6, officialName: 'Microsoft', txId: 'b1' });
    expect(created.junk).toBeUndefined();
    expect(transaction.createdLotId).toBe(99);
    expect(revertTransaction(next, transaction).americanStocks.find((l) => l.id === 99)).toBeUndefined();
  });

  test('a bought lot that was partly sold cannot be reverted before the sale', () => {
    const buy = { ...normalizeTransaction({ type: 'BUY', date: '2025-02-01', assetClass: 'israeli', assetId: '1', units: 10, price: 5 }), id: 'b1' };
    const afterBuy = applyTransaction(portfolio(), buy, { newLotId: 50 });
    const sale = { ...normalizeTransaction({ type: 'SELL', date: '2025-03-01', assetClass: 'israeli', assetId: '1', units: 4, price: 6 }), id: 's1' };
    const afterSale = applyTransaction(afterBuy.portfolio, sale);
    expect(() => revertTransaction(afterSale.portfolio, afterBuy.transaction)).toThrow(/sold/);
    const saleUndone = revertTransaction(afterSale.portfolio, afterSale.transaction);
    expect(revertTransaction(saleUndone, afterBuy.transaction).israeliStocks.find((l) => l.id === 50)).toBeUndefined();
  });

  test('deposit and withdrawal write into the account ledger and revert cleanly', () => {
    const w = { ...normalizeTransaction({ type: 'WITHDRAWAL', date: '2025-01-01', assetClass: 'pension', assetId: 21, amount: 300 }), id: 'w1' };
    const d = { ...normalizeTransaction({ type: 'DEPOSIT', date: '2025-02-01', assetClass: 'bank', assetId: '31', amount: 100 }), id: 'd1' };
    const afterW = applyTransaction(portfolio(), w).portfolio;
    const afterD = applyTransaction(afterW, d).portfolio;
    expect(afterD.pensionFunds[0].deposits).toEqual([
      { date: '2023-01-01', amount: 900 },
      { date: '2025-01-01', amount: -300, txId: 'w1' }
    ]);
    expect(afterD.bankBalances[0].deposits).toEqual([{ date: '2025-02-01', amount: 100, txId: 'd1' }]);
    expect(revertTransaction(afterD, w).pensionFunds[0].deposits).toEqual([{ date: '2023-01-01', amount: 900 }]);
  });

  test('a deposit into an unknown account is refused', () => {
    const d = { ...normalizeTransaction({ type: 'DEPOSIT', date: '2025-02-01', assetClass: 'bank', assetId: '999', amount: 100 }), id: 'd1' };
    expect(() => applyTransaction(portfolio(), d)).toThrow(/no bank account/);
  });
});

describe('derived views', () => {
  const tx = { ...sell(), id: 't1' };
  const { portfolio: afterSale, transaction } = applyTransaction(portfolio(), tx);

  test('closed slices bring the sold units back for history, with a sold date', () => {
    const expanded = expandHoldingsWithClosedLots(afterSale, [transaction]);
    const slices = expanded.americanStocks.filter((l) => l.isClosedSlice);
    expect(slices.map((s) => [s.stockName, s.quantity, s.purchaseDate, s.purchasePrice, s.exchangeRate, s.soldDate])).toEqual([
      ['AAPL', 10, '2023-03-01', 150, 3.6, '2025-01-15'],
      ['AAPL', 2, '2024-03-01', 170, 3.7, '2025-01-15']
    ]);
    // open + closed units = what was ever bought
    const total = expanded.americanStocks.reduce((s, l) => s + l.quantity, 0);
    expect(total).toBe(25);
  });

  test('sale proceeds and dividends are negative flows in ILS', () => {
    const div = { ...normalizeTransaction({ type: 'DIVIDEND', date: '2025-02-10', assetClass: 'american', assetId: 'AAPL', amount: 10, taxWithheld: 2.5, fxRate: 3.6 }), id: 'v1' };
    const flows = ledgerCashFlows([transaction, div]);
    expect(flows[0]).toEqual({ date: '2025-01-15', amount: -(2400 - 6) * 3.65 });
    expect(flows[1].amount).toBeCloseTo(-7.5 * 3.6, 10);
    expect(ledgerCashFlows([transaction], { americanExchangeRate: 4 })[0].amount).toBeCloseTo(-2394 * 4, 10);
    expect(ledgerCashFlows([transaction], { assetClasses: ['israeli'] })).toEqual([]);
  });

  test('realized lots carry nominal gains in currency and ILS', () => {
    const rows = realizedLots([transaction]);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ symbol: 'AAPL', units: 10, cost: 1500, proceeds: 1995, gain: 495 });
    expect(rows[0].costILS).toBeCloseTo(1500 * 3.6, 10);
    expect(rows[0].proceedsILS).toBeCloseTo(1995 * 3.65, 10);
    expect(rows[1].gain).toBeCloseTo(2 * 200 - 1 - 340, 10);
  });
});
