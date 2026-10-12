// Portfolio value history: lists the saved history (for the equity curve,
// max drawdown, real volatility/Sharpe, benchmark comparison on the
// analysis view), and exposes a manual save action.
//
// Saving USED to be automatic (fired as soon as a non-zero total value was
// computed, once per calendar day) - changed to manual-only, triggered by
// a dedicated button (see HomeView.js), because the automatic version
// could fire before live prices had finished loading, capturing a
// snapshot from a stale/incomplete render rather than the real current
// value. saveSnapshotNow takes totalValueILS/breakdown as call-time
// arguments (not reactive hook params) specifically so it captures
// whatever's current at the moment of the click, not a stale closure.

import { useCallback, useEffect, useState } from 'react';
import { apiUrl } from '../apiBase';

export function usePortfolioSnapshots(user, authHeader) {
  const [snapshots, setSnapshots] = useState([]);
  const [snapshotsLoading, setSnapshotsLoading] = useState(false);
  // True once the list has come back from the server at least once. Until
  // then an empty array means "not known yet", not "nothing saved" - see
  // useAutoSnapshot.js, which must not save over a list it hasn't seen.
  const [snapshotsLoaded, setSnapshotsLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [lastSavedAt, setLastSavedAt] = useState(null);

  // authHeader() is a fresh function reference on every render of useAuth()
  // (same as in usePortfolioData) - it must NOT be a dependency here, or
  // this callback (and the effect that runs it) would be recreated every
  // render, causing an infinite fetch loop.
  const fetchSnapshots = useCallback(async () => {
    if (!user) {
      setSnapshots([]);
      setSnapshotsLoaded(false);
      return;
    }
    setSnapshotsLoading(true);
    try {
      const r = await fetch(apiUrl('/api/portfolio-snapshots'), {
        credentials: 'include',
        headers: { ...authHeader() }
      });
      if (!r.ok) throw new Error('load failed');
      const d = await r.json();
      setSnapshots(Array.isArray(d.snapshots) ? d.snapshots : []);
      setSnapshotsLoaded(true);
    } catch {
      // Keep whatever we had before; a failed refresh shouldn't wipe the
      // chart the user is already looking at.
    } finally {
      setSnapshotsLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  useEffect(() => {
    fetchSnapshots();
  }, [fetchSnapshots]);

  const saveSnapshotNow = useCallback(
    async (totalValueILS, breakdown) => {
      if (!user || !user.id) return;
      if (!Number.isFinite(totalValueILS) || totalValueILS <= 0) return;
      setSaving(true);
      setSaveError('');
      try {
        const r = await fetch(apiUrl('/api/portfolio-snapshot'), {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json', ...authHeader() },
          body: JSON.stringify({ totalValueILS, breakdown: breakdown || undefined })
        });
        if (!r.ok) throw new Error('save failed');
        setLastSavedAt(new Date());
        await fetchSnapshots();
      } catch {
        setSaveError('שמירת תמונת המצב נכשלה, נסה שוב');
      } finally {
        setSaving(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [user, fetchSnapshots]
  );

  return { snapshots, snapshotsLoading, snapshotsLoaded, saveSnapshotNow, saving, saveError, lastSavedAt, refetchSnapshots: fetchSnapshots };
}
