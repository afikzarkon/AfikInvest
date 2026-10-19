import React, { useCallback, useState } from 'react';

// Cards or the full table, on a phone. Cards by default; "טבלה מלאה" shows
// the desktop table as it is, for anyone who would rather scroll it. The
// choice is remembered on this device, for every holdings page.
const KEY = 'afikinvest_holdings_view';

function readView() {
  try {
    return localStorage.getItem(KEY) === 'table' ? 'table' : 'cards';
  } catch {
    return 'cards';
  }
}

export function useHoldingsView() {
  const [view, setViewState] = useState(readView);
  const setView = useCallback((next) => {
    setViewState(next);
    try {
      localStorage.setItem(KEY, next);
    } catch {
      /* this visit only */
    }
  }, []);
  return [view, setView];
}

export function HoldingsViewToggle({ view, onChange }) {
  return (
    <div className="hv-toggle" role="group" aria-label="תצוגה">
      <button type="button" className={view === 'cards' ? 'active' : ''} aria-pressed={view === 'cards'} onClick={() => onChange('cards')}>
        כרטיסים
      </button>
      <button type="button" className={view === 'table' ? 'active' : ''} aria-pressed={view === 'table'} onClick={() => onChange('table')}>
        טבלה מלאה
      </button>
    </div>
  );
}
