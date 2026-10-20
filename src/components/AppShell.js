import React from 'react';
import SideNav from './SideNav';
import { useCompactLayout } from '../hooks/useMediaQuery';

// The application frame: navigation on one side, the page on the other.
//
// Every authenticated page renders through this, so the nav is mounted
// once and doesn't rebuild on navigation, and every page inherits the same
// max-width, gutters and scroll behaviour instead of each setting its own.
//
// RTL is handled by the document's `direction: rtl` plus logical CSS
// properties in the layout - the sidebar sits on the right without a
// mirrored stylesheet.
//
// On a phone the account controls (theme, profile, settings, sign-out) sit
// at the top of the bottom bar's "עוד" sheet. They used to have a column of
// their own on the left edge, which took 60px of a 390px screen from every
// page to hold four buttons used a few times a month.
function AppShell({ activePage, onNavigate, user, onLogout, theme, onToggleTheme, badges, displayName, avatar, isAdmin = false, hiddenRoutes, children }) {
  const compact = useCompactLayout();
  return (
    <div className="app-shell">
      <SideNav
        activePage={activePage}
        onNavigate={onNavigate}
        user={user}
        onLogout={onLogout}
        theme={theme}
        onToggleTheme={onToggleTheme}
        badges={badges}
        displayName={displayName}
        avatar={avatar}
        isAdmin={isAdmin}
        hiddenRoutes={hiddenRoutes}
        compact={compact}
      />
      <main className="app-main">
        <div className="app-main-inner">{children}</div>
      </main>
    </div>
  );
}

export default AppShell;
