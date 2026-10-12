import { renderHook } from '@testing-library/react';
import { useAutoSnapshot } from './useAutoSnapshot';
import { todayISO } from '../utils/portfolioDates';

describe('useAutoSnapshot', () => {
  const baseProps = () => ({
    firstCycleComplete: true,
    totalValueILS: 100000,
    breakdown: { israeli: [] },
    snapshots: [],
    saveSnapshotNow: jest.fn(),
    monthlySnapshots: [],
    saveMonthlySnapshot: jest.fn()
  });

  test('does nothing until firstCycleComplete is true', () => {
    const props = { ...baseProps(), firstCycleComplete: false };
    renderHook(() => useAutoSnapshot(props));
    expect(props.saveSnapshotNow).not.toHaveBeenCalled();
  });

  test('does nothing when totalValueILS is not a positive finite number', () => {
    const props1 = { ...baseProps(), totalValueILS: 0 };
    renderHook(() => useAutoSnapshot(props1));
    expect(props1.saveSnapshotNow).not.toHaveBeenCalled();

    const props2 = { ...baseProps(), totalValueILS: NaN };
    renderHook(() => useAutoSnapshot(props2));
    expect(props2.saveSnapshotNow).not.toHaveBeenCalled();
  });

  test('saves a daily snapshot and a monthly one when neither exists yet for today/this month', () => {
    const props = baseProps();
    renderHook(() => useAutoSnapshot(props));
    expect(props.saveSnapshotNow).toHaveBeenCalledWith(100000, { israeli: [] });
    expect(props.saveMonthlySnapshot).toHaveBeenCalledWith(100000, { israeli: [] });
  });

  test('skips the daily save when a snapshot for today already exists (from another device/session)', () => {
    const today = todayISO();
    const props = {
      ...baseProps(),
      snapshots: [{ date: today, totalValueILS: 99000 }],
      monthlySnapshots: [{ month: today.slice(0, 7), totalValueILS: 99000 }]
    };
    renderHook(() => useAutoSnapshot(props));
    expect(props.saveSnapshotNow).not.toHaveBeenCalled();
    expect(props.saveMonthlySnapshot).not.toHaveBeenCalled();
  });

  // The month's save used to be skipped along with the day's, so a month
  // whose first save failed stayed missing until the next month.
  test("still saves a missing month even when today's daily snapshot already exists", () => {
    const props = { ...baseProps(), snapshots: [{ date: todayISO(), totalValueILS: 99000 }] };
    renderHook(() => useAutoSnapshot(props));
    expect(props.saveSnapshotNow).not.toHaveBeenCalled();
    expect(props.saveMonthlySnapshot).toHaveBeenCalledWith(100000, { israeli: [] });
  });

  // An empty list that hasn't come back from the server yet is "unknown",
  // not "nothing saved" - and the monthly save is an upsert, so acting on
  // it would overwrite the month the user had already saved.
  test('waits for both snapshot lists to load before deciding anything', () => {
    const props = { ...baseProps(), snapshotsLoaded: true, monthlySnapshotsLoaded: false };
    const { rerender } = renderHook((p) => useAutoSnapshot(p), { initialProps: props });
    expect(props.saveSnapshotNow).not.toHaveBeenCalled();
    expect(props.saveMonthlySnapshot).not.toHaveBeenCalled();

    const currentMonth = todayISO().slice(0, 7);
    rerender({
      ...props,
      monthlySnapshotsLoaded: true,
      monthlySnapshots: [{ month: currentMonth, totalValueILS: 95000 }]
    });
    expect(props.saveSnapshotNow).toHaveBeenCalledTimes(1);
    expect(props.saveMonthlySnapshot).not.toHaveBeenCalled();
  });

  test('saves the daily snapshot but skips the monthly one when this month is already saved', () => {
    const currentMonth = todayISO().slice(0, 7);
    const props = { ...baseProps(), monthlySnapshots: [{ month: currentMonth, totalValueILS: 95000 }] };
    renderHook(() => useAutoSnapshot(props));
    expect(props.saveSnapshotNow).toHaveBeenCalled();
    expect(props.saveMonthlySnapshot).not.toHaveBeenCalled();
  });

  test('fires at most once per mount even if the effect re-runs with the same completed cycle', () => {
    const props = baseProps();
    const { rerender } = renderHook((p) => useAutoSnapshot(p), { initialProps: props });
    expect(props.saveSnapshotNow).toHaveBeenCalledTimes(1);

    // Re-render with a slightly different (still positive) total value -
    // simulating another price-refresh tick updating the displayed total.
    rerender({ ...props, totalValueILS: 100500 });
    expect(props.saveSnapshotNow).toHaveBeenCalledTimes(1);
  });
});
