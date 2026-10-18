import React, { useState } from 'react';
import { putAccount, downloadAccountFile } from '../../accountApi';
import { useToast } from '../ui/Toast';
import { SettingsCard, Switch } from './shared';

// Privacy and data: downloading everything stored about the user, the
// consents they gave, and the policies.
export function ExportButtons() {
  const toast = useToast();
  const [busy, setBusy] = useState('');
  const download = async (path, name) => {
    setBusy(name);
    try {
      await downloadAccountFile(path, name);
      toast.success('הקובץ ירד');
    } catch (err) {
      toast.error(err.message || 'ההורדה נכשלה');
    } finally {
      setBusy('');
    }
  };
  return (
    <div className="settings-actions">
      <button type="button" className="settings-button" onClick={() => download('/api/account/export', 'afikinvest-export.json')} disabled={Boolean(busy)}>
        {busy === 'afikinvest-export.json' ? 'מכין…' : 'כל הנתונים (JSON)'}
      </button>
      <button type="button" className="settings-button" onClick={() => download('/api/account/export/holdings.csv', 'afikinvest-holdings.csv')} disabled={Boolean(busy)}>
        החזקות (CSV)
      </button>
      <button type="button" className="settings-button" onClick={() => download('/api/account/export/transactions.csv', 'afikinvest-transactions.csv')} disabled={Boolean(busy)}>
        עסקאות (CSV)
      </button>
    </div>
  );
}

function DataSection({ account, onChanged, onOpenHelp }) {
  const toast = useToast();
  const consents = account.consents || {};
  const [state, setState] = useState({ marketing: Boolean(consents.marketing && consents.marketing.granted), analytics: Boolean(consents.analytics && consents.analytics.granted) });

  const setConsent = async (kind, value) => {
    setState((s) => ({ ...s, [kind]: value }));
    const r = await putAccount('/api/account/consents', { [kind]: value });
    if (!r.ok) {
      setState((s) => ({ ...s, [kind]: !value }));
      toast.error(r.data.error || 'השמירה נכשלה');
      return;
    }
    toast.success('נשמר');
    onChanged();
  };

  const terms = consents.terms;
  return (
    <>
      <SettingsCard
        title="ייצוא כל הנתונים שלי"
        description="קובץ JSON עם כל מה שנשמר עליכם - פרטי החשבון, הפרופיל, התיק, העסקאות, תמונות המצב, ההעדפות, ההתראות ויומן האבטחה - או את ההחזקות והעסקאות כ-CSV לאקסל. זהו גם העותק המלא של המידע עליכם."
      >
        <ExportButtons />
      </SettingsCard>
      <SettingsCard title="הסכמות" description="אפשר לשנות בכל עת.">
        <Switch checked={state.marketing} label="דיוור שיווקי" description="עדכונים, טיפים והצעות במייל." onChange={(v) => setConsent('marketing', v)} />
        <Switch checked={state.analytics} label="ניתוח שימוש (אנליטיקס)" description="מדידה אנונימית של השימוש באתר כדי לשפר אותו. כרגע האתר אינו משתמש בכלי כזה; ההעדפה תכובד אם יתווסף." onChange={(v) => setConsent('analytics', v)} />
        {terms && terms.granted ? <p className="auth-hint">תנאי השימוש אושרו (גרסה {terms.version || '—'}).</p> : null}
      </SettingsCard>
      <SettingsCard title="מסמכים ובקשות">
        <ul className="settings-links">
          <li>
            <a href="/terms" target="_blank" rel="noopener noreferrer">
              תנאי השימוש
            </a>
          </li>
          <li>
            <a href="/privacy" target="_blank" rel="noopener noreferrer">
              מדיניות הפרטיות
            </a>
          </li>
          <li>
            <button type="button" className="auth-link auth-link-inline" onClick={onOpenHelp}>
              שאלה או בקשה בנושא המידע שלכם - צרו קשר
            </button>
          </li>
        </ul>
      </SettingsCard>
    </>
  );
}

export default DataSection;
