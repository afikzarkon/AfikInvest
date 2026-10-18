import React, { useEffect, useState } from 'react';
import BrandLogo from './ui/BrandLogo';
import { getApiBase, apiUrl } from '../apiBase';
import { postAuth } from '../authApi';
import { setAuthToken } from '../authToken';
import PasswordField from './ui/PasswordField';
import SocialButtons from './auth/SocialButtons';
import Turnstile from './auth/Turnstile';

// The signed-out screen: sign-up, sign-in, a sign-in link by email, a
// forgotten password - and the steps a sign-in can lead to: confirming the
// address with the emailed code, the 2FA code (or a backup code), and
// restoring an account that is waiting out its deletion.
//
// Only the address and a password are required to sign up; the name, the
// marketing opt-in and a referral code are optional. Errors are checked as
// the user types (in Hebrew) and again by the server, whose messages say
// nothing about whether an address has an account.

function vercelMissingApiHint() {
  if (typeof window === 'undefined') return '';
  const host = window.location.hostname || '';
  const noBase = !getApiBase();
  if (noBase && (host.endsWith('vercel.app') || host.includes('vercel')))
    return ' חסרה כתובת השרת: ב-Vercel הוסף משתנה REACT_APP_API_URL (כתובת ה-API) ועשה Redeploy.';
  return '';
}

const NETWORK_ERROR = () => 'לא ניתן להתחבר לשרת. בפיתוח מקומי ודא שהשרת רץ על פורט 5000.' + vercelMissingApiHint();
const NO_API_ERROR = 'לא נמצא שרת API בכתובת הזו. אם האתר על Vercel, הגדר REACT_APP_API_URL בפרויקט והרץ Deploy מחדש.';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const validateEmail = (v) => (!v.trim() ? 'יש להזין כתובת אימייל' : EMAIL_RE.test(v.trim()) ? '' : 'כתובת האימייל אינה תקינה');
const validatePassword = (v) => (!v ? 'יש להזין סיסמה' : v.length < 8 ? 'הסיסמה חייבת להכיל לפחות 8 תווים' : new TextEncoder().encode(v).length > 72 ? 'הסיסמה ארוכה מדי' : '');

const DEFAULT_OPTIONS = { providers: {}, magicLink: true, turnstileSiteKey: '', oauthBaseUrl: '' };

function formatDateHe(iso) {
  try {
    return new Date(iso).toLocaleDateString('he-IL', { day: 'numeric', month: 'long', year: 'numeric' });
  } catch {
    return '';
  }
}

// onAuthenticated(user, token, meta) - meta: { remember, newUser, verified,
// passwordWithheld } for the first-run steps that follow.
// initialOutcome: a sign-in answer that arrived elsewhere (a link from an
// email, the return from Google) and still needs a step here - 2FA, a
// restore, verification.
function AuthView({ onAuthenticated, initialMode = 'register', initialNotice = '', initialEmail = '', initialOutcome = null, initialOutcomeMeta = {} }) {
  const [options, setOptions] = useState(DEFAULT_OPTIONS);
  const [mode, setMode] = useState(initialMode);
  const [email, setEmail] = useState(initialEmail);
  const [password, setPassword] = useState('');
  const [fullName, setFullName] = useState('');
  const [acceptTerms, setAcceptTerms] = useState(false);
  const [marketing, setMarketing] = useState(false);
  const [referral, setReferral] = useState('');
  const [showReferral, setShowReferral] = useState(false);
  const [honeypot, setHoneypot] = useState('');
  const [remember, setRemember] = useState(true);
  const [turnstileToken, setTurnstileToken] = useState('');
  const [code, setCode] = useState('');
  const [useBackupCode, setUseBackupCode] = useState(false);
  const [challengeToken, setChallengeToken] = useState('');
  const [restore, setRestore] = useState(null); // { restoreToken, purgeAfter }
  const [touched, setTouched] = useState({});
  const [fieldErrors, setFieldErrors] = useState({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState(initialNotice);
  const [resendIn, setResendIn] = useState(0);

  useEffect(() => {
    let cancelled = false;
    fetch(apiUrl('/api/auth/options'), { credentials: 'include' })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!cancelled && data) setOptions({ ...DEFAULT_OPTIONS, ...data });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (initialOutcome) handleOutcome(initialOutcome, initialOutcomeMeta);
    // Once, on arrival.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (resendIn <= 0) return undefined;
    const t = setTimeout(() => setResendIn((s) => s - 1), 1000);
    return () => clearTimeout(t);
  }, [resendIn]);

  const switchMode = (next) => {
    setMode(next);
    setError('');
    setNotice('');
    setCode('');
    setFieldErrors({});
    setTouched({});
    setUseBackupCode(false);
    if (next !== 'twoFactor') setChallengeToken('');
  };

  // What a sign-in step answered with: the next step, or the session.
  const handleOutcome = (data, meta = {}) => {
    if (data.verificationRequired) {
      setEmail(data.email || email);
      setPassword('');
      setMode('verify');
      setCode('');
      setResendIn(60);
      setNotice(`שלחנו קוד אימות ל-${data.email || email}. הזינו אותו כאן או לחצו על הקישור במייל.`);
      return;
    }
    if (data.twoFactorRequired) {
      setChallengeToken(data.challengeToken);
      setPassword('');
      setMode('twoFactor');
      return;
    }
    if (data.deletionPending) {
      setRestore({ restoreToken: data.restoreToken, purgeAfter: data.purgeAfter });
      setMode('restore');
      return;
    }
    if (data.user) {
      const rememberChoice = data.remember !== undefined ? data.remember : remember;
      if (data.token) setAuthToken(data.token, { remember: rememberChoice });
      onAuthenticated(data.user, data.token || '', { remember: rememberChoice, ...meta, newUser: meta.newUser || Boolean(data.verified), passwordWithheld: Boolean(data.passwordWithheld) });
      return;
    }
    setError('תגובת שרת לא תקינה. נסה שוב או בדוק הגדרות API.' + vercelMissingApiHint());
  };

  // One request with the shared loading/error handling.
  const run = async (path, body, onOk) => {
    setError('');
    setLoading(true);
    try {
      const r = await postAuth(path, body);
      if (!r.ok) {
        if (r.status === 404 && !r.isJson) {
          setError(NO_API_ERROR);
          return;
        }
        if (r.data.restart) switchMode('login');
        if (r.data.fieldErrors) setFieldErrors(r.data.fieldErrors);
        setError(r.data.error || 'אירעה שגיאה, נסה שוב');
        return;
      }
      onOk(r.data);
    } catch {
      setError(NETWORK_ERROR());
    } finally {
      setLoading(false);
    }
  };

  // ----- client-side checks, shown once a field has been left -----
  const liveErrors = {
    email: validateEmail(email),
    password: mode === 'register' ? validatePassword(password) : !password ? 'יש להזין סיסמה' : '',
    acceptTerms: acceptTerms ? '' : 'יש לאשר את תנאי השימוש ומדיניות הפרטיות'
  };
  const shownError = (field) => (touched[field] ? liveErrors[field] : '') || fieldErrors[field] || '';
  const touch = (field) => setTouched((t) => ({ ...t, [field]: true }));
  const clearServerError = (field) => setFieldErrors((f) => ({ ...f, [field]: undefined }));

  const submitRegister = (e) => {
    e.preventDefault();
    setTouched({ email: true, password: true, acceptTerms: true });
    if (liveErrors.email || liveErrors.password || liveErrors.acceptTerms) {
      setError('יש לתקן את השדות המסומנים');
      return;
    }
    run(
      '/api/auth/register',
      {
        email: email.trim(),
        password,
        fullName: fullName.trim() || undefined,
        acceptTerms: true,
        marketingOptIn: marketing,
        referralCode: referral.trim() || undefined,
        turnstileToken: turnstileToken || undefined,
        website: honeypot || undefined
      },
      (data) => handleOutcome(data)
    );
  };

  const submitLogin = (e) => {
    e.preventDefault();
    setTouched({ email: true, password: true });
    if (liveErrors.email || liveErrors.password) return;
    run('/api/auth/login', { email: email.trim(), password, remember }, (data) => handleOutcome(data));
  };

  const submitVerifyCode = (e) => {
    e.preventDefault();
    run('/api/auth/verify-email/code', { email: email.trim(), code, remember }, (data) => handleOutcome(data, { newUser: true }));
  };

  const resendVerification = () => {
    run('/api/auth/verify-email/resend', { email: email.trim() }, (data) => {
      setNotice(data.message || 'נשלח מייל חדש');
      setResendIn(60);
    });
  };

  const submitTwoFactor = (e) => {
    e.preventDefault();
    run('/api/auth/login/2fa', { challengeToken, code }, (data) => {
      if (typeof data.backupCodesLeft === 'number') {
        try {
          sessionStorage.setItem('afikinvest_backup_codes_left', String(data.backupCodesLeft));
        } catch {
          /* ignore */
        }
      }
      handleOutcome(data);
    });
  };

  const submitRestore = () => run('/api/auth/restore', { restoreToken: restore.restoreToken }, (data) => handleOutcome(data));

  const submitForgot = (e) => {
    e.preventDefault();
    touch('email');
    if (liveErrors.email) return;
    run('/api/auth/forgot-password', { email: email.trim() }, (data) => setNotice(data.message || 'אם הכתובת רשומה במערכת, נשלח אליה קישור לאיפוס הסיסמה'));
  };

  const submitMagic = (e) => {
    e.preventDefault();
    touch('email');
    if (liveErrors.email) return;
    run('/api/auth/magic-link', { email: email.trim(), turnstileToken: turnstileToken || undefined }, (data) =>
      setNotice(`${data.message || 'אם הכתובת רשומה במערכת, נשלח אליה קישור כניסה'}. הקישור תקף ל-15 דקות.`)
    );
  };

  const providerHref = (provider) => `${options.oauthBaseUrl || getApiBase()}/api/auth/oauth/${provider}?remember=${remember ? 1 : 0}`;

  // ----- pieces -----
  const errorBox = error ? (
    <div className="auth-error" role="alert">
      {error}
    </div>
  ) : null;
  const noticeBox = notice ? (
    <div className="auth-notice" role="status">
      {notice}
    </div>
  ) : null;

  const emailField = (
    <div className="auth-field">
      <label className="auth-label" htmlFor="auth-email">
        אימייל
      </label>
      <input
        id="auth-email"
        className={`auth-input ${shownError('email') ? 'has-error' : ''}`}
        type="email"
        dir="ltr"
        autoComplete="email"
        value={email}
        onChange={(ev) => {
          setEmail(ev.target.value);
          clearServerError('email');
        }}
        onBlur={() => touch('email')}
        required
        maxLength={254}
        aria-invalid={shownError('email') ? 'true' : undefined}
        aria-describedby={shownError('email') ? 'auth-email-error' : undefined}
      />
      {shownError('email') ? (
        <span id="auth-email-error" className="field-error" role="alert">
          {shownError('email')}
        </span>
      ) : null}
    </div>
  );

  const rememberBox = (
    <label className="auth-check">
      <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
      <span>זכור אותי במכשיר הזה</span>
    </label>
  );

  const codeField = (label, hint) => (
    <div className="auth-field">
      <label className="auth-label" htmlFor="auth-code">
        {label}
      </label>
      <input
        id="auth-code"
        className="auth-input auth-code-input"
        type="text"
        dir="ltr"
        inputMode={useBackupCode ? 'text' : 'numeric'}
        autoComplete="one-time-code"
        maxLength={useBackupCode ? 11 : 6}
        value={code}
        onChange={(ev) => setCode(useBackupCode ? ev.target.value.slice(0, 11) : ev.target.value.replace(/\D/g, '').slice(0, 6))}
        required
        autoFocus
        aria-describedby={hint ? 'auth-code-hint' : undefined}
      />
      {hint ? (
        <span id="auth-code-hint" className="auth-hint">
          {hint}
        </span>
      ) : null}
    </div>
  );

  let body;
  let subtitle = 'ניהול תיק השקעות — היכנסו או הירשמו';

  if (mode === 'verify') {
    subtitle = 'אימות כתובת האימייל';
    body = (
      <form className="auth-form" onSubmit={submitVerifyCode} noValidate>
        {noticeBox}
        {codeField('קוד אימות (6 ספרות)')}
        {rememberBox}
        {errorBox}
        <button type="submit" className="auth-submit" disabled={loading || code.length !== 6}>
          {loading ? 'מאמת…' : 'אימות והמשך'}
        </button>
        <button type="button" className="auth-link" onClick={resendVerification} disabled={loading || resendIn > 0}>
          {resendIn > 0 ? `שליחה חוזרת בעוד ${resendIn} שניות` : 'לא קיבלתם? שליחה חוזרת'}
        </button>
        <button type="button" className="auth-link" onClick={() => switchMode('login')}>
          חזרה להתחברות
        </button>
      </form>
    );
  } else if (mode === 'twoFactor') {
    subtitle = 'אימות דו-שלבי';
    body = (
      <form className="auth-form" onSubmit={submitTwoFactor} noValidate>
        <p className="auth-step-text">
          {useBackupCode ? 'הזינו אחד מקודי הגיבוי ששמרתם. כל קוד עובד פעם אחת.' : 'הזינו את הקוד בן 6 הספרות מאפליקציית האימות (Google Authenticator וכדומה).'}
        </p>
        {codeField(useBackupCode ? 'קוד גיבוי' : 'קוד אימות')}
        {errorBox}
        <button type="submit" className="auth-submit" disabled={loading || (useBackupCode ? code.replace(/[^a-z0-9]/gi, '').length !== 10 : code.length !== 6)}>
          {loading ? 'מאמת…' : 'אימות והתחברות'}
        </button>
        <button
          type="button"
          className="auth-link"
          onClick={() => {
            setUseBackupCode((v) => !v);
            setCode('');
          }}
        >
          {useBackupCode ? 'חזרה לקוד מהאפליקציה' : 'אין לי גישה לאפליקציה - שימוש בקוד גיבוי'}
        </button>
        <button type="button" className="auth-link" onClick={() => switchMode('login')}>
          חזרה להתחברות
        </button>
      </form>
    );
  } else if (mode === 'restore' && restore) {
    subtitle = 'החשבון ממתין למחיקה';
    body = (
      <div className="auth-form">
        <p className="auth-step-text">
          ביקשתם למחוק את החשבון. הוא יימחק לצמיתות ב-<strong>{formatDateHe(restore.purgeAfter)}</strong>. רוצים לשחזר אותו? כל הנתונים נשארו כפי שהיו.
        </p>
        {errorBox}
        <button type="button" className="auth-submit" onClick={submitRestore} disabled={loading}>
          {loading ? 'משחזר…' : 'שחזור החשבון'}
        </button>
        <button type="button" className="auth-link" onClick={() => switchMode('login')}>
          לא עכשיו
        </button>
      </div>
    );
  } else if (mode === 'forgot' || mode === 'magic') {
    const isMagic = mode === 'magic';
    subtitle = isMagic ? 'כניסה עם קישור למייל' : 'איפוס סיסמה';
    body = (
      <form className="auth-form" onSubmit={isMagic ? submitMagic : submitForgot} noValidate>
        <p className="auth-step-text">
          {isMagic ? 'הזינו את כתובת האימייל של החשבון, ונשלח קישור שמכניס אתכם בלי סיסמה.' : 'הזינו את כתובת האימייל של החשבון ונשלח קישור לבחירת סיסמה חדשה.'}
        </p>
        {emailField}
        {isMagic ? <Turnstile siteKey={options.turnstileSiteKey} onToken={setTurnstileToken} /> : null}
        {errorBox}
        {noticeBox}
        <button type="submit" className="auth-submit" disabled={loading}>
          {loading ? 'שולח…' : isMagic ? 'שליחת קישור כניסה' : 'שליחת קישור איפוס'}
        </button>
        <button type="button" className="auth-link" onClick={() => switchMode('login')}>
          חזרה להתחברות
        </button>
      </form>
    );
  } else {
    const isRegister = mode === 'register';
    body = (
      <>
        <div className="auth-tabs" role="tablist" aria-label="הרשמה או התחברות">
          <button type="button" role="tab" aria-selected={isRegister} className={`auth-tab ${isRegister ? 'active' : ''}`} onClick={() => switchMode('register')}>
            הרשמה
          </button>
          <button type="button" role="tab" aria-selected={!isRegister} className={`auth-tab ${!isRegister ? 'active' : ''}`} onClick={() => switchMode('login')}>
            התחברות
          </button>
        </div>

        <SocialButtons providers={options.providers} href={providerHref} />

        <form className="auth-form" onSubmit={isRegister ? submitRegister : submitLogin} noValidate>
          {isRegister ? (
            <div className="auth-field">
              <label className="auth-label" htmlFor="auth-name">
                שם <span className="auth-hint">(לא חובה)</span>
              </label>
              <input id="auth-name" className="auth-input" type="text" autoComplete="name" value={fullName} onChange={(e) => setFullName(e.target.value)} maxLength={80} />
            </div>
          ) : null}
          {emailField}
          <PasswordField
            label="סיסמה"
            value={password}
            onChange={(v) => {
              setPassword(v);
              clearServerError('password');
            }}
            onBlur={() => touch('password')}
            autoComplete={isRegister ? 'new-password' : 'current-password'}
            showStrength={isRegister}
            error={shownError('password')}
          />

          {isRegister ? (
            <>
              {/* A field people never see: bots that fill every input give
                  themselves away. Hidden from screen readers and the tab order. */}
              <div className="hp-field" aria-hidden="true">
                <label htmlFor="auth-website">אתר</label>
                <input id="auth-website" type="text" tabIndex={-1} autoComplete="off" value={honeypot} onChange={(e) => setHoneypot(e.target.value)} />
              </div>
              <label className={`auth-check ${shownError('acceptTerms') ? 'has-error' : ''}`}>
                <input
                  type="checkbox"
                  checked={acceptTerms}
                  onChange={(e) => {
                    setAcceptTerms(e.target.checked);
                    touch('acceptTerms');
                  }}
                  aria-invalid={shownError('acceptTerms') ? 'true' : undefined}
                  aria-describedby={shownError('acceptTerms') ? 'auth-terms-error' : undefined}
                />
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
              {shownError('acceptTerms') ? (
                <span id="auth-terms-error" className="field-error" role="alert">
                  {shownError('acceptTerms')}
                </span>
              ) : null}
              <label className="auth-check">
                <input type="checkbox" checked={marketing} onChange={(e) => setMarketing(e.target.checked)} />
                <span>אשמח לקבל עדכונים וטיפים במייל (אפשר לבטל בכל עת)</span>
              </label>
              {showReferral ? (
                <div className="auth-field">
                  <label className="auth-label" htmlFor="auth-referral">
                    קוד הזמנה <span className="auth-hint">(לא חובה)</span>
                  </label>
                  <input id="auth-referral" className="auth-input" type="text" dir="ltr" value={referral} onChange={(e) => setReferral(e.target.value)} maxLength={40} />
                  {fieldErrors.referralCode ? <span className="field-error">{fieldErrors.referralCode}</span> : null}
                </div>
              ) : (
                <button type="button" className="auth-link auth-link-inline" onClick={() => setShowReferral(true)}>
                  יש לי קוד הזמנה
                </button>
              )}
              <Turnstile siteKey={options.turnstileSiteKey} onToken={setTurnstileToken} />
            </>
          ) : (
            rememberBox
          )}

          {noticeBox}
          {errorBox}

          <button type="submit" className="auth-submit" disabled={loading}>
            {loading ? 'מעבד…' : isRegister ? 'יצירת חשבון' : 'התחברות'}
          </button>
          {!isRegister ? (
            <div className="auth-links-row">
              <button type="button" className="auth-link" onClick={() => switchMode('forgot')}>
                שכחתי סיסמה
              </button>
              {options.magicLink ? (
                <button type="button" className="auth-link" onClick={() => switchMode('magic')}>
                  כניסה עם קישור למייל
                </button>
              ) : null}
            </div>
          ) : null}
        </form>
      </>
    );
  }

  return (
    <div className="auth-screen">
      <div className="auth-card">
        <div className="auth-brand">
          <BrandLogo variant="full" />
        </div>
        <h1 className="auth-title">אפיק ההשקעות שלך</h1>
        <p className="auth-subtitle">{subtitle}</p>
        {body}
        <p className="auth-legal-links">
          <a href="/terms">תנאי שימוש</a> · <a href="/privacy">מדיניות פרטיות</a>
        </p>
      </div>
    </div>
  );
}

export default AuthView;
