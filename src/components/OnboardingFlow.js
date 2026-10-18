import React, { useEffect, useRef, useState } from 'react';
import { postAccount, putAccount } from '../accountApi';

// What a new account sees first - every step optional.
//
// OnboardingModal: three short steps after sign-up (the investment goal and
// experience, the main currency and how they heard of the site, then
// "add your first investment" or "load the demo portfolio"). Any step can
// be skipped and the whole thing closed; nothing here is required.
//
// TermsGate: an account opened through Google/Facebook never saw the
// sign-up form's terms checkbox, so it accepts them here once.
//
// ProfilePrompt: a quiet, dismissable note that the profile can be
// completed - never blocking, and gone for good once dismissed.

const GOALS = [
  { value: 'growth', label: 'צמיחה לטווח ארוך' },
  { value: 'retirement', label: 'חיסכון לפרישה' },
  { value: 'income', label: 'הכנסה שוטפת (דיבידנדים)' },
  { value: 'saving', label: 'חיסכון למטרה' },
  { value: 'learning', label: 'ללמוד ולהתנסות' },
  { value: 'other', label: 'אחר' }
];
const EXPERIENCE = [
  { value: 'beginner', label: 'מתחיל/ה' },
  { value: 'intermediate', label: 'עם קצת ניסיון' },
  { value: 'advanced', label: 'מנוסה' }
];
const HEARD = [
  { value: 'friend', label: 'חבר/ה' },
  { value: 'search', label: 'חיפוש בגוגל' },
  { value: 'social', label: 'רשתות חברתיות' },
  { value: 'article', label: 'כתבה או בלוג' },
  { value: 'ad', label: 'פרסומת' },
  { value: 'other', label: 'אחר' }
];
const CURRENCIES = [
  { value: 'ILS', label: '₪ שקל' },
  { value: 'USD', label: '$ דולר' },
  { value: 'EUR', label: '€ אירו' }
];

function Choices({ legend, options, value, onChange, name }) {
  return (
    <fieldset className="choice-group">
      <legend className="auth-label">{legend}</legend>
      <div className="choice-options">
        {options.map((o) => (
          <label key={o.value} className={`choice ${value === o.value ? 'is-selected' : ''}`}>
            <input type="radio" name={name} value={o.value} checked={value === o.value} onChange={() => onChange(o.value)} />
            <span>{o.label}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

// A dialog that takes focus on open and gives it back on close.
function useDialogFocus(onEscape) {
  const ref = useRef(null);
  useEffect(() => {
    const previous = document.activeElement;
    const first = ref.current && ref.current.querySelector('input, button, select, textarea');
    if (first) first.focus();
    const onKey = (e) => {
      if (e.key === 'Escape' && onEscape) onEscape();
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      if (previous && previous.focus) previous.focus();
    };
    // On open only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return ref;
}

export function OnboardingModal({ displayName, onClose, onAddInvestment, onLoadDemo, onCurrency }) {
  const [step, setStep] = useState(0);
  const [answers, setAnswers] = useState({ goal: '', experience: '', heardFrom: '', mainCurrency: 'ILS' });
  const finish = async (then) => {
    const extra = { onboardingDone: true };
    ['goal', 'experience', 'heardFrom'].forEach((k) => {
      if (answers[k]) extra[k] = answers[k];
    });
    await putAccount('/api/account/profile/extra', extra);
    if (answers.mainCurrency !== 'ILS') await onCurrency(answers.mainCurrency);
    onClose();
    if (then) then();
  };
  const ref = useDialogFocus(() => finish());
  const set = (k) => (v) => setAnswers((a) => ({ ...a, [k]: v }));
  const steps = 3;

  return (
    <div className="modal-overlay" role="dialog" aria-modal="true" aria-labelledby="onboarding-title">
      <div className="modal-card onboarding-card" ref={ref}>
        <button type="button" className="modal-close" onClick={() => finish()} aria-label="סגירה">
          ×
        </button>
        <div className="onboarding-progress" aria-hidden="true">
          {Array.from({ length: steps }, (_, i) => (
            <span key={i} className={i <= step ? 'is-done' : ''} />
          ))}
        </div>
        <p className="auth-hint">
          שלב {step + 1} מתוך {steps} · אפשר לדלג
        </p>

        {step === 0 ? (
          <>
            <h2 id="onboarding-title" className="settings-card-title">
              ברוכים הבאים{displayName ? `, ${displayName}` : ''}!
            </h2>
            <p className="auth-step-text">כמה שאלות קצרות, כדי שנכיר. כולן לא חובה.</p>
            <Choices legend="מה מטרת ההשקעה העיקרית?" name="goal" options={GOALS} value={answers.goal} onChange={set('goal')} />
            <Choices legend="מה רמת הניסיון שלכם?" name="experience" options={EXPERIENCE} value={answers.experience} onChange={set('experience')} />
          </>
        ) : null}
        {step === 1 ? (
          <>
            <h2 id="onboarding-title" className="settings-card-title">
              כמה פרטים נוספים
            </h2>
            <Choices legend="באיזה מטבע להציג את השווי הכולל?" name="currency" options={CURRENCIES} value={answers.mainCurrency} onChange={set('mainCurrency')} />
            <Choices legend="איך שמעתם עלינו?" name="heard" options={HEARD} value={answers.heardFrom} onChange={set('heardFrom')} />
          </>
        ) : null}
        {step === 2 ? (
          <>
            <h2 id="onboarding-title" className="settings-card-title">
              מתחילים
            </h2>
            <p className="auth-step-text">הוסיפו את ההשקעה הראשונה, או טענו תיק לדוגמה עם נתונים בדויים כדי לראות איך הכול עובד.</p>
            <div className="onboarding-actions">
              <button type="button" className="auth-submit" onClick={() => finish(onAddInvestment)}>
                + הוספת ההשקעה הראשונה
              </button>
              <button type="button" className="settings-button" onClick={() => finish(onLoadDemo)}>
                טעינת נתוני דמו
              </button>
            </div>
          </>
        ) : null}

        <div className="settings-actions onboarding-nav">
          {step < steps - 1 ? (
            <button type="button" className="auth-submit" onClick={() => setStep((s) => s + 1)}>
              המשך
            </button>
          ) : null}
          {step < steps - 1 ? (
            <button type="button" className="auth-link" onClick={() => setStep((s) => s + 1)}>
              דילוג
            </button>
          ) : (
            <button type="button" className="auth-link" onClick={() => finish()}>
              אחר כך
            </button>
          )}
          {step > 0 ? (
            <button type="button" className="auth-link" onClick={() => setStep((s) => s - 1)}>
              חזרה
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

export function TermsGate({ onAccepted, onLogout }) {
  const [accept, setAccept] = useState(false);
  const [marketing, setMarketing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const ref = useDialogFocus(null);
  const submit = async (e) => {
    e.preventDefault();
    if (!accept) {
      setError('יש לאשר את תנאי השימוש ומדיניות הפרטיות כדי להמשיך');
      return;
    }
    setBusy(true);
    const r = await postAccount('/api/account/accept-terms', { marketing });
    setBusy(false);
    if (!r.ok) {
      setError(r.data.error || 'אירעה שגיאה, נסו שוב');
      return;
    }
    onAccepted();
  };
  return (
    <div className="modal-overlay" role="dialog" aria-modal="true" aria-labelledby="terms-title">
      <form className="modal-card" ref={ref} onSubmit={submit} noValidate>
        <h2 id="terms-title" className="settings-card-title">
          עוד צעד אחד
        </h2>
        <p className="auth-step-text">כדי להשתמש ב-AfikInvest, אשרו את תנאי השימוש ומדיניות הפרטיות.</p>
        <label className="auth-check">
          <input type="checkbox" checked={accept} onChange={(e) => setAccept(e.target.checked)} />
          <span>
            קראתי ואני מסכים/ה ל
            <a href="/terms" target="_blank" rel="noopener noreferrer">
              תנאי השימוש
            </a>{' '}
            ול
            <a href="/privacy" target="_blank" rel="noopener noreferrer">
              מדיניות הפרטיות
            </a>
          </span>
        </label>
        <label className="auth-check">
          <input type="checkbox" checked={marketing} onChange={(e) => setMarketing(e.target.checked)} />
          <span>אשמח לקבל עדכונים וטיפים במייל (לא חובה)</span>
        </label>
        {error ? (
          <div className="auth-error" role="alert">
            {error}
          </div>
        ) : null}
        <div className="settings-actions">
          <button type="submit" className="auth-submit" disabled={busy}>
            {busy ? 'שומר…' : 'אישור והמשך'}
          </button>
          <button type="button" className="auth-link" onClick={onLogout}>
            יציאה
          </button>
        </div>
      </form>
    </div>
  );
}

export function ProfilePrompt({ completion, onComplete, onDismiss }) {
  return (
    <div className="profile-prompt" role="status">
      <span>
        השלמת פרופיל: {completion}% <span className="auth-hint">(לא חובה)</span>
      </span>
      <div className="profile-prompt-actions">
        <button type="button" className="auth-link auth-link-inline" onClick={onComplete}>
          להשלמה
        </button>
        <button type="button" className="auth-link auth-link-inline" onClick={onDismiss}>
          לא להזכיר שוב
        </button>
      </div>
    </div>
  );
}
