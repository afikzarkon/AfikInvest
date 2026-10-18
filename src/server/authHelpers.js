// Building blocks shared by the auth, account and sign-in-provider routes:
// what a request says about where it came from, one-time tokens and codes,
// input validation (zod, Hebrew messages), and the three checks a new
// password or address goes through - disposable domains, passwords seen in
// breaches (HaveIBeenPwned, k-anonymity) and the bot challenge (Cloudflare
// Turnstile).
const crypto = require('crypto');
const { z } = require('zod');
const disposableDomains = require('disposable-email-domains');

const DISPOSABLE = new Set(disposableDomains);
const HTTP_TIMEOUT_MS = 3000;

// ---------------------------------------------------------------------------
// The request

// The client's address with its last part cut off (an IPv4 /24, an IPv6
// /48): enough to tell "same place as usual" from "somewhere new" in the
// security log, without storing anyone's exact address.
function ipPrefix(ip) {
  const raw = String(ip || '').replace(/^::ffff:/, '');
  if (/^\d+\.\d+\.\d+\.\d+$/.test(raw)) return raw.replace(/\.\d+$/, '.0');
  if (raw.includes(':')) return `${raw.split(':').slice(0, 3).join(':')}::`;
  return '';
}

// A country only when a proxy in front of the server says so (Cloudflare,
// Vercel); nothing is looked up.
function countryOf(req) {
  const value = req.get('cf-ipcountry') || req.get('x-vercel-ip-country') || '';
  return /^[A-Z]{2}$/.test(value) ? value : '';
}

function requestContext(req) {
  return { ipPrefix: ipPrefix(req.ip), userAgent: String(req.get('user-agent') || '').slice(0, 400), country: countryOf(req) };
}

// "Chrome · Windows" from a user agent - for the device list, not security.
function describeDevice(userAgent) {
  const ua = String(userAgent || '');
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /SamsungBrowser/.test(ua)
      ? 'Samsung Internet'
      : /OPR\/|Opera/.test(ua)
        ? 'Opera'
        : /Firefox\//.test(ua)
          ? 'Firefox'
          : /Chrome\//.test(ua)
            ? 'Chrome'
            : /Safari\//.test(ua)
              ? 'Safari'
              : '';
  const os = /iPhone|iPad|iPod/.test(ua)
    ? 'iOS'
    : /Android/.test(ua)
      ? 'Android'
      : /Windows/.test(ua)
        ? 'Windows'
        : /Mac OS X|Macintosh/.test(ua)
          ? 'macOS'
          : /Linux/.test(ua)
            ? 'Linux'
            : '';
  const mobile = /Mobile|iPhone|Android/.test(ua);
  return { browser: browser || 'דפדפן לא מזוהה', os: os || 'מערכת לא מזוהה', mobile };
}

// ---------------------------------------------------------------------------
// Tokens and codes

const randomToken = () => crypto.randomBytes(32).toString('base64url');
const hashToken = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');

// A 6-digit code, uniformly random.
const randomCode = () => String(crypto.randomInt(0, 1000000)).padStart(6, '0');

// Compares two strings in constant time.
function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// "d***@example.com" - for the security log and notices.
function maskEmail(email) {
  const [local, domain] = String(email || '').split('@');
  if (!domain) return '';
  return `${local.slice(0, 1)}***@${domain}`;
}

// ---------------------------------------------------------------------------
// Validation

const PASSWORD_MIN = 8;
const PASSWORD_MAX = 128;
// bcrypt reads only the first 72 bytes.
const PASSWORD_MAX_BYTES = 72;
const TERMS_VERSION = '2026-10b';

const emailSchema = z
  .string({ error: 'יש להזין כתובת אימייל' })
  .trim()
  .toLowerCase()
  .max(254, 'כתובת האימייל ארוכה מדי')
  .pipe(z.email('כתובת אימייל לא תקינה'));

const passwordSchema = z
  .string({ error: 'יש להזין סיסמה' })
  .min(PASSWORD_MIN, `הסיסמה חייבת להכיל לפחות ${PASSWORD_MIN} תווים`)
  .max(PASSWORD_MAX, 'הסיסמה ארוכה מדי')
  .refine((p) => Buffer.byteLength(p, 'utf8') <= PASSWORD_MAX_BYTES, 'הסיסמה ארוכה מדי');

const optionalText = (max) =>
  z
    .string()
    .trim()
    .max(max, `עד ${max} תווים`)
    .optional();

const signupSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
  fullName: optionalText(80),
  acceptTerms: z.literal(true, { error: 'יש לאשר את תנאי השימוש ומדיניות הפרטיות' }),
  marketingOptIn: z.boolean().optional(),
  referralCode: z
    .string()
    .trim()
    .max(40)
    .regex(/^[A-Za-z0-9_-]*$/, 'קוד הזמנה יכול להכיל אותיות באנגלית, ספרות, מקף וקו תחתון')
    .optional(),
  remember: z.boolean().optional(),
  turnstileToken: z.string().max(4096).optional(),
  // The honeypot: a field people never see. Checked by the route, not here.
  website: z.string().max(500).optional()
});

const isValidDate = (s) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
};

let TIME_ZONES = null;
const timeZones = () => {
  if (!TIME_ZONES) {
    try {
      TIME_ZONES = new Set(Intl.supportedValuesOf('timeZone'));
    } catch {
      TIME_ZONES = new Set(['Asia/Jerusalem', 'UTC']);
    }
    TIME_ZONES.add('UTC');
  }
  return TIME_ZONES;
};

// Every field optional; '' clears it.
const profileSchema = z
  .object({
    firstName: optionalText(60),
    lastName: optionalText(60),
    displayName: optionalText(60),
    phone: z
      .string()
      .trim()
      .refine((p) => p === '' || /^\+?[0-9][0-9\s-]{5,19}$/.test(p), 'מספר טלפון לא תקין')
      .optional(),
    birthDate: z
      .string()
      .trim()
      .refine((d) => d === '' || (isValidDate(d) && d >= '1900-01-01' && d <= new Date().toISOString().slice(0, 10)), 'תאריך לא תקין')
      .optional(),
    country: z
      .string()
      .trim()
      .toUpperCase()
      .refine((c) => c === '' || /^[A-Z]{2}$/.test(c), 'מדינה לא תקינה')
      .optional(),
    timezone: z
      .string()
      .trim()
      .refine((t) => t === '' || timeZones().has(t), 'אזור זמן לא תקין')
      .optional()
  })
  .strict();

// { ok, data } or { ok: false, error, fieldErrors } with Hebrew messages.
function validate(schema, input) {
  const result = schema.safeParse(input === undefined || input === null ? {} : input);
  if (result.success) return { ok: true, data: result.data };
  const fieldErrors = {};
  result.error.issues.forEach((issue) => {
    const key = issue.path.length ? String(issue.path[0]) : '_';
    if (!fieldErrors[key]) fieldErrors[key] = issue.message;
  });
  return { ok: false, error: Object.values(fieldErrors)[0] || 'הקלט אינו תקין', fieldErrors };
}

// ---------------------------------------------------------------------------
// Checks

// The address's domain, or any domain above it, on the disposable list.
function isDisposableEmail(email) {
  const domain = String(email || '').split('@')[1] || '';
  const parts = domain.toLowerCase().split('.');
  for (let i = 0; i < parts.length - 1; i += 1) {
    if (DISPOSABLE.has(parts.slice(i).join('.'))) return true;
  }
  return false;
}

// fetchImpl defaults to the global fetch, looked up when called (CRA's Jest
// environment has none; tests pass their own).
const defaultFetch = (...args) => fetch(...args);

function withTimeout(promise, ms) {
  return Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms))]);
}

// How many times the password appears in known breaches, by the
// k-anonymity range API: only the first 5 hex characters of its SHA-1 leave
// the server. null when the service could not be reached - the caller lets
// the password through rather than blocking sign-up on an outside service.
async function pwnedCount(password, { fetchImpl = defaultFetch } = {}) {
  if (process.env.HIBP_DISABLED === '1') return null;
  const sha1 = crypto.createHash('sha1').update(String(password), 'utf8').digest('hex').toUpperCase();
  const prefix = sha1.slice(0, 5);
  const suffix = sha1.slice(5);
  try {
    const res = await withTimeout(
      fetchImpl(`https://api.pwnedpasswords.com/range/${prefix}`, { headers: { 'Add-Padding': 'true', 'User-Agent': 'afikinvest-app' } }),
      HTTP_TIMEOUT_MS
    );
    if (!res.ok) return null;
    const body = await res.text();
    for (const line of body.split('\n')) {
      const [hashSuffix, count] = line.trim().split(':');
      if (hashSuffix === suffix) return Number(count) || 0;
    }
    return 0;
  } catch {
    return null;
  }
}

const PWNED_MESSAGE = 'הסיסמה הזו הופיעה בדליפות מידע ידועות ולכן אינה בטוחה. בחרו סיסמה אחרת.';

// Cloudflare Turnstile. Off (always passes) until TURNSTILE_SECRET_KEY is
// set, so local development and the tests need no keys.
async function verifyTurnstile(token, remoteIp, { fetchImpl = defaultFetch } = {}) {
  const secret = process.env.TURNSTILE_SECRET_KEY;
  if (!secret) return true;
  if (!token) return false;
  try {
    const res = await withTimeout(
      fetchImpl('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ secret, response: String(token), remoteip: String(remoteIp || '') }).toString()
      }),
      HTTP_TIMEOUT_MS
    );
    const data = await res.json();
    return Boolean(data && data.success);
  } catch {
    // An outage at Cloudflare should not stop every sign-up; the rate
    // limits still apply.
    return true;
  }
}

module.exports = {
  ipPrefix,
  requestContext,
  describeDevice,
  randomToken,
  hashToken,
  randomCode,
  safeEqual,
  maskEmail,
  emailSchema,
  passwordSchema,
  signupSchema,
  profileSchema,
  validate,
  isDisposableEmail,
  pwnedCount,
  PWNED_MESSAGE,
  verifyTurnstile,
  TERMS_VERSION,
  PASSWORD_MIN,
  PASSWORD_MAX_BYTES
};
