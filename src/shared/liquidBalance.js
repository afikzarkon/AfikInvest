// The balance of a current account or money-market fund on a given day.
//
// Such an account carries a RECORDED balance (the figure the user typed in,
// with its date - currentValue/currentValueDate, or amount/updateDate on
// older current accounts) and a ledger of dated deposits/withdrawals (its
// `deposits` list; withdrawals negative). Its balance on a day is:
//
//     the latest recorded balance on or before that day
//   + every ledger movement after that balance, up to and including the day
//
// So a movement recorded through the entry form shows in the balance at
// once, with no second entry, and the next balance the user records (from a
// statement) simply becomes the new starting point. The recorded balance
// itself is never rewritten by a movement: it stays what the statement said,
// with the date the statement was for - which is what the monthly sync reads
// to decide whether the account has been updated for the month.
//
// Same rule as utils/ledgerAccountHistory.js's valueOfLedgerAccountAtDate,
// which the history and the monthly tracker use; this copy is CommonJS so
// the server's monthly report can apply it too.

const DATE_RE = /^\d{4}-\d{2}-\d{2}/;

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

// The recorded balances an account carries, oldest first.
function recordedBalances(account) {
  const points = [];
  if (!account) return points;
  const push = (date, value) => {
    if (typeof date !== 'string' || !DATE_RE.test(date)) return;
    if (value === null || value === undefined || value === '' || !Number.isFinite(Number(value))) return;
    points.push({ date: date.slice(0, 10), value: Number(value) });
  };
  push(account.previousValueDate, account.previousValue);
  push(account.currentValueDate, account.currentValue !== undefined && account.currentValue !== null ? account.currentValue : account.amount);
  if (!account.currentValueDate) push(account.updateDate, account.amount);
  return points.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

function movementsBetween(account, afterExclusive, uptoInclusive) {
  return (Array.isArray(account && account.deposits) ? account.deposits : []).reduce((sum, d) => {
    if (!d || typeof d.date !== 'string' || !DATE_RE.test(d.date)) return sum;
    const date = d.date.slice(0, 10);
    if (afterExclusive && date <= afterExclusive) return sum;
    if (uptoInclusive && date > uptoInclusive) return sum;
    return sum + num(d.amount);
  }, 0);
}

// day: 'YYYY-MM-DD'.
function liquidBalanceOn(account, day) {
  if (!account) return 0;
  const points = recordedBalances(account);
  const atOrBefore = points.filter((p) => p.date <= day);
  if (atOrBefore.length) {
    const anchor = atOrBefore[atOrBefore.length - 1];
    return anchor.value + movementsBetween(account, anchor.date, day);
  }
  // No balance recorded yet as of that day: a later recorded balance with
  // the movements in between backed out, or failing that the movements.
  if (points.length) return points[0].value - movementsBetween(account, day, points[0].date);
  // A legacy account with only an undated balance: that balance, as before.
  if (account.amount !== undefined && account.amount !== null && account.amount !== '') return num(account.amount);
  return movementsBetween(account, null, day);
}

// The movements recorded after the latest recorded balance, up to `day` -
// what the balance includes beyond the last statement (for the tables to
// say so).
function movementsSinceLastBalance(account, day) {
  const points = recordedBalances(account).filter((p) => p.date <= day);
  if (!points.length) return 0;
  return movementsBetween(account, points[points.length - 1].date, day);
}

module.exports = { liquidBalanceOn, movementsSinceLastBalance, recordedBalances };
