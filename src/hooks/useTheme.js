// Site-wide dark/light theme, applied via a data-theme attribute on <html>
// so App.css's CSS custom properties (the :root / :root[data-theme='light']
// blocks) drive every surface, border and shadow in the app from one place.
//
// RESOLUTION ORDER
//   1. an explicit choice the user made here, persisted in localStorage;
//   2. otherwise the operating system's own setting (prefers-color-scheme);
//   3. otherwise dark.
//
// The distinction between (1) and (2) is the point: storing a resolved
// theme on first load would silently freeze whatever the OS happened to be
// set to at that moment and stop following it afterwards. Only a deliberate
// toggle is written, so a user who has never touched the button keeps
// tracking their system - including when it flips on a day/night schedule,
// which the listener below picks up live without a reload.
//
// The matching pre-paint bootstrap in public/index.html applies the same
// resolution before React loads, so the first paint is already correct and
// the page never flashes the wrong theme.

import { useCallback, useEffect, useState } from 'react';

const STORAGE_KEY = 'afikinvest_theme';
const DARK_QUERY = '(prefers-color-scheme: dark)';

function readStoredTheme() {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored === 'light' || stored === 'dark' ? stored : null;
  } catch {
    // Private mode / blocked storage: no stored preference is a valid
    // answer, not an error - we fall through to the OS setting.
    return null;
  }
}

function readSystemTheme() {
  try {
    if (typeof window.matchMedia !== 'function') return 'dark';
    return window.matchMedia(DARK_QUERY).matches ? 'dark' : 'light';
  } catch {
    return 'dark';
  }
}

export function resolveInitialTheme() {
  return readStoredTheme() || readSystemTheme();
}

export function useTheme() {
  const [theme, setTheme] = useState(resolveInitialTheme);
  // Whether the current theme came from a deliberate toggle. Only an
  // explicit choice is persisted and only an implicit one follows the OS.
  const [isExplicit, setIsExplicit] = useState(() => readStoredTheme() !== null);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
  }, [theme]);

  // Follow the OS while the user hasn't expressed a preference of their own.
  useEffect(() => {
    if (isExplicit) return undefined;
    if (typeof window.matchMedia !== 'function') return undefined;

    const query = window.matchMedia(DARK_QUERY);
    const onChange = (event) => setTheme(event.matches ? 'dark' : 'light');

    // Safari below 14 only has the deprecated addListener/removeListener.
    if (typeof query.addEventListener === 'function') {
      query.addEventListener('change', onChange);
      return () => query.removeEventListener('change', onChange);
    }
    if (typeof query.addListener === 'function') {
      query.addListener(onChange);
      return () => query.removeListener(onChange);
    }
    return undefined;
  }, [isExplicit]);

  const applyTheme = useCallback((next) => {
    setTheme(next);
    setIsExplicit(true);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      /* ignore - the theme just won't persist across reloads */
    }
  }, []);

  const toggleTheme = useCallback(() => {
    setTheme((prev) => {
      const next = prev === 'dark' ? 'light' : 'dark';
      setIsExplicit(true);
      try {
        localStorage.setItem(STORAGE_KEY, next);
      } catch {
        /* ignore */
      }
      return next;
    });
  }, []);

  // Drops the stored choice and goes back to following the OS.
  const useSystemTheme = useCallback(() => {
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      /* ignore */
    }
    setIsExplicit(false);
    setTheme(readSystemTheme());
  }, []);

  return { theme, toggleTheme, setTheme: applyTheme, useSystemTheme, isExplicit };
}
