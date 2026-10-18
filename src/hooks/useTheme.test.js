import { act, renderHook } from '@testing-library/react';
import { useTheme, resolveInitialTheme } from './useTheme';

const STORAGE_KEY = 'afikinvest_theme';

// A controllable matchMedia, so the OS preference can be set and changed
// the way a real system day/night switch would.
function mockMatchMedia(prefersDark, { legacyApi = false } = {}) {
  const listeners = new Set();
  const mql = {
    matches: prefersDark,
    media: '(prefers-color-scheme: dark)',
    addEventListener: legacyApi ? undefined : (_, fn) => listeners.add(fn),
    removeEventListener: legacyApi ? undefined : (_, fn) => listeners.delete(fn),
    addListener: legacyApi ? (fn) => listeners.add(fn) : undefined,
    removeListener: legacyApi ? (fn) => listeners.delete(fn) : undefined,
    _emit(matches) {
      mql.matches = matches;
      listeners.forEach((fn) => fn({ matches }));
    },
    _listenerCount: () => listeners.size
  };
  window.matchMedia = jest.fn().mockReturnValue(mql);
  return mql;
}

describe('useTheme', () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute('data-theme');
  });

  afterEach(() => {
    delete window.matchMedia;
  });

  test('follows the OS preference when the user has never chosen', () => {
    mockMatchMedia(false); // OS is light
    const { result } = renderHook(() => useTheme());
    expect(result.current.theme).toBe('light');
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
  });

  test('a stored explicit choice wins over the OS preference', () => {
    localStorage.setItem(STORAGE_KEY, 'dark');
    mockMatchMedia(false); // OS is light, but the user asked for dark
    const { result } = renderHook(() => useTheme());
    expect(result.current.theme).toBe('dark');
  });

  // The important distinction: storing a resolved theme on first load would
  // freeze whatever the OS happened to be at that moment and stop following
  // it. Only a deliberate toggle is persisted.
  test('does not persist anything until the user actually toggles', () => {
    mockMatchMedia(true);
    const { result } = renderHook(() => useTheme());

    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
    expect(result.current.isExplicit).toBe(false);

    act(() => result.current.toggleTheme());

    expect(localStorage.getItem(STORAGE_KEY)).toBe('light');
    expect(result.current.isExplicit).toBe(true);
  });

  test('keeps following the OS live while no explicit choice has been made', () => {
    const mql = mockMatchMedia(true);
    const { result } = renderHook(() => useTheme());
    expect(result.current.theme).toBe('dark');

    // The OS flips on its own day/night schedule - no reload involved.
    act(() => mql._emit(false));
    expect(result.current.theme).toBe('light');
  });

  test('stops following the OS once the user has chosen for themselves', () => {
    const mql = mockMatchMedia(true);
    const { result } = renderHook(() => useTheme());

    act(() => result.current.toggleTheme()); // -> light, explicit
    expect(result.current.theme).toBe('light');

    act(() => mql._emit(true)); // OS goes dark; the user's choice stands
    expect(result.current.theme).toBe('light');
  });

  test('useSystemTheme drops the stored choice and resumes following the OS', () => {
    const mql = mockMatchMedia(false);
    const { result } = renderHook(() => useTheme());

    act(() => result.current.toggleTheme()); // explicit dark
    expect(localStorage.getItem(STORAGE_KEY)).toBe('dark');

    act(() => result.current.useSystemTheme());
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
    expect(result.current.theme).toBe('light');

    act(() => mql._emit(true));
    expect(result.current.theme).toBe('dark');
  });

  test('applies the theme to the document element so the CSS token layer can react', () => {
    mockMatchMedia(true);
    const { result } = renderHook(() => useTheme());
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');

    act(() => result.current.toggleTheme());
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
  });

  // Safari below 14 only has addListener/removeListener.
  test('supports the deprecated matchMedia listener API', () => {
    const mql = mockMatchMedia(true, { legacyApi: true });
    const { result, unmount } = renderHook(() => useTheme());

    act(() => mql._emit(false));
    expect(result.current.theme).toBe('light');

    unmount();
    expect(mql._listenerCount()).toBe(0);
  });

  test('falls back to dark when neither storage nor matchMedia is available', () => {
    delete window.matchMedia;
    const getItem = jest.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });

    expect(resolveInitialTheme()).toBe('dark');

    getItem.mockRestore();
  });

  test('a blocked localStorage does not stop the theme from being applied', () => {
    mockMatchMedia(false);
    const setItem = jest.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });

    const { result } = renderHook(() => useTheme());
    act(() => result.current.toggleTheme());

    expect(result.current.theme).toBe('dark');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');

    setItem.mockRestore();
  });
});
