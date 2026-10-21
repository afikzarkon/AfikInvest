import { render, screen, fireEvent, within } from '@testing-library/react';
import PortfolioReviewView from './PortfolioReviewView';
import { calculatePortfolioAnalysis } from '../utils/portfolioAnalysis';
import { useBenchmarkHistory } from '../hooks/useBenchmarkHistory';
import { useStockSectors } from '../hooks/useStockSectors';
import { useDividendData } from '../hooks/useDividendData';
import { useHistoricalPortfolioValue } from '../hooks/useHistoricalPortfolioValue';
import { PrivacyContext } from './PrivacyToggle';
import { REVIEW_DISCLAIMER_HE } from '../utils/portfolioReviewConfig';
import { setAmountsHidden } from '../utils/formatters';

jest.mock('../hooks/useBenchmarkHistory');
jest.mock('../hooks/useStockSectors');
jest.mock('../hooks/useDividendData');
jest.mock('../hooks/useHistoricalPortfolioValue');

const EMPTY_PRICES = { taseHistoricalCloses: {}, yahooHistoricalCloses: {}, fxHistoricalCloses: [] };

// Monthly purchases over the last few months, relative to today so the
// test does not age.
function monthsAgo(n, day = 5) {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - n, day)).toISOString().slice(0, 10);
}

const americanStocks = [4, 3, 2, 1].map((n, i) => ({
  id: i + 1,
  stockName: 'VOO',
  purchaseDate: monthsAgo(n),
  purchasePrice: 500,
  quantity: 2,
  exchangeRate: 3.7,
  currentExchangeRate: 3.7,
  currentPrice: 520
}));

function renderView(props = {}, { hideAmounts = false } = {}) {
  const holdings = { israeliStocks: [], americanStocks, pensionFunds: [], cashFunds: [], bankBalances: [], bankSavingsFunds: [], ...props.holdings };
  const analysis = calculatePortfolioAnalysis(holdings.israeliStocks, holdings.americanStocks, [], [], [], []);
  return render(
    <PrivacyContext.Provider value={{ hideAmounts, toggle: () => {} }}>
      <PortfolioReviewView {...holdings} transactions={[]} analysis={analysis} cpi={null} theme="dark" goal={null} onSaveGoal={props.onSaveGoal || jest.fn()} />
    </PrivacyContext.Provider>
  );
}

describe('PortfolioReviewView', () => {
  beforeEach(() => {
    useBenchmarkHistory.mockReturnValue({ points: [], loading: false, error: '' });
    useStockSectors.mockReturnValue({ sectorBySymbol: {}, loading: false });
    useDividendData.mockReturnValue({ dividendsBySymbol: {}, loading: false });
    useHistoricalPortfolioValue.mockReturnValue({ series: [], loading: false, error: '', priceData: EMPTY_PRICES });
  });

  it('shows an empty state, not a score, for an empty portfolio', () => {
    renderView({ holdings: { americanStocks: [] } });
    expect(screen.getByText(/עדיין אין בתיק השקעות/)).toBeInTheDocument();
    expect(screen.queryByText('הדבר האחד לשיפור החודש')).not.toBeInTheDocument();
    expect(screen.getAllByText(REVIEW_DISCLAIMER_HE).length).toBeGreaterThan(0);
  });

  it('renders the review: disclaimer, the review blocks, every category and the method', () => {
    renderView();
    expect(screen.getAllByText(REVIEW_DISCLAIMER_HE)).toHaveLength(2);
    expect(screen.getByText('מה עבד טוב')).toBeInTheDocument();
    expect(screen.getByText('מה דורש תשומת לב')).toBeInTheDocument();
    expect(screen.getByText('נקודות למחשבה')).toBeInTheDocument();
    expect(screen.getByText('פרופיל משקיע')).toBeInTheDocument();
    const grid = screen.getByLabelText('ציון לפי תחום');
    ['היקף ההשקעה החודש', 'פיזור וסיכון', 'עלויות', 'התקדמות מול יעד', 'דיבידנדים והכנסה פסיבית'].forEach((label) => {
      expect(within(grid).getByText(label)).toBeInTheDocument();
    });
    expect(screen.getByText('איך חושב הציון')).toBeInTheDocument();
    // without ledger trades the fees are unknown, and the card says so
    expect(within(grid).getAllByText('אין מספיק נתונים').length).toBeGreaterThan(0);
  });

  it('opens a category to show how it was computed', () => {
    renderView();
    const grid = screen.getByLabelText('ציון לפי תחום');
    const card = within(grid).getByText('פיזור וסיכון').closest('article');
    fireEvent.click(within(card).getByRole('button', { name: 'איך חושב?' }));
    expect(within(card).getByText('המניה הבודדת הגדולה')).toBeInTheDocument();
  });

  it('offers every month since the first purchase and switches to one', () => {
    renderView();
    const select = screen.getByLabelText('בחירת חודש');
    expect(select.querySelectorAll('option')).toHaveLength(5);
    const earliest = select.querySelectorAll('option')[4].value;
    fireEvent.change(select, { target: { value: earliest } });
    expect(select.value).toBe(earliest);
  });

  it('saves a goal from the goal card', async () => {
    const onSaveGoal = jest.fn().mockResolvedValue({});
    renderView({ onSaveGoal });
    const form = screen.getByRole('form', { name: 'יעד השקעה' });
    fireEvent.change(within(form).getByLabelText('סכום יעד (₪)'), { target: { value: '250000' } });
    fireEvent.change(within(form).getByLabelText('תאריך יעד'), { target: { value: '2030-01-01' } });
    fireEvent.click(within(form).getByRole('button', { name: 'שמירת יעד' }));
    expect(onSaveGoal).toHaveBeenCalledWith({ targetAmount: 250000, targetDate: '2030-01-01' });
    expect(await within(form).findByText('נשמר')).toBeInTheDocument();
  });

  it('masks amounts in privacy mode, in the figures and in the sentences', () => {
    // useAccount sets the formatter's flag alongside the context.
    setAmountsHidden(true);
    try {
      renderView({}, { hideAmounts: true });
      const section = screen.getByLabelText('לאן הלך הכסף');
      expect(within(section).getAllByText(/••••/).length).toBeGreaterThan(0);
      expect(screen.getByLabelText('הביקורת').textContent).not.toMatch(/\d,\d{3} ₪/);
    } finally {
      setAmountsHidden(false);
    }
  });
});
