import React from 'react';
import { formatPriceWithSign } from '../utils/formatters';
import {
  CapitalStateCard,
  IsraeliMarketCard,
  AmericanMarketCard,
  NetInvestmentCard,
  ProvidentFundsCard,
  BankSavingsCard,
  CashAndCheckingCard
} from './PortfolioSummary';
import PortfolioActionsToolbar from './PortfolioActionsToolbar';
import KpiTile, { KpiRow } from './KpiTile';
import BetaBanner from './BetaBanner';
import { useCompactLayout } from '../hooks/useMediaQuery';

const pctText = (v) => (v == null || !Number.isFinite(v) ? null : `${v > 0 ? '+' : ''}${v.toFixed(2)}%`);
const toneClass = (v) => (v > 0 ? 'profit-positive' : v < 0 ? 'profit-negative' : '');

// The phone's form of the four headline tiles: one card - the total, then
// profit, daily change and tax as rows, each amount with its percent.
//
// The profit row opens to the net-investment breakdown (profitDetails).
// That breakdown used to be a fold of its own in the list below, headed by
// the same amount and percent - the one figure shown twice on one screen.
function CompactKpis({ headlineValue, headlineSub, totalProfitPercent, summary, dailyChangeSub, profitDetails }) {
  const row = (label, amount, pct, sub) => (
    <div className="home-kpi-row">
      <span className="home-kpi-label">
        {label}
        {sub ? <span className="home-kpi-sub">{sub}</span> : null}
      </span>
      <span className={`home-kpi-value ${toneClass(amount)}`}>
        {formatPriceWithSign(amount)} ₪{pct ? <span className="summary-pct">{pct}</span> : null}
      </span>
    </div>
  );
  return (
    <section className="home-kpis" aria-label="סיכום התיק">
      <div className="home-kpi-head">
        <span className="home-kpi-label">שווי תיק כולל</span>
        <strong className="home-kpi-total">{headlineValue}</strong>
        <span className="home-kpi-sub">{headlineSub}</span>
      </div>
      <details className="home-kpi-fold">
        <summary className="home-kpi-row">
          <span className="home-kpi-label">רווח/הפסד כולל</span>
          <span className={`home-kpi-value ${toneClass(summary.totalProfitILS)}`}>
            {formatPriceWithSign(summary.totalProfitILS)} ₪
            {pctText(totalProfitPercent) ? <span className="summary-pct">{pctText(totalProfitPercent)}</span> : null}
          </span>
        </summary>
        <div className="home-kpi-fold-body">{profitDetails}</div>
      </details>
      {row('שינוי יומי', summary.dailyProfitILS, pctText(summary.weightedDailyChange), dailyChangeSub)}
      <div className="home-kpi-row">
        <span className="home-kpi-label">
          מס צפוי<span className="home-kpi-sub">על הרווח הריאלי</span>
        </span>
        <span className="home-kpi-value">{formatPriceWithSign(summary.totalTaxILS)} ₪</span>
      </div>
    </section>
  );
}

// The phone's summary cards: each one a single line - its name, what it is
// worth and its return - that opens to the full card and the link to its
// page. Six cards of eight rows each were most of a 3,500px page.
function CompactSummaryItem({ title, value, pct, children }) {
  return (
    <details className="home-fold">
      <summary className="home-fold-head">
        <span className="home-fold-title">{title}</span>
        <span className="home-fold-figures">
          <span className="home-fold-value">{value}</span>
          {pct ? <span className={`home-fold-pct ${pct.startsWith('-') ? 'profit-negative' : 'profit-positive'}`}>{pct}</span> : null}
        </span>
      </summary>
      <div className="home-fold-body">{children}</div>
    </details>
  );
}

// The home dashboard: the portfolio's top-level valuation, and one summary
// card per part of it.
//
// It deliberately holds NO holdings tables. Each asset class now has its own
// page (see router/routes.js), and a card here links to the page that shows
// the rows behind it - one card per asset class, so the cards account for
// every shekel in the total above them. The page used to render all five tables one after
// another, which meant the figures a user opens the app to check sat above
// several screens of rows they had not asked for.
function HomeView({
  summary,
  israeliStocks,
  americanStocks,
  pensionFunds,
  cashFunds,
  bankBalances,
  bankSavingsFunds = [],
  onNavigate,
  onLoadSamplePortfolio,
  isSamplePortfolio = false,
  mainCurrency = 'ILS',
  fxRate = null,
  ...toolbarProps
}) {
  const hasAnyData =
    israeliStocks.length > 0 ||
    americanStocks.length > 0 ||
    pensionFunds.length > 0 ||
    cashFunds.length > 0 ||
    bankBalances.length > 0 ||
    bankSavingsFunds.length > 0;


  const toneOf = (value) => (value > 0 ? 'positive' : value < 0 ? 'negative' : 'neutral');

  // There is no portfolio-wide profit percentage on the summary - only
  // per-market ones - so it is derived here from the two totals that do
  // exist. Null rather than 0 when there is nothing invested to divide by,
  // so an empty portfolio doesn't report a confident "0.00%".
  const totalProfitPercent =
    summary.totalPurchaseILS > 0 ? (summary.totalProfitILS / summary.totalPurchaseILS) * 100 : null;

  const cardProps = { summary, formatPriceWithSign };
  const compact = useCompactLayout();
  const ils = (v) => `${formatPriceWithSign(v)} ₪`;
  const savingsPct =
    summary.bankSavingsInitialInvestmentILS > 0 ? (summary.bankSavingsTotalProfitILS / summary.bankSavingsInitialInvestmentILS) * 100 : null;

  // The headline total in the main currency (settings ← investments), when
  // that is not the shekel and its rate is known; the shekel value under it.
  const symbol = { USD: '$', EUR: '€' }[mainCurrency];
  const converted = symbol && fxRate > 0;
  const headlineValue = converted
    ? `${formatPriceWithSign(summary.capitalTotalILS / fxRate)} ${symbol}`
    : `${formatPriceWithSign(summary.capitalTotalILS)} ₪`;
  const headlineSub = converted ? `סך כל הנכסים · ${formatPriceWithSign(summary.capitalTotalILS)} ₪` : 'סך כל הנכסים';

  // Which categories the user holds.
  const present = {
    israeli: israeliStocks.length > 0,
    american: americanStocks.length > 0,
    cash: cashFunds.length > 0,
    pension: pensionFunds.length > 0,
    bank: bankBalances.length > 0,
    bankSavings: bankSavingsFunds.length > 0
  };
  // The markets first - they are read against each other - then the
  // accounts that do not move with the market.
  const categoryCards = [
    present.israeli && {
      key: 'israeli',
      to: 'israeli-stocks',
      title: 'בורסה ישראלית',
      value: ils(summary.israeliOnlyCurrentValueILS),
      pct: pctText(summary.israeliOnlyProfitPercent),
      card: <IsraeliMarketCard {...cardProps} />
    },
    present.american && {
      key: 'american',
      to: 'us-stocks',
      title: 'בורסה אמריקאית',
      value: `${formatPriceWithSign(summary.totalCurrentValueUSD)} $`,
      pct: pctText(summary.americanOnlyProfitPercent),
      card: <AmericanMarketCard {...cardProps} />
    },
    present.pension && {
      key: 'pension',
      to: 'provident-funds',
      title: 'קופות גמל',
      value: ils(summary.pensionCurrentValueILS),
      pct: pctText(summary.pensionProfitPercent),
      card: <ProvidentFundsCard {...cardProps} />
    },
    (present.cash || present.bank) && {
      key: 'liquid',
      to: 'cash-and-checking',
      title: 'כספית שקלית ועו"ש',
      value: ils((summary.capitalCashFundsILS || 0) + (summary.capitalBankILS || 0)),
      pct: null,
      card: <CashAndCheckingCard {...cardProps} showCash={present.cash} showBank={present.bank} />
    },
    present.bankSavings && {
      key: 'bank-savings',
      to: 'bank-savings',
      title: 'קופת חיסכון בבנק',
      value: ils(summary.bankSavingsCurrentValueILS),
      pct: pctText(savingsPct),
      card: <BankSavingsCard {...cardProps} />
    }
  ].filter(Boolean);
  const categoryRows = [];
  for (let i = 0; i < categoryCards.length; i += 2) categoryRows.push(categoryCards.slice(i, i + 2));

  // Says which markets the daily figure is made of, since a market that has
  // not traded today contributes 0 rather than its last session's change
  // (see utils/marketSession.js).
  const sessions = summary.dailyChangeSessions || {};
  const tradedToday = [
    sessions.israeli === 'today' ? 'ת"א' : null,
    sessions.american === 'today' ? 'ארה"ב' : null
  ].filter(Boolean);
  const anySessionKnown = sessions.israeli != null || sessions.american != null;
  const dailyChangeSub = !anySessionKnown
    ? 'משוקלל לפי שווי ההחזקות'
    : tradedToday.length === 0
      ? 'אין מסחר היום עדיין - יתעדכן עם פתיחת המסחר'
      : `מסחר היום: ${tradedToday.join(' + ')}`;

  // Each overview card is a doorway to the page that holds its rows. The
  // card stays a plain block of figures when there is nowhere to go (no
  // onNavigate) rather than rendering a button that does nothing.
  const CardLink = ({ to, children }) =>
    onNavigate ? (
      <button
        type="button"
        className="summary-card-link"
        onClick={() => onNavigate(to)}
        title="פתיחת הדף המלא"
      >
        {children}
        <span className="summary-card-link-hint" aria-hidden="true">
          הצגת הפירוט ←
        </span>
      </button>
    ) : (
      children
    );

  return (
    <div className="App">
      <div className="welcome-container">
        <div className="welcome-content">
          <PortfolioActionsToolbar
            {...toolbarProps}
            title="תיק ההשקעות שלך"
            subtitle={compact ? null : "סיכום התיק - לפירוט המלא של כל אפיק בחרו בו בתפריט או בכרטיס המתאים"}
            hasAnyData={hasAnyData}
            // The overview has no table to edit or to widen with extra
            // columns; those toggles belong on the asset pages.
            showTableControls={false}
            // The dashboard is read top to bottom and has no long table
            // below it, so a pinned header would only reserve a strip
            // over the figures the page is opened for.
            sticky={false}
          />

          <BetaBanner />

          {isSamplePortfolio && (
            <div className="sample-portfolio-note" role="status">
              זהו תיק לדוגמה עם נתונים בדויים. הוא לא נשמר - אפשר לשמור אותו, לערוך אותו או פשוט
              לרענן את הדף כדי להתחיל מאפס.
            </div>
          )}

          {/* The figures the app is opened to see, lifted out of the cards
              below so they aren't buried among detail that is read
              occasionally rather than every time. */}
          {hasAnyData && compact && (
            <CompactKpis
              headlineValue={headlineValue}
              headlineSub={headlineSub}
              totalProfitPercent={totalProfitPercent}
              summary={summary}
              dailyChangeSub={dailyChangeSub}
              profitDetails={<NetInvestmentCard {...cardProps} present={present} />}
            />
          )}

          {hasAnyData && !compact && (
            <KpiRow>
              {/* The figure the app is opened for, given the block of the
                  grid that says so. The three beside it qualify it. */}
              <KpiTile
                featured
                label="שווי תיק כולל"
                icon="₪"
                value={headlineValue}
                // The overall return, beside the figure it qualifies
                // rather than under it.
                badge={
                  totalProfitPercent != null
                    ? `${totalProfitPercent >= 0 ? '+' : ''}${totalProfitPercent.toFixed(1)}%`
                    : null
                }
                badgeTone={totalProfitPercent != null ? toneOf(totalProfitPercent) : 'neutral'}
                sub={headlineSub}
              />
              <KpiTile
                label="רווח/הפסד כולל"
                icon="↗"
                tone={toneOf(summary.totalProfitILS)}
                value={`${formatPriceWithSign(summary.totalProfitILS)} ₪`}
                sub={
                  totalProfitPercent != null
                    ? `${totalProfitPercent.toFixed(2)}% מההשקעה`
                    : 'אין השקעה רשומה'
                }
              />
              <KpiTile
                label="שינוי יומי"
                icon="◷"
                tone={toneOf(summary.dailyProfitILS)}
                value={`${formatPriceWithSign(summary.dailyProfitILS)} ₪`}
                badge={`${summary.weightedDailyChange >= 0 ? '+' : ''}${summary.weightedDailyChange.toFixed(2)}%`}
                badgeTone={toneOf(summary.dailyProfitILS)}
                sub={dailyChangeSub}
              />
              {/* Fills the rest of the featured tile's second row, so the
                  block stays rectangular. */}
              <KpiTile
                wide
                label="מס צפוי"
                icon="%"
                value={`${formatPriceWithSign(summary.totalTaxILS)} ₪`}
                sub="על הרווח הריאלי"
              />
            </KpiRow>
          )}

          {hasAnyData && compact && (
            <div className="portfolio-summary home-folds">
              <h2 className="portfolio-summary-title">סיכום התיק</h2>
              <CompactSummaryItem title='סה"כ מצב ההון' value={ils(summary.capitalTotalILS)}>
                <CapitalStateCard {...cardProps} present={present} />
              </CompactSummaryItem>
              {categoryCards.map((c) => (
                <CompactSummaryItem key={c.key} title={c.title} value={c.value} pct={c.pct}>
                  {c.card}
                  {onNavigate && (
                    <button type="button" className="home-fold-link" onClick={() => onNavigate(c.to)}>
                      לדף המלא ←
                    </button>
                  )}
                </CompactSummaryItem>
              ))}
            </div>
          )}

          {hasAnyData && !compact && (
            <div className="portfolio-summary">
              <h2 className="portfolio-summary-title">סיכום התיק</h2>
              <div className="summary-grid-custom">
                {/* THE ORDER IS AN ARGUMENT, read top to bottom.

                    The two portfolio-wide statements come first and each
                    takes a full row, because neither is about one market:
                    what the whole thing is worth, then what was put into
                    it against what it is worth now. Everything below them
                    is a component of those two totals.

                    Then the markets, paired - they are read against each
                    other. Then the accounts that are not traded. */}
                <div className="summary-row summary-row-single">
                  <CapitalStateCard {...cardProps} present={present} />
                </div>

                <div className="summary-row summary-row-single">
                  <NetInvestmentCard {...cardProps} present={present} />
                </div>

                {/* The categories, two to a row in this order - each only
                    when the user holds it, so the overview shows what they
                    entered rather than a card of zeros for everything else.
                    An odd card out takes the whole row. */}
                {categoryRows.map((row) => (
                  <div key={row.map((c) => c.key).join('-')} className={`summary-row${row.length === 1 ? ' summary-row-single' : ''}`}>
                    {row.map((c) => (
                      <CardLink key={c.key} to={c.to}>
                        {c.card}
                      </CardLink>
                    ))}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* הודעה אם אין נתונים */}
          {!hasAnyData && (
            <div className="no-data-message">
              <p>עדיין לא נוספו מניות לתיק ההשקעות שלך</p>
              <p>לחץ על הכפתור למעלה כדי להתחיל</p>
              {/* The fastest way to see what the app does: every page
                  filled in, without typing anything. */}
              {onLoadSamplePortfolio && (
                <div className="sample-portfolio-cta">
                  <p>רוצים קודם לראות איך זה נראה?</p>
                  <button
                    type="button"
                    className="toolbar-btn-primary"
                    onClick={onLoadSamplePortfolio}
                  >
                    טען תיק לדוגמה
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default HomeView;
