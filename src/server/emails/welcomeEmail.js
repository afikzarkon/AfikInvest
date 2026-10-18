// The welcome email sent after signing up - its words and its markup, kept
// apart from the sending (emailService.js) so the copy can be edited here
// without touching how mail goes out.
//
// The HTML is what email clients can render: nested tables, inline styles
// only, no external CSS and no script, 600px at most and fluid below that.
// Images are files on the web app (public/email/, served by Vercel) linked
// by full URL - Gmail drops base64 images embedded in the body - and every
// one carries Hebrew alt text, so the email still reads with images off.
//
// buildWelcomeEmail returns { subject, html, text }; nodemailer sends the
// html and text together as multipart/alternative.
const { escapeHtml } = require('./html');

const APP_NAME = 'StockView';

// ---------------------------------------------------------------------------
// The copy. Every feature listed here is a page or function that exists in
// the app (see src/router/routes.js) - add one here only once it ships.

const INTRO =
  'StockView מרכז במקום אחד את כל ההשקעות והחסכונות שלכם - מניות בארץ ובחו"ל, קופות גמל, קרן כספית, קופת חיסכון ועו"ש - ומראה בכל רגע כמה הכול שווה, כמה הרווחתם וכמה מס צפוי.';

const FEATURE_GROUPS = [
  {
    title: 'מעקב אחר הנכסים',
    items: [
      'מניות וקרנות בבורסה הישראלית ובבורסה האמריקאית, עם עדכון מחירים אוטומטי',
      'קופות גמל להשקעה, קרן כספית שקלית, קופת חיסכון בבנק ועו"ש - עם פנקס הפקדות ומשיכות לכל חשבון'
    ]
  },
  {
    title: 'סיכומים ותשואה',
    items: [
      'כרטיסי סיכום בדף הבית ובכל עמוד נכס: שווי, רווח והפסד ומס צפוי על הרווח הריאלי',
      'תשואה כללית ותשואה מאז העדכון הקודם לקופות הגמל ולקרן הכספית',
      'ניתוח תיק (ביצועים ופיזור) ומעקב חודשי אחר שווי התיק',
      'ייצוא הנתונים לאקסל ולדוח PDF'
    ]
  },
  {
    title: 'כלים',
    items: [
      'התראות על תנועות חריגות ולוח אירועים',
      'הערכת שווי למניות אמריקאיות - מכפילים ומחשבון DCF',
      'המלצות לאיזון התיק, איתור הזדמנויות לקיזוז מס ויומן עסקאות'
    ]
  },
  {
    title: 'אבטחה',
    items: ['עמוד אבטחה עם אימות דו-שלבי (קוד מאפליקציית אימות בכל כניסה)']
  }
];

// The getting-started steps. `image` is a file in public/email/; `alt`
// describes what it shows, for clients that block images.
const STEPS = [
  {
    title: 'הוסיפו את הנכס הראשון',
    text: 'לחצו על "+ הוספת מידע", בחרו את סוג הנכס - מניה, קופת גמל, קרן כספית ועוד - ומלאו את הפרטים.',
    image: 'step-1-add-asset.png',
    alt: 'טופס "הוספת נכס או רישום פעולה": סוג הנכס, החשבון, הפעולה, התאריך והסכום'
  },
  {
    title: 'עדכנו את השווי',
    text: 'בקופת גמל ובקרן כספית רשמו את השווי מהדוח האחרון, והמערכת תחשב את התשואה מאז העדכון הקודם.',
    image: 'step-2-update-value.png',
    alt: 'טבלת הקרן הכספית השקלית: סך ההפקדות, השווי היום, התשואה מאז העדכון הקודם והתשואה הכללית'
  },
  {
    title: 'צפו בסיכום התיק',
    text: 'דף הבית מרכז את שווי התיק, הרווח והשינוי היומי, עם כרטיס סיכום לכל סוג נכס.',
    image: 'step-3-summary.png',
    alt: 'דף הבית: שווי התיק הכולל, רווח והפסד כולל, שינוי יומי ומס צפוי'
  },
  {
    title: 'הפעילו אימות דו-שלבי',
    text: 'בעמוד "אבטחה" סרקו את קוד ה-QR באפליקציית אימות, כדי שאיש לא ייכנס לחשבון עם הסיסמה בלבד.',
    image: 'step-4-security.png',
    alt: 'עמוד האבטחה עם הכפתור להפעלת אימות דו-שלבי'
  }
];

// ---------------------------------------------------------------------------
// Markup

const FONT = 'Arial, Helvetica, sans-serif';
const COLORS = { page: '#f4f6fb', card: '#ffffff', text: '#1f2937', muted: '#4b5563', faint: '#6b7280', brand: '#1d4ed8', rule: '#e5e7eb' };

const p = (html, style = '') =>
  `<p style="margin:0 0 16px;font-family:${FONT};font-size:16px;line-height:1.6;color:${COLORS.text};${style}">${html}</p>`;

const h2 = (text) =>
  `<h2 style="margin:32px 0 12px;font-family:${FONT};font-size:20px;line-height:1.3;color:${COLORS.text};">${escapeHtml(text)}</h2>`;

function featuresHtml() {
  return FEATURE_GROUPS.map(
    (group) => `
            <p style="margin:16px 0 6px;font-family:${FONT};font-size:15px;font-weight:bold;color:${COLORS.brand};">${escapeHtml(group.title)}</p>
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
              ${group.items
                .map(
                  (item) => `<tr>
                <td width="18" valign="top" style="font-family:${FONT};font-size:15px;line-height:1.6;color:${COLORS.brand};">&#8226;</td>
                <td valign="top" style="font-family:${FONT};font-size:15px;line-height:1.6;color:${COLORS.text};padding-bottom:4px;">${escapeHtml(item)}</td>
              </tr>`
                )
                .join('')}
            </table>`
  ).join('');
}

function stepsHtml(appUrl) {
  return STEPS.map((step, i) => {
    const image = appUrl
      ? `<tr><td colspan="2" style="padding:12px 0 0;">
                  <img src="${escapeHtml(`${appUrl}/email/${step.image}`)}" alt="${escapeHtml(step.alt)}" width="560"
                       style="display:block;width:100%;max-width:560px;height:auto;border:1px solid ${COLORS.rule};border-radius:8px;" />
                </td></tr>`
      : '';
    return `
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 28px;">
              <tr>
                <td width="40" valign="top" style="padding-left:12px;">
                  <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
                    <td width="32" height="32" align="center" valign="middle" style="width:32px;height:32px;border-radius:16px;background:${COLORS.brand};font-family:${FONT};font-size:16px;font-weight:bold;color:#ffffff;">${i + 1}</td>
                  </tr></table>
                </td>
                <td valign="top">
                  <p style="margin:4px 0 4px;font-family:${FONT};font-size:17px;font-weight:bold;color:${COLORS.text};">${escapeHtml(step.title)}</p>
                  <p style="margin:0;font-family:${FONT};font-size:15px;line-height:1.6;color:${COLORS.muted};">${escapeHtml(step.text)}</p>
                </td>
              </tr>
              ${image}
            </table>`;
  }).join('');
}

// A button as a table cell, so Outlook draws it too.
function buttonHtml(href, label) {
  return `
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 24px;">
              <tr><td align="center">
                <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
                  <td align="center" bgcolor="${COLORS.brand}" style="border-radius:10px;">
                    <a href="${escapeHtml(href)}" target="_blank"
                       style="display:inline-block;padding:16px 48px;font-family:${FONT};font-size:18px;font-weight:bold;color:#ffffff;text-decoration:none;border-radius:10px;">${escapeHtml(label)}</a>
                  </td>
                </tr></table>
              </td></tr>
            </table>`;
}

// name: the user's name, when the signup has one; email: the address the
// account was opened with; appUrl: the web app's public address (no
// trailing slash), '' when unknown - then the email goes without images or
// the button rather than with links to nowhere; contactEmail: where to write
// for help.
function buildWelcomeEmail({ name = '', email = '', appUrl = '', contactEmail = '' } = {}) {
  const cleanName = String(name || '').trim();
  const greeting = cleanName ? `שלום ${cleanName},` : 'שלום,';
  const subject = cleanName ? `${cleanName}, ברוכים הבאים ל-${APP_NAME}!` : `ברוכים הבאים ל-${APP_NAME}!`;
  const preheader = 'ההרשמה הושלמה - כך מתחילים לעקוב אחר התיק שלכם.';
  const contactLine = contactEmail
    ? `נתקלתם בבעיה או שיש לכם שאלה? כתבו לנו ל-<a href="mailto:${escapeHtml(contactEmail)}" style="color:${COLORS.brand};">${escapeHtml(contactEmail)}</a>.`
    : 'נתקלתם בבעיה או שיש לכם שאלה? השיבו להודעה זו ונחזור אליכם.';

  const html = `<!doctype html>
<html lang="he" dir="rtl">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="Content-Type" content="text/html; charset=utf-8">
  <title>${escapeHtml(subject)}</title>
</head>
<body dir="rtl" style="margin:0;padding:0;background:${COLORS.page};">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:${COLORS.page};">${escapeHtml(preheader)}</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" dir="rtl" style="background:${COLORS.page};">
    <tr><td align="center" style="padding:24px 12px;">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" dir="rtl"
             style="width:100%;max-width:600px;background:${COLORS.card};border-radius:12px;">
        <tr><td dir="rtl" style="padding:32px 20px;text-align:right;">
            <p style="margin:0 0 24px;font-family:${FONT};font-size:24px;font-weight:bold;color:${COLORS.brand};">${APP_NAME}</p>
            <h1 style="margin:0 0 16px;font-family:${FONT};font-size:24px;line-height:1.3;color:${COLORS.text};">${escapeHtml(greeting)}</h1>
            ${p(`ההרשמה ל-${APP_NAME} הושלמה בהצלחה${email ? ` - החשבון <strong dir="ltr">${escapeHtml(email)}</strong> מוכן לשימוש` : ''}.`)}
            ${p(escapeHtml(INTRO))}
            ${appUrl ? buttonHtml(appUrl, `כניסה ל-${APP_NAME}`) : ''}

            ${h2('מה אפשר לעשות באתר')}
            ${featuresHtml()}

            ${h2('איך מתחילים')}
            ${stepsHtml(appUrl)}

            ${appUrl ? buttonHtml(appUrl, 'מעבר לאתר') : ''}

            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
              <tr><td style="border-top:1px solid ${COLORS.rule};padding-top:20px;">
                ${p(contactLine, `font-size:14px;color:${COLORS.muted};`)}
                ${p(`ההודעה נשלחה אוטומטית מ-${APP_NAME} כי נפתח חשבון בכתובת זו. אם לא אתם נרשמתם, אפשר להתעלם ממנה.`, `margin:0;font-size:12px;color:${COLORS.faint};`)}
              </td></tr>
            </table>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

  const text = [
    greeting,
    '',
    `ההרשמה ל-${APP_NAME} הושלמה בהצלחה${email ? ` - החשבון ${email} מוכן לשימוש` : ''}.`,
    '',
    INTRO,
    '',
    'מה אפשר לעשות באתר',
    ...FEATURE_GROUPS.flatMap((group) => ['', `${group.title}:`, ...group.items.map((item) => `- ${item}`)]),
    '',
    'איך מתחילים',
    ...STEPS.flatMap((step, i) => ['', `${i + 1}. ${step.title}`, `   ${step.text}`]),
    '',
    ...(appUrl ? [`מעבר לאתר: ${appUrl}`, ''] : []),
    contactEmail ? `נתקלתם בבעיה או שיש לכם שאלה? כתבו לנו ל-${contactEmail}.` : 'נתקלתם בבעיה או שיש לכם שאלה? השיבו להודעה זו ונחזור אליכם.',
    '',
    `ההודעה נשלחה אוטומטית מ-${APP_NAME} כי נפתח חשבון בכתובת זו. אם לא אתם נרשמתם, אפשר להתעלם ממנה.`
  ].join('\n');

  return { subject, html, text };
}

module.exports = { buildWelcomeEmail, STEPS };
