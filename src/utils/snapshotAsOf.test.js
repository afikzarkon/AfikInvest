import {
  asOfRange,
  defaultAsOfDate,
  isValidAsOfDate,
  liquidItemsAtDate,
  composeAsOfBreakdown,
  pensionStatementStatus
} from './snapshotAsOf';

describe('as-of range', () => {
  test('inside the month and never in the future', () => {
    expect(asOfRange('2026-08', '2026-10-12')).toEqual({ min: '2026-08-01', max: '2026-08-31' });
    expect(asOfRange('2026-10', '2026-10-12')).toEqual({ min: '2026-10-01', max: '2026-10-12' });
    expect(asOfRange('2026-11', '2026-10-12')).toBeNull();
    expect(defaultAsOfDate('2026-08', '2026-10-12')).toBe('2026-08-31');
    expect(isValidAsOfDate('2026-08', '2026-08-06', '2026-10-12')).toBe(true);
    expect(isValidAsOfDate('2026-08', '2026-09-01', '2026-10-12')).toBe(false);
    expect(isValidAsOfDate('2026-10', '2026-10-13', '2026-10-12')).toBe(false);
  });
});

describe('liquid balances on the as-of date', () => {
  const bank = { id: 1, currentValue: 10000, currentValueDate: '2026-08-01', deposits: [{ date: '2026-08-03', amount: -2000 }, { date: '2026-08-20', amount: 5000 }] };
  test('the recorded balance plus the ledger movements up to that day, and none after it', () => {
    expect(liquidItemsAtDate({ bankBalances: [bank] }, '2026-08-06').bank).toEqual([{ key: 'bank-1', label: 'עו"ש', value: 8000 }]);
    expect(liquidItemsAtDate({ bankBalances: [bank] }, '2026-08-31').bank[0].value).toBe(13000);
  });
  test('an account opened after the date is left out', () => {
    const later = { id: 2, fundName: 'כספית', currentValue: 500, currentValueDate: '2026-09-01', deposits: [] };
    expect(liquidItemsAtDate({ cashFunds: [later] }, '2026-08-06').cashFunds).toEqual([]);
  });
});

describe('composeAsOfBreakdown', () => {
  const live = { israeli: [{ key: 'A', label: 'A', value: 1 }], american: [], pension: [], cashFunds: [], bank: [], bankSavings: [] };
  test("today: the live figures with the liquid accounts synced", () => {
    const bank = { id: 1, amount: 100, currentValue: 100, currentValueDate: '2026-10-01', deposits: [{ date: '2026-10-05', amount: 50 }] };
    const b = composeAsOfBreakdown({ asOfDate: '2026-10-12', today: '2026-10-12', liveBreakdown: live, holdings: { bankBalances: [bank] } });
    expect(b.israeli).toBe(live.israeli);
    expect(b.bank[0].value).toBe(150);
  });
  test('an earlier day: the historical breakdown for that day, or null until it is available', () => {
    const hist = jest.fn(() => ({ israeli: [{ key: 'A', label: 'A', value: 7 }], american: [], pension: [], cashFunds: [], bank: [], bankSavings: [] }));
    const b = composeAsOfBreakdown({ asOfDate: '2026-08-06', today: '2026-10-12', liveBreakdown: live, historicalBreakdownAtDate: hist });
    expect(hist).toHaveBeenCalledWith('2026-08-06');
    expect(b.israeli[0].value).toBe(7);
    const empty = () => ({ israeli: [], american: [], pension: [], cashFunds: [], bank: [], bankSavings: [] });
    expect(composeAsOfBreakdown({ asOfDate: '2026-08-06', today: '2026-10-12', historicalBreakdownAtDate: empty })).toBeNull();
  });
});

describe('pensionStatementStatus', () => {
  const fund = { previousValue: 90, previousValueDate: '2026-06-30', currentValue: 100, currentValueDate: '2026-08-31' };
  test('a statement within the tolerance matches; otherwise it is earlier or later than the date', () => {
    expect(pensionStatementStatus(fund, '2026-09-05')).toMatchObject({ status: 'match', statementDate: '2026-08-31', days: -5 });
    expect(pensionStatementStatus(fund, '2026-10-12')).toMatchObject({ status: 'earlier', statementDate: '2026-08-31' });
    expect(pensionStatementStatus(fund, '2026-08-01')).toMatchObject({ status: 'later', statementDate: '2026-08-31', days: 30 });
    expect(pensionStatementStatus({ deposits: [] }, '2026-08-01')).toMatchObject({ status: 'none' });
  });
});
