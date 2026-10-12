// Every dated external cash flow into or out of the portfolio, drawn from
// the records the user already keeps in the main tables.
//
// "External" means money crossing the portfolio's boundary - a deposit, a
// withdrawal, or the cash spent buying a new position. It is NOT investment
// performance, and it is exactly what has to be netted out before a
// "return" figure means anything: a portfolio that went from ₪100k to
// ₪150k because ₪50k was paid into it did not grow 50%, it grew 0%.
//
// Sources, all of them already maintained elsewhere in the app:
//   * stock purchase lots  - each lot's cost at its purchase date
//                            (an American lot's cost is converted to ILS
//                            at the rate actually paid, matching how
//                            totalPurchaseILS is computed everywhere else)
//   * provident funds      - the dated deposit ledger
//   * bank savings funds   - the dated deposit ledger
//   * money-market funds   - the dated deposit ledger
//
//   * the transactions ledger - sale proceeds and dividends leaving the
//                            invested positions (negative flows), and the
//                            purchases of the units a sale closed, which
//                            arrive here as "closed slices" among the lots
//                            (see shared/transactionLedger.js)
//
// Withdrawals recorded in the ledger are written into the account's own
// deposit list as negative entries, so they flow through the deposit
// ledgers above with no special case. A sale or withdrawal that was NOT
// recorded as a transaction is still invisible and still reads as a loss -
// which is why the monthly tracker keeps its manual net-flow field for the
// liquid accounts, and why a current account's balance changes are not
// treated as flows at all (see below).
import { toNum } from './formatters';
import { earliestEvidenceDate, openingBalanceOfLedgerAccount } from './ledgerAccountHistory';
import { ledgerCashFlows } from '../shared/transactionLedger';

const isDatedFlow = (date) => typeof date === 'string' && /^\d{4}-\d{2}-\d{2}/.test(date);

function pushFlow(flows, date, amount) {
  if (!isDatedFlow(date)) return;
  const value = toNum(amount);
  if (value === 0) return;
  flows.push({ date: date.slice(0, 10), amount: value });
}

function pushDepositLedger(flows, accounts) {
  (accounts || []).forEach((account) => {
    (Array.isArray(account?.deposits) ? account.deposits : []).forEach((deposit) => {
      pushFlow(flows, deposit?.date, deposit?.amount);
    });
  });
}

// An account's OPENING BALANCE as a dated flow: the money it already held
// the first time the app has any record of it.
//
// This exists because of how a ledger account is valued in a performance
// series. With `anchorToFirstRecord` (see ledgerAccountHistory.js) an
// account is worth 0 before its first record, so its balance ARRIVES on
// that date. Something has to say that the arrival was a contribution
// rather than a gain, or the time-weighted return books the whole balance
// as performance - a ₪20,000 current account appearing mid-series would
// read as the portfolio suddenly earning ₪20,000.
//
// Only the unexplained part is recorded. An account whose first ledger
// entry is a deposit is already fully accounted for by that deposit, and
// adds nothing here; a bare balance with no ledger behind it is all
// opening balance.
function pushOpeningBalances(flows, accounts) {
  (accounts || []).forEach((account) => {
    const opening = earliestEvidenceDate(account);
    if (!opening) return;
    pushFlow(flows, opening, openingBalanceOfLedgerAccount(account));
  });
}

// holdings: { israeliStocks, americanStocks, pensionFunds, cashFunds,
// bankBalances, bankSavingsFunds }. Returns [{ date, amount }] sorted
// ascending by date, positive = money in.
//
// `includeLedgerOpeningBalances` pairs with the matching option on the
// valuation side and MUST be set the same way: a series that zeroes
// accounts before their first record needs these flows to explain the
// balances that then appear, and a series that back-projects those
// balances must not have them (the money never "arrives" in it, so a flow
// would be double-counted). They are two halves of one decision - see
// valueOfLedgerAccountAtDate.
//
// A current account's ONGOING balance changes are still not a source, with
// or without that option. A single overwritten balance with no ledger
// behind it cannot distinguish a deposit from spending, salary, or a
// transfer to a brokerage account already counted as a stock purchase.
// Guessing would double-count real flows; the opening balance above is the
// one piece that can be evidenced, because it is the difference between
// "no account" and "an account holding this much".
export const buildPortfolioCashFlows = ({
  israeliStocks = [],
  americanStocks = [],
  pensionFunds = [],
  cashFunds = [],
  bankBalances = [],
  bankSavingsFunds = [],
  includeLedgerOpeningBalances = false,
  // One rate for every American lot, instead of the rate each was bought
  // at. Pairs with computePortfolioValueAtDate's americanExchangeRate and
  // MUST match it: a contribution is netted out of the value change it
  // caused, so a flow recorded at a different rate than the holding was
  // valued at would leave the difference behind as a phantom gain or loss.
  americanExchangeRate = null,
  // The transactions ledger (optional). Only SELL and DIVIDEND rows add
  // flows here, and only for symbols present in the lots passed in - so a
  // caller that narrowed the lots to one market segment gets that
  // segment's sales and nothing else. Pass the lots expanded with their
  // closed slices, or a sold position's purchase is missing its matching
  // sale.
  transactions = null
} = {}) => {
  const flows = [];

  (israeliStocks || []).forEach((lot) => {
    pushFlow(flows, lot?.purchaseDate, toNum(lot?.purchasePrice) * toNum(lot?.quantity));
  });

  const useFixedFx = Number.isFinite(americanExchangeRate) && americanExchangeRate > 0;
  (americanStocks || []).forEach((lot) => {
    // The ILS actually paid: price x quantity x the rate on the day, the
    // same basis as totalPurchaseILS in portfolioMath.js. Using today's
    // rate instead would fold an FX move into the flow and quietly cancel
    // out part of the very performance being measured.
    //
    // Unless the whole series is being valued at one fixed rate, in which
    // case the flow takes that rate for the same reason in reverse: the
    // flow and the value it moved have to be in the same money.
    const rate = useFixedFx ? americanExchangeRate : toNum(lot?.exchangeRate);
    const costILS = toNum(lot?.purchasePrice) * toNum(lot?.quantity) * rate;
    pushFlow(flows, lot?.purchaseDate, costILS);
  });

  pushDepositLedger(flows, pensionFunds);
  pushDepositLedger(flows, cashFunds);
  pushDepositLedger(flows, bankSavingsFunds);

  if (includeLedgerOpeningBalances) {
    // Bank savings funds are deliberately absent. They are not valued
    // from a carried-forward balance at all - computeBankSavingsFundValue
    // compounds each deposit forward from its own date, so such a fund is
    // already worth exactly 0 before its first deposit and needs no
    // opening balance to get there. Its deposits are its flows, and they
    // are recorded above.
    pushOpeningBalances(flows, pensionFunds);
    pushOpeningBalances(flows, cashFunds);
    pushOpeningBalances(flows, bankBalances);
  }

  if (Array.isArray(transactions) && transactions.length) {
    const israeliHeld = new Set((israeliStocks || []).map((lot) => String(lot?.stockName ?? '').trim()));
    const americanHeld = new Set(
      (americanStocks || []).map((lot) => String(lot?.stockName ?? '').trim().toUpperCase())
    );
    const relevant = transactions.filter((tx) => {
      if (tx?.assetClass === 'israeli') return israeliHeld.has(String(tx.assetId ?? '').trim());
      if (tx?.assetClass === 'american') return americanHeld.has(String(tx.assetId ?? '').trim().toUpperCase());
      return false;
    });
    ledgerCashFlows(relevant, { americanExchangeRate: useFixedFx ? americanExchangeRate : null }).forEach((flow) =>
      flows.push(flow)
    );
  }

  return flows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
};

// The subset of flows falling in (periodStart, periodEnd] - a flow dated
// exactly on periodStart is treated as already reflected in that point's
// value, not as new money arriving during the period. Same convention as
// monthlySnapshotComparison.js's flowsInPeriod.
export const cashFlowsInPeriod = (flows, periodStart, periodEnd) =>
  (flows || []).filter((flow) => flow.date > periodStart && flow.date <= periodEnd);
