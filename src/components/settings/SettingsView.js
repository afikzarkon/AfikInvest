import React, { useEffect, useMemo, useRef, useState } from 'react';
import PageToolbar from '../PageToolbar';
import { useMediaQuery } from '../../hooks/useMediaQuery';
import { putAccount } from '../../accountApi';
import { confirmLeave } from '../../utils/unsavedChanges';
import ProfileSection from './ProfileSection';
import SecuritySection from './SecuritySection';
import { DisplaySection, InvestmentsSection, NotificationsSection } from './PreferenceSections';
import DataSection from './DataSection';
import DeleteSection from './DeleteSection';
import HelpSection from './HelpSection';

// /settings - the user's settings, one category at a time.
//
// Desktop: the categories in a column beside the open one. Phone: the list
// of categories, then the chosen one full width with a way back. A search
// box narrows the categories by what they contain. At the top, the
// account's security score, with the steps that would raise it.
const CATEGORIES = [
  { key: 'profile', label: 'פרופיל', hint: 'שם, תמונה ופרטים אישיים', keywords: 'שם תמונה טלפון לידה מדינה אזור זמן פרופיל אווטאר' },
  { key: 'security', label: 'חשבון ואבטחה', hint: 'אימייל, סיסמה, 2FA ומכשירים', keywords: 'אימייל מייל סיסמה אימות דו-שלבי 2fa קודי גיבוי מכשירים התחברויות google facebook היסטוריה אבטחה' },
  { key: 'display', label: 'תצוגה ופרטיות', hint: 'הסתרת סכומים וערכת צבעים', keywords: 'פרטיות הסתרה סכומים עין מצב כהה בהיר ערכת צבעים תצוגה' },
  { key: 'investments', label: 'הגדרות השקעות', hint: 'מטבע ראשי ועמלות', keywords: 'מטבע שקל דולר אירו עמלה ברוקר מס השקעות' },
  { key: 'notifications', label: 'התראות', hint: 'אילו מיילים לקבל', keywords: 'מייל התראות סיכום שבועי חודשי תזכורות דיוור הסרה' },
  { key: 'data', label: 'פרטיות ונתונים', hint: 'ייצוא, הסכמות ומסמכים', keywords: 'ייצוא הורדה json csv הסכמות שיווק אנליטיקס פרטיות תנאי שימוש עותק מידע' },
  { key: 'delete', label: 'מחיקת חשבון', hint: 'מחיקה ושחזור', keywords: 'מחיקה מחק חשבון סגירה עזיבה', danger: true },
  { key: 'help', label: 'עזרה ותמיכה', hint: 'צור קשר, משוב ושאלות', keywords: 'עזרה תמיכה צור קשר משוב הצעה תקלה שאלות נפוצות גרסה' }
];

// 0-100, from what is set up, with the step behind each missing part.
export function securityScore(account) {
  if (!account) return { score: 0, steps: [] };
  const s = account.security || {};
  const items = [
    { ok: s.emailVerified, points: 20, step: 'אימות כתובת האימייל', section: 'security' },
    { ok: s.twoFactorEnabled, points: 40, step: 'הפעלת אימות דו-שלבי', section: 'security' },
    { ok: s.twoFactorEnabled && s.backupCodesLeft >= 3, points: 10, step: 'יצירת קודי גיבוי חדשים', section: 'security', only: s.twoFactorEnabled },
    { ok: (s.hasPassword ? 1 : 0) + (s.providerCount || 0) >= 2, points: 15, step: s.hasPassword ? 'חיבור Google או Facebook כדרך כניסה נוספת' : 'הגדרת סיסמה כדרך כניסה נוספת', section: 'security' },
    { ok: (s.sessionCount || 0) <= 5, points: 15, step: 'ניתוק מכשירים שאינם בשימוש', section: 'security' }
  ];
  const score = items.reduce((sum, i) => sum + (i.ok ? i.points : 0), 0);
  const steps = items.filter((i) => !i.ok && i.only !== false).map((i) => ({ text: i.step, section: i.section }));
  return { score: s.twoFactorEnabled ? score : Math.min(score, 60), steps };
}

function readUrlState() {
  const params = new URLSearchParams(window.location.search);
  const section = params.get('section');
  const linked = params.get('linked');
  const linkError = params.get('linkError');
  const names = { google: 'Google', facebook: 'Facebook' };
  let linkMessage = null;
  if (linked) linkMessage = { text: `${names[linked] || linked} חובר לחשבון.`, error: false };
  if (linkError) linkMessage = { text: `החשבון ב-${names[params.get('provider')] || 'הספק'} כבר מחובר למשתמש אחר, ולכן לא חובר.`, error: true };
  return { section: CATEGORIES.some((c) => c.key === section) ? section : null, linkMessage };
}

function SettingsView({ user, initialSection, accountState, theme, onToggleTheme, onSessionChange, onLogout }) {
  const { account, avatar, setAvatar, refresh, hideAmounts, setHideAmounts, investments, saveInvestments } = accountState;
  const isPhone = useMediaQuery('(max-width: 768px)');
  const urlState = useRef(readUrlState()).current;
  const [active, setActive] = useState(urlState.section || initialSection || (isPhone ? null : 'profile'));
  const [query, setQuery] = useState('');
  const [helpKind, setHelpKind] = useState('contact');
  const headingRef = useRef(null);

  useEffect(() => {
    if (window.location.search) window.history.replaceState({}, '', window.location.pathname);
  }, []);
  useEffect(() => {
    if (!active && !isPhone) setActive('profile');
  }, [active, isPhone]);

  const open = (key) => {
    if (key === active) return;
    if (!confirmLeave()) return;
    setActive(key);
    // Move focus to the opened category's heading, for keyboard and screen
    // reader users.
    setTimeout(() => headingRef.current && headingRef.current.focus(), 0);
  };

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return CATEGORIES;
    return CATEGORIES.filter((c) => `${c.label} ${c.hint} ${c.keywords}`.toLowerCase().includes(q));
  }, [query]);

  const { score, steps } = securityScore(account);
  const current = CATEGORIES.find((c) => c.key === active);

  const setMarketing = async (value) => {
    await putAccount('/api/account/consents', { marketing: value });
  };

  const renderSection = () => {
    if (!account) {
      return (
        <p className="auth-hint" role="status">
          טוען…
        </p>
      );
    }
    switch (active) {
      case 'profile':
        return <ProfileSection account={account} avatar={avatar} setAvatar={setAvatar} email={user.email} onSaved={refresh} />;
      case 'security':
        return <SecuritySection account={account} onSessionChange={onSessionChange} onLogout={onLogout} onChanged={refresh} linkMessage={urlState.linkMessage} />;
      case 'display':
        return <DisplaySection hideAmounts={hideAmounts} onHideAmounts={setHideAmounts} theme={theme} onToggleTheme={onToggleTheme} />;
      case 'investments':
        return <InvestmentsSection investments={investments} onSave={saveInvestments} />;
      case 'notifications':
        return <NotificationsSection onMarketingChange={setMarketing} />;
      case 'data':
        return (
          <DataSection
            account={account}
            onChanged={refresh}
            onOpenHelp={() => {
              setHelpKind('contact');
              open('help');
            }}
          />
        );
      case 'delete':
        return <DeleteSection account={account} onDeleted={onLogout} onLogout={onLogout} />;
      case 'help':
        return <HelpSection initialKind={helpKind} />;
      default:
        return null;
    }
  };

  const showList = !isPhone || !active;
  const showDetail = !isPhone || Boolean(active);

  return (
    <div className="settings-page">
      <PageToolbar title="הגדרות" subtitle={user.email} sticky={false} />

      <div className="settings-score" aria-label="ציון אבטחת החשבון">
        <div className="settings-score-ring" style={{ '--score': score }} aria-hidden="true">
          <span>{score}</span>
        </div>
        <div className="settings-score-text">
          <strong>ציון אבטחת החשבון: {score} מתוך 100</strong>
          {steps.length ? (
            <ul className="settings-score-steps">
              {steps.slice(0, 3).map((s) => (
                <li key={s.text}>
                  <span className="recommend-tag">מומלץ</span>
                  <button type="button" className="auth-link auth-link-inline" onClick={() => open(s.section)}>
                    {s.text}
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <span className="auth-hint">החשבון מוגן היטב.</span>
          )}
        </div>
      </div>

      <div className={`settings-layout ${isPhone ? 'is-phone' : ''}`}>
        {showList ? (
          <nav className="settings-nav" aria-label="קטגוריות הגדרות">
            <label className="visually-hidden" htmlFor="settings-search">
              חיפוש בהגדרות
            </label>
            <input
              id="settings-search"
              type="search"
              className="auth-input settings-search"
              placeholder="חיפוש בהגדרות…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <ul>
              {visible.map((c) => (
                <li key={c.key}>
                  <button
                    type="button"
                    className={`settings-nav-item ${active === c.key ? 'is-active' : ''} ${c.danger ? 'is-danger' : ''}`}
                    aria-current={active === c.key ? 'page' : undefined}
                    onClick={() => open(c.key)}
                  >
                    <span className="settings-nav-label">{c.label}</span>
                    <span className="settings-nav-hint">{c.hint}</span>
                  </button>
                </li>
              ))}
              {!visible.length ? <li className="auth-hint">לא נמצאו הגדרות מתאימות</li> : null}
            </ul>
          </nav>
        ) : null}

        {showDetail && current ? (
          <div className="settings-detail">
            {isPhone ? (
              <button type="button" className="auth-link settings-back" onClick={() => confirmLeave() && setActive(null)}>
                → כל ההגדרות
              </button>
            ) : null}
            <h2 className="settings-detail-title" tabIndex={-1} ref={headingRef}>
              {current.label}
            </h2>
            {renderSection()}
          </div>
        ) : null}
      </div>
    </div>
  );
}

export default SettingsView;
