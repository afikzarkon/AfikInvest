// Which emails a user wants, and the signed opt-out link every non-security
// email carries.
//
// The preferences live in user_preferences under 'notifications' (the
// settings page edits them). An opt-out link needs no sign-in: it names the
// user and the category and carries an HMAC of the two, so it cannot be
// forged for anyone else or another category. Security emails (sign-in
// links, verification, password and address changes) have no opt-out.
const crypto = require('crypto');

const CATEGORIES = ['product_updates', 'weekly_summary', 'monthly_summary', 'price_alerts', 'reminders'];

// Nothing promotional without consent; product updates follow the
// marketing consent given at sign-up.
const DEFAULT_PREFERENCES = {
  product_updates: false,
  weekly_summary: false,
  monthly_summary: false,
  price_alerts: false,
  reminders: true
};

function signingKey() {
  const { getJwtSecret } = require('./authRoutes');
  return crypto.createHash('sha256').update(`${getJwtSecret()}:unsubscribe`).digest();
}

const sign = (userId, category) =>
  crypto.createHmac('sha256', signingKey()).update(`${Number(userId)}.${category}`).digest('base64url').slice(0, 32);

// category: one of CATEGORIES, or 'all'.
function verifyUnsubscribe(userId, category, signature) {
  if (!(CATEGORIES.includes(category) || category === 'all')) return false;
  const expected = Buffer.from(sign(userId, category));
  const given = Buffer.from(String(signature || ''));
  return expected.length === given.length && crypto.timingSafeEqual(expected, given);
}

const query = (userId, category) => `u=${Number(userId)}&c=${encodeURIComponent(category)}&s=${sign(userId, category)}`;

// The page a person lands on from the email's footer link.
function unsubscribeUrlFor(userId, category) {
  const { getAppUrl } = require('./emailService');
  const appUrl = getAppUrl();
  return appUrl ? `${appUrl}/unsubscribe?${query(userId, category)}` : '';
}

// The address mail clients POST to for one-click unsubscribe (RFC 8058) -
// the API itself, so only when its public address is configured.
function oneClickUrlFor(userId, category) {
  const api = String(process.env.API_PUBLIC_URL || '').trim().replace(/\/+$/, '');
  return api ? `${api}/api/email/unsubscribe?${query(userId, category)}` : '';
}

// Stored preferences over the defaults, unknown keys dropped.
function normalizePreferences(value) {
  const out = { ...DEFAULT_PREFERENCES };
  if (value && typeof value === 'object') {
    CATEGORIES.forEach((c) => {
      if (typeof value[c] === 'boolean') out[c] = value[c];
    });
  }
  return out;
}

module.exports = { CATEGORIES, DEFAULT_PREFERENCES, verifyUnsubscribe, unsubscribeUrlFor, oneClickUrlFor, normalizePreferences };
