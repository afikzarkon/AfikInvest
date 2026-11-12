// Ported from day-trader-skill (MIT, Jake Schincariol)
//
// /news - News on my holdings: Yahoo Finance headlines and SEC 8-K filings
// for the US stocks in the portfolio, newest first, grouped by day, with
// filter chips by ticker and by topic. Data: hooks/useNews.js ->
// GET /api/news (server/newsRoutes.js).
import React, { useMemo, useState } from 'react';
import PageToolbar, { ToolbarPrimaryButton } from './PageToolbar';
import { useNews } from '../hooks/useNews';
import { NEWS_TAG_LABELS_HE, NEWS_SOURCE_LABELS_HE } from '../shared/newsTags';
import './NewsView.css';

const WINDOWS = [
  { hours: 24, label: '24 שעות' },
  { hours: 72, label: '3 ימים' },
  { hours: 168, label: 'שבוע' },
  { hours: 720, label: '30 יום' }
];

const SOURCE_SHORT = { yahoo: 'Yahoo', sec: 'SEC' };

// "לפני 5 דק'", "לפני 3 שע'", "לפני 2 ימים".
export function formatRelative(iso, now = new Date()) {
  if (!iso) return 'זמן לא ידוע';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return 'זמן לא ידוע';
  const min = Math.round((now.getTime() - t) / 60000);
  if (min < 1) return 'עכשיו';
  if (min < 60) return `לפני ${min} דק'`;
  const h = Math.round(min / 60);
  if (h < 24) return h === 1 ? 'לפני שעה' : `לפני ${h} שע'`;
  const d = Math.round(h / 24);
  return d === 1 ? 'אתמול' : `לפני ${d} ימים`;
}

const dayKey = (iso) => {
  if (!iso) return 'unknown';
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

export function dayLabel(key, now = new Date()) {
  if (key === 'unknown') return 'ללא תאריך';
  const today = dayKey(now.toISOString());
  const yesterday = dayKey(new Date(now.getTime() - 86400000).toISOString());
  if (key === today) return 'היום';
  if (key === yesterday) return 'אתמול';
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('he-IL', { weekday: 'long', day: 'numeric', month: 'long' });
}

function groupByDay(items) {
  const groups = [];
  const index = new Map();
  items.forEach((it) => {
    const key = dayKey(it.time);
    if (!index.has(key)) {
      index.set(key, groups.length);
      groups.push({ key, items: [] });
    }
    groups[index.get(key)].items.push(it);
  });
  return groups;
}

function Chip({ active, onClick, children }) {
  return (
    <button type="button" className={`news-chip ${active ? 'active' : ''}`} aria-pressed={active} onClick={onClick}>
      {children}
    </button>
  );
}

function NewsItem({ item, now }) {
  const tickers = item.touches && item.touches.length ? item.touches : [item.ticker];
  const exact = item.time ? new Date(item.time).toLocaleString('he-IL', { dateStyle: 'short', timeStyle: 'short' }) : '';
  return (
    <li className={`news-item ${item.important ? 'is-important' : ''}`}>
      <div className="news-item-meta">
        <span className={`news-source-badge source-${item.source}`} title={NEWS_SOURCE_LABELS_HE[item.source] || item.source}>
          {SOURCE_SHORT[item.source] || item.source}
          {item.form ? ` · ${item.form}` : ''}
        </span>
        {tickers.map((t) => (
          <span key={t} className="news-ticker" dir="ltr">
            {t}
          </span>
        ))}
        {item.important && <span className="news-important">דיווח מהותי</span>}
        <time className="news-time" dateTime={item.time || undefined} title={exact}>
          {formatRelative(item.time, now)}
        </time>
      </div>
      <a className="news-title" href={item.link} target="_blank" rel="noopener noreferrer" dir="auto">
        {item.title}
      </a>
      {item.summary && item.kind !== 'filing' && (
        <p className="news-summary" dir="auto">
          {item.summary}
        </p>
      )}
      {item.tags && item.tags.length > 0 && (
        <div className="news-tags">
          {item.tags.map((t) => (
            <span key={t} className="news-tag">
              {NEWS_TAG_LABELS_HE[t] || t}
            </span>
          ))}
        </div>
      )}
    </li>
  );
}

function NewsView({ user, authHeader = () => ({}), americanStocks = [], israeliStocks = [], now = null }) {
  const [hours, setHours] = useState(72);
  const [ticker, setTicker] = useState('all');
  const [tag, setTag] = useState('all');

  const usSymbols = useMemo(
    () => [...new Set((americanStocks || []).map((l) => String(l.stockName || '').trim().toUpperCase()).filter(Boolean))].sort(),
    [americanStocks]
  );
  const hasTase = (israeliStocks || []).some((l) => String(l.stockName || '').trim());
  const news = useNews(user, authHeader, { hours, refreshKey: usSymbols.join(',') });
  const clock = now || new Date();

  const items = useMemo(() => news.items || [], [news.items]);
  const tickers = news.symbols && news.symbols.length ? news.symbols : usSymbols;
  const tagsPresent = useMemo(() => {
    const set = new Set();
    items.forEach((it) => (it.tags || []).forEach((t) => set.add(t)));
    return Object.keys(NEWS_TAG_LABELS_HE).filter((t) => set.has(t));
  }, [items]);

  const visible = useMemo(
    () =>
      items.filter(
        (it) => (ticker === 'all' || it.ticker === ticker || (it.touches || []).includes(ticker)) && (tag === 'all' || (it.tags || []).includes(tag))
      ),
    [items, ticker, tag]
  );
  const groups = useMemo(() => groupByDay(visible), [visible]);

  const unsupportedCount = news.loaded ? (news.unsupported || []).length : hasTase ? 1 : 0;
  const taseOnly = news.loaded ? !(news.symbols || []).length && unsupportedCount > 0 : !usSymbols.length && hasTase;
  const noHoldings = news.loaded ? !(news.symbols || []).length && !unsupportedCount : !usSymbols.length && !hasTase;
  const failedSymbols = [...new Set((news.errors || []).filter((e) => e.symbol).map((e) => e.symbol))];

  let body;
  if (news.loading && !news.loaded) {
    body = <p className="history-empty-note">טוען חדשות…</p>;
  } else if (news.error && !news.loaded) {
    body = (
      <p className="history-empty-note profit-negative" role="alert">
        {news.error}
      </p>
    );
  } else if (noHoldings) {
    body = <p className="history-empty-note">אין עדיין מניות בתיק. הוסיפו מניות אמריקאיות כדי לראות כאן חדשות עליהן.</p>;
  } else if (taseOnly) {
    body = null;
  } else if (!visible.length) {
    body = <p className="history-empty-note">אין חדשות להצגה בטווח הזמן שנבחר{ticker !== 'all' || tag !== 'all' ? ' ובסינון הנוכחי' : ''}.</p>;
  } else {
    body = (
      <div className="news-groups">
        {groups.map((g) => (
          <section key={g.key} className="news-day" aria-label={dayLabel(g.key, clock)}>
            <h2 className="news-day-title">{dayLabel(g.key, clock)}</h2>
            <ul className="news-list">
              {g.items.map((it) => (
                <NewsItem key={it.id} item={it} now={clock} />
              ))}
            </ul>
          </section>
        ))}
      </div>
    );
  }

  return (
    <div className="App">
      <div className="analysis-container">
        <div className="analysis-content">
          <PageToolbar
            title="חדשות על התיק"
            subtitle="כותרות מ-Yahoo Finance ודיווחי 8-K ל-SEC על המניות האמריקאיות שבתיק"
            primaryAction={
              <ToolbarPrimaryButton onClick={news.reload} disabled={news.loading}>
                {news.loading ? 'טוען…' : 'רענון'}
              </ToolbarPrimaryButton>
            }
            status={
              news.error && news.loaded ? (
                <span role="status" className="profit-negative">
                  {news.error}
                </span>
              ) : null
            }
          />

          {news.loaded && !news.secConfigured && (
            <p className="news-notice" role="note">
              דיווחי SEC אינם מוגדרים בשרת (חסר SEC_USER_AGENT), ולכן מוצגות כותרות Yahoo Finance בלבד.
            </p>
          )}
          {taseOnly && (
            <p className="news-notice" role="note">
              התיק כולל רק ניירות שנסחרים בבורסת תל אביב, ואין עדיין מקור חדשות עבורם. חדשות מוצגות כרגע למניות אמריקאיות בלבד.
            </p>
          )}
          {!taseOnly && unsupportedCount > 0 && news.loaded && (
            <p className="news-notice subtle" role="note">
              {unsupportedCount === 1 ? 'נייר אחד מבורסת תל אביב אינו מכוסה' : `${unsupportedCount} ניירות מבורסת תל אביב אינם מכוסים`} - אין עדיין מקור חדשות לבורסה בתל אביב.
            </p>
          )}
          {news.truncated && (
            <p className="news-notice subtle" role="note">
              מוצגות חדשות ל-25 המניות הראשונות בתיק בלבד.
            </p>
          )}

          {!taseOnly && !noHoldings && (
            <div className="news-filters">
              <div className="news-chip-row" role="group" aria-label="טווח זמן">
                {WINDOWS.map((w) => (
                  <Chip key={w.hours} active={hours === w.hours} onClick={() => setHours(w.hours)}>
                    {w.label}
                  </Chip>
                ))}
              </div>
              {tickers.length > 1 && (
                <div className="news-chip-row" role="group" aria-label="סינון לפי מניה">
                  <Chip active={ticker === 'all'} onClick={() => setTicker('all')}>
                    כל המניות
                  </Chip>
                  {tickers.map((t) => (
                    <Chip key={t} active={ticker === t} onClick={() => setTicker(ticker === t ? 'all' : t)}>
                      <span dir="ltr">{t}</span>
                    </Chip>
                  ))}
                </div>
              )}
              {tagsPresent.length > 0 && (
                <div className="news-chip-row" role="group" aria-label="סינון לפי נושא">
                  <Chip active={tag === 'all'} onClick={() => setTag('all')}>
                    כל הנושאים
                  </Chip>
                  {tagsPresent.map((t) => (
                    <Chip key={t} active={tag === t} onClick={() => setTag(tag === t ? 'all' : t)}>
                      {NEWS_TAG_LABELS_HE[t]}
                    </Chip>
                  ))}
                </div>
              )}
            </div>
          )}

          {body}

          {failedSymbols.length > 0 && (
            <p className="section-subtitle">
              לא הצלחנו לטעון חלק מהמקורות עבור: <span dir="ltr">{failedSymbols.join(', ')}</span>. ננסה שוב ברענון הבא.
            </p>
          )}
          <p className="section-subtitle news-disclaimer">
            כותרות הן נקודת פתיחה ולא עובדות - פתחו את הכתבה או את הדיווח המקורי לפני כל החלטה. דיווח ל-SEC גובר על כותרת. אין לראות בכך ייעוץ השקעות.
          </p>
        </div>
      </div>
    </div>
  );
}

export default NewsView;
