// The frame every short account email shares (verification, sign-in link,
// email change, password change, deletion, ...): table layout, inline
// styles, 600px at most.
//
// The text direction is set on the inner table cells as well as on <html>
// and <body>: Gmail drops the attributes of those two, and right-to-left
// text inside a left-to-right box shows its final period at the start of
// the line (".התקבלה בקשה לאיפוס הסיסמה").
const { escapeHtml } = require('./html');

const APP_NAME = 'AfikInvest';
const FONT = 'Arial, Helvetica, sans-serif';

// A paragraph. html is trusted markup - escape any value placed in it.
const para = (html, { size = 16, color = '#1f2937', margin = '0 0 16px' } = {}) =>
  `<p dir="rtl" style="margin:${margin};font-family:${FONT};font-size:${size}px;line-height:1.6;color:${color};text-align:right;">${html}</p>`;

function button(href, label) {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 24px;"><tr>
    <td align="center" bgcolor="#1d4ed8" style="border-radius:10px;">
      <a href="${escapeHtml(href)}" target="_blank"
         style="display:inline-block;padding:14px 36px;font-family:${FONT};font-size:16px;font-weight:bold;color:#ffffff;text-decoration:none;border-radius:10px;">${escapeHtml(label)}</a>
    </td></tr></table>`;
}

// A one-time code, large and spaced, left to right.
function codeBlock(code) {
  return `<p dir="ltr" style="margin:8px 0 24px;font-family:${FONT};font-size:30px;font-weight:bold;letter-spacing:8px;color:#1f2937;text-align:center;">${escapeHtml(code)}</p>`;
}

// The logo at the top of every email. It is an image the site serves, so
// only with a public https address (APP_URL); otherwise - in development,
// or for a client that blocks images - the name stands in as text (alt).
function brandHeader(appUrl = process.env.APP_URL, { margin = '0 0 20px' } = {}) {
  const base = String(appUrl || '').trim().replace(/\/+$/, '');
  if (!/^https:\/\//.test(base)) {
    return para(APP_NAME, { size: 22, color: '#1d4ed8', margin }).replace('font-size:22px;', 'font-size:22px;font-weight:bold;');
  }
  return `<p dir="rtl" style="margin:${margin};text-align:right;"><img src="${escapeHtml(base)}/brand/logo-email.png" width="140" alt="${APP_NAME}"
    style="display:inline-block;width:140px;max-width:140px;height:auto;border:0;outline:none;text-decoration:none;font-family:${FONT};font-size:22px;font-weight:bold;color:#1d4ed8;"></p>`;
}

// A link shown as text, for clients that hide the button.
const rawLink = (href) =>
  `<p dir="ltr" style="margin:0 0 16px;font-family:${FONT};font-size:12px;color:#6b7280;text-align:left;word-break:break-all;">${escapeHtml(href)}</p>`;

// bodyHtml: the message's own markup. kind 'security' says it cannot be
// unsubscribed from; unsubscribeUrl adds the opt-out link (non-security
// mail only).
function layout({ title, bodyHtml, kind = 'security', unsubscribeUrl = '' }) {
  const footer =
    kind === 'security'
      ? 'זוהי הודעת אבטחה על החשבון שלכם, ולכן היא נשלחת גם למי שביטל דיוור.'
      : unsubscribeUrl
        ? `לא רוצים לקבל הודעות כאלה? <a href="${escapeHtml(unsubscribeUrl)}" style="color:#6b7280;">הסרה מרשימת התפוצה</a>`
        : '';
  return `<!doctype html>
<html lang="he" dir="rtl">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title></head>
<body dir="rtl" style="margin:0;padding:0;background:#f4f6fb;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" dir="rtl" style="background:#f4f6fb;">
    <tr><td align="center" style="padding:24px 12px;">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" dir="rtl"
             style="width:100%;max-width:600px;background:#ffffff;border-radius:12px;">
        <tr><td dir="rtl" style="padding:32px 24px;text-align:right;">
          ${brandHeader()}
          ${bodyHtml}
          ${para(`ההודעה נשלחה אוטומטית מ-${APP_NAME}.${footer ? ` ${footer}` : ''}`, { size: 12, color: '#6b7280', margin: '24px 0 0' })}
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

module.exports = { APP_NAME, layout, para, button, codeBlock, rawLink, escapeHtml, brandHeader };
