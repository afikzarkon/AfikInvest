import React from 'react';
import SideNav from './SideNav';

// The application frame: navigation on one side, the page on the other.
//
// Every authenticated page renders through this, so the nav is mounted
// once and doesn't rebuild on navigation, and every page inherits the same
// max-width, gutters and scroll behaviour instead of each setting its own.
//
// RTL is handled by the document's `direction: rtl` plus logical CSS
// properties in the layout - the sidebar sits on the right without a
// mirrored stylesheet.
function AppShell({ activePage, onNavigate, user, onLogout, theme, onToggleTheme, badges, children }) {
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
      />
      <main className="app-main">
        <div className="app-main-inner">{children}</div>
      </main>
    </div>
  );
}

export default AppShell;
