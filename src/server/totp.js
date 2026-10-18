// TOTP (RFC 6238) for two-factor login, via speakeasy + qrcode.
//
// Secrets are stored encrypted (AES-256-GCM) so a leaked database dump alone
// is not enough to generate codes. The key is TOTP_ENCRYPTION_KEY, or one
// derived from JWT_SECRET when that is not set. Changing the key makes every
// stored secret unreadable, i.e. users would have to set 2FA up again.
const crypto = require('crypto');
const speakeasy = require('speakeasy');
const QRCode = require('qrcode');

const ISSUER = 'AfikInvest';
const STEP_SECONDS = 30;
// Accept the previous and next 30s step too, for clock drift on the phone.
const WINDOW = 1;

function encryptionKey() {
  const explicit = String(process.env.TOTP_ENCRYPTION_KEY || '').trim();
  // Lazy require: authRoutes requires this module.
  const base = explicit || `${require('./authRoutes').getJwtSecret()}:totp`;
  return crypto.createHash('sha256').update(base).digest();
}

function encryptSecret(plain) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const ct = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ['v1', iv.toString('base64'), tag.toString('base64'), ct.toString('base64')].join(':');
}

function decryptSecret(stored) {
  const [version, iv, tag, ct] = String(stored || '').split(':');
  if (version !== 'v1' || !iv || !tag || !ct) throw new Error('Unreadable TOTP secret');
  const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(ct, 'base64')), decipher.final()]).toString('utf8');
}

// A new secret plus everything the setup screen needs: the QR code as a
// data URL and the base32 secret for typing in by hand.
async function createTotpEnrollment(email) {
  const secret = speakeasy.generateSecret({ length: 20 }).base32;
  const otpauthUrl = speakeasy.otpauthURL({
    secret,
    encoding: 'base32',
    label: `${ISSUER}:${email}`,
    issuer: ISSUER,
    period: STEP_SECONDS
  });
  const qrCodeDataUrl = await QRCode.toDataURL(otpauthUrl, { errorCorrectionLevel: 'M', margin: 1, width: 220 });
  return { secret, otpauthUrl, qrCodeDataUrl };
}

function normalizeCode(code) {
  return String(code == null ? '' : code).replace(/[\s-]/g, '');
}

// The time step the code belongs to, or null when the code is wrong. The
// caller records the step so the same code cannot be used twice.
function verifyTotp(secret, code, now = Date.now()) {
  const token = normalizeCode(code);
  if (!/^\d{6}$/.test(token)) return null;
  const result = speakeasy.totp.verifyDelta({
    secret,
    encoding: 'base32',
    token,
    window: WINDOW,
    step: STEP_SECONDS,
    time: Math.floor(now / 1000)
  });
  if (!result) return null;
  return Math.floor(now / 1000 / STEP_SECONDS) + result.delta;
}

module.exports = { createTotpEnrollment, verifyTotp, encryptSecret, decryptSecret, normalizeCode };
