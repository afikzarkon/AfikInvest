import React, { useEffect, useMemo, useState } from 'react';
import PageToolbar, { ToolbarPrimaryButton } from './PageToolbar';
import { EVENT_LABELS_HE } from '../shared/eventCalendar';

// /alerts - Smart Alerts: unusual price/volume moves in the user's holdings,
// upcoming earnings and dividend dates, and the thresholds that decide what
// counts as unusual.
//
// Alerts are produced on the server (server/alertEngine.js) by the scheduled
// scan after each market's close; this page reads them, and can ask for an
// immediate scan of the user's own holdings.

export const SEVERITY_LABELS = { critical: 'קריטי', warning: 'אזהרה', info: 'מידע' };

const STATUS_LABELS = { confirmed: 'מאושר', estimated: 'הערכה', projected: 'משוער' };

const ACTION_LABELS = {
  REVIEW: 'לבדוק',
  NO_ACTION: 'אין צורך בפעולה',
  CHECK_NEWS: 'לבדוק חדשות',
  CONSIDER_REBALANCE: 'לשקול איזון',
  CONSIDER_TLH: 'לשקול קיזוז מס'
};

const SETTING_FIELDS = [
  { key: 'pctMove', label: 'שינוי יומי חריג (%)', step: 0.5 },
  { key: 'zWarn', label: 'סטיות תקן - אזהרה', step: 0.5 },
  { key: 'zCritical', label: 'סטיות תקן - קריטי', step: 0.5 },
  { key: 'volWarn', label: 'מחזור חריג - אזהרה (פי ממוצע 30 יום)', step: 0.5 },
  { key: 'volCritical', label: 'מחזור חריג - קריטי (פי ממוצע 30 יום)', step: 0.5 },
  { key: 'majorWeightPct', label: 'משקל פוזיציה גדולה (%)', step: 1 }
];

const formatDateTime = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString('he-IL', { dateStyle: 'short', timeStyle: 'short' });
};

function AlertCard({ alert, onMarkRead }) {
  const unread = !alert.readAt;
  return (
    <li className={`alert-card severity-${alert.severity} ${unread ? 'is-unread' : ''}`}>
      <div className="alert-card-head">
        <span className={`alert-severity-badge severity-${alert.severity}`}>{SEVERITY_LABELS[alert.severity] || alert.severity}</span>
        <h3 className="alert-card-title">{alert.title}</h3>
        <span className="alert-card-time">{formatDateTime(alert.createdAt)}</span>
      </div>
      <p className="alert-card-message">{alert.message}</p>
      {alert.recommendation && (
        <p className="alert-card-recommendation">
          <strong>{ACTION_LABELS[alert.recommendation.action] || alert.recommendation.action}:</strong> {alert.recommendation.text}
        </p>
      )}
      {unread && (
        <button type="button" className="benchmark-toggle-button" onClick={() => onMarkRead(alert.id)}>
          סימון כנקרא
        </button>
      )}
    </li>
  );
}

function CalendarTable({ events, formatPriceWithSign }) {
  if (!events.length) {
    return <p className="history-empty-note">אין אירועים קרובים למניות שבתיק (לוח האירועים זמין כרגע למניות אמריקאיות).</p>;
  }
  return (
    <div className="stocks-table-container">
      <table className="analysis-table" aria-label="לוח אירועים">
        <thead>
          <tr>
            <th>תאריך</th>
            <th>נייר</th>
            <th>אירוע</th>
            <th>סטטוס</th>
            <th>דיבידנד צפוי</th>
          </tr>
        </thead>
        <tbody>
          {events.map((e) => (
            <tr key={`${e.market}:${e.symbol}:${e.eventType}:${e.eventDate}`}>
              <td>
                {e.eventDate}
                {e.eventDateEnd ? ` – ${e.eventDateEnd}` : ''}
              </td>
              <td>{e.name ? `${e.name} (${e.symbol})` : e.symbol}</td>
              <td>{EVENT_LABELS_HE[e.eventType] || e.eventType}</td>
              <td>
                {STATUS_LABELS[e.status] || e.status}
                {e.status === 'projected' && e.confidence ? ` (${Math.round(e.confidence * 100)}%)` : ''}
              </td>
              <td>
                {e.expectedGross
                  ? `${e.expectedGross.toFixed(2)} ${e.currency || ''}${e.expectedGrossILS ? ` · ${formatPriceWithSign(e.expectedGrossILS)} ₪` : ''}`
                  : ''}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SettingsForm({ settings, onSave }) {
  const [draft, setDraft] = useState(settings);
  const [status, setStatus] = useState(null);
  useEffect(() => setDraft(settings), [settings]);
  if (!draft) return <p className="history-empty-note">טוען הגדרות…</p>;

  const submit = async (event) => {
    event.preventDefault();
    setStatus(null);
    try {
      const payload = { enabled: draft.enabled, eventReminders: draft.eventReminders };
      SETTING_FIELDS.forEach(({ key }) => {
        payload[key] = Number(draft[key]);
      });
      await onSave(payload);
      setStatus({ ok: true, text: 'נשמר' });
    } catch (err) {
      setStatus({ ok: false, text: err.message });
    }
  };

  return (
    <form className="stock-form" onSubmit={submit} aria-label="הגדרות התראות">
      <div className="form-group form-group-checkbox">
        <label>
          <input type="checkbox" checked={Boolean(draft.enabled)} onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })} />
          התראות על תנועות חריגות
        </label>
      </div>
      <div className="form-group form-group-checkbox">
        <label>
          <input type="checkbox" checked={Boolean(draft.eventReminders)} onChange={(e) => setDraft({ ...draft, eventReminders: e.target.checked })} />
          תזכורות לדוחות ולימי אקס דיבידנד
        </label>
      </div>
      {SETTING_FIELDS.map(({ key, label, step }) => (
        <div className="form-group" key={key}>
          <label htmlFor={`alert-${key}`}>{label}</label>
          <input id={`alert-${key}`} type="number" step={step} value={draft[key] ?? ''} onChange={(e) => setDraft({ ...draft, [key]: e.target.value })} />
        </div>
      ))}
      <div className="rebalance-sum-row">
        <button type="submit" className="benchmark-toggle-button active">
          שמירה
        </button>
        {status && (
          <span role="status" className={status.ok ? 'profit-positive' : 'profit-negative'}>
            {status.text}
          </span>
        )}
      </div>
    </form>
  );
}

const TABS = [
  { key: 'alerts', label: 'התראות' },
  { key: 'calendar', label: 'לוח אירועים' },
  { key: 'settings', label: 'הגדרות' }
];

function AlertsView({
  alerts = [],
  unreadCount = 0,
  alertsLoading = false,
  onMarkRead,
  onMarkAllRead,
  loadCalendar,
  loadSettings,
  saveSettings,
  refreshNow,
  formatPriceWithSign = (v) => String(v)
}) {
  const [tab, setTab] = useState('alerts');
  const [filter, setFilter] = useState('all');
  const [events, setEvents] = useState(null);
  const [settings, setSettings] = useState(null);
  const [refreshState, setRefreshState] = useState(null);

  useEffect(() => {
    if (tab === 'calendar' && events === null && loadCalendar) {
      loadCalendar()
        .then((d) => setEvents(d.events || []))
        .catch(() => setEvents([]));
    }
    if (tab === 'settings' && settings === null && loadSettings) {
      loadSettings()
        .then((d) => setSettings(d.settings))
        .catch(() => setSettings(null));
    }
  }, [tab, events, settings, loadCalendar, loadSettings]);

  const visible = useMemo(
    () => alerts.filter((a) => (filter === 'unread' ? !a.readAt : filter === 'all' ? true : a.severity === filter)),
    [alerts, filter]
  );

  const handleRefresh = async () => {
    setRefreshState({ busy: true });
    try {
      const r = await refreshNow();
      setEvents(null);
      setRefreshState({ text: `נסרקו ${r.scan.scanned} ניירות, ${r.scan.alertsCreated + r.calendar.remindersCreated} התראות חדשות` });
    } catch (err) {
      setRefreshState({ error: true, text: err.message });
    }
  };

  return (
    <div className="App">
      <div className="analysis-container">
        <div className="analysis-content">
          <PageToolbar
            title="התראות חכמות"
            subtitle="תנועות מחיר ומחזור חריגות במניות שבתיק, ותאריכי דוחות ודיבידנדים"
            primaryAction={
              <ToolbarPrimaryButton onClick={handleRefresh} disabled={refreshState?.busy}>
                {refreshState?.busy ? 'סורק…' : 'סריקה עכשיו'}
              </ToolbarPrimaryButton>
            }
            status={
              refreshState?.text ? (
                <span role="status" className={refreshState.error ? 'profit-negative' : ''}>
                  {refreshState.text}
                </span>
              ) : null
            }
          />

          <div className="alerts-tabs" role="tablist" aria-label="התראות">
            {TABS.map((t) => (
              <button
                key={t.key}
                type="button"
                role="tab"
                aria-selected={tab === t.key}
                className={`benchmark-toggle-button ${tab === t.key ? 'active' : ''}`}
                onClick={() => setTab(t.key)}
              >
                {t.label}
                {t.key === 'alerts' && unreadCount > 0 ? ` (${unreadCount})` : ''}
              </button>
            ))}
          </div>

          {tab === 'alerts' && (
            <div className="analysis-section">
              <div className="rebalance-sum-row">
                <label htmlFor="alert-filter">הצגה</label>
                <select id="alert-filter" value={filter} onChange={(e) => setFilter(e.target.value)}>
                  <option value="all">הכל</option>
                  <option value="unread">שלא נקראו</option>
                  <option value="critical">קריטי</option>
                  <option value="warning">אזהרה</option>
                  <option value="info">מידע</option>
                </select>
                {unreadCount > 0 && (
                  <button type="button" className="benchmark-toggle-button" onClick={onMarkAllRead}>
                    סימון הכל כנקרא
                  </button>
                )}
              </div>
              {alertsLoading && !alerts.length ? (
                <p className="history-empty-note">טוען…</p>
              ) : visible.length === 0 ? (
                <p className="history-empty-note">אין התראות להצגה.</p>
              ) : (
                <ul className="alert-list">
                  {visible.map((a) => (
                    <AlertCard key={a.id} alert={a} onMarkRead={onMarkRead} />
                  ))}
                </ul>
              )}
              <p className="section-subtitle">ההתראות מבוססות כללים ואינן ייעוץ השקעות.</p>
            </div>
          )}

          {tab === 'calendar' && (
            <div className="analysis-section">
              {events === null ? <p className="history-empty-note">טוען…</p> : <CalendarTable events={events} formatPriceWithSign={formatPriceWithSign} />}
              <p className="section-subtitle">
                &quot;משוער&quot; - תאריך שנגזר מקצב התשלומים הקודם ולא הוכרז עדיין; האחוז הוא רמת הביטחון בקצב.
              </p>
            </div>
          )}

          {tab === 'settings' && (
            <div className="analysis-section">
              <SettingsForm
                settings={settings}
                onSave={async (payload) => {
                  const d = await saveSettings(payload);
                  setSettings(d.settings);
                }}
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default AlertsView;
