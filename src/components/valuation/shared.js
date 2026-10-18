import React from 'react';

// Numbers are isolated as left-to-right runs so a sign never jumps to the
// wrong side inside right-to-left text ("-82.8%", not "82.8%-").
export const Num = ({ children }) => <bdi dir="ltr">{children}</bdi>;

export const isNum = (v) => v !== null && v !== undefined && Number.isFinite(v);
export const fmtX = (v) => (isNum(v) ? `${v.toFixed(1)}x` : 'N/M');
export const fmtPlain = (v) => (isNum(v) ? v.toFixed(1) : '—');
export const fmtPct = (v, digits = 1) => (isNum(v) ? `${v > 0 ? '+' : ''}${v.toFixed(digits)}%` : '—');
export const fmtRate = (v, digits = 1) => (isNum(v) ? `${(v * 100).toFixed(digits)}%` : '—');
export const fmtMoney = (v, currency = '') => {
  if (!isNum(v)) return '—';
  const abs = Math.abs(v);
  const text = abs >= 1e9 ? `${(v / 1e9).toFixed(2)}B` : abs >= 1e6 ? `${(v / 1e6).toFixed(1)}M` : v.toFixed(2);
  return `${text}${currency ? ` ${currency}` : ''}`;
};

// A short colored word - "זול", "יקר" - that carries its meaning in the
// text, not only in the color.
export function ToneBadge({ tone, children }) {
  return <span className={`val-badge val-badge-${tone}`}>{children}</span>;
}
