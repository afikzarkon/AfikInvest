// Authentication state: current user, session-check on mount, logout.
// Extracted from App.js — behavior is unchanged, only the location moved.

import { useEffect, useState } from 'react';
import { apiUrl } from '../apiBase';
import { clearAuthToken, getAuthToken, setAuthToken } from '../authToken';

export function useAuth() {
  const [user, setUser] = useState(null);
  const [authLoading, setAuthLoading] = useState(true);

  const authHeader = () => {
    const token = getAuthToken();
    return token ? { Authorization: `Bearer ${token}` } : {};
  };

  // Check for an existing session on mount
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch(apiUrl('/api/auth/me'), {
          credentials: 'include',
          headers: { ...authHeader() }
        });
        const d = await r.json();
        if (!cancelled) setUser(d.user || null);
      } catch {
        if (!cancelled) setUser(null);
      } finally {
        if (!cancelled) setAuthLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Called by AuthView once login/signup succeeds
  const login = (authenticatedUser, token) => {
    if (token) setAuthToken(token);
    setUser(authenticatedUser);
  };

  // The same signed-in user with changed flags (2FA turned on or off, a
  // password set) - from the settings page. Every data hook reloads when
  // `user` becomes a different object (they depend on [user]), so the
  // object is updated in place rather than replaced: the flags change, the
  // portfolio is not fetched again, and the open settings page keeps its
  // place. A different user is a real sign-in and goes through login().
  const [, rerender] = useState(0);
  const updateUser = (changedUser) => {
    if (!changedUser) return;
    if (user && user.id === changedUser.id) {
      Object.assign(user, changedUser);
      rerender((n) => n + 1);
    } else {
      setUser(changedUser);
    }
  };

  // Logs out on the server and clears local auth state.
  // Does NOT touch portfolio data — the caller is responsible for that
  // (see usePortfolioData's resetPortfolio), since useAuth shouldn't know
  // about portfolio concerns.
  const logout = async () => {
    try {
      await fetch(apiUrl('/api/auth/logout'), {
        method: 'POST',
        credentials: 'include',
        headers: { ...authHeader() }
      });
    } catch {
      /* ignore */
    }
    clearAuthToken();
    setUser(null);
  };

  return { user, authLoading, authHeader, login, logout, updateUser };
}
