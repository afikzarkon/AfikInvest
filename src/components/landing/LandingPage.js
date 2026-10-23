import React, { useEffect, useMemo, useRef, useState } from 'react';
import BrandLogo from '../ui/BrandLogo';
import ThemeToggleButton from '../ThemeToggleButton';
import KpiTile, { KpiRow } from '../KpiTile';
import HoldingCards from '../holdings/HoldingCards';
import { LastSessionChange, Money, Pct, shortSessionDate } from '../holdings/MergedValue';
import { formatPriceWithSign } from '../../utils/formatters';
import { buildLandingDemo } from './landingDemo';
import './landing.css';

// The home page for a visitor who is not signed in: what AfikInvest does,
// how it computes what it shows, that it costs nothing - and the way in.
//
// The preview is not a picture. It is the app's own tiles and phone cards,
// fed by the app's own engine over the demo portfolio (landingDemo.js), so
// what a visitor sees here is what they will see with their own holdings.

const ils = (v) => `${formatPriceWithSign(v)} ₪`;
const signedPct = (v, digits = 2) => (Number.isFinite(v) ? `${v > 0 ? '+' : ''}${v.toFixed(digits)}%` : '—');
const toneOf = (v) => (v > 0 ? 'positive' : v < 0 ? 'negative' : 'neutral');

const ASSET_TYPES = [
  { title: 'בורסת תל אביב', text: 'מניות, אג"ח וקרנות סל לפי מספר נייר' },
  { title: 'בורסות ארה"ב', text: 'מניות וקרנות סל לפי טיקר, בדולר ובשקל' },
  { title: 'קופות גמל להשקעה', text: 'הפקדות מתוארכות ושווי מעודכן' },
  { title: 'קרנות כספיות', text: 'יתרה, הפקדות ומשיכות' },
  { title: 'חיסכון בבנק', text: 'ריבית דריבית מכל הפקדה, צמוד או שקלי' },
  { title: 'עו"ש', text: 'הכסף שמחכה, בנפרד מהמושקע' }
];

const FEATURES = [
  {
    icon: 'gift',
    title: '100% חינם',
    text: 'כל הכלים פתוחים לכולם, בלי מסלול בתשלום, בלי מנוי ובלי אותיות קטנות. לא צריך כרטיס אשראי כדי להירשם.'
  },
  {
    icon: 'chart',
    title: 'תשואות שמחושבות נכון',
    text: 'תשואה משוקללת-זמן שמנטרלת הפקדות, תשואה פנימית שמראה איך הכסף שלך הצליח, ומעקב חודשי ושנתי אחרי כמה כסף הושקע. בשיטות TWR, Modified Dietz ו-XIRR.'
  },
  {
    icon: 'shield',
    title: 'סיכון ובריאות התיק',
    text: 'תנודתיות שנתית בשיטה התקנית, יחס שארפ, ירידה מקסימלית מהשיא, ריכוזיות ופיזור - וציון בריאות שמסביר מה משפיע עליו.'
  },
  {
    icon: 'fx',
    title: 'מטבעות וימי מסחר',
    text: 'שווי בשקלים לפי שער הדולר העדכני, עלות לפי השער ששולם בפועל, ו"שינוי אתמול" לפי יום המסחר האחרון שהושלם בכל שוק - גם בסופ"ש ובחגים.'
  },
  {
    icon: 'ledger',
    title: 'עסקאות, עמלות ומס',
    text: 'ספר עסקאות עם בחירה אילו מנות נמכרות - לפי FIFO, LIFO, HIFO או ידנית - עמלות בתוך העלות, ומס רווח הון לפי הרווח הריאלי, עם הפרדה בין ריאלי לאינפלציוני.'
  },
  {
    icon: 'stack',
    title: 'הכל במקום אחד',
    text: 'מניות, אג"ח, קרנות סל, קופות גמל, קרנות כספיות וחיסכון בבנק בתמונה אחת - עם ביקורת תיק חודשית, התראות וייצוא ל-Excel ו-PDF.'
  }
];

// How the main figures are worked out - shown, not hidden.
const METHODS = [
  {
    title: 'תשואה משוקללת-זמן (TWR)',
    formula: 'TWR = Π (1 + rᵢ) − 1,   rᵢ = (V₁ − V₀ − CF) / (V₀ + Σ CFⱼ·wⱼ)',
    text: 'התשואה של ההשקעות עצמן. כל תקופה נמדדת בנפרד, והפקדה נספרת רק לפי הזמן שהייתה מושקעת - כך שהפקדה גדולה לא נראית כרווח.'
  },
  {
    title: 'תשואה פנימית (XIRR)',
    formula: 'Σ CFᵢ / (1 + r)^(tᵢ/365) = 0',
    text: 'התשואה של הכסף שלך, כולל התזמון: כמה הרווחת בשנה על כל שקל, לפי מתי הוא נכנס.'
  },
  {
    title: 'תנודתיות שנתית',
    formula: 'σ = stdev( ln(1 + rᵢ) / √daysᵢ ) × √365',
    text: 'כל תשואה תקופתית מנורמלת לפי השורש של אורכה - הדרך התקנית לשנתיות של פיזור. ממנה נגזר יחס שארפ.'
  },
  {
    title: 'שינוי יומי',
    formula: 'שינוי = שווי × p / (100 + p)',
    text: 'האחוז היומי הוא מול סגירת אתמול, ולכן הסכום מחושב מולה - לא מהשווי של היום.'
  },
  {
    title: 'מס רווח הון',
    formula: 'עלות מותאמת = עלות × מדד עדכני / מדד בקנייה',
    text: 'בנייר ישראלי לפי מדד המחירים, בנייר זר לפי שער הדולר. המס הוא על הרווח הריאלי בלבד, לפי הכללים להצמדה כלפי מעלה ומטה.'
  },
  {
    title: 'כמה כסף הושקע',
    formula: 'הושקע = עלות הרכישות (כולל עמלות) + הפקדות לקופות',
    text: 'כל רכישה לפי מה ששולם בפועל ובשער של יום העסקה, כל הפקדה בחודש שבו בוצעה. כסף שחונה בעו"ש ובקרן כספית מוצג בנפרד.'
  }
];

const ICONS = {
  gift: 'M4 11h16v9H4zM2 7h20v4H2zM12 7v13M12 7c-2-4-6-3-5 0M12 7c2-4 6-3 5 0',
  chart: 'M4 19V5M4 19h16M8 15l3-4 3 2 5-6',
  shield: 'M12 3l7 3v5c0 5-3 8-7 10-4-2-7-5-7-10V6z',
  fx: 'M7 7h11l-3-3M17 17H6l3 3M5 10a7 7 0 0 1 12-3M19 14a7 7 0 0 1-12 3',
  ledger: 'M6 3h10l3 3v15H6zM9 9h7M9 13h7M9 17h4',
  stack: 'M12 3l9 5-9 5-9-5zM3 13l9 5 9-5M3 17l9 5 9-5'
};

function Icon({ name }) {
  return (
    <svg className="lp-icon" viewBox="0 0 24 24" aria-hidden="true">
      <path d={ICONS[name]} fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// Sections fade in as they scroll into view - unless the visitor asked for
// less motion, or the browser has no IntersectionObserver.
function useReveal() {
  const ref = useRef(null);
  useEffect(() => {
    const root = ref.current;
    if (!root) return undefined;
    const items = root.querySelectorAll('.lp-reveal');
    const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduce || typeof IntersectionObserver === 'undefined') {
      items.forEach((el) => el.classList.add('is-visible'));
      return undefined;
    }
    const observer = new IntersectionObserver(
      (entries) =>
        entries.forEach((e) => {
          if (e.isIntersecting) {
            e.target.classList.add('is-visible');
            observer.unobserve(e.target);
          }
        }),
      { rootMargin: '0px 0px -8% 0px', threshold: 0.08 }
    );
    items.forEach((el) => observer.observe(el));
    return () => observer.disconnect();
  }, []);
  return ref;
}

const prefersNarrow = () => typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(max-width: 720px)').matches;

function DesktopPreview({ demo }) {
  const s = demo.summary;
  const last = demo.lastSession;
  return (
    <div className="lp-desktop" aria-label="תצוגת מחשב">
      <div className="lp-window-bar" aria-hidden="true">
        <span />
        <span />
        <span />
      </div>
      <div className="lp-window-body">
        <KpiRow>
          <KpiTile
            featured
            label="שווי תיק כולל"
            icon="₪"
            value={ils(s.capitalTotalILS)}
            badge={demo.totalProfitPercent != null ? signedPct(demo.totalProfitPercent, 1) : null}
            badgeTone={toneOf(demo.totalProfitPercent)}
            sub="סך כל הנכסים"
          />
          <KpiTile label="רווח/הפסד כולל" icon="↗" tone={toneOf(s.totalProfitILS)} value={ils(s.totalProfitILS)} sub={`${signedPct(demo.totalProfitPercent)} מההשקעה`} />
          <KpiTile
            label="שינוי יומי"
            icon="◷"
            tone={toneOf(s.dailyProfitILS)}
            value={ils(s.dailyProfitILS)}
            badge={signedPct(s.weightedDailyChange)}
            badgeTone={toneOf(s.dailyProfitILS)}
            sub='מסחר היום: ת"א + ארה"ב'
          />
          <KpiTile
            label="שינוי אתמול"
            icon="↺"
            tone={toneOf(last ? last.changeILS : 0)}
            value={last ? ils(last.changeILS) : '—'}
            badge={last ? signedPct(last.pct) : null}
            badgeTone={toneOf(last ? last.changeILS : 0)}
            sub={`ניירות ערך · יום המסחר ${shortSessionDate(demo.session)}`}
          />
          <KpiTile
            label="תשואה פנימית (XIRR)"
            icon="%"
            tone={toneOf(demo.mwr.annualPercent)}
            value={signedPct(demo.mwr.annualPercent)}
            sub="בשנה, לפי מועדי ההפקדות"
          />
        </KpiRow>
        <div className="lp-alloc" aria-label="פיזור התיק">
          <div className="lp-alloc-head">
            <span>פיזור התיק</span>
            <span className="lp-muted">לפי שווי</span>
          </div>
          <div className="lp-alloc-bar" role="img" aria-label={demo.allocation.map((a) => `${a.label} ${(a.share * 100).toFixed(0)}%`).join(', ')}>
            {demo.allocation.map((a) => (
              <span key={a.key} className={`lp-alloc-seg is-${a.key}`} style={{ width: `${a.share * 100}%` }} />
            ))}
          </div>
          <ul className="lp-alloc-legend">
            {demo.allocation.map((a) => (
              <li key={a.key}>
                <span className={`lp-dot is-${a.key}`} aria-hidden="true" />
                {a.label}
                <span className="lp-muted">{(a.share * 100).toFixed(1)}%</span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}

function PhonePreview({ demo }) {
  const s = demo.summary;
  const last = demo.lastSession;
  const items = demo.holdings.map((h) => ({
    key: h.symbol,
    name: h.name,
    idLine: `${h.market === 'israeli' ? `${h.symbol} · ` : ''}${h.quantity} יח׳`,
    lotsCount: h.lots,
    value: <Money value={h.value} currency={h.currency} />,
    pl: (
      <>
        <Money value={h.profit} currency={h.currency} signed /> <Pct value={h.profitPercent} />
      </>
    ),
    daily: (
      <>
        <Money value={h.dailyChange} currency={h.currency} signed /> <Pct value={h.dailyPercent} />
      </>
    ),
    yesterday: <LastSessionChange result={h.yesterday} label="" />,
    details: [{ label: 'כמות', value: h.quantity }],
    ext: []
  }));
  const row = (label, amount, pct, sub) => (
    <div className="home-kpi-row">
      <span className="home-kpi-label">
        {label}
        {sub ? <span className="home-kpi-sub">{sub}</span> : null}
      </span>
      <span className={`home-kpi-value ${amount > 0 ? 'profit-positive' : amount < 0 ? 'profit-negative' : ''}`}>
        {amount == null ? '—' : ils(amount)}
        {pct ? <span className="summary-pct">{pct}</span> : null}
      </span>
    </div>
  );
  return (
    <div className="lp-phone" aria-label="תצוגת נייד">
      <div className="lp-phone-notch" aria-hidden="true" />
      <div className="lp-phone-screen">
        <section className="home-kpis" aria-label="סיכום התיק לדוגמה">
          <div className="home-kpi-head">
            <span className="home-kpi-label">שווי תיק כולל</span>
            <strong className="home-kpi-total">{ils(s.capitalTotalILS)}</strong>
            <span className="home-kpi-sub">סך כל הנכסים</span>
          </div>
          {row('רווח/הפסד כולל', s.totalProfitILS, signedPct(demo.totalProfitPercent))}
          {row('שינוי יומי', s.dailyProfitILS, signedPct(s.weightedDailyChange), 'מסחר היום: ת"א + ארה"ב')}
          {row('שינוי אתמול', last ? last.changeILS : null, last ? signedPct(last.pct) : null, `יום המסחר ${shortSessionDate(demo.session)}`)}
        </section>
        <p className="lp-phone-hint">הקישו על כרטיס כדי לפתוח אותו</p>
        <HoldingCards items={items} label="אחזקות לדוגמה" />
      </div>
    </div>
  );
}

function LandingPage({ theme, onToggleTheme, onRegister, onLogin }) {
  const demo = useMemo(() => buildLandingDemo(), []);
  const [view, setView] = useState(() => (prefersNarrow() ? 'phone' : 'desktop'));
  const rootRef = useReveal();

  const scrollTo = (id) => (e) => {
    e.preventDefault();
    const el = document.getElementById(id);
    if (!el) return;
    const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    el.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' });
  };

  return (
    <div className="lp" ref={rootRef}>
      <header className="lp-top">
        <a href="/" className="lp-brand" aria-label="AfikInvest - דף הבית">
          <BrandLogo className="lp-brand-logo" />
          <span>AfikInvest</span>
        </a>
        <nav className="lp-nav" aria-label="ניווט בדף">
          <a href="#preview" onClick={scrollTo('preview')}>
            הצצה
          </a>
          <a href="#features" onClick={scrollTo('features')}>
            יכולות
          </a>
          <a href="#methods" onClick={scrollTo('methods')}>
            איך מחשבים
          </a>
        </nav>
        <div className="lp-top-actions">
          <ThemeToggleButton theme={theme} onToggleTheme={onToggleTheme} />
          <button type="button" className="lp-btn lp-btn-ghost" onClick={onLogin}>
            התחברות
          </button>
        </div>
      </header>

      <main>
        <section className="lp-hero">
          <div className="lp-hero-glow" aria-hidden="true" />
          <p className="lp-free-badge">
            <span aria-hidden="true">✦</span> חינם לחלוטין – ללא עלות וללא דמי מנוי
          </p>
          <h1 className="lp-title">
            כל ההשקעות שלך.
            <br />
            <span className="lp-title-accent">תמונה אחת, מדויקת.</span>
          </h1>
          <p className="lp-lead">
            AfikInvest מאחד במקום אחד מניות, אג"ח וקרנות סל בבורסת תל אביב ובבורסות ארה"ב, קופות גמל, קרנות כספיות וחיסכון בבנק - ומחשב לך תשואות, סיכון ומס
            בשיטות המקובלות בעולם הפיננסים.
          </p>
          <div className="lp-cta">
            <button type="button" className="lp-btn lp-btn-primary" onClick={onRegister}>
              התחל עכשיו בחינם
            </button>
            <button type="button" className="lp-btn lp-btn-ghost" onClick={onLogin}>
              התחברות
            </button>
          </div>
          <ul className="lp-trust">
            <li>בלי כרטיס אשראי</li>
            <li>לא מתחברים לחשבון הבנק או המסחר שלך</li>
            <li>עברית מלאה, בטלפון ובמחשב</li>
          </ul>
        </section>

        <section id="preview" className="lp-section lp-reveal" aria-labelledby="lp-preview-title">
          <div className="lp-section-head">
            <h2 id="lp-preview-title">ככה זה נראה</h2>
            <p>
              תיק לדוגמה עם נתונים בדויים - אבל כל מספר כאן חושב על ידי אותו מנוע שיחשב את התיק שלך: השווי, הרווח, השינוי היומי, השינוי ביום המסחר הקודם והתשואה
              הפנימית.
            </p>
          </div>
          <div className="lp-view-toggle" role="tablist" aria-label="בחירת תצוגה">
            <button type="button" role="tab" aria-selected={view === 'desktop'} className={view === 'desktop' ? 'is-active' : ''} onClick={() => setView('desktop')}>
              מחשב
            </button>
            <button type="button" role="tab" aria-selected={view === 'phone'} className={view === 'phone' ? 'is-active' : ''} onClick={() => setView('phone')}>
              נייד
            </button>
          </div>
          <div className="lp-preview" role="tabpanel">
            {view === 'desktop' ? <DesktopPreview demo={demo} /> : <PhonePreview demo={demo} />}
          </div>
        </section>

        <section className="lp-section lp-reveal" aria-labelledby="lp-assets-title">
          <div className="lp-section-head">
            <h2 id="lp-assets-title">כל מה שבבעלותך, במקום אחד</h2>
            <p>במקום גיליון, שלוש אפליקציות ודוח שנתי מהקופה.</p>
          </div>
          <ul className="lp-assets">
            {ASSET_TYPES.map((a) => (
              <li key={a.title}>
                <strong>{a.title}</strong>
                <span>{a.text}</span>
              </li>
            ))}
          </ul>
        </section>

        <section id="features" className="lp-section lp-reveal" aria-labelledby="lp-features-title">
          <div className="lp-section-head">
            <h2 id="lp-features-title">מה מקבלים</h2>
            <p>הכלים של מנהל תיקים, בשפה שמבינים.</p>
          </div>
          <ul className="lp-features">
            {FEATURES.map((f) => (
              <li key={f.title} className="lp-feature">
                <Icon name={f.icon} />
                <h3>{f.title}</h3>
                <p>{f.text}</p>
              </li>
            ))}
          </ul>
        </section>

        <section id="methods" className="lp-section lp-reveal" aria-labelledby="lp-methods-title">
          <div className="lp-section-head">
            <h2 id="lp-methods-title">איך מחשבים - בלי קופסה שחורה</h2>
            <p>כל מספר באתר מחושב בשיטה מוצהרת, ונבדק בבדיקות אוטומטיות. הנה העיקריות:</p>
          </div>
          <div className="lp-methods">
            {METHODS.map((m) => (
              <details key={m.title} className="lp-method">
                <summary>{m.title}</summary>
                <code dir="ltr">{m.formula}</code>
                <p>{m.text}</p>
              </details>
            ))}
          </div>
        </section>

        <section className="lp-section lp-reveal" aria-labelledby="lp-steps-title">
          <div className="lp-section-head">
            <h2 id="lp-steps-title">שלושה צעדים</h2>
          </div>
          <ol className="lp-steps">
            <li>
              <strong>נרשמים</strong>
              <span>עם כתובת אימייל, בדקה. בלי תשלום ובלי כרטיס אשראי.</span>
            </li>
            <li>
              <strong>מוסיפים את מה שיש</strong>
              <span>נייר ערך לפי מספר או טיקר, קופה, קרן או חיסכון - או מתחילים מתיק לדוגמה.</span>
            </li>
            <li>
              <strong>רואים את התמונה</strong>
              <span>מחירים מתעדכנים לבד, והתשואות, הסיכון והמס מחושבים בשבילך.</span>
            </li>
          </ol>
        </section>

        <section className="lp-final lp-reveal" aria-labelledby="lp-final-title">
          <h2 id="lp-final-title">התיק שלך מחכה</h2>
          <p>חינם, בלי מנוי, ובלי לחבר שום חשבון.</p>
          <button type="button" className="lp-btn lp-btn-primary" onClick={onRegister}>
            התחל עכשיו בחינם
          </button>
        </section>
      </main>

      <footer className="lp-footer">
        <p>
          המידע באתר הוא כלי עזר למעקב אישי בלבד ואינו ייעוץ השקעות, ייעוץ מס או המלצה לקנות או למכור נייר ערך. מחירים מגיעים ממקורות ציבוריים וייתכן בהם עיכוב.
        </p>
        <p className="lp-footer-links">
          <a href="/terms">תנאי שימוש</a> · <a href="/privacy">מדיניות פרטיות</a> · © AfikInvest
        </p>
      </footer>
    </div>
  );
}

export default LandingPage;
