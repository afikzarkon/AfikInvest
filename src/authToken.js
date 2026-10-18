const AUTH_TOKEN_KEY = 'afikinvest_auth_token';

export function getAuthToken() {
  try {
    return localStorage.getItem(AUTH_TOKEN_KEY) || '';
  } catch {
    return '';
  }
}

export function setAuthToken(token) {
  try {
    if (!token) return;
    localStorage.setItem(AUTH_TOKEN_KEY, String(token));
  } catch {
    /* ignore storage errors */
  }
}

export function clearAuthToken() {
  try {
    localStorage.removeItem(AUTH_TOKEN_KEY);
  } catch {
    /* ignore storage errors */
  }
}
