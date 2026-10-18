import React, { useEffect, useRef } from 'react';

// The disclaimer shown on arrival: what this system is, what it is not
// secured against, and what must not be typed into it.
//
// Shown on every load rather than once per browser. A "don't show again"
// flag would be read as a preference, and this is not one - the warning is
// about what the user is about to type into the system, so it has to be in
// front of them each time they arrive at it, including after a refresh.
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
            AfikInvest נמצאת כרגע בשלב פיתוח ובדיקות. היא מסופקת כסביבת ניסיון (sandbox) בלבד - לא
            כמערכת פיננסית לשימוש אמיתי.
          </p>

          <ul className="beta-modal-list">
            <li>
              <strong>המערכת אינה מאובטחת סייבר.</strong> אין להסתמך עליה לשמירת מידע רגיש, ואין להניח
              שהנתונים שיוזנו בה מוגנים או פרטיים.
            </li>
            <li>
              <strong>אין להזין נתונים פיננסיים אמיתיים.</strong> אל תזינו יתרות, סכומים, מספרי חשבון או
              פרטים מזהים המייצגים כספים אמיתיים שלכם. השתמשו בנתוני דמה בלבד.
            </li>
            <li>
              <strong>חישובי המס הם אומדן בלבד.</strong> קיזוז הפסדים (Tax-Loss Harvesting), חישובי מס רווח
              הון וההצמדה למדד המוצגים כאן הם הערכה חישובית - לא חוות דעת, לא ייעוץ מס ולא קביעה מחייבת.
            </li>
            <li>
              <strong>התייעצו עם איש מקצוע מוסמך.</strong> לפני כל פעולה או החלטה בעלת השלכות מס או השקעה,
              פנו ליועץ מס, רואה חשבון או יועץ השקעות מורשה.
            </li>
          </ul>

          <p className="beta-modal-note">
            נתונים, מחירים ותשואות עשויים להיות חלקיים, מתעכבים או שגויים. המערכת אינה מהווה המלצה
            לביצוע פעולה בניירות ערך.
          </p>
        </div>

        <div className="beta-modal-actions">
          <button
            type="button"
            className="beta-modal-button"
            onClick={onAcknowledge}
            ref={buttonRef}
          >
            הבנתי, אני נכנס/ת לסביבת בדיקות
          </button>
        </div>
      </div>
    </div>
  );
}

export default BetaNoticeModal;
