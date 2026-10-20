import React from 'react';

// The portfolio's figures, as five self-contained cards.
//
// Each card is exported on its own because the pages now need them
// separately: the home dashboard shows four of them side by side as its
// overview, while each asset page shows only the one card that describes
// the holdings on that page. Previously this was a single 35-row block that
// only ever rendered as a whole, so a page that wanted one market's numbers
// had to show every other market's too.
//
// The rows themselves are unchanged - the same labels, the same fields off
// the same `summary` object, the same profit-positive/negative classes.

// A card's frame. Kept in one place so every card keeps the same padding,
// title weight and row rhythm no matter which page renders it.
//
// The figures inside are .summary-item/.summary-label/.summary-value
// triples. That markup is already a tile - a label and a value - so
// turning these cards from a stacked list of rows into a scannable grid
// of tiles is done entirely in App.css (see .summary-section), with the
// gain/loss classes the values already carry rendered as tinted badges.
// Nothing here had to change for it, which is why nothing here did.
function SummaryCard({ children }) {
  return <div className="summary-section summary-col">{children}</div>;
}

// Which categories the user holds - each card leaves out the rows of one
// they don't. All of them unless said otherwise.
export const ALL_CATEGORIES = { israeli: true, american: true, cash: true, pension: true, bank: true, bankSavings: true };

export function CapitalStateCard({ summary, formatPriceWithSign, present = ALL_CATEGORIES }) {
  const row = (shown, label, value) =>
    shown ? (
      <div className="summary-item"><span className="summary-label">{label}:</span><span className="summary-value">{formatPriceWithSign(value)} ₪</span></div>
    ) : null;
  return (
    <SummaryCard>
        <h3 className="summary-section-title">סה"כ מצב ההון</h3>
        {row(present.israeli, 'בורסה ישראלית', summary.capitalIsraeliILS)}
        {row(present.american, 'בורסה אמריקאית', summary.capitalAmericanILS)}
        {row(present.cash, 'כספית שקלית', summary.capitalCashFundsILS)}
        {row(present.pension, 'קופת גמל', summary.capitalPensionILS)}
        {row(present.bank, 'עו"ש', summary.capitalBankILS)}
        {/* capitalTotalILS has always counted bank savings; this row was
            missing, so the components visibly did not add up to the total
            underneath them for anyone holding one. */}
        {row(present.bankSavings, 'קופת חיסכון בבנק', summary.capitalBankSavingsILS)}
        {row(true, 'סה"כ מצב ההון', summary.capitalTotalILS)}
    </SummaryCard>
  );
}

// Percent return against what was paid in. Null rather than 0 when nothing
// has been deposited, so an unused account doesn't report a confident
// "0.00%" return.
function returnPercent(profit, invested) {
  return invested > 0 ? (profit / invested) * 100 : null;
}

function percentText(value) {
  return value == null ? '—' : `${value.toFixed(2)}%`;
}

function percentClass(value) {
  if (value == null) return '';
  return value >= 0 ? 'profit-positive' : 'profit-negative';
}

// An amount with its percent beside it, in one row - the two always read
// together ("how much, and how much is that"), so they are no longer two
// rows a reader has to pair up.
function AmountPercentRow({ label, amount, percent, currency = '₪', formatPriceWithSign }) {
  const tone = amount >= 0 ? 'profit-positive' : 'profit-negative';
  return (
    <div className="summary-item">
      <span className="summary-label">{label}:</span>
      <span className={`summary-value ${tone}`}>
        {formatPriceWithSign(amount)} {currency}
        {percent != null && Number.isFinite(percent) ? (
          <span className="summary-pct">
            {percent > 0 ? '+' : ''}
            {percent.toFixed(2)}%
          </span>
        ) : null}
      </span>
    </div>
  );
}

export function BankSavingsCard({ summary, formatPriceWithSign }) {
  const profitPercent = returnPercent(
    summary.bankSavingsTotalProfitILS,
    summary.bankSavingsInitialInvestmentILS
  );
  return (
    <SummaryCard>
        <h3 className="summary-section-title">קופת חיסכון בבנק - השקעה בש''ח(₪)</h3>
        <div className="summary-item"><span className="summary-label">סך הפקדות:</span><span className="summary-value">{formatPriceWithSign(summary.bankSavingsInitialInvestmentILS)} ₪</span></div>
        <div className="summary-item"><span className="summary-label">סך שווי היום:</span><span className="summary-value">{formatPriceWithSign(summary.bankSavingsCurrentValueILS)} ₪</span></div>
        <AmountPercentRow label='סה"כ רווח והפסד' amount={summary.bankSavingsTotalProfitILS} percent={profitPercent} formatPriceWithSign={formatPriceWithSign} />
        <div className="summary-item"><span className="summary-label">רווח ריאלי - חייב במס:</span><span className={`summary-value ${summary.bankSavingsRealGainILS >= 0 ? 'profit-positive' : 'profit-negative'}`}>{formatPriceWithSign(summary.bankSavingsRealGainILS)} ₪</span></div>
        <div className="summary-item"><span className="summary-label">סה"כ מס שנשלם:</span><span className="summary-value profit-negative">{formatPriceWithSign(-summary.bankSavingsTaxILS)} ₪</span></div>
    </SummaryCard>
  );
}

// The two liquid categories, together - the same pairing the
// /cash-and-checking page makes, and for the same reason: to the user these
// are one thing, money available right now.
//
// There is no profit line here. Neither category records what was paid in
// as distinct from what it is worth: a current account is a balance, and a
// money-market fund is held at its updated value. A "profit" row would have
// nothing behind it.
//
// The money-market funds have their return since the previous value update
// and their return since the money went in (portfolioSummary.js), with the
// profit in shekels beside the percentage. showCash/showBank leave out a
// category the user does not hold, rather than a row of zeros for it.
export function CashAndCheckingCard({ summary, formatPriceWithSign, showCash = true, showBank = true }) {
  const liquidTotal = (summary.capitalCashFundsILS || 0) + (summary.capitalBankILS || 0);
  const returnRow = (label, percent, profit) => (
    <div className="summary-item">
      <span className="summary-label">{label}:</span>
      <span className={`summary-value ${percentClass(percent)}`}>
        {percentText(percent)}
        {percent != null && profit != null ? ` (${formatPriceWithSign(profit)} ₪)` : ''}
      </span>
    </div>
  );
  return (
    <SummaryCard>
        <h3 className="summary-section-title">קרן כספית שקלית ועו"ש (₪)</h3>
        {showCash && (
          <>
            <div className="summary-item"><span className="summary-label">כספית שקלית:</span><span className="summary-value">{formatPriceWithSign(summary.capitalCashFundsILS)} ₪</span></div>
            {returnRow('כספית - תשואה מעדכון קודם', summary.cashFundsPeriodReturnPercent, summary.cashFundsPeriodProfitILS)}
            {returnRow('כספית - תשואה כללית', summary.cashFundsTotalReturnPercent, summary.cashFundsTotalProfitILS)}
          </>
        )}
        {showBank && (
          <div className="summary-item"><span className="summary-label">עו"ש:</span><span className="summary-value">{formatPriceWithSign(summary.capitalBankILS)} ₪</span></div>
        )}
        <div className="summary-item"><span className="summary-label">סה"כ נזיל:</span><span className="summary-value">{formatPriceWithSign(liquidTotal)} ₪</span></div>
        <div className="summary-item"><span className="summary-label">שיעור מהתיק:</span><span className="summary-value">{percentText(returnPercent(liquidTotal, summary.capitalTotalILS))}</span></div>
    </SummaryCard>
  );
}

export function IsraeliMarketCard({ summary, formatPriceWithSign }) {
  return (
    <SummaryCard>
        <h3 className="summary-section-title"> בורסה ישראל - השקעה בש''ח(₪)</h3>
        <div className="summary-item"><span className="summary-label">סה"כ השקעה:</span><span className="summary-value">{formatPriceWithSign(summary.israeliOnlyPurchaseILS)} ₪</span></div>
        <div className="summary-item"><span className="summary-label">סה"כ שווי:</span><span className="summary-value">{formatPriceWithSign(summary.israeliOnlyCurrentValueILS)} ₪</span></div>
        <AmountPercentRow label="סך רווח והפסד" amount={summary.israeliOnlyProfitILS} percent={summary.israeliOnlyProfitPercent} formatPriceWithSign={formatPriceWithSign} />
        <AmountPercentRow label="רווח והפסד יומי" amount={summary.israeliOnlyDailyProfitILS} percent={summary.israeliOnlyDailyPercent} formatPriceWithSign={formatPriceWithSign} />
        <div className="summary-item"><span className="summary-label">רווח ריאלי - חייב במס:</span><span className={`summary-value ${summary.israeliOnlyRealGainILS >= 0 ? 'profit-positive' : 'profit-negative'}`}>{formatPriceWithSign(summary.israeliOnlyRealGainILS)} ₪</span></div>
        <div className="summary-item"><span className="summary-label">רווח אינפלציוני - פטור ממס:</span><span className="summary-value">{formatPriceWithSign(summary.israeliOnlyInflationaryGainILS)} ₪</span></div>
        <div className="summary-item"><span className="summary-label">סה"כ מס שנשלם:</span><span className="summary-value profit-negative">{formatPriceWithSign(-summary.israeliOnlyTaxILS)} ₪</span></div>
    </SummaryCard>
  );
}

export function AmericanMarketCard({ summary, formatPriceWithSign }) {
  return (
    <SummaryCard>
        <h3 className="summary-section-title">בורסה אמריקאית - השקעה בדולר ($)</h3>
        <div className="summary-item"><span className="summary-label">סה"כ השקעה:</span><span className="summary-value">{formatPriceWithSign(summary.totalPurchaseUSD)} $</span></div>
        <div className="summary-item"><span className="summary-label">סה"כ שווי:</span><span className="summary-value">{formatPriceWithSign(summary.totalCurrentValueUSD)} $</span></div>
        <AmountPercentRow label='סה"כ רווח והפסד' amount={summary.totalProfitUSD} percent={summary.americanOnlyProfitPercent} currency="$" formatPriceWithSign={formatPriceWithSign} />
        <AmountPercentRow label="רווח והפסד יומי" amount={summary.americanOnlyDailyProfitUSD} percent={summary.americanOnlyDailyPercent} currency="$" formatPriceWithSign={formatPriceWithSign} />
        <div className="summary-item"><span className="summary-label">רווח ריאלי חייב במס:</span><span className={`summary-value ${summary.americanOnlyRealGainILS >= 0 ? 'profit-positive' : 'profit-negative'}`}>{formatPriceWithSign(summary.americanOnlyRealGainILS)} ₪</span></div>
        <div className="summary-item"><span className="summary-label">רווח אינפלציוני פטור ממס (משער חליפין):</span><span className="summary-value">{formatPriceWithSign(summary.americanOnlyCurrencyExemptGainILS)} ₪</span></div>
        <div className="summary-item"><span className="summary-label">סך מס שנשלם:</span><span className="summary-value profit-negative">{formatPriceWithSign(-summary.americanOnlyTaxUSD)} $</span></div>
        {/* What the dollar's move did to these holdings in shekels - until
            now only in the home page's overall summary. */}
        <div className="summary-item"><span className="summary-label">השפעת הדולר על התיק:</span><span className={`summary-value ${summary.totalExchangeImpact >= 0 ? 'profit-positive' : 'profit-negative'}`}>{formatPriceWithSign(summary.totalExchangeImpact)} ₪</span></div>
    </SummaryCard>
  );
}

export function NetInvestmentCard({ summary, formatPriceWithSign, present = ALL_CATEGORIES }) {
  const totalReturn = returnPercent(summary.totalProfitILS, summary.totalPurchaseILS);
  return (
    <SummaryCard>
        <h3 className="summary-section-title">רווח והפסד כולל (₪)</h3>
        <div className="summary-item"><span className="summary-label">סה"כ השקעה בש"ח:</span><span className="summary-value">{formatPriceWithSign(summary.totalPurchaseILS)} ₪</span></div>
        <div className="summary-item"><span className="summary-label">סה"כ שווי בש"ח:</span><span className="summary-value">{formatPriceWithSign(summary.totalCurrentValueILS)} ₪</span></div>
        <AmountPercentRow label='סה"כ רווח והפסד בש"ח' amount={summary.totalProfitILS} percent={totalReturn} formatPriceWithSign={formatPriceWithSign} />
        <div className="summary-item"><span className="summary-label">סה"כ רווח ריאלי חייב במס:</span><span className={`summary-value ${summary.totalRealGainILS >= 0 ? 'profit-positive' : 'profit-negative'}`}>{formatPriceWithSign(summary.totalRealGainILS)} ₪</span></div>
        <div className="summary-item"><span className="summary-label">סה"כ רווח אינפלציוני פטור ממס:</span><span className="summary-value">{formatPriceWithSign(summary.totalInflationaryGainILS)} ₪</span></div>
        <div className="summary-item"><span className="summary-label">סה"כ מס לשלם:</span><span className="summary-value profit-negative">{formatPriceWithSign(-summary.totalTaxILS)} ₪</span></div>
        <div className="summary-item"><span className="summary-label">סה"כ רווח והפסד לאחר מס:</span><span className={`summary-value ${summary.totalProfitAfterTaxILS >= 0 ? 'profit-positive' : 'profit-negative'}`}>{formatPriceWithSign(summary.totalProfitAfterTaxILS)} ₪</span></div>
        {present.american && (
          <div className="summary-item"><span className="summary-label">השפעת הדולר על התיק:</span><span className={`summary-value ${summary.totalExchangeImpact >= 0 ? 'profit-positive' : 'profit-negative'}`}>{formatPriceWithSign(summary.totalExchangeImpact)} ₪</span></div>
        )}
    </SummaryCard>
  );
}

export function ProvidentFundsCard({ summary, formatPriceWithSign }) {
  return (
    <SummaryCard>
        <h3 className="summary-section-title">קופות גמל - השקעה בש''ח(₪)</h3>
        <div className="summary-item"><span className="summary-label">סך הפקדות:</span><span className="summary-value">{formatPriceWithSign(summary.pensionInitialInvestmentILS)} ₪</span></div>
        <div className="summary-item"><span className="summary-label">סך שווי היום:</span><span className="summary-value">{formatPriceWithSign(summary.pensionCurrentValueILS)} ₪</span></div>
        <div className="summary-item"><span className="summary-label">תשואה מעדכון קודם:</span><span className={`summary-value ${summary.pensionPreviousProfitPercent >= 0 ? 'profit-positive' : 'profit-negative'}`}>{summary.pensionPreviousProfitPercent.toFixed(2)}%</span></div>
        <AmountPercentRow label='סה"כ רווח והפסד' amount={summary.pensionTotalProfitILS} percent={summary.pensionProfitPercent} formatPriceWithSign={formatPriceWithSign} />
        <div className="summary-item"><span className="summary-label">רווח ריאלי - חייב במס:</span><span className={`summary-value ${summary.pensionRealGainILS >= 0 ? 'profit-positive' : 'profit-negative'}`}>{formatPriceWithSign(summary.pensionRealGainILS)} ₪</span></div>
        <div className="summary-item"><span className="summary-label">רווח אינפלציוני פטור:</span><span className="summary-value">{formatPriceWithSign(summary.pensionInflationaryGainILS)} ₪</span></div>
    </SummaryCard>
  );
}

// All seven cards in one block. Still used where the complete picture is
// wanted in one place.
function PortfolioSummary({ summary, formatPriceWithSign }) {
  const cardProps = { summary, formatPriceWithSign };
  return (
    <div className="portfolio-summary">
      <h2 className="portfolio-summary-title">סיכום התיק</h2>
      <div className="summary-grid-custom">
        <div className="summary-row summary-row-single">
          <CapitalStateCard {...cardProps} />
        </div>

        <div className="summary-row">
          <IsraeliMarketCard {...cardProps} />
          <AmericanMarketCard {...cardProps} />
        </div>

        <div className="summary-row">
          <NetInvestmentCard {...cardProps} />
          <ProvidentFundsCard {...cardProps} />
        </div>

        <div className="summary-row">
          <BankSavingsCard {...cardProps} />
          <CashAndCheckingCard {...cardProps} />
        </div>
      </div>
    </div>
  );
}

export default PortfolioSummary;
