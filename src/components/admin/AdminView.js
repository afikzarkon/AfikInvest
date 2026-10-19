import React, { useState } from 'react';
import PageToolbar from '../PageToolbar';
import FlagsTab from './FlagsTab';
import UsersTab from './UsersTab';
import SystemTab from './SystemTab';
import StatsTab from './StatsTab';
import HealthTab from './HealthTab';
import AdminsTab from './AdminsTab';
import AuditTab from './AuditTab';

// The admin panel. Rendered only for holders of the admin role (App.js),
// but that is only what the page shows - every call it makes is checked on
// the server for the role AND two-factor sign-in (server/adminRoutes.js),
// so the page is no key to anything.

const TABS = [
  { key: 'flags', label: 'פיצ׳רים' },
  { key: 'users', label: 'משתמשים' },
  { key: 'system', label: 'באנר ותחזוקה' },
  { key: 'stats', label: 'סטטיסטיקות' },
  { key: 'health', label: 'שגיאות ומשימות' },
  { key: 'admins', label: 'אדמינים' },
  { key: 'audit', label: 'יומן וייצוא' }
];
const TAB_KEY = 'afikinvest_admin_tab';

function readTab() {
  try {
    const t = sessionStorage.getItem(TAB_KEY);
    return TABS.some((x) => x.key === t) ? t : 'flags';
  } catch {
    return 'flags';
  }
}

// The role without 2FA: nothing in the panel works yet, so say what to do.
function TwoFactorRequired({ onNavigate }) {
  return (
    <section className="analysis-section admin-2fa-gate">
      <h3 className="section-title">נדרש אימות דו-שלבי</h3>
      <p>
        לחשבון שלך יש הרשאת אדמין, אבל הפאנל פועל רק כשאימות דו-שלבי מופעל בחשבון. זה מגן על כל המשתמשים במקרה שהסיסמה שלך תדלוף.
      </p>
      <button type="button" className="benchmark-toggle-button active admin-submit" onClick={() => onNavigate('security')}>
        להפעלת אימות דו-שלבי
      </button>
    </section>
  );
}

function AdminView({ needs2fa = false, currentUserId, theme, onFlagsChanged, onSystemChanged, onNavigate }) {
  const [tab, setTab] = useState(readTab);
  const choose = (key) => {
    setTab(key);
    try {
      sessionStorage.setItem(TAB_KEY, key);
    } catch {
      /* ignore */
    }
  };

  return (
    <div className="App">
      <div className="analysis-container">
        <div className="analysis-content">
          <PageToolbar title="ניהול" subtitle="פיצ׳רים, משתמשים, מצב המערכת ויומן פעולות - כל פעולה נרשמת" />
          {needs2fa ? (
            <TwoFactorRequired onNavigate={onNavigate} />
          ) : (
            <>
              <div className="alerts-tabs admin-tabs" role="tablist" aria-label="ניהול">
                {TABS.map((t) => (
                  <button
                    key={t.key}
                    type="button"
                    role="tab"
                    aria-selected={tab === t.key}
                    className={`benchmark-toggle-button ${tab === t.key ? 'active' : ''}`}
                    onClick={() => choose(t.key)}
                  >
                    {t.label}
                  </button>
                ))}
              </div>
              {tab === 'flags' && <FlagsTab onFlagsChanged={onFlagsChanged} />}
              {tab === 'users' && <UsersTab currentUserId={currentUserId} />}
              {tab === 'system' && <SystemTab onSystemChanged={onSystemChanged} />}
              {tab === 'stats' && <StatsTab theme={theme} />}
              {tab === 'health' && <HealthTab />}
              {tab === 'admins' && <AdminsTab currentUserId={currentUserId} />}
              {tab === 'audit' && <AuditTab />}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export default AdminView;
