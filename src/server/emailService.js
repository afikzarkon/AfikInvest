// Outgoing mail from the Gmail account EMAIL_USER, two ways:
//
// - Gmail API over HTTPS, when GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET and
//   GMAIL_REFRESH_TOKEN are set. Needed on Render's free plan, which blocks
//   outbound SMTP ports (25/465/587) - the SMTP route just times out there.
//   nodemailer still builds the message; only the delivery is an API call.
// - SMTP (nodemailer, service: 'gmail') with EMAIL_PASS, a Gmail App
//   Password - fine locally or on a host that allows SMTP.
//
// With neither, the service is "unconfigured": in development it prints the
// message to the console so the reset flow can still be exercised locally;
// in production it skips the send and logs a warning.
const nodemailer = require('nodemailer');

const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GMAIL_SEND_URL = 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send';
const HTTP_TIMEOUT_MS = 15000;

function gmailApiConfigured() {
  return Boolean(
    process.env.GMAIL_CLIENT_ID && process.env.GMAIL_CLIENT_SECRET && process.env.GMAIL_REFRESH_TOKEN
  );
}

async function readGoogleError(res) {
  const body = await res.text().catch(() => '');
  return `${res.status} ${body.slice(0, 300)}`;
}

// A nodemailer-shaped transport ({ sendMail }) that delivers through the
// Gmail API. The access token lasts about an hour and is reused until a
// minute before it expires.
// fetchImpl defaults to Node's global fetch, looked up at call time (CRA's
// Jest environment has none).
function createGmailApiTransport({ fetchImpl = (...args) => globalThis.fetch(...args) } = {}) {
  const composer = nodemailer.createTransport({ streamTransport: true, buffer: true, newline: 'unix' });
  let accessToken = '';
  let expiresAt = 0;

  async function getAccessToken() {
    if (accessToken && Date.now() < expiresAt - 60 * 1000) return accessToken;
    const res = await fetchImpl(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: process.env.GMAIL_CLIENT_ID,
        client_secret: process.env.GMAIL_CLIENT_SECRET,
        refresh_token: process.env.GMAIL_REFRESH_TOKEN,
        grant_type: 'refresh_token'
      }).toString(),
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS)
    });
    // invalid_grant here means the refresh token was revoked or expired
    // (e.g. the OAuth app was left in "Testing", where tokens last 7 days).
    if (!res.ok) throw new Error(`Gmail token refresh failed: ${await readGoogleError(res)}`);
    const data = await res.json();
    accessToken = data.access_token;
    expiresAt = Date.now() + (Number(data.expires_in) || 3600) * 1000;
    return accessToken;
  }

  return {
    async sendMail(mail) {
      const { message } = await composer.sendMail(mail);
      const res = await fetchImpl(GMAIL_SEND_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${await getAccessToken()}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ raw: message.toString('base64url') }),
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS)
      });
      if (!res.ok) throw new Error(`Gmail send failed: ${await readGoogleError(res)}`);
      return res.json();
    }
  };
}

function buildTransport(user, pass) {
  if (gmailApiConfigured()) return createGmailApiTransport();
  if (user && pass) return nodemailer.createTransport({ service: 'gmail', auth: { user, pass } });
  return null;
}

const APP_NAME = 'StockView';

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// The public address of the web app, used to build links in emails. Taken
// only from configuration - never from the request's Host header, which an
// attacker controls and could use to point a reset link at their own site.
function getAppUrl() {
  const configured = String(process.env.APP_URL || '').trim().replace(/\/+$/, '');
  if (configured) return configured;
  if (process.env.NODE_ENV === 'production') return '';
  return 'http://localhost:3000';
}

function layout(title, bodyHtml) {
  return `<!doctype html>
<html lang="he" dir="rtl">
  <head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head>
  <body style="margin:0;padding:24px;background:#f4f6fb;font-family:Arial,Helvetica,sans-serif;color:#1f2937;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
      <tr><td align="center">
        <table role="presentation" width="560" cellpadding="0" cellspacing="0"
               style="max-width:560px;background:#ffffff;border-radius:12px;padding:32px;text-align:right;">
          <tr><td>
            <h1 style="margin:0 0 16px;font-size:22px;color:#1d4ed8;">${APP_NAME}</h1>
            ${bodyHtml}
            <p style="margin:32px 0 0;font-size:12px;color:#6b7280;">
              הודעה זו נשלחה אוטומטית מ-${APP_NAME}. אין להשיב לה.
            </p>
          </td></tr>
        </table>
      </td></tr>
    </table>
  </body>
</html>`;
}

function button(href, label) {
  return `<p style="margin:24px 0;">
    <a href="${escapeHtml(href)}"
       style="display:inline-block;background:#1d4ed8;color:#ffffff;text-decoration:none;padding:12px 24px;border-radius:8px;font-weight:bold;">
      ${escapeHtml(label)}
    </a>
  </p>`;
}

function welcomeMessage(email) {
  const appUrl = getAppUrl();
  const html = layout(
    `ברוכים הבאים ל-${APP_NAME}`,
    `<p style="font-size:16px;">שלום,</p>
     <p style="font-size:16px;">החשבון <strong>${escapeHtml(email)}</strong> נוצר בהצלחה.
       אפשר להתחיל להוסיף אחזקות ולעקוב אחרי התיק.</p>
     ${appUrl ? button(appUrl, `כניסה ל-${APP_NAME}`) : ''}
     <p style="font-size:14px;color:#4b5563;">מומלץ להפעיל אימות דו-שלבי (2FA) בעמוד האבטחה באפליקציה.</p>
     <p style="font-size:14px;color:#4b5563;">אם לא אתם נרשמתם, אפשר להתעלם מהודעה זו.</p>`
  );
  const text =
    `ברוכים הבאים ל-${APP_NAME}!\n\nהחשבון ${email} נוצר בהצלחה.` +
    (appUrl ? `\nכניסה: ${appUrl}` : '') +
    '\n\nאם לא אתם נרשמתם, אפשר להתעלם מהודעה זו.';
  return { subject: `ברוכים הבאים ל-${APP_NAME}`, html, text };
}

function passwordResetMessage(resetUrl, minutes) {
  const html = layout(
    'איפוס סיסמה',
    `<p style="font-size:16px;">התקבלה בקשה לאיפוס הסיסמה לחשבון שלכם.</p>
     ${button(resetUrl, 'בחירת סיסמה חדשה')}
     <p style="font-size:14px;color:#4b5563;">הקישור תקף ל-${minutes} דקות ולשימוש אחד בלבד.</p>
     <p style="font-size:14px;color:#4b5563;">אם לא ביקשתם לאפס סיסמה, התעלמו מהודעה זו - הסיסמה לא תשתנה.</p>
     <p style="font-size:12px;color:#6b7280;direction:ltr;text-align:left;word-break:break-all;">${escapeHtml(resetUrl)}</p>`
  );
  const text =
    `התקבלה בקשה לאיפוס הסיסמה לחשבון ${APP_NAME}.\n\n` +
    `לבחירת סיסמה חדשה: ${resetUrl}\n\n` +
    `הקישור תקף ל-${minutes} דקות ולשימוש אחד בלבד. אם לא ביקשתם איפוס, התעלמו מהודעה זו.`;
  return { subject: `איפוס סיסמה - ${APP_NAME}`, html, text };
}

// transport: a nodemailer transport (or anything with sendMail) - tests pass
// a fake; normally built from the environment.
function createEmailService({ transport } = {}) {
  const user = String(process.env.EMAIL_USER || '').trim();
  // Google shows App Passwords in groups of four ("abcd efgh ijkl mnop").
  const pass = String(process.env.EMAIL_PASS || '').replace(/\s+/g, '');
  const transporter = transport || buildTransport(user, pass);
  const configured = Boolean(transporter);

  async function send(to, { subject, html, text }) {
    if (!transporter) {
      if (process.env.NODE_ENV === 'production') {
        console.warn(`email: no mail credentials (GMAIL_* or EMAIL_PASS) - skipped "${subject}"`);
      } else if (process.env.NODE_ENV !== 'test') {
        console.log(`\n[email:dev] to=${to}\nsubject: ${subject}\n${text}\n`);
      }
      return { skipped: true };
    }
    return transporter.sendMail({ from: `"${APP_NAME}" <${user || 'no-reply@stockview.local'}>`, to, subject, html, text });
  }

  return {
    configured,
    sendWelcomeEmail: (to) => send(to, welcomeMessage(to)),
    sendPasswordResetEmail: (to, resetUrl, minutes) => send(to, passwordResetMessage(resetUrl, minutes))
  };
}

module.exports = { createEmailService, createGmailApiTransport, gmailApiConfigured, getAppUrl, escapeHtml };
