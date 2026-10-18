import React, { useState } from 'react';
import { postAccount } from '../../accountApi';
import PasswordField from '../ui/PasswordField';
import { SettingsCard, Field } from './shared';
import { ExportButtons } from './DataSection';

// Deleting the account. Re-authenticated (the password - or a fresh sign-in
// for an account without one - and the 2FA code when it is on), confirmed
// by typing a word, and reversible for 14 days by signing in again; after
// that everything is deleted for good. The "why are you leaving" answer is
// optional and stored with nothing that leads back to the account.
const CONFIRM_WORD = 'מחק';
const REASONS = [
  { value: '', label: 'לא רוצה לענות' },
  { value: 'not_useful', label: 'האתר לא שימושי לי' },
  { value: 'missing_features', label: 'חסרות לי תכונות' },
  { value: 'too_complex', label: 'מסובך מדי לשימוש' },
  { value: 'privacy', label: 'דאגה לפרטיות' },
  { value: 'other_tool', label: 'עברתי לכלי אחר' },
  { value: 'other', label: 'סיבה אחרת' }
];

function DeleteSection({ account, onDeleted, onLogout }) {
  const user = account.user;
  const [step, setStep] = useState('intro'); // intro | confirm | done
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [confirm, setConfirm] = useState('');
  const [reason, setReason] = useState('');
  const [comment, setComment] = useState('');
  const [error, setError] = useState('');
  const [reauth, setReauth] = useState('');
  const [busy, setBusy] = useState(false);
  const [purgeAfter, setPurgeAfter] = useState('');

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    setReauth('');
    const r = await postAccount('/api/account/delete', { confirm, password, code, reason, comment: comment.trim() });
    setBusy(false);
    if (!r.ok) {
      setError(r.data.error || 'המחיקה נכשלה');
      setReauth(r.data.reauth || '');
      return;
    }
    setPurgeAfter(r.data.purgeAfter);
    setStep('done');
  };

  if (step === 'done') {
    const date = new Date(purgeAfter).toLocaleDateString('he-IL', { day: 'numeric', month: 'long', year: 'numeric' });
    return (
      <SettingsCard title="החשבון ימחק" tone="danger">
        <p className="auth-step-text">
          החשבון נותק מכל המכשירים ויימחק לצמיתות ב-<strong>{date}</strong>. עד אז אפשר לשחזר אותו פשוט על ידי כניסה מחדש. שלחנו אישור למייל.
        </p>
        <button type="button" className="auth-submit" onClick={onDeleted}>
          סיום
        </button>
      </SettingsCard>
    );
  }

  return (
    <>
      <SettingsCard
        title="מחיקת חשבון"
        tone="danger"
        description="מחיקת החשבון מוחקת את כל הנתונים: התיק, העסקאות, תמונות המצב, ההעדפות, הפרופיל והחיבורים ל-Google/Facebook. במשך 14 יום אפשר לשחזר את החשבון בכניסה מחדש; לאחר מכן המחיקה סופית ואי אפשר לבטל אותה."
      >
        <p className="auth-step-text">מומלץ להוריד קודם עותק של הנתונים:</p>
        <ExportButtons />
        {step === 'intro' ? (
          <div className="settings-actions">
            <button type="button" className="settings-button is-danger" onClick={() => setStep('confirm')}>
              אני רוצה למחוק את החשבון
            </button>
          </div>
        ) : (
          <form className="settings-form" onSubmit={submit} noValidate>
            <Field label="למה אתם עוזבים?" optional hint="אנונימי - נשמר בלי שום קשר לחשבון.">
              <select value={reason} onChange={(e) => setReason(e.target.value)} className="auth-input">
                {REASONS.map((r) => (
                  <option key={r.value} value={r.value}>
                    {r.label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="משהו נוסף?" optional>
              <textarea rows={3} maxLength={1000} value={comment} onChange={(e) => setComment(e.target.value)} className="auth-input" />
            </Field>
            {user.hasPassword ? (
              <PasswordField label="הסיסמה שלכם" value={password} onChange={setPassword} />
            ) : (
              <p className="auth-hint">לחשבון אין סיסמה: לאישור המחיקה צריך כניסה מהדקות האחרונות.</p>
            )}
            {user.twoFactorEnabled ? (
              <Field label="קוד אימות דו-שלבי (או קוד גיבוי)">
                <input type="text" dir="ltr" className="auth-input auth-code-input" autoComplete="one-time-code" maxLength={11} value={code} onChange={(e) => setCode(e.target.value.slice(0, 11))} />
              </Field>
            ) : null}
            <Field label={`לאישור, הקלידו: ${CONFIRM_WORD}`}>
              <input type="text" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="off" />
            </Field>
            {error ? (
              <div className="auth-error" role="alert">
                {error}
                {reauth === 'fresh_login' ? (
                  <>
                    {' '}
                    <button type="button" className="auth-link auth-link-inline" onClick={onLogout}>
                      יציאה והתחברות מחדש
                    </button>
                  </>
                ) : null}
              </div>
            ) : null}
            <div className="settings-actions">
              <button type="submit" className="auth-submit auth-submit-danger" disabled={busy || confirm.trim() !== CONFIRM_WORD}>
                {busy ? 'מוחק…' : 'מחיקת החשבון'}
              </button>
              <button type="button" className="auth-link" onClick={() => setStep('intro')}>
                ביטול
              </button>
            </div>
          </form>
        )}
      </SettingsCard>
    </>
  );
}

export default DeleteSection;
