// fetch() for the market-data routes (prices, search, history, sectors,
// valuation...). The routes are open, so no Authorization header is sent:
// on a cross-origin API (front end and API on different hosts) that header
// would make every GET a non-simple request, costing a CORS preflight
// round trip before each one. The cookie still goes along.
import { apiUrl } from '../apiBase';

export function marketFetch(path, init = {}) {
  return fetch(apiUrl(path), { ...init, credentials: 'include' });
}
