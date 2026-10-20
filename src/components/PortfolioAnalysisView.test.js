import { render, screen, fireEvent, within, waitFor } from '@testing-library/react';
import PortfolioAnalysisView from './PortfolioAnalysisView';
import { calculatePortfolioAnalysis } from '../utils/portfolioAnalysis';
import { useBenchmarkHistory } from '../hooks/useBenchmarkHistory';
import { useStockSectors } from '../hooks/useStockSectors';
import { useAnalystRecommendations } from '../hooks/useAnalystRecommendations';
import { useDividendData } from '../hooks/useDividendData';

jest.mock('../hooks/useBenchmarkHistory');
jest.mock('../hooks/useStockSectors');
jest.mock('../hooks/useAnalystRecommendations');
jest.mock('../hooks/useDividendData');

const noop = () => {};

const israeliStocks = [
  { stockName: 'TEVA', quantity: 100, purchasePrice: 30, currentPrice: 3500, dailyChangePercent: 1.2, purchaseDate: '2023-01-15' }
];
const americanStocks = [
  {
    stockName: 'AAPL',
    quantity: 10,
    purchasePrice: 150,
    currentPrice: 190,
    exchangeRate: 3.6,
    currentExchangeRate: 3.7,
    dailyChangePercent: 0.8,
    purchaseDate: '2022-03-01'
  }
];
const pensionFunds = [{ initialInvestment: 1000, currentValue: 1100, previousValue: 1050, updateDate: '2023-01-01' }];
const cashFunds = [{ amount: 500, updateDate: '2023-01-01' }];
const bankBalances = [{ amount: 2000, updateDate: '2023-01-01' }];

const analysis = calculatePortfolioAnalysis(israeliStocks, americanStocks, pensionFunds, cashFunds, bankBalances);

function makeProps(overrides = {}) {
  return {
    analysis,
    formatPriceWithSign: (v) => (v ?? 0).toFixed(2),
    snapshots: [],
    snapshotsLoading: false,
    americanStocks,
    israeliStocks,
    pensionFunds,
    cpi: null,
    rebalanceTargets: null,
    rebalanceTargetsLoading: false,
    rebalanceSaving: false,
    rebalanceSaveError: '',
    onSaveRebalanceTargets: noop,
    monthlySnapshots: [],
    monthlySnapshotsLoading: false,
    onSaveMonthlySnapshot: noop,
    savingMonthly: false,
    saveMonthlyError: '',
    onUpdateMonthlySnapshot: undefined,
    updatingMonth: null,
    updateMonthlyError: '',
    onDeleteMonthlySnapshot: undefined,
    deletingMonth: null,
    deleteMonthlyError: '',
    onAddManualMonthlySnapshot: undefined,
    addingManual: false,
    addManualError: '',
    ...overrides
  };
}

describe('PortfolioAnalysisView', () => {
  beforeEach(() => {
    useBenchmarkHistory.mockReturnValue({ points: [], loading: false, error: '' });
    useStockSectors.mockReturnValue({ sectorBySymbol: {}, loading: false });
    useAnalystRecommendations.mockReturnValue({ recommendationsBySymbol: {}, loading: false });
    useDividendData.mockReturnValue({ dividendsBySymbol: {}, loading: false });
    // Backs the custom date-range picker's useHistoricalPortfolioValue call
    // - real network calls (not mocked at the hook level, unlike the
    // hooks above) since it's not jest.mock()'d, matching how the rest of
    // this suite exercises it as a real dependency.
    global.fetch = jest.fn().mockRejectedValue(new Error('network unavailable in test'));
  });

  afterEach(() => {
    delete global.fetch;
  });

  // Section navigation is a horizontal tab strip now, not a sidebar column:
  // ten links to things already on the page do not justify a permanent
  // ~210px of the width.
  test('renders without crashing, with the section nav as a tab strip', () => {
    const { container } = render(<PortfolioAnalysisView {...makeProps()} />);
    expect(container.querySelector('.sw-sidebar')).toBeNull();
    expect(container.querySelector('.analysis-tabs')).not.toBeNull();

    // 10 destinations. The monthly tracker and the tax-loss calculator left
    // for their own pages, the quarterly earnings board was removed, and the
    // benchmark comparison is now an overlay on the performance chart rather
    // than a section to navigate to.
    expect(container.querySelectorAll('.analysis-tab').length).toBe(10);
    // The four groups survive as separators between runs of tabs.
    expect(container.querySelectorAll('.analysis-tabs-divider').length).toBe(3);
    expect(screen.queryByText('ציון בריאות תיק')).toBeNull();
  });

  // Every tab has to land somewhere: a key with no matching section is a
  // button that silently does nothing.
  test('every tab points at a section that exists on the page', () => {
    const { container } = render(<PortfolioAnalysisView {...makeProps()} />);
    const tabCount = container.querySelectorAll('.analysis-tab').length;
    expect(container.querySelectorAll('[data-section-key]').length).toBe(tabCount);
  });

  // Both are tasks rather than read-outs, and each is now a page of its own
  // reached from the app's main sidebar (see router/routes.js).
  test('no longer carries the monthly tracker or the tax-loss calculator', () => {
    const { container } = render(<PortfolioAnalysisView {...makeProps()} />);
    const titles = Array.from(container.querySelectorAll('.section-title')).map((el) => el.textContent);
    expect(titles).not.toContain('מעקב חודשי');
    expect(titles).not.toContain('הזדמנויות לקיזוז מס (Tax-Loss Harvesting)');
  });

  // Removed outright, not moved: the board listed upcoming US earnings
  // dates, which is calendar data about companies rather than anything
  // about this portfolio.
  test('the quarterly earnings board is gone from the page entirely', () => {
    const { container } = render(<PortfolioAnalysisView {...makeProps()} />);
    expect(container.textContent).not.toContain('לוח רבעונים');
    expect(screen.queryByText('לוח רבעונים (מניות אמריקאיות)')).toBeNull();
  });

  test('clicking a tab scrolls the corresponding section into view', () => {
    const scrollIntoViewMock = jest.fn();
    window.HTMLElement.prototype.scrollIntoView = scrollIntoViewMock;

    const { container } = render(<PortfolioAnalysisView {...makeProps()} />);
    fireEvent.click(within(container.querySelector('.analysis-tabs')).getByText('דיבידנדים'));
    expect(scrollIntoViewMock).toHaveBeenCalledWith({ behavior: 'smooth', block: 'start' });
  });

  test('the duplicate "פיזור לפי רכיבי תיק" section is gone (its numbers already live on Home and are repeated by the pie chart right below it)', () => {
    render(<PortfolioAnalysisView {...makeProps()} />);
    expect(screen.queryByText('פיזור לפי רכיבי תיק')).toBeNull();
    // the pie chart section (the non-duplicate one) is still there - text
    // appears twice (sidebar nav item + section heading), so disambiguate
    // to the heading specifically
    expect(screen.getByText('גרף עוגה - פיזור התיק', { selector: '.section-title' })).toBeInTheDocument();
  });

  test('"התיק במבט מהיר" is trimmed to the 3 metrics not already shown on Home - the other 3 (total P&L, forex impact, total portfolio value) are cut', () => {
    render(<PortfolioAnalysisView {...makeProps()} />);
    expect(screen.getByText('החזקות בתיק')).toBeInTheDocument();
    expect(screen.getByText('השינוי היום')).toBeInTheDocument();
    expect(screen.getByText('3 ההחזקות הגדולות')).toBeInTheDocument();
    // A per-holding "weighted annualized return" used to ride along here,
    // disagreeing with the real annual return in the performance section.
    expect(screen.queryByText(/תשואה שנתית משוקללת/)).toBeNull();
  });

  // Each number comes with the words that say what it means.
  test('the concentration figure carries a plain-language verdict', () => {
    const { container } = render(<PortfolioAnalysisView {...makeProps()} />);
    const verdict = container.querySelector('.snap-tile .snap-verdict');
    expect(['מפוזר היטב', 'ריכוזיות בינונית', 'ריכוזי מאוד']).toContain(verdict.textContent);
  });

  // The method is still on the page, folded away: most visitors want the
  // answer, not the four steps that produce it.
  test('the calculation method sits in a collapsed explainer, not above the chart', () => {
    const { container } = render(<PortfolioAnalysisView {...makeProps()} />);
    const guide = container.querySelector('.calc-guide');
    const details = guide.closest('details');
    expect(details).not.toBeNull();
    expect(details.open).toBe(false);
    expect(within(details).getByText('איך מחשבים את התשואה?')).toBeInTheDocument();
    expect(screen.queryByText('רווח/הפסד לא ממומש')).toBeNull();
    expect(screen.queryByText('השפעת מט"ח על רכיב ארה"ב')).toBeNull();
    expect(screen.queryByText('סה"כ שווי תיק מלא')).toBeNull();
  });

  // DOM order is also grid order now, so it is what pairs the half-width
  // sections into rows: the two distribution charts sit side by side, and
  // the year breakdown sits beside the report lists. A section moved out
  // of this order leaves a half-row hole.
  test('renders the sections in the order that pairs them into dashboard rows', () => {
    const { container } = render(<PortfolioAnalysisView {...makeProps()} />);
    const titles = Array.from(container.querySelectorAll('.section-title')).map((el) => el.textContent);
    expect(titles).toEqual([
      'התיק במבט מהיר',
      'ביצועי התיק לאורך זמן',
      'גרף עוגה - פיזור התיק',
      'פיזור לפי סקטור',
      'פיזור לפי מניות',
      'פיזור לפי תאריכי קנייה והפקדה',
      'דוחות מפורטים',
      'מעקב דיבידנדים (מניות אמריקאיות)',
      'המלצות אנליסטים (מניות אמריקאיות)',
      'איזון מחדש (Rebalancing)'
    ]);
    // "השוואה מול מדד ייחוס" isn't in the list above since it's gated
    // behind stats.hasHistory (empty snapshots here -> not rendered) -
    // asserted separately below rather than baked into the fixed order,
    // since its presence is data-dependent, not a section-order concern.
  });

  // The page is a dashboard grid rather than one tall column. The sections
  // that are narrow by nature take half a row and pair up; the ones that
  // need the width (the performance chart, the holdings table) do not.
  describe('dashboard grid', () => {
    test('lays the sections out in a grid container', () => {
      const { container } = render(<PortfolioAnalysisView {...makeProps()} />);
      expect(container.querySelector('.analysis-grid')).not.toBeNull();
    });

    test('gives half a row to exactly the sections that pair up', () => {
      const { container } = render(<PortfolioAnalysisView {...makeProps()} />);
      const halves = Array.from(container.querySelectorAll('.analysis-section-half')).map(
        (el) => el.querySelector('.section-title').textContent
      );
      expect(halves).toEqual([
        'גרף עוגה - פיזור התיק',
        'פיזור לפי סקטור',
        'פיזור לפי תאריכי קנייה והפקדה',
        'דוחות מפורטים'
      ]);
    });

    // An odd number of half-width sections would leave a gap at the end of
    // a row, which is the thing this layout exists to remove.
    test('pairs them evenly, leaving no half-row hole', () => {
      const { container } = render(<PortfolioAnalysisView {...makeProps()} />);
      expect(container.querySelectorAll('.analysis-section-half').length % 2).toBe(0);
    });
  });

  // The page's own title bar comes from PageToolbar now, like every other
  // page - the sidebar is how you leave, so there is no bespoke back link.
  test('titles itself through the shared page toolbar, with no bespoke back button', () => {
    const { container } = render(<PortfolioAnalysisView {...makeProps()} />);
    expect(container.querySelector('.page-toolbar')).not.toBeNull();
    expect(screen.getByText('ניתוח תיק', { selector: '.page-toolbar-title' })).toBeInTheDocument();
    expect(screen.queryByText('חזרה לדף הבית')).toBeNull();
  });

  // The purchase/deposit history is a year-level summary that drills into
  // months, rather than two flat lists side by side - the monthly one grew
  // by twelve rows a year and was the longest thing on the page.
  describe('purchase/deposit history accordion', () => {
    function yearRow(year) {
      return screen.getByText(year, { selector: '.year-accordion-year' }).closest('.year-accordion-item');
    }

    test('lists the years, with every year collapsed to begin with', () => {
      const { container } = render(<PortfolioAnalysisView {...makeProps()} />);
      const years = Array.from(container.querySelectorAll('.year-accordion-year')).map((el) => el.textContent);
      // The fixture buys in 2022 (AAPL) and 2023 (TEVA).
      expect(years).toEqual(expect.arrayContaining(['2022', '2023']));

      container.querySelectorAll('.year-accordion-body').forEach((body) => {
        expect(body).toHaveAttribute('hidden');
      });
      expect(container.querySelectorAll('.year-accordion-item.is-open').length).toBe(0);
    });

    test('expanding a year reveals that year\u2019s months, and only that year\u2019s', () => {
      render(<PortfolioAnalysisView {...makeProps()} />);
      const row2023 = yearRow('2023');

      fireEvent.click(within(row2023).getByRole('button'));

      expect(row2023.querySelector('.year-accordion-body')).not.toHaveAttribute('hidden');
      const labels = Array.from(row2023.querySelectorAll('.date-label')).map((el) => el.textContent);
      // A Hebrew month name and year, never the raw "YYYY-MM" sort key.
      expect(labels).toContain('ינואר 2023');
      labels.forEach((label) => expect(label).not.toMatch(/^\d{4}-\d{2}$/));

      // The other year stayed shut - expanding is per year, not a
      // page-wide "show everything".
      expect(yearRow('2022').querySelector('.year-accordion-body')).toHaveAttribute('hidden');
    });

    test('states whether a year is expanded, rather than only styling it', () => {
      render(<PortfolioAnalysisView {...makeProps()} />);
      const toggle = within(yearRow('2023')).getByRole('button');
      expect(toggle).toHaveAttribute('aria-expanded', 'false');

      fireEvent.click(toggle);
      expect(toggle).toHaveAttribute('aria-expanded', 'true');

      fireEvent.click(toggle);
      expect(toggle).toHaveAttribute('aria-expanded', 'false');
    });
  });

  test('the static "how this is computed" explanations under section titles are gone (dynamic result callouts like the benchmark summary stay)', () => {
    const { container } = render(<PortfolioAnalysisView {...makeProps()} />);
    expect(container.textContent).not.toContain('מבוסס על סיווג הסקטור');
    expect(container.textContent).not.toContain('מבוסס על תשואות יומיות היסטוריות');
    expect(container.textContent).not.toContain('תשואת דיבידנד ותאריך תשלום קרוב');
  });

  // The standalone upcoming-dividend board was removed: every figure it
  // carried (the next payment date, the rate per share) is already a column
  // of the table above it, for the same holdings.
  test('no longer carries a separate upcoming-dividend board', () => {
    useDividendData.mockReturnValue({
      dividendsBySymbol: {
        AAPL: { dividendRate: 1.5, nextDividendDateEpoch: 4102444800, history: [] }
      },
      loading: false
    });
    const { container } = render(<PortfolioAnalysisView {...makeProps()} />);
    expect(container.textContent).not.toContain('לוח דיבידנדים קרובים');
    // The data itself is still shown - as a column of the tracker table.
    const dividends = screen.getByText('מעקב דיבידנדים (מניות אמריקאיות)').closest('.analysis-section');
    expect(within(dividends).getByText('תאריך תשלום קרוב')).toBeInTheDocument();
  });

  // Which holdings the performance curve is about - see
  // utils/portfolioSegments.js.
  describe('market selection and the FX toggle', () => {
    function segmentButton(label) {
      return within(document.querySelector('.segment-controls')).getByText(label);
    }

    test('offers the three market views above the chart', () => {
      render(<PortfolioAnalysisView {...makeProps()} />);
      ['כלל המניות', 'בורסה ישראלית', 'בורסה אמריקאית'].forEach((label) => {
        expect(segmentButton(label)).toBeInTheDocument();
      });
    });

    // A net-worth return is a different question from an investment
    // return; the balance-sheet figures live on the home dashboard.
    test('no longer offers a net-worth scope', () => {
      const { container } = render(<PortfolioAnalysisView {...makeProps()} />);
      expect(container.textContent).not.toContain('סה"כ הון נטו');
      expect(container.querySelector('.segment-summary').textContent).toContain('מניות בלבד');
    });

    // The default is the whole point of the change: cash, savings and
    // provident funds do not move with the market but would sit in both
    // ends of every sub-period and drag each percentage toward zero.
    test('defaults to all equities', () => {
      render(<PortfolioAnalysisView {...makeProps()} />);
      expect(segmentButton('כלל המניות')).toHaveAttribute('aria-pressed', 'true');
      expect(segmentButton('בורסה ישראלית')).toHaveAttribute('aria-pressed', 'false');
    });

    test('selecting a market marks it, and unmarks the others', () => {
      render(<PortfolioAnalysisView {...makeProps()} />);
      fireEvent.click(segmentButton('בורסה ישראלית'));
      expect(segmentButton('בורסה ישראלית')).toHaveAttribute('aria-pressed', 'true');
      expect(segmentButton('כלל המניות')).toHaveAttribute('aria-pressed', 'false');
    });

    // Two toggles read separately do not say what their combination means.
    test('states in words what the current selection covers', () => {
      const { container } = render(<PortfolioAnalysisView {...makeProps()} />);
      const summary = () => container.querySelector('.segment-summary').textContent;
      expect(summary()).toContain('כלל המניות');
      expect(summary()).toContain('מניות בלבד');

      fireEvent.click(segmentButton('בורסה אמריקאית'));
      expect(summary()).toContain('בורסה אמריקאית');
    });

    // The US view's headline question: did the stocks go up, or the dollar?
    describe('FX impact toggle', () => {
      const fxToggle = () => document.querySelector('.fx-toggle input');

      test('appears wherever the selection holds American lots, and not otherwise', () => {
        render(<PortfolioAnalysisView {...makeProps()} />);
        // The combined view is the default, and it holds US lots.
        expect(fxToggle()).not.toBeNull();

        fireEvent.click(segmentButton('בורסה ישראלית'));
        expect(fxToggle()).toBeNull();

        fireEvent.click(segmentButton('בורסה אמריקאית'));
        expect(fxToggle()).not.toBeNull();
      });

      // Offering the choice must not change what the whole-portfolio view
      // shows first: its headline is still what the holdings were really
      // worth in the currency their owner spends.
      test('the combined view still opens with the currency included', () => {
        const { container } = render(<PortfolioAnalysisView {...makeProps()} />);
        expect(fxToggle().checked).toBe(true);
        expect(container.querySelector('.segment-summary').textContent).toContain('שער הדולר');
      });

      test('turning it off on the combined view isolates the stocks from the currency', () => {
        const { container } = render(<PortfolioAnalysisView {...makeProps()} />);
        fireEvent.click(fxToggle());
        expect(fxToggle().checked).toBe(false);
        expect(container.querySelector('.segment-summary').textContent).toContain('דולרית');
      });

      // Each view keeps its own setting, so switching market and back does
      // not discard a choice the user made deliberately.
      test('remembers the setting per market rather than sharing one across them', () => {
        render(<PortfolioAnalysisView {...makeProps()} />);
        fireEvent.click(fxToggle()); // combined view -> off
        expect(fxToggle().checked).toBe(false);

        fireEvent.click(segmentButton('בורסה אמריקאית'));
        expect(fxToggle().checked).toBe(false); // the US view's own default

        fireEvent.click(fxToggle()); // US view -> on
        fireEvent.click(segmentButton('כלל המניות'));
        expect(fxToggle().checked).toBe(false); // combined view, as left

        fireEvent.click(segmentButton('בורסה אמריקאית'));
        expect(fxToggle().checked).toBe(true); // US view, as left
      });

      test('starts off, so the US view defaults to the pure dollar return', () => {
        const { container } = render(<PortfolioAnalysisView {...makeProps()} />);
        fireEvent.click(segmentButton('בורסה אמריקאית'));
        expect(fxToggle().checked).toBe(false);
        expect(container.querySelector('.segment-summary').textContent).toContain('דולרית');
      });

      test('switching it on says the currency move is now included', () => {
        const { container } = render(<PortfolioAnalysisView {...makeProps()} />);
        fireEvent.click(segmentButton('בורסה אמריקאית'));
        fireEvent.click(fxToggle());
        expect(fxToggle().checked).toBe(true);
        expect(container.querySelector('.segment-summary').textContent).toContain('שער הדולר');
      });

      // The amounts stay in shekels under both modes - only the basis of
      // the RETURN changes.
      test('says the amounts are in shekels either way', () => {
        const { container } = render(<PortfolioAnalysisView {...makeProps()} />);
        fireEvent.click(segmentButton('בורסה אמריקאית'));
        expect(container.querySelector('.segment-summary').textContent).toContain('בשקלים');
      });
    });

    // A portfolio can be full and still have nothing in the chosen market;
    // the generic "no holdings" note would be misleading.
    test('names the filter that emptied the chart, rather than claiming no holdings', () => {
      render(<PortfolioAnalysisView {...makeProps({ americanStocks: [] })} />);
      fireEvent.click(segmentButton('בורסה אמריקאית'));
      expect(screen.getByText(/אין החזקות בבחירה הנוכחית/)).toBeInTheDocument();
    });
  });

  describe('benchmarks follow the selected market', () => {
    function segmentButton(label) {
      return within(document.querySelector('.segment-controls')).getByText(label);
    }
    // Scoped to the benchmark section: RebalancingSection reuses the
    // .benchmark-toggle-button class for its own save button.
    function benchmarkLabels() {
      const group = document.querySelector('[aria-label="בחירת מדד ייחוס"]');
      if (!group) return [];
      return Array.from(group.querySelectorAll('.benchmark-toggle-button')).map((b) => b.textContent);
    }

    // The section only renders once there is a usable portfolio series
    // behind it, so the price fetch has to return real closes - mocking
    // the benchmark alone is not enough.
    function renderWithHistory(props) {
      global.fetch.mockImplementation((url) => {
        const u = String(url);
        if (u.includes('israeli-stocks-history')) {
          return Promise.resolve({
            ok: true,
            json: async () => ({
              history: {
                TEVA: [
                  { date: '2023-01-15', close: 10000 },
                  { date: '2024-01-01', close: 11000 },
                  { date: '2024-06-01', close: 12000 }
                ]
              }
            })
          });
        }
        if (u.includes('american-stocks-history')) {
          return Promise.resolve({
            ok: true,
            json: async () => ({ history: { AAPL: [{ date: '2023-01-15', close: 150 }] } })
          });
        }
        if (u.includes('exchange-rate-history')) {
          return Promise.resolve({
            ok: true,
            json: async () => ({ history: [{ date: '2023-01-15', close: 3.6 }] })
          });
        }
        return Promise.resolve({ ok: true, json: async () => ({}) });
      });
      useBenchmarkHistory.mockReturnValue({
        points: [
          { date: '2023-01-15', close: 100 },
          { date: '2024-01-15', close: 120 }
        ],
        loading: false,
        error: ''
      });
      return render(<PortfolioAnalysisView {...makeProps(props)} />);
    }

    // The comparison is an overlay on the performance chart rather than a
    // section of its own, and it starts off - so the index buttons do not
    // exist until it is switched on.
    async function enableBenchmark() {
      const toggle = await screen.findByLabelText('השוואה מול מדד ייחוס');
      fireEvent.click(toggle);
      await waitFor(() => expect(benchmarkLabels().length).toBeGreaterThan(0));
    }

    test('offers no index buttons until the comparison is switched on', async () => {
      renderWithHistory();
      expect(await screen.findByLabelText('השוואה מול מדד ייחוס')).not.toBeChecked();
      expect(benchmarkLabels()).toEqual([]);
    });

    test('an Israeli portfolio is offered TASE indices, not the S&P', async () => {
      renderWithHistory();
      await enableBenchmark();
      fireEvent.click(segmentButton('בורסה ישראלית'));
      await waitFor(() => expect(benchmarkLabels().length).toBeGreaterThan(0));
      expect(benchmarkLabels()).toEqual(['תל אביב 125', 'תל אביב 35', 'תל אביב 90', 'תל אביב בנקים']);
    });

    test('a US portfolio is offered US indices', async () => {
      renderWithHistory();
      await enableBenchmark();
      fireEvent.click(segmentButton('בורסה אמריקאית'));
      await waitFor(() => expect(benchmarkLabels().length).toBeGreaterThan(0));
      expect(benchmarkLabels()).toEqual(['S&P 500', 'NASDAQ Composite', 'NASDAQ 100', 'Russell 2000']);
    });

    test('a combined portfolio is offered an anchor from each market', async () => {
      renderWithHistory();
      await enableBenchmark();
      expect(benchmarkLabels()).toContain('S&P 500');
      expect(benchmarkLabels()).toContain('תל אביב 125');
    });

    // Switching market must not silently reset a comparison the user set
    // up, when the new market offers the same index.
    test('keeps the chosen index across a market change that still offers it', async () => {
      renderWithHistory();
      await enableBenchmark();
      fireEvent.click(screen.getByText('S&P 500'));
      fireEvent.click(segmentButton('בורסה אמריקאית'));
      await waitFor(() =>
        expect(screen.getByText('S&P 500')).toHaveAttribute('aria-pressed', 'true')
      );
    });

    test('falls back to the new market primary index when it does not', async () => {
      renderWithHistory();
      await enableBenchmark();
      fireEvent.click(screen.getByText('S&P 500'));
      fireEvent.click(segmentButton('בורסה ישראלית'));
      await waitFor(() =>
        expect(screen.getByText('תל אביב 125')).toHaveAttribute('aria-pressed', 'true')
      );
    });

    test('says that US indices are shown in shekels', async () => {
      renderWithHistory();
      await enableBenchmark();
      expect(screen.getByText(/מוצגים בשקלים/)).toBeInTheDocument();
    });
  });

  describe('dividend table - projected annual income column', () => {
    test('shows dividendRate × quantity held (not the historical "received" amount) for a known holding', () => {
      // americanStocks (top-level fixture) has one AAPL lot with quantity 10.
      useDividendData.mockReturnValue({
        dividendsBySymbol: { AAPL: { dividendRate: 1.5, dividendYieldPercent: 0.8, payoutRatio: 0.2, history: [] } },
        loading: false
      });
      const { getByText } = render(<PortfolioAnalysisView {...makeProps()} />);
      const dividendsSection = getByText('מעקב דיבידנדים (מניות אמריקאיות)').closest('.analysis-section');
      // 1.5 * 10 = 15.00, distinct from receivedUSD (0, no history entries) -
      // appears twice (the summary card + the table cell), both correct.
      expect(within(dividendsSection).getAllByText('$15.00').length).toBe(2);
    });

    test('shows "—" when no dividend rate is known for a holding, instead of a fabricated $0.00', () => {
      useDividendData.mockReturnValue({ dividendsBySymbol: {}, loading: false });
      const { getByText } = render(<PortfolioAnalysisView {...makeProps()} />);
      const dividendsSection = getByText('מעקב דיבידנדים (מניות אמריקאיות)').closest('.analysis-section');
      const row = within(dividendsSection).getByText('AAPL').closest('tr');
      // Last-but-one column is the new projected-income column; last is "סה"כ שהתקבל" - both "-" here.
      const cells = within(row).getAllByRole('cell');
      expect(cells[cells.length - 2].textContent).toBe('—');
    });
  });

  // Performance over time is now computed on the fly from real historical
  // closing prices for whatever the portfolio held on each date, instead of
  // being read back from saved daily snapshots. The section therefore works
  // with `snapshots: []`, which is what every fixture here passes.
  describe('performance over time (computed from historical closes)', () => {
    const mockHistoryFetch = () => {
      global.fetch.mockImplementation((url) => {
        const u = String(url);
        if (u.includes('israeli-stocks-history')) {
          return Promise.resolve({
            ok: true,
            json: async () => ({
              history: {
                TEVA: [
                  { date: '2023-01-15', close: 10000 },
                  { date: '2024-01-01', close: 11000 },
                  { date: '2024-06-01', close: 12000 }
                ]
              }
            })
          });
        }
        if (u.includes('american-stocks-history') || u.includes('exchange-rate-history')) {
          return Promise.resolve({
            ok: true,
            json: async () => ({ history: u.includes('exchange-rate') ? [] : {} })
          });
        }
        return Promise.resolve({ ok: true, json: async () => ({}) });
      });
    };

    // The period buttons and the date inputs write the same two values,
    // so a test that wants the whole history asks for it the way a user
    // does rather than reaching past the UI.
    const selectPeriod = (label) => fireEvent.click(screen.getByRole('button', { name: label }));

    const yearStart = `${new Date().getUTCFullYear()}-01-01`;

    // Requirement: the range a user lands on is the one they almost always
    // want. Opening on the full history instead meant a first paint that
    // fetched every year back to the first purchase to answer a question
    // about a decade ago.
    test('opens on year-to-date rather than on the whole history', async () => {
      mockHistoryFetch();
      const { container } = render(<PortfolioAnalysisView {...makeProps({ americanStocks: [] })} />);

      await waitFor(() => expect(container.querySelector('#performanceFrom').value).toBe(yearStart));
      expect(screen.getByRole('button', { name: 'מתחילת השנה' })).toHaveAttribute('aria-pressed', 'true');
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/israeli-stocks-history'),
        expect.objectContaining({ method: 'POST' })
      );
    });

    test('offers a quick toggle for each of the periods actually asked for', () => {
      mockHistoryFetch();
      render(<PortfolioAnalysisView {...makeProps({ americanStocks: [] })} />);
      ['יומי', 'חודשי', 'מתחילת השנה', 'שנה', '3 שנים', '5 שנים', 'הכל'].forEach((label) => {
        expect(screen.getByRole('button', { name: label })).toBeInTheDocument();
      });
    });

    test('a period toggle sets the range, and the button for it is the one marked current', async () => {
      mockHistoryFetch();
      const { container } = render(<PortfolioAnalysisView {...makeProps({ americanStocks: [] })} />);
      await waitFor(() => expect(container.querySelector('#performanceFrom').value).toBe(yearStart));

      selectPeriod('שנה');

      const expected = new Date();
      expected.setUTCFullYear(expected.getUTCFullYear() - 1);
      await waitFor(() =>
        expect(container.querySelector('#performanceFrom').value).toBe(
          expected.toISOString().slice(0, 10)
        )
      );
      expect(screen.getByRole('button', { name: 'שנה' })).toHaveAttribute('aria-pressed', 'true');
      expect(screen.getByRole('button', { name: 'מתחילת השנה' })).toHaveAttribute('aria-pressed', 'false');
    });

    // Typing a range of your own is not one of the offered periods, so
    // none of them may keep claiming to be what the chart is showing.
    test('no period is marked current once a range is typed by hand', async () => {
      mockHistoryFetch();
      const { container } = render(<PortfolioAnalysisView {...makeProps({ americanStocks: [] })} />);
      await waitFor(() => expect(container.querySelector('#performanceFrom').value).toBe(yearStart));

      fireEvent.change(container.querySelector('#performanceFrom'), { target: { value: '2023-06-11' } });

      await waitFor(() =>
        expect(screen.getByRole('button', { name: 'מתחילת השנה' })).toHaveAttribute('aria-pressed', 'false')
      );
      ['יומי', 'חודשי', 'שנה', '3 שנים', '5 שנים', 'הכל'].forEach((label) => {
        expect(screen.getByRole('button', { name: label })).toHaveAttribute('aria-pressed', 'false');
      });
    });

    // THE REQUIREMENT THIS SECTION EXISTS FOR: "הכל" on a chart of stocks
    // means the first stock, not the first anything. A provident-fund
    // deposit years earlier used to open the curve on a date with no
    // shares in it, and every figure below claimed to measure from there.
    test('"all" starts at the first share purchase, not at an earlier provident-fund deposit', async () => {
      mockHistoryFetch();
      const earlyPension = [
        { fundName: 'קופת גמל', currentValue: 50000, deposits: [{ date: '2012-04-01', amount: 40000 }] }
      ];
      const { container } = render(
        <PortfolioAnalysisView {...makeProps({ americanStocks: [], pensionFunds: earlyPension })} />
      );

      selectPeriod('הכל');

      // TEVA, 2023-01-15 - the earliest actual purchase, not 2012.
      await waitFor(() => expect(container.querySelector('#performanceFrom').value).toBe('2023-01-15'));
    });

    // Each market's curve contains only that market's lots, so its own
    // "all" has to start where those lots start.
    test('"all" follows the selected market to that market own first purchase', async () => {
      mockHistoryFetch();
      const { container } = render(<PortfolioAnalysisView {...makeProps()} />);

      selectPeriod('הכל');
      // Both markets: the AAPL lot from 2022 is the earlier one.
      await waitFor(() => expect(container.querySelector('#performanceFrom').value).toBe('2022-03-01'));

      fireEvent.click(within(container.querySelector('.segment-controls')).getByText('בורסה ישראלית'));
      await waitFor(() => expect(container.querySelector('#performanceFrom').value).toBe('2023-01-15'));
    });

    test('computes the return since inception from the historical closes', async () => {
      mockHistoryFetch();
      render(<PortfolioAnalysisView {...makeProps({ americanStocks: [] })} />);
      selectPeriod('הכל');
      await waitFor(() => expect(screen.getByText('תשואה מאז תחילת ההשקעה')).toBeInTheDocument());
      // The old label measured from the first saved snapshot instead.
      expect(screen.queryByText('תשואה מאז תחילת המעקב')).toBeNull();
      // The headline is also said as a sentence a non-investor can read.
      expect(screen.getByText(/שהיו מושקעים בתחילת התקופה הפכו ל-/)).toBeInTheDocument();
    });

    test('narrowing the range re-fetches and recomputes, rather than reading a stored figure', async () => {
      mockHistoryFetch();
      const { container } = render(<PortfolioAnalysisView {...makeProps({ americanStocks: [] })} />);
      await waitFor(() => expect(container.querySelector('#performanceFrom').value).toBe(yearStart));

      const callsBefore = global.fetch.mock.calls.length;
      fireEvent.change(container.querySelector('#performanceFrom'), { target: { value: '2024-01-01' } });

      await waitFor(() => expect(global.fetch.mock.calls.length).toBeGreaterThan(callsBefore));
      expect(container.querySelector('#performanceFrom').value).toBe('2024-01-01');
    });

    // Everything in the section is scoped to the chosen range, so the
    // headline cannot keep naming a start date it is no longer measured
    // from.
    test('the headline stops claiming "since inception" once the range is narrowed', async () => {
      mockHistoryFetch();
      const { container } = render(<PortfolioAnalysisView {...makeProps({ americanStocks: [] })} />);
      selectPeriod('הכל');
      await waitFor(() => expect(screen.getByText('תשואה מאז תחילת ההשקעה')).toBeInTheDocument());

      fireEvent.change(container.querySelector('#performanceFrom'), { target: { value: '2024-01-01' } });

      await waitFor(() => expect(screen.getByText('תשואה בתקופה שנבחרה')).toBeInTheDocument());
      expect(screen.queryByText('תשואה מאז תחילת ההשקעה')).toBeNull();
    });

    test('surfaces an error message instead of a fake/blank result when the underlying fetch fails', async () => {
      const { getByText } = render(<PortfolioAnalysisView {...makeProps()} />);
      await waitFor(() =>
        expect(getByText('לא ניתן היה לטעון נתוני מחירים היסטוריים כרגע')).toBeInTheDocument()
      );
    });

    // THE DATE-PICKER FREEZE. A date input fires onChange on every keystroke
    // while the year is typed, so "2024" arrives as "0002", "0020", "0202"
    // and only then "2024". Those intermediate values used to be committed
    // straight through: a range starting in year 2 is ~105,000 weekly
    // sample points, each pricing every holding, and the page stopped
    // responding. Half-typed values are now ignored outright.
    test('ignores the half-typed year values a date input emits while being typed into', async () => {
      mockHistoryFetch();
      const { container } = render(<PortfolioAnalysisView {...makeProps({ americanStocks: [] })} />);
      await waitFor(() => expect(container.querySelector('#performanceFrom').value).toBe(yearStart));

      const fromInput = container.querySelector('#performanceFrom');
      const callsBefore = global.fetch.mock.calls.length;

      // Everything a browser emits while "2024-03-01" is being typed.
      ['0002-03-01', '0020-03-01', '0202-03-01'].forEach((partial) => {
        fireEvent.change(fromInput, { target: { value: partial } });
        // Not committed: the input keeps showing the last good range.
        expect(fromInput.value).toBe(yearStart);
      });

      // And nothing was refetched or recomputed for any of them.
      expect(global.fetch.mock.calls.length).toBe(callsBefore);

      // The completed date is accepted normally.
      fireEvent.change(fromInput, { target: { value: '2024-03-01' } });
      await waitFor(() => expect(fromInput.value).toBe('2024-03-01'));
    });

    test('ignores a future date, which has no prices to value the portfolio at', async () => {
      mockHistoryFetch();
      const { container } = render(<PortfolioAnalysisView {...makeProps({ americanStocks: [] })} />);
      await waitFor(() => expect(container.querySelector('#performanceFrom').value).toBe(yearStart));

      const toInput = container.querySelector('#performanceTo');
      const committed = toInput.value;
      fireEvent.change(toInput, { target: { value: '2099-01-01' } });
      expect(toInput.value).toBe(committed);
    });

    test('a start date after the end date collapses to a valid range instead of blanking the section', async () => {
      mockHistoryFetch();
      const { container } = render(<PortfolioAnalysisView {...makeProps({ americanStocks: [] })} />);
      await waitFor(() => expect(container.querySelector('#performanceFrom').value).toBe(yearStart));

      fireEvent.change(container.querySelector('#performanceTo'), { target: { value: '2024-01-01' } });
      fireEvent.change(container.querySelector('#performanceFrom'), { target: { value: '2025-01-01' } });

      await waitFor(() => {
        const from = container.querySelector('#performanceFrom').value;
        const to = container.querySelector('#performanceTo').value;
        expect(to >= from).toBe(true);
      });
    });

    // Requirement: the headline return must exclude money paid in.
    // Every percentage in this section is cash-flow-neutralized. The raw
    // "how much bigger is the portfolio now" figure used to sit beside the
    // real return, which invited the two to be read as alternatives - it is
    // not a return at all, since a portfolio that grew only because money
    // was paid into it shows a large positive number for doing nothing.
    test('the return is labelled as neutralized, and the raw value change is not offered beside it', async () => {
      mockHistoryFetch();
      const { container } = render(<PortfolioAnalysisView {...makeProps({ americanStocks: [] })} />);
      selectPeriod('הכל');

      await waitFor(() => expect(screen.getByText('תשואה מאז תחילת ההשקעה')).toBeInTheDocument());
      expect(screen.getByText(/מנוטרל הפקדות ורכישות/)).toBeInTheDocument();
      expect(screen.queryByText('שינוי בשווי התיק (כולל הפקדות)')).toBeNull();

      // Scoped to the headline cards: a return that includes deposits is
      // not a return, so no card may present one as performance.
      const metricCards = Array.from(container.querySelectorAll('.perf-hero-label, .perf-stat-label')).map(
        (el) => el.textContent
      );
      expect(metricCards.some((label) => /כולל הפקדות/.test(label))).toBe(false);
    });

    test('the removed metrics are gone: no health score, no max drawdown, no Sharpe ratio', async () => {
      mockHistoryFetch();
      render(<PortfolioAnalysisView {...makeProps({ americanStocks: [] })} />);
      selectPeriod('הכל');
      await waitFor(() => expect(screen.getByText('תשואה מאז תחילת ההשקעה')).toBeInTheDocument());

      expect(screen.queryByText('ציון בריאות תיק')).toBeNull();
      expect(screen.queryByText('ירידה מקסימלית (Drawdown)')).toBeNull();
      expect(screen.queryByText('Sharpe Ratio (משוער)')).toBeNull();
      // Annualized volatility stays - it was kept, not removed.
      expect(screen.getByText('תנודתיות שנתית (משוערת)')).toBeInTheDocument();
    });
  });

  // Requirement: provident-fund deposits belong in the purchase-date
  // breakdown, at the date each deposit was actually made - not lumped onto
  // whatever date the fund's value happened to last be updated.
  describe('breakdown by purchase/deposit date', () => {
    test('places each provident-fund deposit in the month it was made, alongside the stock purchases', () => {
      const pensionWithLedger = [
        {
          fundName: 'קופת גמל',
          currentValue: 5000,
          currentValueDate: '2024-06-01',
          deposits: [
            { date: '2023-03-10', amount: 1000 },
            { date: '2023-09-10', amount: 2000 }
          ]
        }
      ];
      const analysisWithPension = calculatePortfolioAnalysis(
        israeliStocks,
        [],
        pensionWithLedger,
        [],
        [],
        []
      );
      const months = analysisWithPension.monthlyDistribution.map((m) => m.month);

      expect(months).toContain('2023-03');
      expect(months).toContain('2023-09');
      // Not collapsed onto the fund's last-updated month.
      expect(months).not.toContain('2024-06');

      const march = analysisWithPension.monthlyDistribution.find((m) => m.month === '2023-03');
      expect(march.value).toBe(1000);
    });
  });
});

function formatMonthLabelForTest(monthKey) {
  const [year, month] = monthKey.split('-').map(Number);
  return new Date(year, month - 1, 1).toLocaleDateString('he-IL', { month: 'long', year: 'numeric' });
}

// THE PHONE LAYOUT (PHONE_TABS in PortfolioAnalysisView.js). jsdom has no
// matchMedia, which is why every test above renders the wide layout; here
// it is stubbed to answer the phone widths.
describe('PortfolioAnalysisView on a phone', () => {
  let originalMatchMedia;

  beforeEach(() => {
    useBenchmarkHistory.mockReturnValue({ points: [], loading: false, error: '' });
    useStockSectors.mockReturnValue({ sectorBySymbol: { AAPL: 'Technology' }, loading: false });
    useAnalystRecommendations.mockReturnValue({
      recommendationsBySymbol: {
        AAPL: { recommendationKey: 'buy', numberOfAnalystOpinions: 30, targetMeanPrice: 209 }
      },
      loading: false
    });
    useDividendData.mockReturnValue({
      dividendsBySymbol: { AAPL: { dividendRate: 1, dividendYieldPercent: 0.5, history: [] } },
      loading: false
    });
    global.fetch = jest.fn().mockRejectedValue(new Error('network unavailable in test'));
    originalMatchMedia = window.matchMedia;
    window.matchMedia = (query) => ({
      matches: /max-width:\s*(768|960)px/.test(query),
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {}
    });
  });

  afterEach(() => {
    window.matchMedia = originalMatchMedia;
    delete global.fetch;
  });

  const sectionKeys = (container) =>
    Array.from(container.querySelectorAll('[data-section-key]')).map((el) => el.dataset.sectionKey);

  test('four tabs replace the ten-link strip, and the first holds performance', () => {
    const { container } = render(<PortfolioAnalysisView {...makeProps()} />);
    expect(container.querySelector('.analysis-tabs')).toBeNull();
    const tabs = screen.getAllByRole('tab');
    expect(tabs.map((t) => t.textContent)).toEqual(['ביצועים', 'פיזור', 'מניות', 'כלים']);
    expect(tabs[0]).toHaveAttribute('aria-selected', 'true');
    expect(sectionKeys(container)).toEqual(['summary', 'performance']);
  });

  test('every section is reachable from some tab, except the two folded into the stock cards', () => {
    const { container } = render(<PortfolioAnalysisView {...makeProps()} />);
    const seen = new Set();
    screen.getAllByRole('tab').forEach((tab) => {
      fireEvent.click(tab);
      expect(tab).toHaveAttribute('aria-selected', 'true');
      sectionKeys(container).forEach((key) => seen.add(key));
    });
    expect([...seen].sort()).toEqual(['byDate', 'byStock', 'performance', 'pie', 'rebalancing', 'reports', 'sector', 'summary']);
  });

  test('a stock card carries its dividend and the analysts view, not three tables', () => {
    const { container } = render(<PortfolioAnalysisView {...makeProps()} />);
    fireEvent.click(screen.getByRole('tab', { name: 'מניות' }));
    expect(container.querySelector('.analysis-table')).toBeNull();
    const cards = container.querySelectorAll('.stock-card');
    expect(cards.length).toBe(analysis.stockDistribution.length);
    const aapl = Array.from(cards).find((card) => card.textContent.includes('AAPL'));
    // 209 against a current price of 190 is a 10% upside.
    expect(aapl).toHaveTextContent('קנייה · יעד');
    expect(aapl).toHaveTextContent('+10.0%');
    expect(aapl).toHaveTextContent('דיבידנד 0.50% · $10.00 בשנה');
    const teva = Array.from(cards).find((card) => card.textContent.includes('TEVA'));
    expect(teva).not.toHaveTextContent('דיבידנד');
  });

  test('the market, currency and date controls are in the filter sheet, not above the chart', () => {
    const { container } = render(<PortfolioAnalysisView {...makeProps()} />);
    expect(container.querySelector('#performanceFrom')).toBeNull();
    expect(screen.queryByRole('button', { name: 'בורסה ישראלית' })).toBeNull();
    expect(container.querySelector('.perf-filter-count')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'סינון' }));
    const sheet = screen.getByRole('dialog', { name: 'סינון ביצועים' });
    expect(within(sheet).getByLabelText('מתאריך')).toBeInTheDocument();
    fireEvent.click(within(sheet).getByRole('button', { name: 'בורסה ישראלית' }));
    fireEvent.click(within(sheet).getByRole('button', { name: 'הצגת תוצאות' }));

    expect(screen.queryByRole('dialog')).toBeNull();
    // The narrowed market shows on the button without reopening the sheet.
    expect(container.querySelector('.perf-filter-count')).toHaveTextContent('1');
  });

  test('the sheet closes on Escape', () => {
    render(<PortfolioAnalysisView {...makeProps()} />);
    fireEvent.click(screen.getByRole('button', { name: 'סינון' }));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  test('the reports are read one at a time', () => {
    render(<PortfolioAnalysisView {...makeProps()} />);
    fireEvent.click(screen.getByRole('tab', { name: 'כלים' }));
    expect(screen.getByText('אין כרגע מניות בהפסד')).not.toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'מפסידות' }));
    expect(screen.getByText('אין כרגע מניות בהפסד')).toBeVisible();
    expect(screen.getByRole('button', { name: 'מפסידות' })).toHaveAttribute('aria-pressed', 'true');
  });

  // The indices are buttons above the chart, one tap each - not behind a
  // switch inside the filter sheet. They need a portfolio series to render,
  // so the price fetch returns real closes.
  test('every index of the market is one tap away above the chart', async () => {
    global.fetch.mockImplementation((url) => {
      const u = String(url);
      const body = u.includes('israeli-stocks-history')
        ? { history: { TEVA: [{ date: '2023-01-15', close: 10000 }, { date: '2024-01-01', close: 11000 }, { date: '2024-06-01', close: 12000 }] } }
        : u.includes('american-stocks-history')
        ? { history: { AAPL: [{ date: '2023-01-15', close: 150 }] } }
        : u.includes('exchange-rate-history')
        ? { history: [{ date: '2023-01-15', close: 3.6 }] }
        : {};
      return Promise.resolve({ ok: true, json: async () => body });
    });
    render(<PortfolioAnalysisView {...makeProps()} />);

    const group = await screen.findByRole('group', { name: 'השוואה למדד' });
    const labels = within(group)
      .getAllByRole('button')
      .map((b) => b.textContent);
    expect(labels).toEqual(['ללא', 'S&P 500', 'תל אביב 125', 'NASDAQ Composite']);
    expect(within(group).getByRole('button', { name: 'ללא' })).toHaveAttribute('aria-pressed', 'true');

    fireEvent.click(within(group).getByRole('button', { name: 'תל אביב 125' }));
    expect(within(group).getByRole('button', { name: 'תל אביב 125' })).toHaveAttribute('aria-pressed', 'true');
    await waitFor(() => expect(useBenchmarkHistory).toHaveBeenLastCalledWith('ta125', expect.anything()));

    // Nothing about the index is left in the sheet.
    fireEvent.click(screen.getByRole('button', { name: 'סינון' }));
    expect(within(screen.getByRole('dialog')).queryByText('השוואה מול מדד ייחוס')).toBeNull();
  });

  test('sectors are bars rather than a second donut', () => {
    const { container } = render(<PortfolioAnalysisView {...makeProps()} />);
    fireEvent.click(screen.getByRole('tab', { name: 'פיזור' }));
    const sector = container.querySelector('[data-section-key="sector"]');
    expect(sector.querySelectorAll('.sector-bar').length).toBeGreaterThan(0);
    expect(sector.querySelector('.recharts-responsive-container')).toBeNull();
  });
});
