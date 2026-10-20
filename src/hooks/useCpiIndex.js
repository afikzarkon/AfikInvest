import { useEffect, useState } from 'react';
import { marketFetch } from '../api/marketFetch';

// שולף את "המדד הידוע" העדכני ביותר, ואת ערכי המדד לכל החודשים
// הרלוונטיים לתיק (תאריכי קניית מניות, תאריכי הפקדות לקופות גמל).
//
// מחזיר { currentIndex, indexByMonth, loading, error } כדי שקוד שקורא
// לפונקציה יוכל להציג נפילה חזרה (fallback) לחישוב הישן כל עוד המדד
// עדיין לא נטען או שהמשיכה נכשלה - כדי שהאפליקציה לעולם לא "תישבר"
// בגלל תקלה במקור חיצוני.
//
// TWO REQUESTS, TWO EFFECTS - deliberately not one.
//
// The two calls answer unrelated questions: "what is the latest published
// index" does not depend on the portfolio at all, while "what was the
// index in each of these months" depends on exactly which months the
// holdings span. They used to share one effect keyed on the month list,
// which meant the month list changing re-fetched BOTH.
//
// That happens on every single page load, because the month list is empty
// on the first render and fills in once the portfolio arrives from the
// server - so /api/cpi/latest was requested twice per load on every page
// of the app, the second time to re-fetch a value that could not have
// changed. Splitting them makes the latest index a mount-once fetch.
//
// `enabled`: the CPI routes are for signed-in users (marketDataAccess.js),
// and App mounts this before sign-in - so the latest index is fetched once
// there is a user, not on mount.
export function useCpiIndex(monthKeys, { enabled = true } = {}) {
  const [latest, setLatest] = useState({ currentIndex: null, currentIndexMonth: null, loading: true, error: null });
  const [months, setMonths] = useState({ indexByMonth: {}, loading: true });

  // A stable identity for the month list. `monthKeys` is rebuilt on every
  // render by the caller, so depending on the array itself would re-fetch
  // on every render; depending on its sorted, de-duplicated contents
  // re-fetches only when those contents actually differ.
  const monthKeysKey = JSON.stringify([...new Set((monthKeys || []).filter(Boolean))].sort());

  // The latest published index: once per mount (once enabled). The CPI is
  // published monthly, so re-reading it mid-session cannot return anything new.
  useEffect(() => {
    if (!enabled) return undefined;
    let cancelled = false;
    (async () => {
      try {
        const res = await marketFetch('/api/cpi/latest');
        const data = res.ok ? await res.json() : null;
        if (cancelled) return;
        setLatest({
          currentIndex: data ? data.value : null,
          currentIndexMonth: data ? data.month : null,
          loading: false,
          error: data ? null : 'לא ניתן היה למשוך את מדד המחירים לצרכן'
        });
      } catch (err) {
        if (cancelled) return;
        setLatest((prev) => ({ ...prev, loading: false, error: err.message || 'שגיאה במשיכת המדד' }));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [enabled]);

  // The per-month values: re-fetched whenever the set of months the
  // portfolio spans actually changes.
  useEffect(() => {
    let cancelled = false;
    const uniqueMonths = JSON.parse(monthKeysKey);

    if (uniqueMonths.length === 0) {
      setMonths({ indexByMonth: {}, loading: false });
      return undefined;
    }

    (async () => {
      setMonths((prev) => ({ ...prev, loading: true }));
      try {
        const res = await marketFetch('/api/cpi/months', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ months: uniqueMonths })
        });
        const map = res.ok ? await res.json() : {};
        if (cancelled) return;
        setMonths({ indexByMonth: map || {}, loading: false });
      } catch {
        if (cancelled) return;
        // The per-month lookup failing is not fatal: the callers fall back
        // to the un-indexed calculation, and the error surfaced to the UI
        // is the one from the latest-index fetch above.
        setMonths((prev) => ({ ...prev, loading: false }));
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [monthKeysKey]);

  return {
    currentIndex: latest.currentIndex,
    currentIndexMonth: latest.currentIndexMonth,
    indexByMonth: months.indexByMonth,
    loading: latest.loading || months.loading,
    error: latest.error
  };
}
