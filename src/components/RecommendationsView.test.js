import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import RecommendationsView from './RecommendationsView';
import { calculatePortfolioAnalysis } from '../utils/portfolioAnalysis';

const israeliStocks = [
  { id: 1, stockName: 'WIN', purchaseDate: '2024-01-01', purchasePrice: 10, quantity: 100, currentPrice: 30 }
];
const bankBalances = [{ id: 9, amount: 7000 }];
const analysis = calculatePortfolioAnalysis(israeliStocks, [], [], [], bankBalances, []);

function renderView(overrides = {}) {
  const props = {
    israeliStocks,
    bankBalances,
    analysis,
    rebalanceTargets: { israeli: 60, american: 0, pension: 0, cashFunds: 0, bank: 40, bankSavings: 0 },
    onSavePrefs: jest.fn().mockResolvedValue({}),
    formatPriceWithSign: (v) => v.toFixed(0),
    ...overrides
  };
  render(<RecommendationsView {...props} />);
  return props;
}

test('shows ranked recommendations with the numbers behind them', () => {
  renderView();
  const list = screen.getByRole('list', { name: 'המלצות' });
  expect(list).toHaveTextContent('הגדלת בורסה ישראלית');
  fireEvent.click(screen.getAllByRole('button', { name: 'למה?' })[0]);
  expect(screen.getByText('currentPercent')).toBeInTheDocument();
});

test('no recommendations inside the thresholds means hold', () => {
  renderView({ rebalanceTargets: { israeli: 30, american: 0, pension: 0, cashFunds: 0, bank: 70, bankSavings: 0 }, savedPrefs: { positionCapPct: 50 } });
  expect(screen.getByText(/אין כרגע המלצות/)).toBeInTheDocument();
});

test('saves settings', async () => {
  const props = renderView();
  fireEvent.click(screen.getByRole('button', { name: 'הגדרות ההמלצות' }));
  fireEvent.change(screen.getByLabelText('תקרת פוזיציה בודדת (% מהתיק)'), { target: { value: '20' } });
  fireEvent.change(screen.getByLabelText('שיטת התאמת מנות במכירה'), { target: { value: 'HIFO' } });
  fireEvent.click(screen.getByLabelText(/תושב מס בארה/));
  fireEvent.click(screen.getByRole('button', { name: 'שמירה' }));
  await waitFor(() => expect(props.onSavePrefs).toHaveBeenCalled());
  expect(props.onSavePrefs.mock.calls[0][0]).toMatchObject({ positionCapPct: 20, lotMethod: 'HIFO', usTaxResident: true });
});
