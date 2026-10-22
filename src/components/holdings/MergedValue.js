import React from 'react';
import { formatPriceWithSign } from '../../utils/formatters';

// The pieces a merged holdings column is made of: an amount, a percent
// beside it, and a second figure under it (the shekel value under the
// dollar one, the purchase price under the current one).
//
// Columns that always read together were separate - profit in shekels in
// one column and its percent three columns away, the dollar value and the
// shekel value side by side - so a reader had to pair them up by eye. Now
// each pair is one cell. Every amount goes through formatPriceWithSign, so
// privacy mode masks all of them; percents stay visible, as elsewhere.

const tone = (v) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n === 0) return '';
  return n > 0 ? 'profit-positive' : 'profit-negative';
};

// An amount and its currency. `signed` colors it by its sign (profit,
// change); a plain amount (value, cost) stays in the text color.
export function Money({ value, currency = '₪', signed = false, className = '' }) {
  return (
    <span className={`mv-num ${signed ? tone(value) : ''} ${className}`.trim()}>
      {formatPriceWithSign(value)} {currency}
    </span>
  );
}

// A percent with its sign, colored like the amount it qualifies.
export function Pct({ value, digits = 2 }) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return (
    <span className={`mv-pct ${tone(n)}`}>
      {n > 0 ? '+' : ''}
      {n.toFixed(digits)}%
    </span>
  );
}

// "15.10" - a session date, short.
export const shortSessionDate = (iso) => (iso ? `${Number(iso.slice(8, 10))}.${Number(iso.slice(5, 7))}` : '');

// The change on the holding's last completed session (see
// utils/lastSessionChange.js): "אתמול +12.30 ₪ +0.40%", or "—" when it is
// not known. The session's date is in the tooltip - on a Monday it is
// Friday's.
export function LastSessionChange({ result, label = 'אתמול' }) {
  if (!result || !Number.isFinite(result.changeILS)) {
    return (
      <span className="mv-last" title="אין עדיין נתון על יום המסחר האחרון">
        {label} —
      </span>
    );
  }
  const title = `יום המסחר ${shortSessionDate(result.date)}${result.fxApprox ? ' · לפי שער הדולר הנוכחי' : ''}`;
  return (
    <span className="mv-last" title={title}>
      {label} <Money value={result.changeILS} signed /> <Pct value={result.pct} />
    </span>
  );
}

// A cell's content: the main line, and optionally a quieter line under it.
export function Merged({ main, sub }) {
  return (
    <span className="mv">
      <span className="mv-main">{main}</span>
      {sub != null && sub !== false && <span className="mv-sub">{sub}</span>}
    </span>
  );
}

// A two-line column header: the name, and under it what the cell holds
// ("₪ · %"), so a merged column says what its two figures are.
export function MergedHeader({ title, hint }) {
  return (
    <span className="mv-head">
      <span className="mv-head-title">{title}</span>
      {hint && <span className="mv-head-hint">{hint}</span>}
    </span>
  );
}
