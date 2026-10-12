const { liquidBalanceOn, movementsSinceLastBalance } = require('./liquidBalance');

describe('liquidBalanceOn', () => {
  const account = {
    currentValue: 10000,
    currentValueDate: '2026-09-30',
    previousValue: 8000,
    previousValueDate: '2026-08-31',
    deposits: [
      { date: '2026-09-15', amount: 1000 }, // inside the statement of Sep 30 already
      { date: '2026-10-05', amount: -2500, txId: 'a' },
      { date: '2026-10-20', amount: 400, txId: 'b' }
    ]
  };

  test('the latest recorded balance plus the movements after it, up to the day', () => {
    expect(liquidBalanceOn(account, '2026-10-12')).toBe(7500);
    expect(liquidBalanceOn(account, '2026-10-31')).toBe(7900);
    expect(movementsSinceLastBalance(account, '2026-10-12')).toBe(-2500);
  });

  test('an earlier day starts from the balance recorded then', () => {
    expect(liquidBalanceOn(account, '2026-09-20')).toBe(9000);
  });

  test('an older current account (amount + updateDate) and an undated one', () => {
    expect(liquidBalanceOn({ amount: 500, updateDate: '2026-01-01', deposits: [{ date: '2026-02-01', amount: 50 }] }, '2026-03-01')).toBe(550);
    expect(liquidBalanceOn({ amount: 500, deposits: [] }, '2026-03-01')).toBe(500);
    expect(liquidBalanceOn({ amount: 500 }, '2026-03-01')).toBe(500);
  });
});
