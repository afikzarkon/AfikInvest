import { actionsFor, buildEntryPayload, duplicateAccount, emptyEntry, entryFromTransaction, entryPreview, NEW_ASSET, unitsHeld } from './assetEntry';

const holdings = {
  israeliStocks: [{ stockName: '604611', quantity: 10 }, { stockName: '604611', quantity: 5 }],
  americanStocks: [{ stockName: 'AAPL', quantity: 3 }],
  pensionFunds: [{ id: 1, fundName: 'קרן השתלמות מור' }],
  cashFunds: [{ id: 3, fundName: 'כספית', securityId: '5119609' }],
  bankBalances: [{ id: 4, currentValue: 1000, currentValueDate: '2026-10-01', deposits: [] }],
  bankSavingsFunds: []
};

test('what each asset allows', () => {
  expect(actionsFor('israeli', { held: 0 })).toEqual(['BUY']);
  expect(actionsFor('american', { held: 3 })).toEqual(['BUY', 'SELL', 'DIVIDEND']);
  expect(actionsFor('pension')).toEqual(['DEPOSIT', 'WITHDRAWAL', 'VALUE']);
  expect(actionsFor('bankSavings')).toEqual(['DEPOSIT', 'WITHDRAWAL']);
  expect(actionsFor('cashFunds', { isNew: true })).toEqual(['DEPOSIT']);
  expect(unitsHeld(holdings, 'israeli', '604611')).toBe(15);
  expect(unitsHeld(holdings, 'american', 'aapl')).toBe(3);
});

test('every transaction goes to the ledger; a statement value does not', () => {
  const sell = { ...emptyEntry({ assetClass: 'american', assetId: 'AAPL', action: 'SELL' }, '2026-10-12'), units: '2', price: '200', fxRate: '3.6' };
  expect(buildEntryPayload(sell)).toEqual({
    kind: 'transaction',
    tx: expect.objectContaining({ type: 'SELL', assetClass: 'american', assetId: 'AAPL', units: 2, price: 200, fees: 0, fxRate: 3.6, lotMethod: 'FIFO' })
  });
  const value = { ...emptyEntry({ assetClass: 'pension', assetId: 1, action: 'VALUE' }, '2026-09-30'), value: '1234' };
  expect(buildEntryPayload(value)).toEqual({ kind: 'value', assetClass: 'pension', assetId: '1', value: 1234, date: '2026-09-30' });
});

test('a new account is a DEPOSIT carrying its details, without an assetId', () => {
  const open = { ...emptyEntry({ assetClass: 'cashFunds', assetId: NEW_ASSET }, '2026-10-12'), amount: '500', newAccount: { fundName: ' כספית ב ', securityId: ' 111 ' } };
  const { tx } = buildEntryPayload(open);
  expect(tx).toMatchObject({ type: 'DEPOSIT', amount: 500, newAccount: { fundName: 'כספית ב', securityId: '111' } });
  expect(tx.assetId).toBeUndefined();
});

test('a duplicate account is found by name (spacing and case aside) or by security number', () => {
  const byName = { ...emptyEntry({ assetClass: 'pension', assetId: NEW_ASSET }), newAccount: { fundName: '  קרן  השתלמות מור' } };
  expect(duplicateAccount(byName, holdings)).toBe(holdings.pensionFunds[0]);
  const byNumber = { ...emptyEntry({ assetClass: 'cashFunds', assetId: NEW_ASSET }), newAccount: { securityId: '5119609' } };
  expect(duplicateAccount(byNumber, holdings)).toBe(holdings.cashFunds[0]);
  expect(duplicateAccount({ ...byName, newAccount: { fundName: 'אחרת' } }, holdings)).toBeNull();
});

test('editing starts from the recorded transaction', () => {
  const tx = { id: 'x', type: 'BUY', date: '2026-01-05', assetClass: 'american', assetId: 'AAPL', units: 2, price: 150, fees: 1, currency: 'USD', fxRate: 3.7 };
  expect(entryFromTransaction(tx)).toMatchObject({ editingTxId: 'x', action: 'BUY', units: '2', price: '150', fees: '1', fxRate: '3.7', date: '2026-01-05' });
});

test('says what will happen', () => {
  expect(entryPreview({ ...emptyEntry({ assetClass: 'israeli', assetId: '604611', action: 'BUY' }) }, holdings)).toMatch(/כבר מוחזקות 15 יחידות/);
  expect(entryPreview({ ...emptyEntry({ assetClass: 'israeli', assetId: '604611', action: 'SELL' }), units: '20' }, holdings)).toMatch(/מוחזקות רק 15/);
  expect(entryPreview({ ...emptyEntry({ assetClass: 'bank', assetId: 4, action: 'WITHDRAWAL' }), amount: '200' }, holdings)).toMatch(/תתווסף ליתרה מיד/);
  expect(entryPreview({ ...emptyEntry({ assetClass: 'pension', assetId: NEW_ASSET }) }, holdings)).toMatch(/ייפתח חשבון חדש/);
});
