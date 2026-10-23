import { render, screen } from '@testing-library/react';
import QuickInsights from './QuickInsights';
import { calculatePortfolioAnalysis } from '../utils/portfolioAnalysis';
import { calculatePortfolioSummary } from '../utils/portfolioSummary';
import { setAmountsHidden } from '../utils/formatters';
import { israelToday } from '../utils/marketSession';

const lot = { id: 1, stockName: '1', officialName: 'אלפא', purchaseDate: '2024-01-01', purchasePrice: 100, quantity: 100, currentPrice: 120, dailyChangePercent: 0, securityType: 'מניות', priceFetchedAt: new Date().toISOString() };

function props(israeliStocks) {
  return {
    holdings: { israeliStocks, americanStocks: [], pensionFunds: [], cashFunds: [], bankBalances: [], bankSavingsFunds: [] },
    analysis: calculatePortfolioAnalysis(israeliStocks, [], [], [], [], []),
    summary: calculatePortfolioSummary(israeliStocks, [], [], [], []),
    lastSession: null,
    pricesLoaded: true
  };
}

describe('QuickInsights', () => {
  afterEach(() => setAmountsHidden(false));

  test('renders nothing for an empty portfolio', () => {
    const { container } = render(<QuickInsights {...props([])} />);
    expect(container).toBeEmptyDOMElement();
  });

  test('a single holding gets its cards, each with a tone for screen readers', () => {
    render(<QuickInsights {...props([lot])} />);
    expect(screen.getByRole('heading', { name: 'תובנות מהירות על התיק' })).toBeInTheDocument();
    const items = screen.getAllByRole('listitem');
    expect(items.length).toBeGreaterThan(0);
    expect(items.length).toBeLessThanOrEqual(3);
    expect(screen.getByText('אלפא (1) היא 100% מהתיק שלך')).toBeInTheDocument();
  });

  test('privacy mode masks the amounts and keeps the percentages', () => {
    setAmountsHidden(true);
    // A big move today: its card carries the holding's value.
    render(<QuickInsights {...props([{ ...lot, dailyChangePercent: 6, dailyChangeTradeDate: israelToday() }])} />);
    const text = screen.getByRole('list').textContent;
    expect(text).toContain('••••');
    expect(text).toMatch(/%/);
  });
});
