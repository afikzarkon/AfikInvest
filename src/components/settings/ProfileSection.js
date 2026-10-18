import React, { useEffect, useMemo, useState } from 'react';
import { putAccount } from '../../accountApi';
import { useToast } from '../ui/Toast';
import { setUnsaved } from '../../utils/unsavedChanges';
import { displayNameOf } from '../ui/Avatar';
import AvatarEditor from './AvatarEditor';
import { SettingsCard, Field } from './shared';

// Personal details - every one of them optional. Nothing on the site
// depends on them, nothing asks for them, and clearing a field is a valid
// save. Without a display name, the site shows the first name, the name
// Google/Facebook gave, or the start of the email address.
const FIELDS = ['firstName', 'lastName', 'displayName', 'phone', 'birthDate', 'country', 'timezone'];
const COUNTRY_CODES = ['IL', 'US', 'GB', 'CA', 'AU', 'DE', 'FR', 'NL', 'ES', 'IT', 'CH', 'AT', 'BE', 'SE', 'NO', 'DK', 'FI', 'IE', 'PT', 'PL', 'CZ', 'GR', 'CY', 'RO', 'HU', 'UA', 'RU', 'AE', 'IN', 'SG', 'JP', 'KR', 'CN', 'BR', 'AR', 'MX', 'ZA'];
const FALLBACK_ZONES = ['Asia/Jerusalem', 'Europe/London', 'Europe/Paris', 'Europe/Berlin', 'America/New_York', 'America/Chicago', 'America/Los_Angeles', 'Asia/Dubai', 'Asia/Tokyo', 'Australia/Sydney', 'UTC'];

const countryName = (() => {
  try {
    const names = new Intl.DisplayNames(['he'], { type: 'region' });
    return (code) => names.of(code) || code;
  } catch {
    return (code) => code;
  }
})();

const timeZones = () => {
  try {
    return Intl.supportedValuesOf('timeZone');
  } catch {
    return FALLBACK_ZONES;
  }
};

const fromProfile = (p) => Object.fromEntries(FIELDS.map((f) => [f, (p && p[f]) || '']));

// The share of the optional details filled in - shown, never required.
export function profileCompletion(profile, hasAvatar) {
  const counted = ['firstName', 'lastName', 'displayName', 'phone', 'country', 'timezone'];
  const filled = counted.filter((f) => profile && profile[f]).length + (hasAvatar ? 1 : 0);
  return Math.round((filled / (counted.length + 1)) * 100);
}

function ProfileSection({ account, avatar, setAvatar, email, onSaved }) {
  const toast = useToast();
  const saved = useMemo(() => fromProfile(account && account.profile), [account]);
  const [form, setForm] = useState(saved);
  const [errors, setErrors] = useState({});
  const [saving, setSaving] = useState(false);
  const zones = useMemo(timeZones, []);

  useEffect(() => setForm(saved), [saved]);
  const dirty = FIELDS.some((f) => form[f] !== saved[f]);
  useEffect(() => {
    setUnsaved('profile', dirty);
    return () => setUnsaved('profile', false);
  }, [dirty]);

  const set = (field) => (e) => {
    setForm((f) => ({ ...f, [field]: e.target.value }));
    setErrors((er) => ({ ...er, [field]: undefined }));
  };

  const save = async (e) => {
    e.preventDefault();
    setSaving(true);
    const changes = Object.fromEntries(FIELDS.filter((f) => form[f] !== saved[f]).map((f) => [f, form[f].trim()]));
    const r = await putAccount('/api/account/profile', changes);
    setSaving(false);
    if (!r.ok) {
      setErrors(r.data.fieldErrors || {});
      toast.error(r.data.error || 'השמירה נכשלה');
      return;
    }
    setUnsaved('profile', false);
    toast.success('הפרופיל נשמר');
    onSaved();
  };

  const completion = profileCompletion(form, Boolean(avatar));
  const shownAs = displayNameOf(form, email);

  return (
    <>
      <SettingsCard title="תמונת פרופיל" description="תוצג בתפריט האתר. אם אין תמונה, תוצג האות הראשונה של השם.">
        <AvatarEditor avatar={avatar} name={shownAs} onChange={setAvatar} />
      </SettingsCard>

      <SettingsCard title="פרטים אישיים" description="כל הפרטים כאן הם רשות בלבד - אפשר למלא, לשנות או למחוק בכל עת, ושום דבר באתר לא תלוי בהם.">
        <div className="profile-progress" aria-label={`השלמת פרופיל ${completion}%`}>
          <div className="profile-progress-head">
            <span>השלמת פרופיל: {completion}%</span>
            <span className="auth-hint">לא חובה</span>
          </div>
          <div className="profile-progress-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={completion}>
            <span style={{ width: `${completion}%` }} />
          </div>
        </div>

        <form className="settings-form" onSubmit={save} noValidate>
          <div className="settings-grid">
            <Field label="שם פרטי" optional error={errors.firstName}>
              <input type="text" autoComplete="given-name" value={form.firstName} onChange={set('firstName')} maxLength={60} />
            </Field>
            <Field label="שם משפחה" optional error={errors.lastName}>
              <input type="text" autoComplete="family-name" value={form.lastName} onChange={set('lastName')} maxLength={60} />
            </Field>
            <Field label="שם תצוגה" optional hint={`יוצג כ: ${shownAs}`} error={errors.displayName}>
              <input type="text" autoComplete="nickname" value={form.displayName} onChange={set('displayName')} maxLength={60} />
            </Field>
            <Field label="טלפון" optional error={errors.phone}>
              <input type="tel" dir="ltr" autoComplete="tel" value={form.phone} onChange={set('phone')} maxLength={20} />
            </Field>
            <Field label="תאריך לידה" optional error={errors.birthDate}>
              <input type="date" value={form.birthDate} onChange={set('birthDate')} max={new Date().toISOString().slice(0, 10)} />
            </Field>
            <Field label="מדינה" optional error={errors.country}>
              <select value={form.country} onChange={set('country')} className="auth-input">
                <option value="">לא נבחרה</option>
                {COUNTRY_CODES.map((c) => (
                  <option key={c} value={c}>
                    {countryName(c)}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="אזור זמן" optional error={errors.timezone}>
              <select value={form.timezone} onChange={set('timezone')} className="auth-input" dir="ltr">
                <option value="">לא נבחר</option>
                {zones.map((z) => (
                  <option key={z} value={z}>
                    {z}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <div className="settings-actions">
            <button type="submit" className="auth-submit" disabled={!dirty || saving}>
              {saving ? 'שומר…' : 'שמירת שינויים'}
            </button>
            {dirty ? (
              <button type="button" className="auth-link" onClick={() => setForm(saved)} disabled={saving}>
                ביטול השינויים
              </button>
            ) : null}
          </div>
        </form>
      </SettingsCard>
    </>
  );
}

export default ProfileSection;
