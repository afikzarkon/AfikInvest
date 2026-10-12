// Silent automatic portfolio-value snapshot - replaces the old manual
// "שמור מידע יומי עדכני" button entirely. Fires at most once per mount,
// and only after usePriceRefresh.js signals that a full price-refresh
// cycle has actually completed (firstCycleComplete) - not on raw page
// load, where the displayed value is still whatever was last persisted
// rather than freshly confirmed live. This is exactly the problem that
// got the ORIGINAL always-on auto-save reverted to manual-only (see
// usePortfolioSnapshots.js's header comment) - waiting for a real
// completed cycle is what makes bringing it back safe.
//
// De-duplication is derived from the already-fetched snapshots/
// monthlySnapshots arrays (the real source of truth), not localStorage -
// so it works correctly across devices/browsers, not just the one that
// happened to save first - which is why it waits for both lists to have
// actually loaded. A daily snapshot is skipped if today's date is
// already present; a monthly snapshot is only ever taken once per
// calendar month (the first time the app is opened that month), so
// month-over-month comparison keeps meaning "value as of whichever day
// the app was first opened that month" instead of being overwritten
// every single day.
import { useEffect, useRef } from 'react';
import { todayISO } from '../utils/portfolioDates';

// Israel's calendar, same as the server's (see utils/portfolioDates.js).
function todayDateString() {
  return todayISO();
}

function currentMonthString() {
  return todayISO().slice(0, 7);
}

export function useAutoSnapshot({
  firstCycleComplete,
  totalValueILS,
  breakdown,
  snapshots,
  saveSnapshotNow,
  monthlySnapshots,
  saveMonthlySnapshot,
  // Whether each list has actually arrived from the server. An empty list
  // before then means "unknown", and deciding "this month isn't saved yet"
  // from it would overwrite a month that is (the monthly save is an
  // upsert). Default true so a caller that already awaits the lists itself
  // needn't pass them.
  snapshotsLoaded = true,
  monthlySnapshotsLoaded = true
}) {
  const firedRef = useRef(false);

  useEffect(() => {
    if (!firstCycleComplete || firedRef.current) return;
    if (!snapshotsLoaded || !monthlySnapshotsLoaded) return;
    if (!Number.isFinite(totalValueILS) || totalValueILS <= 0) return;
    firedRef.current = true;

    const today = todayDateString();
    const alreadySavedToday = Array.isArray(snapshots) && snapshots.some((s) => s.date === today);
    if (!alreadySavedToday) saveSnapshotNow(totalValueILS, breakdown);

    // Judged on its own, not only when the daily save fires: a month whose
    // first save failed (or was taken by a device whose daily save
    // succeeded and monthly one didn't) used to stay missing for the rest of
    // the month, because "today already saved" skipped this check too.
    const currentMonth = currentMonthString();
    const hasCurrentMonth = Array.isArray(monthlySnapshots) && monthlySnapshots.some((m) => m.month === currentMonth);
    if (!hasCurrentMonth) {
      saveMonthlySnapshot(totalValueILS, breakdown);
    }
  }, [
    firstCycleComplete,
    snapshotsLoaded,
    monthlySnapshotsLoaded,
    totalValueILS,
    breakdown,
    snapshots,
    saveSnapshotNow,
    monthlySnapshots,
    saveMonthlySnapshot
  ]);
}
