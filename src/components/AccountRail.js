import React, { useEffect, useRef, useState } from 'react';
import Avatar from './ui/Avatar';

// The account controls on a phone: a narrow column pinned to the physical
// LEFT edge of the screen (not the logical start, which under RTL would be
// the right), holding the profile, settings, the theme switch and sign-out.
//
// On a phone these used to share the bottom bar with the page links and
// took room from them. Moved here, the bottom bar holds only the pages and
// the content sits beside this column (App.css, "ACCOUNT RAIL"). On the
// desktop SideNav keeps them in its footer and this is not rendered -
// AppShell picks one or the other.
//
// Every control is a 44px square, the minimum comfortable touch target.

const ICON_PROPS = {
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: '1.8',
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  'aria-hidden': 'true'
};

const GearIcon = () => (
  <svg className="account-rail-icon" {...ICON_PROPS}>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z" />
  </svg>
);

const LogoutIcon = () => (
  <svg className="account-rail-icon" {...ICON_PROPS}>
    <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
    <path d="m16 17 5-5-5-5" />
    <path d="M21 12H9" />
  </svg>
);

const AdminIcon = () => (
  <svg className="account-rail-icon" {...ICON_PROPS}>
    <path d="M12 3 4 6v6c0 4.5 3.4 8.3 8 9 4.6-.7 8-4.5 8-9V6l-8-3Z" />
    <path d="m9 12 2 2 4-4" />
  </svg>
);

const MoonIcon = () => (
  <svg className="account-rail-theme-icon" {...ICON_PROPS}>
    <path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z" />
  </svg>
);

const SunIcon = () => (
  <svg className="account-rail-theme-icon" {...ICON_PROPS}>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2v2m0 16v2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M2 12h2m16 0h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
  </svg>
);

function AccountRail({ user, displayName = '', avatar = null, theme, onToggleTheme, activePage, onNavigate, onLogout, isAdmin = false }) {
  const [profileOpen, setProfileOpen] = useState(false);
  const rootRef = useRef(null);
  const isDark = theme === 'dark';
  const themeLabel = isDark ? 'עבור למצב בהיר' : 'עבור למצב כהה';
  const settingsActive = ['settings', 'security'].includes(activePage);
  const name = displayName || (user ? user.email : '');

  // The name card closes on a tap anywhere else, on Escape, and on leaving
  // the page it was opened on.
  useEffect(() => {
    if (!profileOpen) return undefined;
    const onPointer = (event) => {
      if (rootRef.current && !rootRef.current.contains(event.target)) setProfileOpen(false);
    };
    const onKey = (event) => {
      if (event.key === 'Escape') setProfileOpen(false);
    };
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [profileOpen]);

  useEffect(() => {
    setProfileOpen(false);
  }, [activePage]);

  if (!user) return null;

  return (
    <aside className="account-rail" aria-label="חשבון" ref={rootRef}>
      <div className="account-rail-profile">
        <button
          type="button"
          className="account-rail-button account-rail-avatar"
          onClick={() => setProfileOpen((open) => !open)}
          aria-expanded={profileOpen}
          aria-controls="account-rail-card"
          aria-label={`פרופיל: ${name}`}
        >
          <Avatar src={avatar} name={name} size={32} />
        </button>
        {profileOpen && (
          <div className="account-rail-card" id="account-rail-card" role="dialog" aria-label="פרטי החשבון">
            {displayName ? <span className="account-rail-card-name">{displayName}</span> : null}
            <span className="account-rail-card-email">{user.email}</span>
          </div>
        )}
      </div>

      <button
        type="button"
        className={`account-rail-button ${settingsActive ? 'is-active' : ''}`}
        onClick={() => onNavigate('settings')}
        aria-current={settingsActive ? 'page' : undefined}
        aria-label="הגדרות"
        title="הגדרות"
      >
        <GearIcon />
      </button>

      {isAdmin && (
        <button
          type="button"
          className={`account-rail-button ${activePage === 'admin' ? 'is-active' : ''}`}
          onClick={() => onNavigate('admin')}
          aria-current={activePage === 'admin' ? 'page' : undefined}
          aria-label="ניהול"
          title="ניהול"
        >
          <AdminIcon />
        </button>
      )}

      {/* A vertical two-position switch: both icons always visible, the lit
          one is the current theme - the same reasoning as
          ThemeToggleButton, turned on its side to fit the column. */}
      <button
        type="button"
        className="account-rail-theme"
        data-state={isDark ? 'dark' : 'light'}
        onClick={onToggleTheme}
        aria-label={themeLabel}
        aria-pressed={!isDark}
        title={themeLabel}
      >
        <span className="account-rail-theme-thumb" aria-hidden="true" />
        <MoonIcon />
        <SunIcon />
      </button>

      <button type="button" className="account-rail-button account-rail-logout" onClick={onLogout} aria-label="התנתקות" title="התנתקות">
        <LogoutIcon />
      </button>
    </aside>
  );
}

export default AccountRail;
