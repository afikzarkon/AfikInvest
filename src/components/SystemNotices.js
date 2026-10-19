import React, { useState } from 'react';
import ThemeToggleButton from './ThemeToggleButton';

// What the admin panel's "system" tab sets, as the user sees it
// (hooks/useSystemStatus.js).

const DISMISS_KEY = 'afikinvest_banner_dismissed';

function readDismissed() {
  try {
    return sessionStorage.getItem(DISMISS_KEY) || '';
  } catch {
    return '';
  }
}

// The banner across the top of every screen, signed in or not. An info or
// warning banner can be closed for the rest of the visit (a new banner
// shows again); a critical one stays.
export function SystemBanner({ banner }) {
  const [dismissed, setDismissed] = useState(readDismissed);
  if (!banner || !banner.text) return null;
  const level = ['info', 'warning', 'critical'].includes(banner.level) ? banner.level : 'info';
  const id = `${banner.id}|${banner.text}`;
  if (level !== 'critical' && dismissed === id) return null;

  const dismiss = () => {
    setDismissed(id);
    try {
      sessionStorage.setItem(DISMISS_KEY, id);
    } catch {
      /* ignore - it closes for this view only */
    }
  };

  return (
    <div className={`system-banner is-${level}`} role={level === 'critical' ? 'alert' : 'status'}>
      <span className="system-banner-text">{banner.text}</span>
      {level !== 'critical' && (
        <button type="button" className="system-banner-close" onClick={dismiss} aria-label="סגירת ההודעה">
          ×
        </button>
      )}
    </div>
  );
}

// In place of the app while maintenance mode is on, for everyone but an
// admin. The server already answers 503; this says why, and keeps sign-out
// and the theme reachable.
export function MaintenanceScreen({ message, onLogout, theme, onToggleTheme }) {
  return (
    <div className="App">
      <div className="auth-theme-toggle-wrap">
        <ThemeToggleButton theme={theme} onToggleTheme={onToggleTheme} />
      </div>
      <main className="maintenance-screen">
        <div className="maintenance-card">
          <div className="maintenance-icon" aria-hidden="true">
            🛠️
          </div>
          <h1>האתר בתחזוקה</h1>
          <p>{message || 'אנחנו משדרגים את המערכת. הנתונים שלכם שמורים, ונחזור בקרוב.'}</p>
          {onLogout ? (
            <button type="button" className="benchmark-toggle-button" onClick={onLogout}>
              התנתקות
            </button>
          ) : null}
        </div>
      </main>
    </div>
  );
}
