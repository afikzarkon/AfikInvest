// Outgoing mail through Gmail (nodemailer, service: 'gmail').
//
// Credentials come from EMAIL_USER and EMAIL_PASS. EMAIL_PASS is a Gmail
// App Password (Google Account -> Security -> 2-Step Verification -> App
// passwords), never the account's real password. Without both variables the
// service is "unconfigured": in development it prints the message to the
// console so the reset flow can still be exercised locally; in production it
// skips the send and logs a warning.
const nodemailer = require('nodemailer');

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
  const configured = Boolean(transport) || Boolean(user && pass);

  const transporter =
    transport || (configured ? nodemailer.createTransport({ service: 'gmail', auth: { user, pass } }) : null);

  async function send(to, { subject, html, text }) {
    if (!transporter) {
      if (process.env.NODE_ENV === 'production') {
        console.warn(`email: EMAIL_USER/EMAIL_PASS not set - skipped "${subject}"`);
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

module.exports = { createEmailService, getAppUrl, escapeHtml };
