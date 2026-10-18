// JSON calls to the account API (the settings page, onboarding, the
// sign-in flows that need a session). Like authApi.postAuth, it never
// throws for an HTTP error - callers branch on `ok` - only for a network
// failure, which it reports as { ok: false, network: true }.
import { apiUrl } from './apiBase';
import { getAuthToken } from './authToken';

export function authHeaders() {
  const token = getAuthToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export async function accountRequest(method, path, body) {
  try {
    const res = await fetch(apiUrl(path), {
      method,
      credentials: 'include',
      headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...authHeaders() },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {})
    });
    const ct = res.headers.get('content-type') || '';
    const data = ct.includes('application/json') ? await res.json().catch(() => ({})) : {};
    return { ok: res.ok, status: res.status, data };
  } catch {
    return { ok: false, status: 0, network: true, data: { error: 'לא ניתן להתחבר לשרת. בדקו את החיבור ונסו שוב.' } };
  }
}

export const getAccount = (path) => accountRequest('GET', path);
export const postAccount = (path, body = {}) => accountRequest('POST', path, body);
export const putAccount = (path, body = {}) => accountRequest('PUT', path, body);
export const deleteAccount = (path) => accountRequest('DELETE', path);

// A file download from an authenticated endpoint (the data export): fetched
// with the session, then saved through a temporary link.
export async function downloadAccountFile(path, fallbackName) {
  const res = await fetch(apiUrl(path), { credentials: 'include', headers: authHeaders() });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || 'ההורדה נכשלה');
  }
  const disposition = res.headers.get('content-disposition') || '';
  const match = /filename="([^"]+)"/.exec(disposition);
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = match ? match[1] : fallbackName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
