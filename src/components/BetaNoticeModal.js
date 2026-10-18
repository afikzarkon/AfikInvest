import React, { useEffect, useRef } from 'react';

// The notice shown on arrival: the system is in testing, nothing in it is
// investment or tax advice, the decisions are the user's own, and their
// data is kept confidential. Acknowledging it is acknowledging the terms.
//
// Shown on every load rather than once per browser. A "don't show again"
// flag would be read as a preference, and this is not one - the warning is
// about how everything the user is about to see may be relied on, so it has
// to be in front of them each time they arrive, including after a refresh.
//
// It cannot be dismissed by clicking away or by Escape either. Both are the
// gestures for closing something optional, and acknowledging what the
// system does and does not guarantee is the one thing on this screen that
// is not. The single button is the only way out, which is what makes the
// acknowledgement deliberate.
function BetaNoticeModal({ onAcknowledge }) {
  const buttonRef = useRef(null);

  // Focus lands on the acknowledgement, so a keyboard user does not have
  // to tab in from wherever focus happened to be behind the overlay.
  useEffect(() => {
    buttonRef.current?.focus();
  }, []);

  // The page behind must not scroll while this is up: a modal you can
  // scroll past is a banner with extra steps.
  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, []);

  return (
    <div className="beta-modal-overlay">
      <div
        className="beta-modal"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="beta-modal-title"
        aria-describedby="beta-modal-body"
      >
        <div className="beta-modal-header">
          <span className="beta-modal-tag">BETA</span>
          <h2 className="beta-modal-title" id="beta-modal-title">
            המערכת נמצאת בשלב בדיקות
          </h2>
        </div>

        <div className="beta-modal-body" id="beta-modal-body">
          <p className="beta-modal-lead">
            AfikInvest נמצאת כרגע בשלב בדיקות (Beta). ייתכנו שינויים, תקלות ושיפורים שוטפים, והשירות מסופק כמות שהוא (AS IS).
          </p>

          <ul className="beta-modal-list">
            <li>
              <strong>אין כאן ייעוץ השקעות או המלצה.</strong> AfikInvest ומפעיליה אינם בעלי רישיון לייעוץ השקעות, לשיווק השקעות או לניהול תיקים. הערכות שווי,
              הצעות איזון, התראות ונתונים הם מידע כללי שנוצר אוטומטית - לא המלצה ולא הצעה לקנות, למכור או להחזיק נייר ערך, והם אינם מתחשבים בנתונים ובצרכים
              האישיים שלכם.
            </li>
            <li>
              <strong>חישובי המס הם אומדן בלבד.</strong> קיזוז הפסדים (Tax-Loss Harvesting), חישובי מס רווח הון וההצמדה למדד הם הערכה חישובית בהנחות מפושטות -
              לא ייעוץ מס, לא חוות דעת ולא קביעה מחייבת. חבות המס בפועל נקבעת על ידי רשות המסים ועשויה להיות שונה.
            </li>
            <li>
              <strong>ההחלטות והאחריות שלכם.</strong> כל פעולה בכספים, בניירות ערך או בדיווח למס היא באחריותכם בלבד. מחירים, תשואות ונתונים מגיעים ממקורות
              חיצוניים ועשויים להיות חלקיים, מתעכבים או שגויים. ביצועי עבר אינם מבטיחים תשואה בעתיד.
            </li>
            <li>
              <strong>התייעצו עם איש מקצוע מוסמך.</strong> לפני כל החלטה בעלת השלכות מס או השקעה, פנו ליועץ מס, רואה חשבון או יועץ השקעות מורשה.
            </li>
            <li>
              <strong>המידע שלכם נשמר בסודיות.</strong> התקשורת מוצפנת, הסיסמאות נשמרות כגיבוב בלבד, והנתונים שלכם אינם נמכרים, אינם משמשים לפרסום ואינם
              מועברים לאחרים, מלבד ספקי התשתית הנדרשים להפעלת האתר או כשהדין מחייב.
            </li>
          </ul>

          <p className="beta-modal-note">
            ההמשך לשימוש באתר מהווה הסכמה ל
            <a href="/terms" target="_blank" rel="noopener noreferrer">
              תנאי השימוש
            </a>{' '}
            ול
            <a href="/privacy" target="_blank" rel="noopener noreferrer">
              מדיניות הפרטיות
            </a>
            .
          </p>
        </div>

        <div className="beta-modal-actions">
          <button
            type="button"
            className="beta-modal-button"
            onClick={onAcknowledge}
            ref={buttonRef}
          >
            קראתי, הבנתי ואני מסכים/ה
          </button>
        </div>
      </div>
    </div>
  );
}

export default BetaNoticeModal;
