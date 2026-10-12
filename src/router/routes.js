// The app's route table - the single place a page's path, its nav label and
// its icon are declared.
//
// Everything else derives from this: the sidebar builds its groups from
// NAV_GROUPS below, App.js switches on `key`, and useRoute maps the
// browser's path back to a key. Adding a page means adding one row here
// plus its branch in App.js, not touching four files.
export const ROUTES = [
  { key: 'home', path: '/', label: 'דף הבית', hint: 'סיכום התיק', icon: 'home' },
  {
    key: 'israeli-stocks',
    path: '/israeli-stocks',
    label: 'בורסה ישראלית',
    hint: 'מניות וקרנות בת"א',
    icon: 'israel'
  },
  {
    key: 'us-stocks',
    path: '/us-stocks',
    label: 'בורסה אמריקאית',
    hint: 'מניות בוול סטריט',
    icon: 'usa'
  },
  {
    key: 'provident-funds',
    path: '/provident-funds',
    label: 'קופות גמל להשקעה',
    hint: 'הפקדות ושווי',
    icon: 'vault'
  },
  {
    key: 'cash-and-checking',
    path: '/cash-and-checking',
    label: 'כספית שקלית ועו"ש',
    hint: 'נזילות שוטפת',
    icon: 'wallet'
  },
  {
    key: 'bank-savings',
    path: '/bank-savings',
    label: 'קופת חיסכון בבנק',
    hint: 'פיקדונות וחיסכון',
    icon: 'piggy'
  },
  {
    key: 'monthly-tracker',
    path: '/monthly-tracker',
    label: 'מעקב חודשי',
    hint: 'צילומי מצב חודשיים',
    icon: 'calendar'
  },
  {
    key: 'tax-offset',
    path: '/tax-offset',
    label: 'הזדמנות לקיזוז מס',
    hint: 'מימוש הפסדים',
    icon: 'tax'
  },
  {
    key: 'alerts',
    path: '/alerts',
    label: 'התראות',
    hint: 'תנועות חריגות ולוח אירועים',
    icon: 'bell'
  },
  {
    key: 'reports',
    path: '/reports',
    label: 'דוחות חודשיים',
    hint: 'עדכון חודשי ודוח PDF',
    icon: 'report'
  },
  {
    key: 'valuation',
    path: '/valuation',
    label: 'הערכת שווי',
    hint: 'מכפילים ו-DCF',
    icon: 'scale'
  },
  {
    key: 'recommendations',
    path: '/recommendations',
    label: 'המלצות',
    hint: 'איזון, מימוש וקיזוז מס',
    icon: 'compass'
  },
  {
    key: 'transactions',
    path: '/transactions',
    label: 'עסקאות',
    hint: 'מכירות, דיבידנדים ומשיכות',
    icon: 'ledger'
  },
  {
    key: 'analytics',
    path: '/analytics',
    label: 'ניתוח תיק',
    hint: 'ביצועים ופיזור',
    icon: 'analysis'
  },
  // Reachable from the "+ הוספת מידע" action rather than the sidebar, but a
  // real route all the same so the form survives a refresh and the browser's
  // back button leaves it the way it leaves any other page.
  { key: 'add', path: '/add', label: 'הוספת מידע', hint: 'הוספה ועריכה', icon: 'home', hidden: true }
];

// The sidebar's visible structure. Grouped rather than one flat list of
// eleven items: the asset pages are a set the user scans together, and
// separating them from the overview and the tools keeps each group short
// enough to read at a glance.
export const NAV_GROUPS = [
  { label: 'סקירה', keys: ['home', 'analytics', 'alerts', 'monthly-tracker', 'reports'] },
  {
    label: 'נכסים',
    keys: ['israeli-stocks', 'us-stocks', 'provident-funds', 'cash-and-checking', 'bank-savings']
  },
  { label: 'כלים', keys: ['recommendations', 'valuation', 'transactions', 'tax-offset'] }
];

const BY_KEY = ROUTES.reduce((acc, route) => ({ ...acc, [route.key]: route }), {});

export function routeByKey(key) {
  return BY_KEY[key] || BY_KEY.home;
}

export function pathForKey(key) {
  return routeByKey(key).path;
}

// The browser's path back to a route key.
//
// Trailing slashes and a sub-path under a route both resolve to that route
// rather than 404-ing, and anything unrecognised falls back to home - a
// stale bookmark should land somewhere useful, not on a blank page.
export function keyForPath(pathname) {
  const clean = String(pathname || '/').replace(/\/+$/, '') || '/';
  const exact = ROUTES.find((route) => route.path === clean);
  if (exact) return exact.key;
  const prefixed = ROUTES.find((route) => route.path !== '/' && clean.startsWith(`${route.path}/`));
  return prefixed ? prefixed.key : 'home';
}
