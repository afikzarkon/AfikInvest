import { render, screen, within } from '@testing-library/react';
import TaxOffsetView from './TaxOffsetView';

// The tax-loss calculator, now its own page rather than one section among
// fourteen on the analytics page. It holds no state: everything shown is
// derived from the current holdings and the CPI.

const formatPriceWithSign = (v) => (v ?? 0).toFixed(2);

// Bought at 50, now 35 - a real loss, so it is an offsetting opportunity.
const losingStock = {
  id: 1,
  stockName: 'LOSS',
  quantity: 100,
  purchasePrice: 50,
  currentPrice: 35,
  purchaseDate: '2023-01-15'
};
// Bought at 20, now 35 - a gain, so it is something to offset against.
const winningStock = {
  id: 2,
  stockName: 'WIN',
  quantity: 100,
  purchasePrice: 20,
  currentPrice: 35,
  purchaseDate: '2023-01-15'
};

function makeProps(overrides = {}) {
  return {
    formatPriceWithSign,
    israeliStocks: [losingStock, winningStock],
    americanStocks: [],
    pensionFunds: [],
    bankSavingsFunds: [],
    cpi: null,
    ...overrides
  };
}

test('titles itself through the shared page toolbar, like every other page', () => {
  const { container } = render(<TaxOffsetView {...makeProps()} />);
  expect(container.querySelector('.page-toolbar')).not.toBeNull();
  expect(screen.getByText('הזדמנות לקיזוז מס', { selector: '.page-toolbar-title' })).toBeInTheDocument();
});

test('shows the three headline figures the decision turns on', () => {
  const { container } = render(<TaxOffsetView {...makeProps()} />);
  // Scoped to the cards: "שווי מס פוטנציאלי" is also a column heading in
  // the positions table below them.
  const cards = Array.from(container.querySelectorAll('.distribution-card h3')).map((el) => el.textContent);
  expect(cards).toEqual([
    'סה"כ הפסד ריאלי הניתן למימוש',
    'שווי מס פוטנציאלי',
    'רווחים ריאליים פתוחים כרגע'
  ]);
});

test('lists the losing positions, and not the winning ones', () => {
  const { container } = render(<TaxOffsetView {...makeProps()} />);
  const table = container.querySelector('.analysis-table');
  expect(table).not.toBeNull();
  expect(within(table).getByText('LOSS')).toBeInTheDocument();
  expect(within(table).queryByText('WIN')).toBeNull();
});

// Several purchases of one share are one decision, so one row.
test('shows one row per holding, however many times it was bought', () => {
  const secondLot = { ...losingStock, id: 3, purchasePrice: 45, purchaseDate: '2024-03-01' };
  const { container } = render(<TaxOffsetView {...makeProps({ israeliStocks: [losingStock, secondLot, winningStock] })} />);
  const table = container.querySelector('.analysis-table');
  expect(within(table).getAllByText('LOSS')).toHaveLength(1);
  expect(within(table).getByText('2 מתוך 2')).toBeInTheDocument();
});

// Nothing to harvest is a real answer, not an empty table to interpret.
test('says plainly when there is nothing in loss, instead of an empty table', () => {
  const { container } = render(<TaxOffsetView {...makeProps({ israeliStocks: [winningStock] })} />);
  expect(screen.getByText('אין כרגע פוזיציות בהפסד ריאלי בתיק.')).toBeInTheDocument();
  expect(container.querySelector('.analysis-table')).toBeNull();
});

test('renders with an empty portfolio rather than throwing', () => {
  expect(() => render(<TaxOffsetView {...makeProps({ israeliStocks: [] })} />)).not.toThrow();
});
