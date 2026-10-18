import React from 'react';

// The standing "this system is in testing" strip, with the legal note that
// fits the page it sits on.
//
// Deliberately a separate component from BetaNoticeModal rather than a
// prop on it: the modal is an interruption shown once per visit and then
// dismissed, and what a user needs while acting on a figure is a notice
// that is still on the page. One says it on arrival; this says it wherever
// it still applies.
//
// `tone` picks which note leads: "data" where holdings are typed in, "tax"
// where a tax figure is claimed, "invest" where a stock is valued, "advice"
// where actions are suggested, and the general one elsewhere.
const BETA = 'המערכת בשלב בדיקות (Beta)';
const NOT_ADVICE = 'אינו ייעוץ השקעות, ייעוץ מס או המלצה לקנות, למכור או להחזיק נייר ערך כלשהו';

const MESSAGES = {
  general: {
    title: BETA,
    body: `ייתכנו שינויים ותקלות. התוכן באתר הוא מידע כללי וכלי עזר בלבד, ${NOT_ADVICE}.`
  },
  data: {
    title: BETA,
    body: `הנתונים שאתם מזינים נשמרים בסודיות בחשבון שלכם בלבד. החישובים הם כלי עזר, ${NOT_ADVICE}.`
  },
  tax: {
    title: `${BETA} - חישובי המס הם אומדן`,
    body:
      'קיזוז ההפסדים וחישובי המס המוצגים הם הערכה בהנחות מפושטות בלבד, ואינם ייעוץ מס, חוות דעת או המלצה לבצע פעולה. חבות המס בפועל נקבעת על ידי רשות המסים ועשויה להיות שונה. לפני כל פעולה התייעצו עם יועץ מס או איש מקצוע מוסמך.'
  },
  invest: {
    title: `${BETA} - אין זו המלצה`,
    body:
      'הערכות השווי והחישובים כאן הם מידע כללי שנוצר אוטומטית מנתונים חיצוניים, ואינם ייעוץ השקעות, המלצה או הצעה לקנות או למכור ניירות ערך. הם אינם מתחשבים בנתונים ובצרכים האישיים שלכם. ההחלטה והאחריות שלכם בלבד.'
  },
  advice: {
    title: `${BETA} - הצעות לעיון בלבד`,
    body:
      'ההצעות (איזון, מימוש רווחים, קיזוז הפסדים) מחושבות אוטומטית לפי הספים שהגדרתם, ואינן ייעוץ השקעות, ייעוץ מס או המלצה לבצע פעולה. חישובי המס הם אומדן בלבד. לפני כל פעולה התייעצו עם יועץ השקעות מורשה, יועץ מס או איש מקצוע מוסמך.'
  }
};

function BetaBanner({ tone = 'general' }) {
  const message = MESSAGES[tone] || MESSAGES.general;
  return (
    <div className={`beta-banner beta-banner-${tone}`} role="note">
      <span className="beta-banner-tag">BETA</span>
      <span className="beta-banner-text">
        <strong className="beta-banner-title">{message.title}</strong>
        <span className="beta-banner-body">{message.body}</span>
      </span>
    </div>
  );
}

export default BetaBanner;
