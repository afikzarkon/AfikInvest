import React, { useEffect, useRef, useState } from 'react';
import { apiUrl } from '../apiBase';
import { postAuth } from '../authApi';
import { setAuthToken } from '../authToken';
import AuthView from './AuthView';

// The pages a link from an email (or the return from Google/Facebook)
// opens. Each reads its token from the address, takes it out of the
// address bar at once (so it stays out of history), makes one call, and
// either signs the user in, hands over to the sign-in screen for a step
// still missing (2FA, restore, verification), or says what happened.
export const ACCOUNT_LINK_PATHS = [
  '/verify-email',
  '/magic-link',
  '/auth/callback',
  '/confirm-email-change',
  '/cancel-email-change',
  '/confirm-link',
  '/unsubscribe',
  '/data-deletion-status'
];

export function accountLinkFromUrl() {
  if (typeof window === 'undefined') return null;
  const path = window.location.pathname.replace(/\/+$/, '');
  if (!ACCOUNT_LINK_PATHS.includes(path)) return null;
  return { path, params: Object.fromEntries(new URLSearchParams(window.location.search)) };
}

const OAUTH_ERRORS = {
  cancelled: 'הכניסה בוטלה.',
  failed: 'הכניסה דרך הספק נכשלה. נסו שוב.',
  email_missing: 'הספק לא שיתף כתובת אימייל, ובלעדיה אי אפשר לפתוח חשבון. אפשר להירשם עם אימייל וסיסמה.',
  provider_unavailable: 'הכניסה הזו אינה זמינה כרגע.',
  link_expired: 'בקשת החיבור פגה. נסו שוב מההגדרות.',
  server: 'אירעה שגיאה. נסו שוב.'
};

const UNSUBSCRIBE_LABELS = {
  all: 'כל ההודעות שאינן הודעות אבטחה',
  product_updates: 'עדכוני מוצר וטיפים',
  weekly_summary: 'סיכום שבועי',
  monthly_summary: 'סיכום חודשי',
  price_alerts: 'התראות מחיר',
  reminders: 'תזכורות'
};

function AccountLinkView({ link, onAuthenticated, onDone }) {
  const { path, params } = link;
  const [state, setState] = useState({ status: 'loading', message: '' });
  const [handover, setHandover] = useState(null); // { outcome, meta }
  const started = useRef(false);

  const signInWith = (data, meta = {}) => {
    if (data.user && data.token) {
      setAuthToken(data.token, { remember: data.remember !== false });
      onAuthenticated(data.user, data.token, { remember: data.remember !== false, ...meta, passwordWithheld: Boolean(data.passwordWithheld) });
      return;
    }
    setHandover({ outcome: data, meta });
  };

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    window.history.replaceState({}, '', path);
    const token = params.token || '';

    const post = async (apiPath, body, onOk) => {
      try {
        const r = await postAuth(apiPath, body);
        if (!r.ok) {
          setState({ status: 'error', message: r.data.error || 'הקישור אינו תקין או שפג תוקפו.' });
          return;
        }
        onOk(r.data);
      } catch {
        setState({ status: 'error', message: 'לא ניתן להתחבר לשרת. נסו שוב.' });
      }
    };

    switch (path) {
      case '/verify-email':
        post('/api/auth/verify-email', { token, remember: true }, (data) => signInWith(data, { newUser: true }));
        break;
      case '/magic-link':
        post('/api/auth/magic-link/verify', { token, remember: true }, (data) => signInWith(data));
        break;
      case '/confirm-link':
        post('/api/auth/oauth/confirm-link', { token }, (data) => signInWith(data));
        break;
      case '/auth/callback':
        if (params.error) {
          setState({ status: 'error', message: OAUTH_ERRORS[params.error] || OAUTH_ERRORS.failed });
        } else if (params.status === 'link_confirmation_sent') {
          setState({
            status: 'info',
            message: `כבר יש חשבון עם הכתובת הזו. כדי לחבר אליו את החשבון החיצוני, שלחנו קישור אישור ל-${params.email || 'כתובת החשבון'}.`
          });
        } else {
          post('/api/auth/oauth/exchange', { code: params.code || '' }, (data) => signInWith(data, { newUser: Boolean(data.newUser) }));
        }
        break;
      case '/confirm-email-change':
        post('/api/account/email/confirm', { token }, (data) => setState({ status: 'ok', message: `כתובת האימייל עודכנה ל-${data.email}.` }));
        break;
      case '/cancel-email-change':
        post('/api/account/email/cancel', { token }, () =>
          setState({ status: 'ok', message: 'השינוי בוטל והחשבון נשאר עם הכתובת הזו. אם השינוי כבר בוצע, כל המכשירים נותקו ונשלח אליכם קישור לבחירת סיסמה חדשה.' })
        );
        break;
      case '/unsubscribe':
        setState({ status: 'confirm', message: '' });
        break;
      case '/data-deletion-status':
        fetch(apiUrl(`/api/auth/facebook/data-deletion/status?code=${encodeURIComponent(params.code || '')}`))
          .then((r) => r.json())
          .then((d) =>
            setState(
              d.status === 'deleted'
                ? { status: 'ok', message: 'המידע שהתקבל מ-Facebook (החיבור לחשבון והשם) נמחק. החשבון ב-AfikInvest עצמו לא נמחק - אפשר למחוק אותו בהגדרות.' }
                : { status: 'error', message: 'לא נמצאה בקשת מחיקה עם הקוד הזה.' }
            )
          )
          .catch(() => setState({ status: 'error', message: 'לא ניתן לבדוק את הסטטוס כרגע.' }));
        break;
      default:
        setState({ status: 'error', message: 'הקישור אינו מוכר.' });
    }
    // Once per link.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const unsubscribe = async () => {
    setState({ status: 'loading', message: '' });
    try {
      const r = await postAuth('/api/email/unsubscribe', { u: params.u, c: params.c, s: params.s });
      setState(r.ok ? { status: 'ok', message: `הוסרתם מ: ${UNSUBSCRIBE_LABELS[params.c] || 'רשימת התפוצה'}. אפשר לשנות זאת בכל עת בהגדרות.` } : { status: 'error', message: r.data.error || 'הקישור אינו תקין.' });
    } catch {
      setState({ status: 'error', message: 'לא ניתן להתחבר לשרת. נסו שוב.' });
    }
  };

  if (handover) {
    return <AuthView onAuthenticated={onAuthenticated} initialMode="login" initialOutcome={handover.outcome} initialOutcomeMeta={handover.meta} />;
  }

  return (
    <div className="auth-screen">
      <div className="auth-card">
        <div className="auth-brand">
          <span className="side-nav-mark" aria-hidden="true">
            ₪
          </span>
          <span>AfikInvest</span>
        </div>
        {state.status === 'loading' ? (
          <p className="auth-step-text" role="status">
            רגע אחד…
          </p>
        ) : null}
        {state.status === 'confirm' ? (
          <div className="auth-form">
            <p className="auth-step-text">להסיר את הכתובת שלכם מ: {UNSUBSCRIBE_LABELS[params.c] || 'רשימת התפוצה'}? הודעות אבטחה ימשיכו להישלח.</p>
            <button type="button" className="auth-submit" onClick={unsubscribe}>
              הסרה מרשימת התפוצה
            </button>
          </div>
        ) : null}
        {['ok', 'info', 'error'].includes(state.status) ? (
          <div className={state.status === 'error' ? 'auth-error' : 'auth-notice'} role={state.status === 'error' ? 'alert' : 'status'}>
            {state.message}
          </div>
        ) : null}
        {state.status !== 'loading' && state.status !== 'confirm' ? (
          <button type="button" className="auth-submit" onClick={onDone}>
            מעבר ל-AfikInvest
          </button>
        ) : null}
      </div>
    </div>
  );
}

export default AccountLinkView;
