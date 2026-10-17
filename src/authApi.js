// JSON POST to the auth API, shared by the login, reset and 2FA screens.
// Never throws for an HTTP error - callers branch on `ok` - only for a
// network failure.
import { apiUrl } from './apiBase';

export async function postAuth(path, body, headers = {}) {
  const res = await fetch(apiUrl(path), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    credentials: 'include',
    body: JSON.stringify(body || {})
  });
  const ct = res.headers.get('content-type') || '';
  const isJson = ct.includes('application/json');
  const data = isJson ? await res.json().catch(() => ({})) : {};
  return { ok: res.ok, status: res.status, data, isJson };
}
