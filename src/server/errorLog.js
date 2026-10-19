// Server errors for the admin panel. Every route already reports its
// failures through console.error; this wraps it once, so each of those is
// also kept in the database (server_errors, adminStore.js) without touching
// a single route. The console output itself is unchanged.
//
// Before anything is written it is scrubbed: email addresses, JWTs and
// long token-like strings become placeholders, so the panel never shows an
// address or a usable credential that happened to be in a message.
// Capped at MAX_PER_MINUTE writes, so a failure in a loop cannot flood the
// table; rows older than 30 days are pruned as new ones arrive.

const MAX_PER_MINUTE = 30;
const PRUNE_EVERY = 50;

const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const JWT = /eyJ[\w-]+\.[\w-]+\.[\w-]+/g;
const LONG_TOKEN = /\b[A-Za-z0-9_-]{32,}\b/g;

function scrub(text) {
  return String(text).replace(JWT, '[jwt]').replace(EMAIL, '[email]').replace(LONG_TOKEN, '[token]');
}

function formatArg(arg) {
  if (arg instanceof Error) return arg.stack || arg.message;
  if (typeof arg === 'string') return arg;
  try {
    return JSON.stringify(arg);
  } catch {
    return String(arg);
  }
}

// admin: adminStore (insertError, pruneErrors). Returns uninstall().
function installErrorCapture(admin, { target = console } = {}) {
  const original = target.error;
  // Writes go one after another; a failed write is dropped silently (never
  // logged, so it cannot record itself).
  let queue = Promise.resolve();
  let windowStart = Date.now();
  let inWindow = 0;
  let sincePrune = 0;

  target.error = function captured(...args) {
    original.apply(target, args);
    const now = Date.now();
    if (now - windowStart > 60 * 1000) {
      windowStart = now;
      inWindow = 0;
    }
    if (inWindow >= MAX_PER_MINUTE) return;
    inWindow += 1;

    const parts = args.map(formatArg);
    const label = scrub(parts[0] || 'error').split('\n')[0];
    const detail = scrub(parts.join(' '));
    queue = queue
      .then(() => admin.insertError(label, detail))
      .then(() => {
        sincePrune += 1;
        if (sincePrune >= PRUNE_EVERY) {
          sincePrune = 0;
          return admin.pruneErrors();
        }
        return null;
      })
      .catch(() => {});
  };

  return () => {
    target.error = original;
  };
}

module.exports = { installErrorCapture, scrub };
