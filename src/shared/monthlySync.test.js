const {
  targetMonthFor,
  isUpdatedForMonth,
  evaluateSyncStatus,
  syncFingerprint,
  nextSyncState,
  previousMonth,
  nextMonth,
  monthEnd
} = require('./monthlySync');

test('month helpers', () => {
  expect(previousMonth('2026-01')).toBe('2025-12');
  expect(nextMonth('2026-12')).toBe('2027-01');
  expect(monthEnd('2024-02')).toBe('2024-02-29');
});

test('the target month: previous month during the first 10 days', () => {
  expect(targetMonthFor('2026-09-05')).toBe('2026-08');
  expect(targetMonthFor('2026-09-10')).toBe('2026-08');
  expect(targetMonthFor('2026-09-11')).toBe('2026-09');
  expect(targetMonthFor('2026-01-03')).toBe('2025-12');
});

test('updated for a month: inside it, or in the first 10 days after', () => {
  expect(isUpdatedForMonth('2026-08-31', '2026-08')).toBe(true);
  expect(isUpdatedForMonth('2026-09-10', '2026-08')).toBe(true);
  expect(isUpdatedForMonth('2026-09-11', '2026-08')).toBe(false);
  expect(isUpdatedForMonth('2026-07-31', '2026-08')).toBe(false);
  expect(isUpdatedForMonth(null, '2026-08')).toBe(false);
});

const portfolio = {
  pensionFunds: [
    { id: 1, fundName: 'גמל', currentValue: 1000, currentValueDate: '2026-09-02' },
    { id: 2, fundName: 'השתלמות', currentValue: 500, currentValueDate: '2026-07-01' }
  ],
  cashFunds: [{ id: 3, fundName: 'כספית', amount: 0 }],
  bankBalances: [{ id: 4, amount: 300, updateDate: '2026-08-20' }],
  bankSavingsFunds: [{ id: 5, deposits: [{ date: '2025-01-01', amount: 100 }] }]
};

test('required accounts: non-zero manual accounts; bank savings never required', () => {
  const s = evaluateSyncStatus(portfolio, '2026-08');
  expect(s.accounts.map((a) => [a.key, a.updated])).toEqual([
    ['pension:1', true],
    ['pension:2', false],
    ['bank:4', true]
  ]);
  expect(s).toMatchObject({ updatedCount: 2, allUpdated: false, anyUpdated: true });
});

test('excluding the stale account completes the month', () => {
  const s = evaluateSyncStatus(portfolio, '2026-08', { excluded: ['pension:2'] });
  expect(s.allUpdated).toBe(true);
  expect(s.accounts.find((a) => a.key === 'pension:2').excluded).toBe(true);
  expect(evaluateSyncStatus({}, '2026-08').allUpdated).toBe(false); // nothing to wait for is not "complete"
});

test('state machine and fingerprint', () => {
  const s = evaluateSyncStatus(portfolio, '2026-08');
  expect(nextSyncState('OPEN', s)).toBe('IN_PROGRESS');
  expect(nextSyncState('OPEN', evaluateSyncStatus(portfolio, '2026-08', { excluded: ['pension:2'] }))).toBe('COMPLETE');
  expect(nextSyncState('COMPLETE', evaluateSyncStatus({}, '2026-08'))).toBe('COMPLETE');
  expect(nextSyncState('OPEN', evaluateSyncStatus({}, '2026-08'))).toBe('OPEN');
  const a = syncFingerprint(s);
  const changed = JSON.parse(JSON.stringify(portfolio));
  changed.pensionFunds[0].currentValue = 1001;
  expect(syncFingerprint(evaluateSyncStatus(changed, '2026-08'))).not.toBe(a);
  expect(syncFingerprint(evaluateSyncStatus(portfolio, '2026-08'))).toBe(a);
});
