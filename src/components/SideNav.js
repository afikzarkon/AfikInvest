import React from 'react';
import ThemeToggleButton from './ThemeToggleButton';
import { NAV_GROUPS, ROUTES, routeByKey } from '../router/routes';

// Inline SVG rather than an icon dependency or emoji: these inherit
// currentColor, so they follow the active/inactive and theme states for
// free, and they stay crisp at any size. An emoji would be neither.
const ICONS = {
  home: <path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1v-9.5Z" />,
  analysis: <path d="M4 20V10m5 10V4m5 16v-7m5 7V8" />,
  israel: (
    <>
      <path d="m12 4 3.5 6h-7L12 4Z" />
      <path d="m12 20-3.5-6h7L12 20Z" />
    </>
  ),
  usa: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 9h18M3 15h18" />
      <path d="M12 3a14 14 0 0 0 0 18a14 14 0 0 0 0-18Z" />
    </>
  ),
  vault: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <circle cx="12" cy="12" r="4" />
      <path d="M12 8v1m0 6v1m4-4h-1m-6 0H8" />
    </>
  ),
  wallet: (
    <>
      <path d="M3 8a2 2 0 0 1 2-2h13a1 1 0 0 1 1 1v2" />
      <rect x="3" y="8" width="18" height="11" rx="2" />
      <path d="M16 13h2" />
    </>
  ),
  piggy: (
    <>
      <path d="M4 12a6 6 0 0 1 6-6h3a6 6 0 0 1 6 6v3a1 1 0 0 1-1 1h-1v2h-3v-2H9v2H6v-2.5A6 6 0 0 1 4 12Z" />
      <path d="M8 11h.01" />
      <path d="M13 6V4" />
    </>
  ),
  calendar: (
    <>
      <rect x="3" y="5" width="18" height="16" rx="2" />
      <path d="M3 10h18M8 3v4m8-4v4" />
    </>
  ),
  tax: (
    <>
      <path d="m7 17 10-10" />
      <circle cx="8" cy="8" r="2" />
      <circle cx="16" cy="16" r="2" />
    </>
  ),
  scale: (
    <>
      <path d="M12 4v16M7 20h10M5 8h14" />
      <path d="m5 8-3 6a3 3 0 0 0 6 0L5 8Zm14 0-3 6a3 3 0 0 0 6 0l-3-6Z" />
    </>
  ),
  report: (
    <>
      <path d="M7 3h7l4 4v14H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z" />
      <path d="M14 3v4h4M9 17v-3m3 3v-5m3 5v-2" />
    </>
  ),
  compass: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="m15.5 8.5-2 5-5 2 2-5 5-2Z" />
    </>
  ),
  bell: (
    <>
      <path d="M6 16V11a6 6 0 1 1 12 0v5l1.5 2h-15L6 16Z" />
      <path d="M10 20a2 2 0 0 0 4 0" />
    </>
  ),
  ledger: (
    <>
      <path d="M7 4h11a1 1 0 0 1 1 1v15H7a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Z" />
      <path d="M9 9h6m-6 4h6m-6 4h3" />
    </>
  )
};

function NavIcon({ name }) {
  return (
    <svg
      className="side-nav-icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {ICONS[name]}
    </svg>
  );
}

// Kept as a named export: the flat list of visible destinations, which the
// tests read. NAV_GROUPS is what this component actually renders.
export const NAV_ITEMS = ROUTES.filter((route) => !route.hidden);

// The app's primary navigation.
//
// A sidebar rather than a row of tabs: the nav is a fixed list that benefits
// from always being visible, and moving it out of the header frees the
// entire top edge for the CONTEXTUAL actions of whatever page is open (see
// PageToolbar). Those two things were previously competing for the same
// strip.
//
// Now that each asset class has its own page the list is long enough to need
// grouping - see NAV_GROUPS in router/routes.js for how it's split.
//
// On narrow screens it becomes a bottom bar - thumb-reachable, and it
// doesn't steal horizontal space a table needs.
// badges: { [routeKey]: count } - a count shown on that link (unread alerts).
function SideNav({ activePage, onNavigate, user, onLogout, theme, onToggleTheme, badges = {} }) {
  return (
    <nav className="side-nav" aria-label="ניווט ראשי">
      <div className="side-nav-brand">
        <span className="side-nav-mark" aria-hidden="true">
          ₪
        </span>
        <span className="side-nav-brand-text">StockView</span>
      </div>

      <div className="side-nav-scroll">
        {NAV_GROUPS.map((group) => (
          <div className="side-nav-group" key={group.label}>
            {/* Hidden from the accessibility tree rather than announced: the
                group's purpose is visual scanning, and each link already
                states where it goes. */}
            <div className="side-nav-group-label" aria-hidden="true">
              {group.label}
            </div>
            <ul className="side-nav-list">
              {group.keys.map((key) => {
                const item = routeByKey(key);
                const isActive = activePage === item.key;
                return (
                  <li key={item.key}>
                    <button
                      type="button"
                      className={`side-nav-link ${isActive ? 'active' : ''}`}
                      onClick={() => onNavigate(item.key)}
                      // The active page is a state, not just a style - a
                      // screen reader has no way to see the highlight.
                      aria-current={isActive ? 'page' : undefined}
                      title={item.hint}
                    >
                      <NavIcon name={item.icon} />
                      <span className="side-nav-label">{item.label}</span>
                      {badges[item.key] > 0 && (
                        <span className="side-nav-badge" aria-label={`${badges[item.key]} חדשות`}>
                          {badges[item.key] > 99 ? '99+' : badges[item.key]}
                        </span>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </div>

      <div className="side-nav-footer">
        <ThemeToggleButton theme={theme} onToggleTheme={onToggleTheme} />
        {user && (
          <div className="side-nav-user">
            <span className="side-nav-user-email" title={user.email}>
              {user.email}
            </span>
            <button type="button" className="side-nav-logout" onClick={onLogout}>
              התנתקות
            </button>
          </div>
        )}
      </div>
    </nav>
  );
}

export default SideNav;
