import React, { useState } from 'react';
import { useCompactLayout } from '../hooks/useMediaQuery';

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

// On a phone the full strip repeated at the top of every page pushed each
// page's figures down by a screen's worth of amber. There it is one line
// that opens on a tap. The general and data notes - the same text on every
// page, already accepted in the arrival notice - can be closed for good;
// the tax, valuation and advice notes say something specific to the page
// they sit on, so they collapse but never go away.
const CLOSE_KEY = 'afikinvest_beta_strip_closed';
const CLOSABLE = new Set(['general', 'data']);

function readClosed() {
  try {
    return localStorage.getItem(CLOSE_KEY) === '1';
  } catch {
    return false;
  }
}

function CompactBetaBanner({ tone, message }) {
  const [open, setOpen] = useState(false);
  const [closed, setClosed] = useState(readClosed);
  const closable = CLOSABLE.has(tone);
  if (closable && closed) return null;
  const close = () => {
    setClosed(true);
    try {
      localStorage.setItem(CLOSE_KEY, '1');
    } catch {
      /* closes for this visit only */
    }
  };
  return (
    <div className={`beta-banner beta-banner-${tone} is-compact ${open ? 'is-open' : ''}`} role="note">
      <button type="button" className="beta-banner-toggle" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <span className="beta-banner-tag">BETA</span>
        <strong className="beta-banner-title">{message.title}</strong>
        <span className="beta-banner-more" aria-hidden="true">
          {open ? '▴' : '▾'}
        </span>
      </button>
      {open && <p className="beta-banner-body">{message.body}</p>}
      {closable && (
        <button type="button" className="beta-banner-close" onClick={close} aria-label="סגירת ההודעה">
          ×
        </button>
      )}
    </div>
  );
}

function BetaBanner({ tone = 'general' }) {
  const message = MESSAGES[tone] || MESSAGES.general;
  const compact = useCompactLayout();
  if (compact) return <CompactBetaBanner tone={MESSAGES[tone] ? tone : 'general'} message={message} />;
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
