/**
 * בפיתוח (ללא משתנה): נתיבים יחסיים /api → פרוקסי ל-localhost:5000.
 * ב-Vercel: הגדר REACT_APP_API_URL לכתובת השרת (בלי / בסוף), למשל https://api.afikinvest.com
 */
export function getApiBase() {
  const base = process.env.REACT_APP_API_URL || '';
  return String(base).replace(/\/$/, '');
}

export function apiUrl(path) {
  const p = path.startsWith('/') ? path : `/${path}`;
  return `${getApiBase()}${p}`;
}
