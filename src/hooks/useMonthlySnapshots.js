// Monthly portfolio-value checkpoints - a deliberate, separate action from
// the daily snapshots in usePortfolioSnapshots.js (see
// server/monthlySnapshotRoutes.js for why). Same fetch-on-mount + exposed
// save-action shape as that hook.

import { useCallback, useEffect, useState } from 'react';
import { apiUrl } from '../apiBase';

export function useMonthlySnapshots(user, authHeader) {
  const [monthlySnapshots, setMonthlySnapshots] = useState([]);
  const [monthlySnapshotsLoading, setMonthlySnapshotsLoading] = useState(false);
  // See usePortfolioSnapshots.js's snapshotsLoaded - the same guard, and it
  // matters more here: the monthly save is an upsert, so saving against a
  // list that simply hadn't arrived yet REPLACED the month the user had
  // already saved, cash-flow declarations included.
  const [monthlySnapshotsLoaded, setMonthlySnapshotsLoaded] = useState(false);
  const [savingMonthly, setSavingMonthly] = useState(false);
  const [saveMonthlyError, setSaveMonthlyError] = useState('');
  const [updatingMonth, setUpdatingMonth] = useState(null);
  const [updateMonthlyError, setUpdateMonthlyError] = useState('');
  const [deletingMonth, setDeletingMonth] = useState(null);
  const [deleteMonthlyError, setDeleteMonthlyError] = useState('');
  const [addingManual, setAddingManual] = useState(false);
  const [addManualError, setAddManualError] = useState('');

  // authHeader() is a fresh function reference every render (see
  // usePortfolioSnapshots.js's identical comment) - must not be a dependency.
  const fetchMonthlySnapshots = useCallback(async () => {
    if (!user) {
      setMonthlySnapshots([]);
      setMonthlySnapshotsLoaded(false);
      return;
    }
    setMonthlySnapshotsLoading(true);
    try {
      const r = await fetch(apiUrl('/api/portfolio-monthly-snapshots'), {
        credentials: 'include',
        headers: { ...authHeader() }
      });
      if (!r.ok) throw new Error('load failed');
      const d = await r.json();
      setMonthlySnapshots(Array.isArray(d.snapshots) ? d.snapshots : []);
      setMonthlySnapshotsLoaded(true);
    } catch {
      // Keep whatever we had before; a failed refresh shouldn't wipe the
      // history table the user is already looking at.
    } finally {
      setMonthlySnapshotsLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  useEffect(() => {
    fetchMonthlySnapshots();
  }, [fetchMonthlySnapshots]);

  const saveMonthlySnapshot = useCallback(
    async (totalValueILS, breakdown) => {
      if (!user || !user.id) return;
      if (!Number.isFinite(totalValueILS) || totalValueILS <= 0) return;
      setSavingMonthly(true);
      setSaveMonthlyError('');
      try {
        const r = await fetch(apiUrl('/api/portfolio-monthly-snapshot'), {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json', ...authHeader() },
          body: JSON.stringify({ totalValueILS, breakdown: breakdown || undefined })
        });
        if (!r.ok) throw new Error('save failed');
        await fetchMonthlySnapshots();
      } catch {
        setSaveMonthlyError('שמירת השמירה החודשית נכשלה, נסה שוב');
      } finally {
        setSavingMonthly(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [user, fetchMonthlySnapshots]
  );

  // Corrects a month that was already saved (used by the "ערוך"/"שמור
  // עריכה" flow in PortfolioAnalysisView.js's history table) - never
  // creates a new month (see the server route's comment). Returns whether
  // it succeeded so the caller can decide whether to exit edit mode.
  const updateMonthlySnapshot = useCallback(
    async (month, totalValueILS, breakdown) => {
      if (!user || !user.id) return false;
      if (!Number.isFinite(totalValueILS) || totalValueILS < 0) return false;
      setUpdatingMonth(month);
      setUpdateMonthlyError('');
      try {
        const r = await fetch(apiUrl(`/api/portfolio-monthly-snapshot/${encodeURIComponent(month)}`), {
          method: 'PUT',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json', ...authHeader() },
          body: JSON.stringify({ totalValueILS, breakdown })
        });
        if (!r.ok) throw new Error('update failed');
        await fetchMonthlySnapshots();
        return true;
      } catch {
        setUpdateMonthlyError('עדכון השמירה החודשית נכשל, נסה שוב');
        return false;
      } finally {
        setUpdatingMonth(null);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [user, fetchMonthlySnapshots]
  );

  // Permanently removes a specific saved month (used by the "מחק" button in
  // PortfolioAnalysisView.js's history section). Returns whether it
  // succeeded so the caller can drop any selection pointing at the
  // now-deleted month.
  const deleteMonthlySnapshot = useCallback(
    async (month) => {
      if (!user || !user.id) return false;
      setDeletingMonth(month);
      setDeleteMonthlyError('');
      try {
        const r = await fetch(apiUrl(`/api/portfolio-monthly-snapshot/${encodeURIComponent(month)}`), {
          method: 'DELETE',
          credentials: 'include',
          headers: { ...authHeader() }
        });
        if (!r.ok) throw new Error('delete failed');
        await fetchMonthlySnapshots();
        return true;
      } catch {
        setDeleteMonthlyError('מחיקת השמירה החודשית נכשלה, נסה שוב');
        return false;
      } finally {
        setDeletingMonth(null);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [user, fetchMonthlySnapshots]
  );

  // Deliberately backfills a specific past month the user forgot to save
  // (the "➕ הוספה ידנית" flow in PortfolioAnalysisView.js) - unlike
  // saveMonthlySnapshot (always "now"), the month here is chosen by the
  // user. Returns whether it succeeded so the caller can close the form.
  const addManualMonthlySnapshot = useCallback(
    async (month, totalValueILS, breakdown) => {
      if (!user || !user.id) return false;
      if (!Number.isFinite(totalValueILS) || totalValueILS < 0) return false;
      setAddingManual(true);
      setAddManualError('');
      try {
        const r = await fetch(apiUrl('/api/portfolio-monthly-snapshot/manual'), {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json', ...authHeader() },
          body: JSON.stringify({ month, totalValueILS, breakdown })
        });
        if (!r.ok) throw new Error('add failed');
        await fetchMonthlySnapshots();
        return true;
      } catch {
        setAddManualError('הוספת השמירה החודשית נכשלה, נסה שוב');
        return false;
      } finally {
        setAddingManual(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [user, fetchMonthlySnapshots]
  );

  return {
    monthlySnapshots,
    monthlySnapshotsLoading,
    monthlySnapshotsLoaded,
    saveMonthlySnapshot,
    savingMonthly,
    saveMonthlyError,
    updateMonthlySnapshot,
    updatingMonth,
    updateMonthlyError,
    deleteMonthlySnapshot,
    deletingMonth,
    deleteMonthlyError,
    addManualMonthlySnapshot,
    addingManual,
    addManualError
  };
}
