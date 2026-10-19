// The admin panel's calls (server/adminRoutes.js). Each returns the parsed
// body, or throws an Error carrying the server's message (and its `code`,
// e.g. admin_2fa_required) - the panel shows it as is. The server checks
// the admin role and 2FA on every one of these.
import { apiUrl } from './apiBase';
import { getAuthToken } from './authToken';

function headers(json) {
  const token = getAuthToken();
  return {
    ...(json ? { 'Content-Type': 'application/json' } : {}),
    ...(token ? { Authorization: `Bearer ${token}` } : {})
  };
}

async function call(path, { method = 'GET', body } = {}) {
  const res = await fetch(apiUrl(path), {
    method,
    credentials: 'include',
    headers: headers(body !== undefined),
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || 'שגיאה');
    err.code = data.code;
    throw err;
  }
  return data;
}

const enc = encodeURIComponent;

// flags
export const listFlags = () => call('/api/admin/flags').then((d) => d.flags);
export const createFlag = (flag) => call('/api/admin/flags', { method: 'POST', body: flag }).then((d) => d.flag);
export const updateFlag = (key, patch) => call(`/api/admin/flags/${enc(key)}`, { method: 'PATCH', body: patch }).then((d) => d.flag);
export const deleteFlag = (key) => call(`/api/admin/flags/${enc(key)}`, { method: 'DELETE' });

// users
export const listUsers = ({ q = '', offset = 0, limit = 50 } = {}) => call(`/api/admin/users?q=${enc(q)}&offset=${offset}&limit=${limit}`);
export const blockUser = (id, reason) => call(`/api/admin/users/${id}/block`, { method: 'POST', body: { reason } });
export const unblockUser = (id) => call(`/api/admin/users/${id}/unblock`, { method: 'POST', body: {} });
export const revokeSessions = (id) => call(`/api/admin/users/${id}/revoke-sessions`, { method: 'POST', body: {} });
export const sendPasswordReset = (id) => call(`/api/admin/users/${id}/password-reset`, { method: 'POST', body: {} });

// admins
export const listAdmins = () => call('/api/admin/admins');
export const grantAdmin = (email) => call('/api/admin/admins', { method: 'POST', body: { email } }).then((d) => d.admins);
export const revokeAdmin = (id) => call(`/api/admin/admins/${id}`, { method: 'DELETE' }).then((d) => d.admins);

// banner and maintenance
export const getSettings = () => call('/api/admin/settings');
export const saveBanner = (banner) => call('/api/admin/settings/banner', { method: 'PUT', body: banner }).then((d) => d.banner);
export const saveMaintenance = (m) => call('/api/admin/settings/maintenance', { method: 'PUT', body: m }).then((d) => d.maintenance);

// insight
export const getStats = () => call('/api/admin/stats');
export const listErrors = () => call('/api/admin/errors?limit=200').then((d) => d.errors);
export const clearErrors = () => call('/api/admin/errors', { method: 'DELETE' });
export const listJobs = (status = '') => call(`/api/admin/jobs${status ? `?status=${enc(status)}` : ''}`).then((d) => d.jobs);
export const listAudit = (limit = 100) => call(`/api/admin/audit?limit=${limit}`).then((d) => d.entries);

// Downloads one of the CSV exports (users.csv, audit.csv) as a file.
export async function downloadExport(name) {
  const res = await fetch(apiUrl(`/api/admin/export/${name}`), { credentials: 'include', headers: headers(false) });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || 'הייצוא נכשל');
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `afikinvest-${name.replace('.csv', '')}-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
