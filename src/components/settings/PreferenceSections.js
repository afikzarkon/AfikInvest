import React, { useEffect, useState } from 'react';
import { getAccount, putAccount } from '../../accountApi';
import { useToast } from '../ui/Toast';
import ThemeToggleButton from '../ThemeToggleButton';
import { SettingsCard, Field, Switch } from './shared';

// Display and privacy, investment defaults, and email notifications - the
// preference documents (GET/PUT /api/preferences/:namespace), each saved
// the moment it changes.

export function DisplaySection({ hideAmounts, onHideAmounts, theme, onToggleTheme }) {
  const toast = useToast();
  return (
    <>
      <SettingsCard
        title="מצב פרטיות - הסתרת סכומים"
        description="מסתיר יתרות, שווי תיק, רווח והפסד וסכומי עסקאות בכל האתר - שימושי במקום ציבורי. אחוזים ותנועת הגרפים נשארים גלויים, כך שרואים מגמה בלי לחשוף כסף. ההגדרה נשמרת בחשבון וזהה בכל המכשירים, ואפשר להחליף אותה גם מאייקון העין בתפריט."
      >
        <Switch
          checked={hideAmounts}
          label="הסתרת סכומים"
          onChange={async (next) => {
            const ok = await onHideAmounts(next);
            if (ok) toast.success(next ? 'הסכומים מוסתרים' : 'הסכומים גלויים');
            else toast.error('השמירה בחשבון נכשלה - ההגדרה תחול רק במכשיר הזה');
          }}
        />
      </SettingsCard>
      <SettingsCard title="ערכת צבעים" description="מצב כהה או בהיר. אותו מתג נמצא גם בתחתית התפריט.">
        <ThemeToggleButton theme={theme} onToggleTheme={onToggleTheme} />
      </SettingsCard>
    </>
  );
}

const CURRENCIES = [
  { value: 'ILS', label: '₪ שקל' },
  { value: 'USD', label: '$ דולר' },
  { value: 'EUR', label: '€ אירו' }
];

export function InvestmentsSection({ investments, onSave }) {
  const toast = useToast();
  const [form, setForm] = useState({ mainCurrency: 'ILS', defaultFeeIls: '', defaultFeeUsd: '' });
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setForm({
      mainCurrency: investments.mainCurrency || 'ILS',
      defaultFeeIls: investments.defaultFeeIls ?? '',
      defaultFeeUsd: investments.defaultFeeUsd ?? ''
    });
  }, [investments]);

  const save = async (patch) => {
    const next = { ...form, ...patch };
    setForm(next);
    setBusy(true);
    const r = await onSave({
      mainCurrency: next.mainCurrency,
      ...(next.defaultFeeIls !== '' ? { defaultFeeIls: Number(next.defaultFeeIls) } : {}),
      ...(next.defaultFeeUsd !== '' ? { defaultFeeUsd: Number(next.defaultFeeUsd) } : {})
    });
    setBusy(false);
    if (r.ok) toast.success('נשמר');
    else toast.error(r.data.error || 'השמירה נכשלה');
  };

  return (
    <>
      <SettingsCard title="מטבע ראשי" description="המטבע שבו יוצג השווי הכולל של התיק בדף הבית (לפי שער החליפין העדכני). החישובים עצמם נעשים בשקלים.">
        <Field label="מטבע ראשי">
          <select value={form.mainCurrency} onChange={(e) => save({ mainCurrency: e.target.value })} disabled={busy} className="auth-input">
            {CURRENCIES.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </select>
        </Field>
      </SettingsCard>
      <SettingsCard title="עמלת ברוקר ברירת מחדל" description="תמולא אוטומטית בטופס קנייה ומכירה, ואפשר לשנות אותה בכל עסקה. השאירו ריק כדי לא למלא.">
        <form
          className="settings-grid"
          onSubmit={(e) => {
            e.preventDefault();
            save({});
          }}
        >
          <Field label="עמלה לעסקה בבורסה הישראלית (₪)" optional>
            <input type="number" min="0" step="any" dir="ltr" value={form.defaultFeeIls} onChange={(e) => setForm((f) => ({ ...f, defaultFeeIls: e.target.value }))} onBlur={() => save({})} />
          </Field>
          <Field label="עמלה לעסקה בבורסה האמריקאית ($)" optional>
            <input type="number" min="0" step="any" dir="ltr" value={form.defaultFeeUsd} onChange={(e) => setForm((f) => ({ ...f, defaultFeeUsd: e.target.value }))} onBlur={() => save({})} />
          </Field>
        </form>
      </SettingsCard>
      <SettingsCard title="מס רווחי הון" description="החישובים באתר משתמשים בשיעור של 25% על הרווח הריאלי (מוצמד למדד), לפי החוק לרוב המשקיעים, עם הפרדה בין רווח ריאלי לאינפלציוני." />
    </>
  );
}

const NOTIFICATIONS = [
  { key: 'product_updates', label: 'עדכוני מוצר וטיפים', description: 'מה חדש באתר ואיך להפיק ממנו יותר.' },
  { key: 'reminders', label: 'תזכורות', description: 'למשל לעדכן שווי של קופת גמל או קרן כספית.' },
  { key: 'weekly_summary', label: 'סיכום שבועי', description: 'שווי התיק והשינוי בשבוע האחרון.', soon: true },
  { key: 'monthly_summary', label: 'סיכום חודשי', description: 'מבט חודשי על התיק.', soon: true },
  { key: 'price_alerts', label: 'התראות מחיר במייל', description: 'תנועות חריגות בניירות שבתיק (ההתראות באתר עצמו תמיד פעילות).', soon: true }
];

export function NotificationsSection({ onMarketingChange }) {
  const toast = useToast();
  const [prefs, setPrefs] = useState(null);
  useEffect(() => {
    getAccount('/api/preferences/notifications').then((r) => setPrefs(r.ok ? r.data.value || {} : {}));
  }, []);

  const toggle = async (key, value) => {
    const next = { ...prefs, [key]: value };
    setPrefs(next);
    const r = await putAccount('/api/preferences/notifications', next);
    if (!r.ok) {
      toast.error(r.data.error || 'השמירה נכשלה');
      return;
    }
    setPrefs(r.data.value);
    // Product updates are marketing: the consent follows the switch.
    if (key === 'product_updates') await onMarketingChange(value);
    toast.success('נשמר');
  };

  return (
    <SettingsCard
      title="הודעות במייל"
      description="בחרו אילו הודעות לקבל. בכל מייל כזה יש גם קישור להסרה מרשימת התפוצה. הודעות אבטחה (כניסה, שינוי סיסמה וכדומה) נשלחות תמיד."
    >
      {!prefs ? (
        <p className="auth-hint" role="status">
          טוען…
        </p>
      ) : (
        NOTIFICATIONS.map((n) => (
          <Switch
            key={n.key}
            checked={Boolean(prefs[n.key])}
            label={n.soon ? `${n.label} (בקרוב)` : n.label}
            description={n.soon ? `${n.description} ההעדפה נשמרת ותחול כשהשליחה תופעל.` : n.description}
            onChange={(v) => toggle(n.key, v)}
          />
        ))
      )}
    </SettingsCard>
  );
}
