import React, { useEffect, useState } from 'react';
import { getAccount, postAccount } from '../../accountApi';
import { useToast } from '../ui/Toast';
import { SettingsCard, Field } from './shared';

// Help and support: a contact / feedback form (sent to the app's mailbox,
// with the user's address to reply to), the version running, and answers
// to the questions people ask first.
const KINDS = [
  { value: 'contact', label: 'פנייה כללית' },
  { value: 'bug', label: 'דיווח על תקלה' },
  { value: 'feedback', label: 'משוב' },
  { value: 'suggestion', label: 'הצעה לשיפור' }
];

const FAQ = [
  {
    q: 'האם הנתונים שלי בטוחים?',
    a: 'כן. הנתונים שלכם נשמרים בסודיות ומוצגים רק לכם. התקשורת מוצפנת, הסיסמאות שמורות כגיבוב, פעולות רגישות דורשות אימות מחדש, ונשלחת הודעה במייל על כל שינוי רגיש בחשבון. המידע אינו נמכר ואינו משמש לפרסום. מומלץ להפעיל אימות דו-שלבי. הפרטים המלאים במדיניות הפרטיות.'
  },
  {
    q: 'האם האתר נותן ייעוץ השקעות או ייעוץ מס?',
    a: 'לא. הערכות השווי, ההצעות וחישובי המס הם מידע כללי שמחושב אוטומטית, ואינם ייעוץ השקעות, ייעוץ מס או המלצה לקנות או למכור ניירות ערך. חישובי המס הם אומדן בלבד. לפני כל פעולה התייעצו עם יועץ השקעות מורשה, יועץ מס או רואה חשבון.'
  },
  { q: 'איך מוסיפים נכס או עסקה?', a: 'בכפתור "+ הוספת מידע" שבראש כל עמוד: בוחרים את סוג הנכס, את הפעולה (קנייה, הפקדה, עדכון שווי וכדומה), ומזינים את הפרטים.' },
  { q: 'למה המחיר של מניה לא מתעדכן?', a: 'המחירים מתעדכנים אוטומטית ממקורות שוק חיצוניים. אם מקור לא זמין, יוצג המחיר האחרון הידוע; נסו לרענן מאוחר יותר.' },
  { q: 'איך מחושב המס?', a: '25% על הרווח הריאלי - הרווח שמעבר לעליית המדד (במניות זרות: לשינוי בשער הדולר). זו הערכה בלבד ואינה ייעוץ מס.' },
  { q: 'איך מסתירים סכומים כשמישהו לידי?', a: 'באייקון העין בתפריט, או בהגדרות ← תצוגה ופרטיות. האחוזים נשארים גלויים.' },
  { q: 'איך מוחקים את החשבון?', a: 'בהגדרות ← מחיקת חשבון. במשך 14 יום אפשר לשחזר בכניסה מחדש, ולאחר מכן הכול נמחק לצמיתות.' }
];

function HelpSection({ initialKind = 'contact' }) {
  const toast = useToast();
  const [kind, setKind] = useState(initialKind);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [version, setVersion] = useState(null);

  useEffect(() => {
    getAccount('/api/version').then((r) => r.ok && setVersion(r.data));
  }, []);

  const send = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    const r = await postAccount('/api/account/support', { kind, message: message.trim() });
    setBusy(false);
    if (!r.ok) {
      setError((r.data.fieldErrors && r.data.fieldErrors.message) || r.data.error || 'השליחה נכשלה');
      return;
    }
    setMessage('');
    toast.success('הפנייה נשלחה. נחזור אליכם למייל של החשבון.');
  };

  return (
    <>
      <SettingsCard title="צור קשר, משוב והצעות" description="נשמח לשמוע - על תקלה, רעיון או כל דבר אחר. התשובה תגיע לכתובת המייל של החשבון.">
        <form className="settings-form" onSubmit={send} noValidate>
          <Field label="נושא">
            <select value={kind} onChange={(e) => setKind(e.target.value)} className="auth-input">
              {KINDS.map((k) => (
                <option key={k.value} value={k.value}>
                  {k.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="ההודעה" error={error}>
            <textarea rows={5} maxLength={3000} value={message} onChange={(e) => setMessage(e.target.value)} className="auth-input" required />
          </Field>
          <div className="settings-actions">
            <button type="submit" className="auth-submit" disabled={busy || message.trim().length < 5}>
              {busy ? 'שולח…' : 'שליחה'}
            </button>
          </div>
        </form>
      </SettingsCard>
      <SettingsCard title="שאלות נפוצות">
        <div className="faq-list">
          {FAQ.map((item) => (
            <details key={item.q} className="faq-item">
              <summary>{item.q}</summary>
              <p>{item.a}</p>
            </details>
          ))}
        </div>
      </SettingsCard>
      <SettingsCard title="גרסת האתר">
        <p className="auth-hint" dir="ltr">
          AfikInvest {version ? `v${version.version}${version.commit ? ` (${version.commit})` : ''}` : ''}
        </p>
      </SettingsCard>
    </>
  );
}

export default HelpSection;
