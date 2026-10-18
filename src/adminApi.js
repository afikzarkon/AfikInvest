// The admin panel's calls (server/adminRoutes.js). Each returns the parsed
// body, or throws an Error carrying the server's message - the panel shows
// it as is. The server checks the admin role on every one of these.
import { apiUrl } from './apiBase';
import { getAuthToken } from './authToken';

async function call(path, { method = 'GET', body } = {}) {
  const token = getAuthToken();
  const res = await fetch(apiUrl(path), {
    method,
    credentials: 'include',
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'שגיאה');
  return data;
}

export const listFlags = () => call('/api/admin/flags').then((d) => d.flags);
export const createFlag = (flag) => call('/api/admin/flags', { method: 'POST', body: flag }).then((d) => d.flag);
export const updateFlag = (key, patch) =>
  call(`/api/admin/flags/${encodeURIComponent(key)}`, { method: 'PATCH', body: patch }).then((d) => d.flag);
export const deleteFlag = (key) => call(`/api/admin/flags/${encodeURIComponent(key)}`, { method: 'DELETE' });
export const listAudit = (limit = 100) => call(`/api/admin/audit?limit=${limit}`).then((d) => d.entries);
