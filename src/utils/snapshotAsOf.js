// THE AS-OF DATE OF A MONTHLY CHECKPOINT, and the figures that go with it.
//
// A checkpoint for "August 2026" is a set of figures that were true on ONE
// day - say August 6. Everything here works from that day:
//
//   * the liquid accounts (checking, money-market funds) are worth their
//     last recorded balance on or before it, plus every deposit/withdrawal
//     in their ledger after that balance up to and including it - computed,
//     not retyped (see ledgerAccountHistory.js's valueOfLedgerAccountAtDate);
//   * stocks are priced from the closes on or before it, for the units held
//     on it (the historical breakdown, see historicalPortfolioValue.js);
//   * a provident fund's value comes from a statement, and a statement has
//     its own date. pensionStatementStatus says whether the statement behind
//     the figure is for this date, or an earlier/later one the figure was
//     carried across.
//
// And the comparison between two checkpoints measures from one as-of date
// to the other (see monthlySnapshotComparison.js), never from month names.

import { valueOfLedgerAccountAtDate } from './ledgerAccountHistory';
import { computeBankSavingsFundValue } from './bankSavingsFund';

// A statement within this many days of the as-of date counts as being FOR
// it - provident-fund statements for a month-end arrive in the first days
// of the next month (the same grace the monthly sync uses).
export const STATEMENT_TOLERANCE_DAYS = 10;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86400000;

const lastDayOfMonth = (month) => {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
};

const daysBetween = (from, to) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);

// The dates a month's checkpoint may be valid for: inside the month, and
// never in the future.
export function asOfRange(month, today) {
  if (!/^\d{4}-\d{2}$/.test(String(month || ''))) return null;
  const end = lastDayOfMonth(month);
  const max = end > today ? today : end;
  const min = `${month}-01`;
  return min > max ? null : { min, max };
}

// The default as-of date: the month's last day, or today for the month in
// progress.
export function defaultAsOfDate(month, today) {
  const range = asOfRange(month, today);
  return range ? range.max : null;
}

export function isValidAsOfDate(month, date, today) {
  const range = asOfRange(month, today);
  return Boolean(range && DATE_RE.test(String(date || '')) && date >= range.min && date <= range.max);
}

// The liquid accounts' itemized balances on `date`, from their ledgers.
// Keyed exactly as monthlySnapshotBreakdown.js keys them, so a checkpoint
// saved from these compares item-for-item with one saved live.
export function liquidItemsAtDate({ cashFunds = [], bankBalances = [] }, date) {
  const cash = (cashFunds || [])
    .map((fund) => ({
      key: fund.fundName || `cash-${fund.id}`,
      label: fund.fundName || 'קרן כספית',
      value: valueOfLedgerAccountAtDate(fund, date, { anchorToFirstRecord: true })
    }))
    .filter((item) => item.value !== 0);
  const bank = (bankBalances || [])
    .map((account, index) => ({
      key: `bank-${index + 1}`,
      label: bankBalances.length > 1 ? `עו"ש #${index + 1}` : 'עו"ש',
      value: valueOfLedgerAccountAtDate(account, date, { anchorToFirstRecord: true })
    }))
    .filter((item) => item.value !== 0);
  return { cashFunds: cash, bank };
}

// Bank savings compound deterministically from their deposits, so they can
// be valued exactly on any date.
export function bankSavingsItemsAtDate(bankSavingsFunds = [], date) {
  return (bankSavingsFunds || [])
    .map((fund) => {
      const deposits = (fund.deposits || []).filter((d) => d && d.date && d.date <= date);
      return {
        key: fund.fundName || `bank-savings-${fund.id}`,
        label: fund.fundName || 'קופת חיסכון בבנק',
        value: deposits.length ? computeBankSavingsFundValue({ ...fund, deposits }, date) : 0
      };
    })
    .filter((item) => item.value !== 0);
}

// The full itemized breakdown a checkpoint valid on `asOfDate` should hold.
//
//   asOfDate === today: the live figures (current prices, current
//     statements), with the liquid accounts synced from their ledgers;
//   an earlier date: the historical breakdown on that day - which needs the
//     price history loaded, so null until it is (the caller says "not yet"
//     rather than saving a row of zeroes).
export function composeAsOfBreakdown({ asOfDate, today, liveBreakdown, historicalBreakdownAtDate, holdings = {} }) {
  if (!DATE_RE.test(String(asOfDate || ''))) return null;
  const liquid = liquidItemsAtDate(holdings, asOfDate);
  if (asOfDate === today) {
    if (!liveBreakdown) return null;
    return { ...liveBreakdown, ...liquid };
  }
  const historical = historicalBreakdownAtDate ? historicalBreakdownAtDate(asOfDate) : null;
  if (!historical) return null;
  const hasAny = ['israeli', 'american', 'pension', 'cashFunds', 'bank', 'bankSavings'].some(
    (key) => (historical[key] || []).length > 0
  );
  if (!hasAny && liquid.cashFunds.length === 0 && liquid.bank.length === 0) return null;
  return { ...historical, ...liquid, bankSavings: bankSavingsItemsAtDate(holdings.bankSavingsFunds, asOfDate) };
}

// The value statements a provident fund carries, oldest first.
function statementPoints(fund) {
  const points = [];
  [
    [fund && fund.previousValueDate, fund && fund.previousValue],
    [fund && fund.currentValueDate, fund && fund.currentValue]
  ].forEach(([date, value]) => {
    if (typeof date === 'string' && DATE_RE.test(date.slice(0, 10)) && Number.isFinite(Number(value))) {
      points.push({ date: date.slice(0, 10), value: Number(value) });
    }
  });
  return points.sort((a, b) => (a.date < b.date ? -1 : 1));
}

// Whether a provident fund's figure on `asOfDate` comes from a statement for
// that date.
//
//   'match'   - the nearest statement is within STATEMENT_TOLERANCE_DAYS;
//   'earlier' - the nearest statement is older: the figure is that
//               statement carried forward, plus the deposits since - growth
//               since then is not in it;
//   'later'   - the nearest statement is newer: the figure is that statement
//               with the deposits made after the as-of date backed out - it
//               includes growth that happened after the as-of date;
//   'none'    - no statement at all; the figure is only the deposits.
export function pensionStatementStatus(fund, asOfDate, toleranceDays = STATEMENT_TOLERANCE_DAYS) {
  const points = statementPoints(fund);
  if (!points.length) return { status: 'none', statementDate: null, days: null };
  const nearest = points.reduce((best, p) =>
    Math.abs(daysBetween(asOfDate, p.date)) < Math.abs(daysBetween(asOfDate, best.date)) ? p : best
  );
  const days = daysBetween(asOfDate, nearest.date);
  const status = Math.abs(days) <= toleranceDays ? 'match' : days < 0 ? 'earlier' : 'later';
  return { status, statementDate: nearest.date, days };
}

export function pensionStatementsAtDate(pensionFunds = [], asOfDate) {
  return (pensionFunds || []).map((fund) => ({
    key: fund.fundName || `pension-${fund.id}`,
    name: fund.fundName || 'קופת גמל',
    ...pensionStatementStatus(fund, asOfDate)
  }));
}
