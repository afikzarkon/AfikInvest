// The account emails' words: verification, sign-in links, email and
// password changes, linked providers, deletion. Each returns
// { subject, html, text }; the frame is layout.js. Values placed into the
// HTML are escaped there or here - never trusted.
const { APP_NAME, layout, para, button, codeBlock, rawLink, escapeHtml } = require('./layout');

const PROVIDER_LABELS = { google: 'Google', facebook: 'Facebook', apple: 'Apple' };
const providerLabel = (p) => PROVIDER_LABELS[p] || p;

const dateHe = (iso) => {
  try {
    return new Date(iso).toLocaleDateString('he-IL', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Asia/Jerusalem' });
  } catch {
    return String(iso).slice(0, 10);
  }
};

const textOf = (...lines) => lines.filter((l) => l !== null && l !== undefined).join('\n');
const IGNORE = 'אם לא אתם ביקשתם זאת, אפשר להתעלם מההודעה.';

function verifyEmail({ link, code, minutes }) {
  const subject = `אימות כתובת האימייל - ${APP_NAME}`;
  return {
    subject,
    html: layout({
      title: subject,
      bodyHtml: [
        para('תודה שנרשמתם! כדי להשלים את ההרשמה, אשרו שהכתובת הזו שלכם.'),
        button(link, 'אימות הכתובת'),
        para('או הזינו את הקוד הזה במסך ההרשמה:'),
        codeBlock(code),
        para(`הקישור והקוד תקפים ל-${minutes} דקות. ${IGNORE}`, { size: 14, color: '#4b5563' }),
        rawLink(link)
      ].join('')
    }),
    text: textOf('תודה שנרשמתם! כדי להשלים את ההרשמה, אשרו שהכתובת הזו שלכם.', '', `לאימות: ${link}`, `או הזינו את הקוד: ${code}`, '', `תקף ל-${minutes} דקות. ${IGNORE}`)
  };
}

// Someone signed up with an address that already has an account. The
// sign-up form answers exactly as for a new address, so this email is the
// only place that says so - to the address's owner.
function signupAttemptExisting({ loginUrl, resetUrl }) {
  const subject = `ניסיון הרשמה עם הכתובת שלכם - ${APP_NAME}`;
  return {
    subject,
    html: layout({
      title: subject,
      bodyHtml: [
        para('מישהו ניסה עכשיו לפתוח חשבון חדש עם הכתובת הזו, אבל כבר יש לכם חשבון.'),
        button(loginUrl, 'כניסה לחשבון'),
        para(`שכחתם את הסיסמה? <a href="${escapeHtml(resetUrl)}" style="color:#1d4ed8;">אפשר לאפס אותה כאן</a>.`, { size: 14 }),
        para(`${IGNORE} החשבון שלכם לא השתנה.`, { size: 14, color: '#4b5563' })
      ].join('')
    }),
    text: textOf('מישהו ניסה עכשיו לפתוח חשבון חדש עם הכתובת הזו, אבל כבר יש לכם חשבון.', `כניסה: ${loginUrl}`, `איפוס סיסמה: ${resetUrl}`, '', `${IGNORE} החשבון שלכם לא השתנה.`)
  };
}

function passwordReset({ link, minutes }) {
  const subject = `איפוס סיסמה - ${APP_NAME}`;
  return {
    subject,
    html: layout({
      title: subject,
      bodyHtml: [
        para('התקבלה בקשה לאיפוס הסיסמה לחשבון שלכם.'),
        button(link, 'בחירת סיסמה חדשה'),
        para(`הקישור תקף ל-${minutes} דקות ולשימוש אחד בלבד.`, { size: 14, color: '#4b5563' }),
        para('אם לא ביקשתם לאפס סיסמה, התעלמו מההודעה - הסיסמה לא תשתנה.', { size: 14, color: '#4b5563' }),
        rawLink(link)
      ].join('')
    }),
    text: textOf(`התקבלה בקשה לאיפוס הסיסמה לחשבון ${APP_NAME}.`, '', `לבחירת סיסמה חדשה: ${link}`, '', `הקישור תקף ל-${minutes} דקות ולשימוש אחד בלבד. אם לא ביקשתם איפוס, התעלמו מההודעה.`)
  };
}

function magicLink({ link, minutes }) {
  const subject = `קישור כניסה ל-${APP_NAME}`;
  return {
    subject,
    html: layout({
      title: subject,
      bodyHtml: [
        para('ביקשתם להיכנס בלי סיסמה. הקישור יכניס אתכם לחשבון:'),
        button(link, `כניסה ל-${APP_NAME}`),
        para(`הקישור תקף ל-${minutes} דקות ולשימוש אחד. ${IGNORE}`, { size: 14, color: '#4b5563' }),
        rawLink(link)
      ].join('')
    }),
    text: textOf('ביקשתם להיכנס בלי סיסמה. הקישור יכניס אתכם לחשבון:', link, '', `תקף ל-${minutes} דקות ולשימוש אחד. ${IGNORE}`)
  };
}

function magicLinkNoAccount({ signupUrl }) {
  const subject = `ביקשתם קישור כניסה ל-${APP_NAME}`;
  return {
    subject,
    html: layout({
      title: subject,
      bodyHtml: [
        para('ביקשתם קישור כניסה, אבל אין חשבון עם הכתובת הזו.'),
        button(signupUrl, 'פתיחת חשבון'),
        para(IGNORE, { size: 14, color: '#4b5563' })
      ].join('')
    }),
    text: textOf('ביקשתם קישור כניסה, אבל אין חשבון עם הכתובת הזו.', `פתיחת חשבון: ${signupUrl}`, '', IGNORE)
  };
}

function emailChangeConfirm({ link, hours }) {
  const subject = `אישור כתובת אימייל חדשה - ${APP_NAME}`;
  return {
    subject,
    html: layout({
      title: subject,
      bodyHtml: [
        para(`ביקשתם לשנות את כתובת האימייל של חשבון ה-${APP_NAME} שלכם לכתובת הזו. הכתובת תתעדכן רק אחרי האישור:`),
        button(link, 'אישור הכתובת החדשה'),
        para(`הקישור תקף ל-${hours} שעות. ${IGNORE}`, { size: 14, color: '#4b5563' }),
        rawLink(link)
      ].join('')
    }),
    text: textOf(`ביקשתם לשנות את כתובת האימייל של חשבון ה-${APP_NAME} שלכם לכתובת הזו.`, `לאישור: ${link}`, '', `תקף ל-${hours} שעות. ${IGNORE}`)
  };
}

// To the new address when another account already has it: the request
// answered as usual, so the requester learns nothing.
function emailChangeTaken() {
  const subject = `בקשה לשינוי כתובת - ${APP_NAME}`;
  return {
    subject,
    html: layout({
      title: subject,
      bodyHtml: [para(`מישהו ביקש להעביר חשבון ${APP_NAME} לכתובת הזו, אבל כבר יש חשבון עם הכתובת הזו, ולכן לא בוצע שינוי.`), para(IGNORE, { size: 14, color: '#4b5563' })].join('')
    }),
    text: textOf(`מישהו ביקש להעביר חשבון ${APP_NAME} לכתובת הזו, אבל כבר יש חשבון עם הכתובת הזו, ולכן לא בוצע שינוי.`, '', IGNORE)
  };
}

function emailChangeNotice({ newEmailMasked, cancelLink, days }) {
  const subject = `התבקש שינוי של כתובת האימייל - ${APP_NAME}`;
  return {
    subject,
    html: layout({
      title: subject,
      bodyHtml: [
        para(`התבקש שינוי של כתובת האימייל בחשבון שלכם ל-<strong dir="ltr">${escapeHtml(newEmailMasked)}</strong>.`),
        para('אם זה אתם - אין צורך לעשות דבר.'),
        para('אם לא ביקשתם זאת, בטלו את השינוי. הביטול מחזיר את הכתובת הזו לחשבון ומנתק את כל המכשירים:', { size: 15 }),
        button(cancelLink, 'ביטול השינוי'),
        para(`אפשר לבטל במשך ${days} ימים.`, { size: 14, color: '#4b5563' })
      ].join('')
    }),
    text: textOf(`התבקש שינוי של כתובת האימייל בחשבון שלכם ל-${newEmailMasked}.`, 'אם זה אתם - אין צורך לעשות דבר.', '', `אם לא ביקשתם זאת, בטלו את השינוי: ${cancelLink}`, `אפשר לבטל במשך ${days} ימים.`)
  };
}

function emailChangeReverted({ resetUrl }) {
  const subject = `שינוי הכתובת בוטל - ${APP_NAME}`;
  return {
    subject,
    html: layout({
      title: subject,
      bodyHtml: [
        para('שינוי כתובת האימייל בוטל, והחשבון חזר לכתובת הזו. כל המכשירים נותקו.'),
        para('אם לא אתם ביקשתם את השינוי, מומלץ לבחור עכשיו סיסמה חדשה:'),
        button(resetUrl, 'בחירת סיסמה חדשה')
      ].join('')
    }),
    text: textOf('שינוי כתובת האימייל בוטל, והחשבון חזר לכתובת הזו. כל המכשירים נותקו.', `בחירת סיסמה חדשה: ${resetUrl}`)
  };
}

function passwordChanged({ resetUrl, wasSet }) {
  const what = wasSet ? 'הוגדרה סיסמה לחשבון' : 'הסיסמה של החשבון שונתה';
  const subject = `${what} - ${APP_NAME}`;
  return {
    subject,
    html: layout({
      title: subject,
      bodyHtml: [
        para(`${what}, וכל שאר המכשירים נותקו.`),
        para('אם לא אתם עשיתם זאת, אפסו את הסיסמה מיד:'),
        button(resetUrl, 'איפוס סיסמה')
      ].join('')
    }),
    text: textOf(`${what}, וכל שאר המכשירים נותקו.`, `אם לא אתם עשיתם זאת, אפסו את הסיסמה מיד: ${resetUrl}`)
  };
}

// A sign-in through a provider whose email is not verified (Facebook, at
// times) matched an existing account: it is linked only once the
// account's own address confirms.
function oauthLinkConfirm({ provider, link, minutes }) {
  const name = providerLabel(provider);
  const subject = `חיבור ${name} לחשבון - ${APP_NAME}`;
  return {
    subject,
    html: layout({
      title: subject,
      bodyHtml: [
        para(`מישהו ניסה להיכנס לחשבון שלכם דרך ${escapeHtml(name)}. כדי לחבר את ${escapeHtml(name)} לחשבון ולהיכנס, אשרו:`),
        button(link, `חיבור ${name} וכניסה`),
        para(`הקישור תקף ל-${minutes} דקות. ${IGNORE} שום דבר לא חובר.`, { size: 14, color: '#4b5563' })
      ].join('')
    }),
    text: textOf(`מישהו ניסה להיכנס לחשבון שלכם דרך ${name}. כדי לחבר ולהיכנס: ${link}`, '', `תקף ל-${minutes} דקות. ${IGNORE} שום דבר לא חובר.`)
  };
}

function providerChanged({ provider, linked }) {
  const name = providerLabel(provider);
  const what = linked ? `${name} חובר לחשבון` : `${name} נותק מהחשבון`;
  const subject = `${what} - ${APP_NAME}`;
  return {
    subject,
    html: layout({ title: subject, bodyHtml: [para(`${escapeHtml(what)}.`), para('אם לא אתם עשיתם זאת, החליפו סיסמה ובדקו את המכשירים המחוברים בהגדרות.', { size: 14 })].join('') }),
    text: textOf(`${what}.`, 'אם לא אתם עשיתם זאת, החליפו סיסמה ובדקו את המכשירים המחוברים בהגדרות.')
  };
}

function twoFactorChanged({ enabled }) {
  const what = enabled ? 'אימות דו-שלבי הופעל בחשבון' : 'אימות דו-שלבי כובה בחשבון';
  const subject = `${what} - ${APP_NAME}`;
  return {
    subject,
    html: layout({ title: subject, bodyHtml: [para(`${what}.`), para('אם לא אתם עשיתם זאת, החליפו סיסמה מיד ובדקו את המכשירים המחוברים.', { size: 14 })].join('') }),
    text: textOf(`${what}.`, 'אם לא אתם עשיתם זאת, החליפו סיסמה מיד ובדקו את המכשירים המחוברים.')
  };
}

function deletionScheduled({ purgeAfter, loginUrl }) {
  const subject = `החשבון שלכם יימחק - ${APP_NAME}`;
  const date = dateHe(purgeAfter);
  return {
    subject,
    html: layout({
      title: subject,
      bodyHtml: [
        para(`קיבלנו את בקשתכם למחוק את החשבון. כל הנתונים יימחקו לצמיתות ב-<strong>${escapeHtml(date)}</strong>.`),
        para('עד אז אפשר לשחזר את החשבון פשוט על ידי כניסה מחדש:'),
        button(loginUrl, 'כניסה ושחזור החשבון'),
        para('אחרי המועד הזה אי אפשר לשחזר דבר.', { size: 14, color: '#4b5563' })
      ].join('')
    }),
    text: textOf(`קיבלנו את בקשתכם למחוק את החשבון. כל הנתונים יימחקו לצמיתות ב-${date}.`, `עד אז אפשר לשחזר את החשבון בכניסה מחדש: ${loginUrl}`, 'אחרי המועד הזה אי אפשר לשחזר דבר.')
  };
}

function deletionReminder({ purgeAfter, loginUrl }) {
  const subject = `תזכורת: החשבון יימחק בקרוב - ${APP_NAME}`;
  const date = dateHe(purgeAfter);
  return {
    subject,
    html: layout({
      title: subject,
      bodyHtml: [para(`החשבון שלכם וכל הנתונים בו יימחקו לצמיתות ב-<strong>${escapeHtml(date)}</strong>.`), para('השתנו התוכניות? כניסה לחשבון עד אז תשחזר אותו:'), button(loginUrl, 'כניסה ושחזור החשבון')].join('')
    }),
    text: textOf(`החשבון שלכם וכל הנתונים בו יימחקו לצמיתות ב-${date}.`, `כניסה לחשבון עד אז תשחזר אותו: ${loginUrl}`)
  };
}

function accountRestored() {
  const subject = `החשבון שוחזר - ${APP_NAME}`;
  return {
    subject,
    html: layout({ title: subject, bodyHtml: [para('החשבון שלכם שוחזר, ובקשת המחיקה בוטלה. כל הנתונים נשארו כפי שהיו.'), para('אם לא אתם נכנסתם, החליפו סיסמה מיד.', { size: 14 })].join('') }),
    text: textOf('החשבון שלכם שוחזר, ובקשת המחיקה בוטלה. כל הנתונים נשארו כפי שהיו.', 'אם לא אתם נכנסתם, החליפו סיסמה מיד.')
  };
}

function accountPurged() {
  const subject = `החשבון נמחק - ${APP_NAME}`;
  return {
    subject,
    html: layout({ title: subject, bodyHtml: [para(`החשבון שלכם ב-${APP_NAME} וכל הנתונים שבו נמחקו לצמיתות. תודה שהייתם איתנו.`)].join('') }),
    text: textOf(`החשבון שלכם ב-${APP_NAME} וכל הנתונים שבו נמחקו לצמיתות. תודה שהייתם איתנו.`)
  };
}

module.exports = {
  verifyEmail,
  signupAttemptExisting,
  passwordReset,
  magicLink,
  magicLinkNoAccount,
  emailChangeConfirm,
  emailChangeTaken,
  emailChangeNotice,
  emailChangeReverted,
  passwordChanged,
  oauthLinkConfirm,
  providerChanged,
  twoFactorChanged,
  deletionScheduled,
  deletionReminder,
  accountRestored,
  accountPurged,
  providerLabel
};
