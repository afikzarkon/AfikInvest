// The session token this browser holds beside the httpOnly cookie (for the
// API calls that send it as a Bearer header).
//
// "Remember me": a remembered sign-in keeps it in localStorage, across
// browser restarts; otherwise it lives in sessionStorage and ends with the
// browser, like the server's cookie for that session.
const AUTH_TOKEN_KEY = 'afikinvest_auth_token';

const safe = (fn, fallback) => {
  try {
    return fn();
  } catch {
    return fallback;
  }
};

export function getAuthToken() {
  return safe(() => localStorage.getItem(AUTH_TOKEN_KEY), '') || safe(() => sessionStorage.getItem(AUTH_TOKEN_KEY), '') || '';
}

export function setAuthToken(token, { remember } = {}) {
  if (!token) return;
  // Without a choice, keep it where the current one lives.
  const keep = remember === undefined ? safe(() => sessionStorage.getItem(AUTH_TOKEN_KEY), null) === null : remember;
  safe(() => (keep ? sessionStorage : localStorage).removeItem(AUTH_TOKEN_KEY));
  safe(() => (keep ? localStorage : sessionStorage).setItem(AUTH_TOKEN_KEY, String(token)));
}

export function clearAuthToken() {
  safe(() => localStorage.removeItem(AUTH_TOKEN_KEY));
  safe(() => sessionStorage.removeItem(AUTH_TOKEN_KEY));
}
