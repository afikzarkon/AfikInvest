// fetch() for the market-data routes (prices, search, history, sectors,
// valuation...). The server serves them to signed-in users only
// (server/marketDataAccess.js), so every call carries the session: the
// cookie, and the Bearer token for browsers that drop a cross-site cookie.
import { apiUrl } from '../apiBase';
import { authHeaders } from '../accountApi';

export function marketFetch(path, init = {}) {
  return fetch(apiUrl(path), {
    ...init,
    credentials: 'include',
    headers: { ...(init.headers || {}), ...authHeaders() }
  });
}
