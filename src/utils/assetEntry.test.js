import {
  normalizeAccountName,
  findExistingAccount,
  existingStockLots,
  describeEntry,
  applyLiquidAccountTransaction
} from './assetEntry';

const holdings = {
  pensionFunds: [{ id: 1, fundName: 'קרן השתלמות מור', deposits: [] }],
  bankSavingsFunds: [{ id: 2, fundName: 'חיסכון לאומי', deposits: [] }],
  cashFunds: [{ id: 3, fundName: 'כספית', securityId: '5119609', deposits: [] }],
  bankBalances: [{ id: 4, currentValue: 10000, currentValueDate: '2026-10-01', amount: 10000, deposits: [] }],
  israeliStocks: [{ stockName: '629014', quantity: 10 }, { stockName: '629014', quantity: 5 }],
  americanStocks: [{ stockName: 'AAPL', quantity: 3 }]
};

describe('findExistingAccount', () => {
  test('matches a fund name regardless of surrounding/repeated whitespace and letter case', () => {
    expect(normalizeAccountName('  Fund   A ')).toBe('fund a');
    expect(findExistingAccount('pension', { stockName: 'קרן השתלמות מור ' }, holdings)).toBe(holdings.pensionFunds[0]);
    expect(findExistingAccount('pension', { stockName: 'קרן  השתלמות מור' }, holdings)).toBe(holdings.pensionFunds[0]);
  });

  test('a different name is a new account; a blank one matches nothing', () => {
    expect(findExistingAccount('pension', { stockName: 'קרן אחרת' }, holdings)).toBeNull();
    expect(findExistingAccount('pension', { stockName: '  ' }, holdings)).toBeNull();
  });

  test('money-market funds match by security number, current accounts by being the one account', () => {
    expect(findExistingAccount('cash_fund', { securityId: ' 5119609 ' }, holdings)).toBe(holdings.cashFunds[0]);
    expect(findExistingAccount('cash_fund', { securityId: '' }, holdings)).toBeNull();
    expect(findExistingAccount('bank', {}, holdings)).toBe(holdings.bankBalances[0]);
    expect(findExistingAccount('bank', {}, { bankBalances: [] })).toBeNull();
  });
});

describe('existingStockLots / describeEntry', () => {
  test('a security already held is another purchase lot of it', () => {
    expect(existingStockLots({ exchange: 'israeli', stockName: '629014' }, holdings)).toHaveLength(2);
    expect(existingStockLots({ exchange: 'american', stockName: 'aapl' }, holdings)).toHaveLength(1);
    expect(describeEntry({ itemType: 'stock', exchange: 'israeli', stockName: '629014' }, holdings).kind).toBe(
      'additional-lot'
    );
    expect(describeEntry({ itemType: 'stock', exchange: 'american', stockName: 'MSFT' }, holdings).kind).toBe(
      'new-holding'
    );
  });

  test('says whether an account entry is a transaction or a new account, and nothing before it can tell', () => {
    expect(describeEntry({ itemType: 'pension', stockName: 'קרן השתלמות מור' }, holdings)).toEqual({
      kind: 'transaction',
      target: holdings.pensionFunds[0]
    });
    expect(describeEntry({ itemType: 'pension', stockName: 'חדשה' }, holdings).kind).toBe('new-account');
    expect(describeEntry({ itemType: 'pension', stockName: '' }, holdings)).toBeNull();
    expect(describeEntry({ itemType: 'bank' }, holdings).kind).toBe('transaction');
  });
});

describe('applyLiquidAccountTransaction', () => {
  const account = {
    id: 4,
    currentValue: 10000,
    currentValueDate: '2026-10-01',
    previousValue: 9000,
    previousValueDate: '2026-09-01',
    amount: 10000,
    deposits: []
  };

  test('a movement after the last recorded balance moves the balance and is logged', () => {
    const after = applyLiquidAccountTransaction(account, -2500, '2026-10-05');
    expect(after.currentValue).toBe(7500);
    expect(after.amount).toBe(7500);
    expect(after.currentValueDate).toBe('2026-10-05');
    expect(after.deposits).toEqual([{ date: '2026-10-05', amount: -2500 }]);
    // The previous update is untouched, so its period return still covers
    // the same span.
    expect(after.previousValue).toBe(9000);
    expect(after.previousValueDate).toBe('2026-09-01');
  });

  test('a backdated movement is logged without moving a balance recorded after it', () => {
    const after = applyLiquidAccountTransaction(account, 500, '2026-09-15');
    expect(after.currentValue).toBe(10000);
    expect(after.currentValueDate).toBe('2026-10-01');
    expect(after.deposits).toEqual([{ date: '2026-09-15', amount: 500 }]);
  });

  test('reads a current account recorded with updateDate/amount only', () => {
    const legacy = { id: 5, amount: 2000, updateDate: '2026-10-01', deposits: [] };
    const after = applyLiquidAccountTransaction(legacy, 1000, '2026-10-02');
    expect(after.currentValue).toBe(3000);
    expect(after.amount).toBe(3000);
  });
});
