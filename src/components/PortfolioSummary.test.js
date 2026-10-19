import { render, within } from '@testing-library/react';
import PortfolioSummary, {
  CapitalStateCard,
  BankSavingsCard,
  CashAndCheckingCard
} from './PortfolioSummary';
import { calculatePortfolioSummary } from '../utils/portfolioSummary';

const formatPriceWithSign = (v) => (v ?? 0).toFixed(2);

const israeliStocks = [
  { id: 1, stockName: 'TEVA', purchaseDate: '2023-01-15', purchasePrice: 30, quantity: 100, currentPrice: 35 }
];
const pensionFunds = [{ id: 100, fundName: 'קופה א', initialInvestment: 10000, currentValue: 12000, updateDate: '2024-01-01' }];
const cashFunds = [{ id: 200, fundName: 'קרן כספית', updateDate: '2024-01-01', amount: 5000 }];
const bankBalances = [{ id: 300, updateDate: '2024-01-01', amount: 20000 }];
const bankSavingsFunds = [
  {
    id: 400,
    fundName: 'חיסכון בנק',
    updateDate: '2024-01-01',
    deposits: [{ date: '2023-01-01', amount: 50000 }],
    interestRate: 4,
    isLinkedToIndex: false
  }
];

const summary = calculatePortfolioSummary(
  israeliStocks,
  [],
  pensionFunds,
  cashFunds,
  bankBalances,
  undefined,
  bankSavingsFunds
);

// Reads a card's rows as { label: value } so an assertion names the row it
// means rather than indexing into the DOM.
function rowsOf(container) {
  return Array.from(container.querySelectorAll('.summary-item')).reduce((acc, item) => {
    acc[item.querySelector('.summary-label').textContent] = item.querySelector('.summary-value').textContent;
    return acc;
  }, {});
}

describe('CapitalStateCard', () => {
  test('lists a row for every asset class the total is made of', () => {
    const { container } = render(
      <CapitalStateCard summary={summary} formatPriceWithSign={formatPriceWithSign} />
    );
    const labels = Object.keys(rowsOf(container));
    expect(labels).toEqual([
      'בורסה ישראלית:',
      'בורסה אמריקאית:',
      'כספית שקלית:',
      'קופת גמל:',
      'עו"ש:',
      'קופת חיסכון בבנק:',
      'סה"כ מצב ההון:'
    ]);
  });

  // The regression this row exists for: the total always counted bank
  // savings, but the card listed five components, so with a savings fund
  // the figures on screen visibly did not add up to the total beneath them.
  test('the listed components sum to the stated total', () => {
    const { container } = render(
      <CapitalStateCard summary={summary} formatPriceWithSign={formatPriceWithSign} />
    );
    const rows = rowsOf(container);
    const num = (label) => parseFloat(rows[label]);
    const parts =
      num('בורסה ישראלית:') +
      num('בורסה אמריקאית:') +
      num('כספית שקלית:') +
      num('קופת גמל:') +
      num('עו"ש:') +
      num('קופת חיסכון בבנק:');
    expect(parts).toBeCloseTo(num('סה"כ מצב ההון:'), 2);
  });

  test('the bank savings row carries the value the summary computed', () => {
    const { container } = render(
      <CapitalStateCard summary={summary} formatPriceWithSign={formatPriceWithSign} />
    );
    expect(summary.capitalBankSavingsILS).toBeGreaterThan(0);
    expect(rowsOf(container)['קופת חיסכון בבנק:']).toBe(
      `${formatPriceWithSign(summary.capitalBankSavingsILS)} ₪`
    );
  });
});

describe('BankSavingsCard', () => {
  test('shows deposits, current value, profit and tax', () => {
    const { container } = render(
      <BankSavingsCard summary={summary} formatPriceWithSign={formatPriceWithSign} />
    );
    const rows = rowsOf(container);
    expect(rows['סך הפקדות:']).toBe(`${formatPriceWithSign(summary.bankSavingsInitialInvestmentILS)} ₪`);
    expect(rows['סך שווי היום:']).toBe(`${formatPriceWithSign(summary.bankSavingsCurrentValueILS)} ₪`);
    // The amount with its percent beside it, in one row.
    expect(rows['סה"כ רווח והפסד:'].startsWith(`${formatPriceWithSign(summary.bankSavingsTotalProfitILS)} ₪`)).toBe(true);
    expect(rows['סה"כ רווח והפסד:']).toMatch(/%$/);
    expect(rows['סה"כ מס שנשלם:']).toBe(`${formatPriceWithSign(-summary.bankSavingsTaxILS)} ₪`);
  });

  // An account with nothing in it has no return, and saying "0.00%" would
  // state one.
  test('reports no percentage rather than 0.00% when nothing was deposited', () => {
    const empty = calculatePortfolioSummary([], [], [], [], [], undefined, []);
    const { container } = render(
      <BankSavingsCard summary={empty} formatPriceWithSign={formatPriceWithSign} />
    );
    expect(rowsOf(container)['סה"כ רווח והפסד:']).not.toMatch(/%/);
  });
});

describe('CashAndCheckingCard', () => {
  test('pairs the money-market funds with the current accounts and totals them', () => {
    const { container } = render(
      <CashAndCheckingCard summary={summary} formatPriceWithSign={formatPriceWithSign} />
    );
    const rows = rowsOf(container);
    expect(rows['כספית שקלית:']).toBe(`${formatPriceWithSign(summary.capitalCashFundsILS)} ₪`);
    expect(rows['עו"ש:']).toBe(`${formatPriceWithSign(summary.capitalBankILS)} ₪`);
    expect(rows['סה"כ נזיל:']).toBe(
      `${formatPriceWithSign(summary.capitalCashFundsILS + summary.capitalBankILS)} ₪`
    );
  });

  // Neither category records what was paid in separately from what it is
  // worth, so a profit row would have nothing behind it.
  test('states no profit figure, which it has no basis for', () => {
    const { container } = render(
      <CashAndCheckingCard summary={summary} formatPriceWithSign={formatPriceWithSign} />
    );
    const labels = Object.keys(rowsOf(container));
    expect(labels.some((l) => l.includes('רווח'))).toBe(false);
  });

  test('an empty portfolio reports no share of the portfolio rather than 0.00%', () => {
    const empty = calculatePortfolioSummary([], [], [], [], [], undefined, []);
    const { container } = render(
      <CashAndCheckingCard summary={empty} formatPriceWithSign={formatPriceWithSign} />
    );
    expect(rowsOf(container)['שיעור מהתיק:']).toBe('—');
  });
});

test('the full summary block renders all seven cards', () => {
  const { container } = render(
    <PortfolioSummary summary={summary} formatPriceWithSign={formatPriceWithSign} />
  );
  expect(container.querySelectorAll('.summary-section').length).toBe(7);
  expect(within(container).getByText('סיכום התיק')).toBeInTheDocument();
});
