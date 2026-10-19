import React, { useMemo } from 'react';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { getStats } from '../../adminApi';
import { getChartTheme, tooltipStyles } from '../../utils/chartTheme';
import { ErrorNote, Loading, useLoad } from './shared';

// Usage statistics: aggregate counts only - no address, no portfolio
// figure ever reaches this tab (the server sends counts).

const PROVIDER_LABELS = { google: 'Google', facebook: 'Facebook' };

function Stat({ label, value, sub }) {
  return (
    <div className="admin-stat">
      <span className="admin-stat-value">{Number(value).toLocaleString('he-IL')}</span>
      <span className="admin-stat-label">{label}</span>
      {sub ? <span className="admin-stat-sub">{sub}</span> : null}
    </div>
  );
}

const pct = (part, total) => (total ? `${Math.round((part / total) * 100)}%` : '—');

function StatsTab({ theme }) {
  const stats = useLoad(getStats);
  const chart = useMemo(() => getChartTheme(theme), [theme]);
  const tip = useMemo(() => tooltipStyles(theme), [theme]);

  if (!stats.data) return stats.error ? <ErrorNote>{stats.error}</ErrorNote> : <Loading />;
  const { users, active, signupsLast30Days, providers } = stats.data;
  const signups30 = signupsLast30Days.reduce((s, d) => s + d.count, 0);
  const data = signupsLast30Days.map((d) => ({ ...d, label: `${d.date.slice(8, 10)}/${d.date.slice(5, 7)}` }));

  return (
    <>
      <section className="analysis-section">
        <h3 className="section-title">משתמשים</h3>
        <div className="admin-stat-grid">
          <Stat label="רשומים" value={users.total} />
          <Stat label="מאומתים" value={users.verified} sub={pct(users.verified, users.total)} />
          <Stat label="עם אימות דו-שלבי" value={users.with2fa} sub={pct(users.with2fa, users.total)} />
          <Stat label="שמרו תיק" value={users.withSavedPortfolio} sub={pct(users.withSavedPortfolio, users.total)} />
          <Stat label="חסומים" value={users.blocked} />
          <Stat label="ממתינים למחיקה" value={users.deletionPending} />
        </div>
      </section>

      <section className="analysis-section">
        <h3 className="section-title">פעילות</h3>
        <p className="section-subtitle">משתמשים ייחודיים שהיה להם סשן פעיל בתקופה.</p>
        <div className="admin-stat-grid">
          <Stat label="ב-24 השעות האחרונות" value={active.day} />
          <Stat label="ב-7 הימים האחרונים" value={active.week} />
          <Stat label="ב-30 הימים האחרונים" value={active.month} />
        </div>
      </section>

      <section className="analysis-section">
        <h3 className="section-title">הרשמות - 30 הימים האחרונים</h3>
        <p className="section-subtitle">
          {signups30} הרשמות בסך הכל
          {Object.keys(providers).length
            ? ` · חשבונות מחוברים: ${Object.entries(providers)
                .map(([p, n]) => `${PROVIDER_LABELS[p] || p} ${n}`)
                .join(', ')}`
            : ''}
        </p>
        <div className="admin-chart" dir="ltr">
          <ResponsiveContainer width="100%" height={200}>
            <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -24 }} barCategoryGap={2}>
              <CartesianGrid vertical={false} stroke={chart.grid} />
              <XAxis dataKey="label" tick={{ fill: chart.axis, fontSize: 11 }} tickLine={false} axisLine={false} interval={6} />
              <YAxis allowDecimals={false} tick={{ fill: chart.axis, fontSize: 11 }} tickLine={false} axisLine={false} width={48} />
              <Tooltip
                {...tip}
                cursor={{ fill: chart.grid }}
                formatter={(value) => [value, 'הרשמות']}
                labelFormatter={(label, payload) => (payload && payload[0] ? payload[0].payload.date : label)}
              />
              <Bar dataKey="count" fill={chart.accent} radius={[4, 4, 0, 0]} maxBarSize={18} isAnimationActive={false} />
            </BarChart>
          </ResponsiveContainer>
        </div>
        {/* The same figures as a table, for screen readers. */}
        <table className="visually-hidden">
          <caption>הרשמות לפי יום</caption>
          <tbody>
            {signupsLast30Days.map((d) => (
              <tr key={d.date}>
                <th scope="row">{d.date}</th>
                <td>{d.count}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </>
  );
}

export default StatsTab;
