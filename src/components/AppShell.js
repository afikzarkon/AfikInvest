import React from 'react';
import SideNav from './SideNav';
import AccountRail from './AccountRail';
import { useMediaQuery } from '../hooks/useMediaQuery';

// Matches the breakpoint in App.css where the sidebar becomes a bottom bar.
export const COMPACT_SHELL_QUERY = '(max-width: 960px)';

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
// On a phone the account controls (theme, profile, settings, sign-out)
// leave the nav for their own column on the left edge (AccountRail.js), so
// the bottom bar holds only the pages. One or the other is rendered, never
// both, so each control exists once on the page.
function AppShell({ activePage, onNavigate, user, onLogout, theme, onToggleTheme, badges, displayName, avatar, isAdmin = false, hiddenRoutes, children }) {
  const compact = useMediaQuery(COMPACT_SHELL_QUERY);
  return (
    <div className={`app-shell ${compact && user ? 'has-account-rail' : ''}`}>
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
        showAccount={!compact}
      />
      {compact && (
        <AccountRail
          user={user}
          displayName={displayName}
          avatar={avatar}
          theme={theme}
          onToggleTheme={onToggleTheme}
          activePage={activePage}
          onNavigate={onNavigate}
          onLogout={onLogout}
          isAdmin={isAdmin}
        />
      )}
      <main className="app-main">
        <div className="app-main-inner">{children}</div>
      </main>
    </div>
  );
}

export default AppShell;
