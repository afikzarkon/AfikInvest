// Feature flags: the parts of the site an admin can switch on and off while
// it runs, without a deploy. Shared by the server (server/adminStore.js,
// which stores them and enforces them on the API) and the client
// (hooks/useFeatureFlags.js, which hides what is off).
//
// A flag has one of three states:
//   off   - hidden from everyone;
//   admin - visible to admins only, to try a feature on the live site
//           before releasing it;
//   all   - visible to everyone.
//
// FLAG_DEFINITIONS are the flags the code checks. Each is created in the
// database on startup in its default state if it is not there yet; from
// then on the database holds its state and the admin panel changes it.
// An admin can also add flags of their own in the panel, for code that is
// about to check them.

const FLAG_STATES = ['off', 'admin', 'all'];

const FLAG_KEY_PATTERN = /^[a-z][a-z0-9-]{1,48}$/;

// `route`: the page (router/routes.js) the flag shows or hides.
const FLAG_DEFINITIONS = [
  { key: 'valuation', route: 'valuation', defaultState: 'all', description: 'דף הערכת שווי - מכפילים ו-DCF (כולל ה-API שלו)' },
  { key: 'alerts', route: 'alerts', defaultState: 'all', description: 'דף ההתראות ולוח האירועים (כולל ה-API שלו)' },
  { key: 'recommendations', route: 'recommendations', defaultState: 'all', description: 'דף ההמלצות - איזון, מימוש וקיזוז' },
  { key: 'tax-offset', route: 'tax-offset', defaultState: 'all', description: 'דף הזדמנות לקיזוז מס' },
  { key: 'analytics', route: 'analytics', defaultState: 'all', description: 'דף ניתוח התיק' }
];

function isFlagState(value) {
  return FLAG_STATES.includes(value);
}

// Whether a flag in `state` is on for a user who is (or is not) an admin.
function flagVisibleTo(state, isAdmin) {
  if (state === 'all') return true;
  if (state === 'admin') return Boolean(isAdmin);
  return false;
}

// The flag states before the database has answered: each defined flag's
// default. (No object spread here: see sharedModules.test.js.)
function defaultFlagStates() {
  const states = {};
  FLAG_DEFINITIONS.forEach((flag) => {
    states[flag.key] = flag.defaultState;
  });
  return states;
}

exports.FLAG_STATES = FLAG_STATES;
exports.FLAG_KEY_PATTERN = FLAG_KEY_PATTERN;
exports.FLAG_DEFINITIONS = FLAG_DEFINITIONS;
exports.isFlagState = isFlagState;
exports.flagVisibleTo = flagVisibleTo;
exports.defaultFlagStates = defaultFlagStates;
