// An account's value follows its ledger until a statement is recorded
// (transactionLedger.js's syncLedgerValue), and accounts opened before that
// existed are repaired (normalizeLedgerAccounts).
const { applyTransaction, revertTransaction, normalizeLedgerAccounts } = require('./transactionLedger');
const { liquidBalanceOn } = require('./liquidBalance');

const empty = () => ({ israeliStocks: [], americanStocks: [], pensionFunds: [], cashFunds: [], bankBalances: [], bankSavingsFunds: [] });
const open = (assetClass, amount, date, newAccount = { fundName: 'חשבון', securityId: '1' }) =>
  applyTransaction(empty(), { id: 'open', type: 'DEPOSIT', date, assetClass, amount, newAccount }, { newLotId: 1 });
const deposit = (portfolio, assetClass, id, amount, date, type = 'DEPOSIT') =>
  applyTransaction(portfolio, { id, type, date, assetClass, assetId: '1', amount }, {});

test('a same-day deposit after the opening one is part of the balance', () => {
  let p = open('cashFunds', 14000, '2026-10-14').portfolio;
  p = deposit(p, 'cashFunds', 'second', 2500, '2026-10-14').portfolio;
  const fund = p.cashFunds[0];
  expect(fund.valueFromLedger).toBe(true);
  expect(fund.currentValue).toBe(16500);
  expect(liquidBalanceOn(fund, '2026-10-14')).toBe(16500);
});

test('a back-dated deposit and a withdrawal move it too; deleting one moves it back', () => {
  let p = open('bank', 10000, '2026-10-10').portfolio;
  p = deposit(p, 'bank', 'early', 500, '2026-10-01').portfolio;
  const withdrawal = deposit(p, 'bank', 'out', 3000, '2026-10-12', 'WITHDRAWAL');
  p = withdrawal.portfolio;
  expect(p.bankBalances[0].currentValue).toBe(7500);
  expect(p.bankBalances[0].currentValueDate).toBe('2026-10-12');
  expect(liquidBalanceOn(p.bankBalances[0], '2026-10-14')).toBe(7500);

  p = revertTransaction(p, withdrawal.transaction);
  expect(p.bankBalances[0].currentValue).toBe(10500);
  expect(p.bankBalances[0].currentValueDate).toBe('2026-10-10');
});

test('an account opened the old way is repaired: its opening echo becomes the ledger sum', () => {
  const legacy = {
    ...empty(),
    cashFunds: [
      {
        id: 1,
        fundName: 'כספית',
        currentValue: 14000,
        currentValueDate: '2026-10-14',
        previousValue: 0,
        previousValueDate: '',
        amount: 14000,
        deposits: [
          { date: '2026-10-14', amount: 14000, txId: 'a' },
          { date: '2026-10-14', amount: 2500, txId: 'b' }
        ]
      }
    ]
  };
  const fixed = normalizeLedgerAccounts(legacy).cashFunds[0];
  expect(fixed.valueFromLedger).toBe(true);
  expect(fixed.currentValue).toBe(16500);
});

test('...and when a statement has since rolled the echo into "previous", that previous balance is repaired', () => {
  const legacy = {
    ...empty(),
    cashFunds: [
      {
        id: 1,
        currentValue: 15000,
        currentValueDate: '2026-10-15',
        previousValue: 14000,
        previousValueDate: '2026-10-14',
        deposits: [
          { date: '2026-10-14', amount: 14000, txId: 'a' },
          { date: '2026-10-14', amount: 2500, txId: 'b' }
        ]
      }
    ]
  };
  const fixed = normalizeLedgerAccounts(legacy).cashFunds[0];
  expect(fixed.previousValue).toBe(16500);
  expect(fixed.previousValueFromLedger).toBe(true);
  expect(fixed.currentValue).toBe(15000); // the statement is untouched
});

test('a value typed in from a statement is never mistaken for an echo', () => {
  const typed = {
    ...empty(),
    cashFunds: [{ id: 1, currentValue: 9000, currentValueDate: '2026-09-30', deposits: [{ date: '2026-09-01', amount: 9000 }] }]
  };
  const result = normalizeLedgerAccounts(typed);
  expect(result.cashFunds[0]).toBe(typed.cashFunds[0]);
});

test('a ledger-made previous value follows an edited deposit dated before it', () => {
  let p = open('cashFunds', 14000, '2026-10-04').portfolio;
  const second = deposit(p, 'cashFunds', 'second', 2500, '2026-10-04');
  p = second.portfolio;
  // A statement rolls the ledger value into "previous" (what portfolioMath
  // does), marked as ledger-made.
  const fund = p.cashFunds[0];
  p.cashFunds[0] = { ...fund, valueFromLedger: undefined, previousValue: fund.currentValue, previousValueDate: fund.currentValueDate, previousValueFromLedger: true, currentValue: 15000, currentValueDate: '2026-10-05' };
  // Correct the 2,500 to 3,000 on 03/10: revert, then re-apply.
  p = revertTransaction(p, second.transaction);
  expect(p.cashFunds[0].previousValue).toBe(14000);
  p = deposit(p, 'cashFunds', 'fixed', 3000, '2026-10-03').portfolio;
  expect(p.cashFunds[0].previousValue).toBe(17000);
  expect(p.cashFunds[0].currentValue).toBe(15000); // the statement is untouched
});
