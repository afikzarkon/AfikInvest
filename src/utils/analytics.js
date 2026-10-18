// Google Analytics (the Google tag in public/index.html), behind one narrow
// door so nothing personal can reach it by accident.
//
// What is sent: which screen was opened (its route path - never the full
// address, which can carry a one-time token) and a few general usage
// events (signed in, signed up, and by which method). What is never sent:
// user ids or emails, amounts, holdings, symbols, or any free text. Event
// parameters are filtered against ALLOWED_PARAMS below, and their values
// must be short plain strings, so a number or a name typed by the user
// cannot slip through.
//
// Without the tag (blocked by the browser, tests, local builds without
// network) every call is a no-op.

const ALLOWED_PARAMS = new Set(['method', 'feature']);
const SAFE_VALUE = /^[a-z0-9_-]{1,40}$/i;

function gtagOrNull() {
  return typeof window !== 'undefined' && typeof window.gtag === 'function' ? window.gtag : null;
}

export function trackPageView(path, title) {
  const gtag = gtagOrNull();
  if (!gtag) return;
  gtag('event', 'page_view', {
    page_location: `${window.location.origin}${path}`,
    page_path: path,
    page_title: title || document.title
  });
}

export function trackEvent(name, params = {}) {
  const gtag = gtagOrNull();
  if (!gtag || !SAFE_VALUE.test(String(name))) return;
  const clean = {};
  Object.keys(params).forEach((key) => {
    const value = params[key];
    if (ALLOWED_PARAMS.has(key) && typeof value === 'string' && SAFE_VALUE.test(value)) clean[key] = value;
  });
  gtag('event', name, clean);
}
