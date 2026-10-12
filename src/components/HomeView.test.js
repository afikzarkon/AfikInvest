import { render, fireEvent, waitFor } from '@testing-library/react';
import HomeView from './HomeView';
import { calculatePortfolioSummary } from '../utils/portfolioSummary';
import * as exportReport from '../utils/exportReport';

const noop = () => {};

const israeliStocks = [
  { id: 1, stockName: 'TEVA', purchaseDate: '2023-01-15', purchasePrice: 30, quantity: 100, currentPrice: 3500, dailyChangePercent: 1.2 }
];
const americanStocks = [
  { id: 10, stockName: 'AAPL', purchaseDate: '2022-03-01', purchasePrice: 150, quantity: 10, currentPrice: 190, exchangeRate: 3.6, currentExchangeRate: 3.7, dailyChangePercent: 0.8 }
];
const pensionFunds = [{ id: 100, fundName: 'Pension A', initialInvestment: 10000, currentValue: 12000, previousValue: 11500, updateDate: '2024-01-01' }];
const cashFunds = [{ id: 200, fundName: 'Cash Fund', updateDate: '2024-01-01', amount: 5000 }];
const bankBalances = [{ id: 300, updateDate: '2024-01-01', amount: 20000 }];

const summary = calculatePortfolioSummary(israeliStocks, americanStocks, pensionFunds, cashFunds, bankBalances);

function makeProps(overrides = {}) {
  return {
    showLegacyImportButton: false,
    legacyImportLoading: false,
    handleLegacyImportOnce: noop,
    savePortfolio: noop,
    hasUnsavedChanges: false,
    saveLoading: false,
    lastSavedAt: null,
    saveError: '',
    snapshotSaveError: '',
    lastSnapshotSavedAt: null,
    legacyImportBanner: '',
    summary,
    israeliStocks,
    americanStocks,
    pensionFunds,
    cashFunds,
    bankBalances,
    handleAddInfo: noop,
    isEditMode: false,
    setIsEditMode: noop,
    showAmericanColumns: true,
    setShowAmericanColumns: noop,
    expandedGroups: {},
    editingField: null,
    handleCellClick: noop,
    handleInlineEdit: noop,
    finishInlineEdit: noop,
    handleKeyDown: noop,
    handleDelete: noop,
    toggleGroup: noop,
    ...overrides
  };
}

// The dashboard is an overview now: the holdings tables were moved out to a
// page per asset class, so the figures the app is opened to check are not
// buried under several screens of rows.
test('shows the summary cards for a populated portfolio, and no holdings tables', () => {
  const { container, getByText } = render(<HomeView {...makeProps()} />);
  expect(container.querySelectorAll('table').length).toBe(0);
  expect(getByText('סיכום התיק')).toBeInTheDocument();
  ['סה"כ מצב ההון', 'סיכום השקעות נטו (₪)'].forEach((title) => {
    expect(getByText(title)).toBeInTheDocument();
  });
});

// Each market/fund card is the way into the page holding its rows; without
// that the pages are reachable only from the sidebar.
test('each asset card opens the page that holds its rows', () => {
  const onNavigate = jest.fn();
  const { container } = render(<HomeView {...makeProps({ onNavigate })} />);
  const links = Array.from(container.querySelectorAll('.summary-card-link'));

  // One per asset class - the dashboard describes every part of the total
  // it shows, and each part is a doorway to its own page.
  // In the order the dashboard now lays them out: the two markets
  // first, then the accounts that do not move with the market.
  const expected = [
    'israeli-stocks',
    'us-stocks',
    'provident-funds',
    'cash-and-checking',
    'bank-savings'
  ];
  expect(links.length).toBe(expected.length);

  expected.forEach((route, i) => {
    fireEvent.click(links[i]);
    expect(onNavigate).toHaveBeenCalledWith(route);
  });
});

// The capital card states a total; the cards under it are meant to be what
// that total is made of. A missing card means the overview silently
// accounts for less than it totals.
test('the summary cards account for every asset class in the total', () => {
  const { container } = render(<HomeView {...makeProps()} />);
  const titles = Array.from(container.querySelectorAll('.summary-section-title')).map((el) => el.textContent);
  [/בורסה ישראל/, /בורסה אמריקאית/, /קופות גמל/, /קופת חיסכון בבנק/, /כספית שקלית ועו"ש/].forEach((title) => {
    expect(titles.some((t) => title.test(t))).toBe(true);
  });
});

// A card with nowhere to go should not pretend to be a control.
test('renders the cards as plain figures when there is nowhere to navigate', () => {
  const { container } = render(<HomeView {...makeProps({ onNavigate: undefined })} />);
  expect(container.querySelectorAll('.summary-card-link').length).toBe(0);
  expect(container.querySelectorAll('.summary-section').length).toBeGreaterThan(0);
});

test('shows the no-data message for an empty portfolio', () => {
  const emptySummary = calculatePortfolioSummary([], [], [], [], []);
  const { getByText, container } = render(
    <HomeView
      {...makeProps({
        israeliStocks: [],
        americanStocks: [],
        pensionFunds: [],
        cashFunds: [],
        bankBalances: [],
        summary: emptySummary
      })}
    />
  );
  expect(getByText('עדיין לא נוספו מניות לתיק ההשקעות שלך')).toBeInTheDocument();
  expect(container.querySelectorAll('table').length).toBe(0);
});

test('always shows the detailed portfolio summary (no collapse toggle)', () => {
  const { getByText, queryByText } = render(<HomeView {...makeProps()} />);
  expect(getByText('סיכום התיק')).toBeInTheDocument();
  expect(queryByText('הצג סיכום מפורט ▼')).toBeNull();
});

test('there is no manual "save daily info" button - the daily snapshot is taken silently (see useAutoSnapshot.js) - only a passive status line reflects it', () => {
  const { queryByText, getByText, rerender } = render(<HomeView {...makeProps()} />);

  expect(queryByText('שמור מידע יומי עדכני')).toBeNull();
  expect(queryByText('שומר…')).toBeNull();

  const savedAt = new Date('2024-06-01T10:00:00');
  rerender(<HomeView {...makeProps({ lastSnapshotSavedAt: savedAt })} />);
  expect(getByText(`מידע יומי נשמר: ${savedAt.toLocaleTimeString('he-IL')}`)).toBeInTheDocument();

  rerender(<HomeView {...makeProps({ snapshotSaveError: 'שמירת תמונת המצב נכשלה, נסה שוב' })} />);
  expect(getByText('שמירת תמונת המצב נכשלה, נסה שוב')).toBeInTheDocument();
});

test('shows the legacy import button only when showLegacyImportButton is true', () => {
  const { queryByText, rerender } = render(<HomeView {...makeProps({ showLegacyImportButton: false })} />);
  expect(queryByText('ייבוא מהדפדפן')).toBeNull();

  rerender(<HomeView {...makeProps({ showLegacyImportButton: true })} />);
  expect(queryByText('ייבוא מהדפדפן')).not.toBeNull();
});

test('save button reflects hasUnsavedChanges and saveLoading state', () => {
  const { getByText, rerender } = render(<HomeView {...makeProps({ hasUnsavedChanges: false })} />);
  expect(getByText('נשמר')).toBeInTheDocument();

  rerender(<HomeView {...makeProps({ hasUnsavedChanges: true })} />);
  expect(getByText('שמור שינויים')).toBeInTheDocument();

  rerender(<HomeView {...makeProps({ hasUnsavedChanges: true, saveLoading: true })} />);
  expect(getByText('שומר…')).toBeInTheDocument();
});

test('shows the save error message when present', () => {
  const { getByText } = render(<HomeView {...makeProps({ saveError: 'שמירה נכשלה. בדוק התחברות/רשת ונסה שוב.' })} />);
  expect(getByText('שמירה נכשלה. בדוק התחברות/רשת ונסה שוב.')).toBeInTheDocument();
});

test('shows the legacy import banner when present', () => {
  const { getByText } = render(<HomeView {...makeProps({ legacyImportBanner: 'ייבוא מהדפדפן הושלם — הנתונים נשמרו בשרת.' })} />);
  expect(getByText('ייבוא מהדפדפן הושלם — הנתונים נשמרו בשרת.')).toBeInTheDocument();
});

test('shows export buttons for a populated portfolio and wires them to downloadPortfolioExcel/Pdf', async () => {
  const excelSpy = jest.spyOn(exportReport, 'downloadPortfolioExcel').mockResolvedValue(undefined);
  const pdfSpy = jest.spyOn(exportReport, 'downloadPortfolioPdf').mockImplementation(() => {});

  // Supplied the way App.js supplies it: one payload covering the whole
  // portfolio, so the report does not depend on which page it was
  // triggered from.
  const exportPortfolioData = {
    summary,
    israeliStocks,
    americanStocks,
    pensionFunds,
    cashFunds,
    bankBalances,
    bankSavingsFunds: []
  };
  const { getByText } = render(<HomeView {...makeProps({ exportPortfolioData })} />);

  fireEvent.click(getByText('ייצוא Excel'));
  fireEvent.click(getByText('ייצוא PDF'));

  // Both handlers dynamically import('../utils/exportReport') now (code
  // splitting - see the comment in HomeView.js), which resolves on a later
  // microtask than a plain sync call would, so the spies aren't called yet
  // synchronously after fireEvent.click.
  await waitFor(() => {
    expect(pdfSpy).toHaveBeenCalledWith(exportPortfolioData);
    expect(excelSpy).toHaveBeenCalledWith(exportPortfolioData);
  });

  excelSpy.mockRestore();
  pdfSpy.mockRestore();
});

test('hides export buttons for an empty portfolio', () => {
  const emptySummary = calculatePortfolioSummary([], [], [], [], []);
  const { queryByText } = render(
    <HomeView
      {...makeProps({
        israeliStocks: [],
        americanStocks: [],
        pensionFunds: [],
        cashFunds: [],
        bankBalances: [],
        summary: emptySummary
      })}
    />
  );
  expect(queryByText('ייצוא Excel')).toBeNull();
  expect(queryByText('ייצוא PDF')).toBeNull();
});

test('shows an error message if the PDF export throws', async () => {
  const pdfSpy = jest.spyOn(exportReport, 'downloadPortfolioPdf').mockImplementation(() => {
    throw new Error('boom');
  });

  const { findByText } = render(<HomeView {...makeProps()} />);
  fireEvent.click(await findByText('ייצוא PDF'));

  expect(await findByText('שגיאה בייצוא ל-PDF, נסה שוב')).toBeInTheDocument();
  pdfSpy.mockRestore();
});

// Edit mode and the extra-columns toggle act on table cells, and there are
// no tables here any more - offering them would be a control with nothing
// to control. They live on the asset pages (see pages/AssetPages.test.js).
test('omits the table-only controls, having no table to act on', () => {
  const { queryByText } = render(<HomeView {...makeProps({ isEditMode: false })} />);
  expect(queryByText('מצב עריכה')).toBeNull();
  expect(queryByText('נתונים מורחבים')).toBeNull();
});

test('puts every page action in one toolbar, split into primary and secondary', () => {
  const { container } = render(<HomeView {...makeProps()} />);

  // Exactly one filled primary action - the thing the page is for.
  const primary = container.querySelectorAll('.page-toolbar-primary .toolbar-btn-primary');
  expect(primary.length).toBe(1);
  expect(primary[0]).toHaveTextContent('הוספת מידע');

  // View/export controls live together in the quieter secondary cluster.
  const secondary = container.querySelector('.page-toolbar-secondary');
  expect(secondary).not.toBeNull();
  ['ייצוא Excel', 'ייצוא PDF'].forEach((label) => {
    expect(secondary).toHaveTextContent(label);
  });

  // And no page action is left stranded outside it.
  expect(container.querySelector('.control-buttons')).toBeNull();
  expect(container.querySelector('.page-header-actions')).toBeNull();
});

test('surfaces the headline figures as KPI tiles above the detailed summary', () => {
  const { container, getByText } = render(<HomeView {...makeProps()} />);
  const tiles = container.querySelectorAll('.kpi-tile');
  expect(tiles.length).toBe(4);
  ['שווי תיק כולל', 'רווח/הפסד כולל', 'שינוי יומי', 'מס צפוי'].forEach((label) => {
    expect(getByText(label)).toBeInTheDocument();
  });
  // The full breakdown is still there, below them.
  expect(getByText('סיכום התיק')).toBeInTheDocument();
});

// The KPI row is a bento block, not four equal boxes: one figure is what
// the app is opened to see and three qualify it, and the layout says so.
// The spans also have to tile exactly - a featured 2x2 beside two 1x1s
// leaves a hole on the second row unless one tile is wide.
test('gives the headline figure the featured block, and fills the row beside it', () => {
  const { container } = render(<HomeView {...makeProps()} />);
  const featured = container.querySelectorAll('.kpi-tile.is-featured');
  expect(featured.length).toBe(1);
  expect(featured[0].textContent).toContain('שווי תיק כולל');

  // 4 columns: featured takes 2x2, so the other three must occupy 2 + 2
  // single-row cells and one double-wide.
  expect(container.querySelectorAll('.kpi-tile.is-wide').length).toBe(1);
  expect(container.querySelectorAll('.kpi-tile').length).toBe(4);
});

test('an empty portfolio shows no KPI tiles rather than a row of zeroes', () => {
  const { container } = render(
    <HomeView
      {...makeProps({ israeliStocks: [], americanStocks: [], pensionFunds: [], cashFunds: [], bankBalances: [] })}
    />
  );
  expect(container.querySelectorAll('.kpi-tile').length).toBe(0);
});

// The dashboard has no long table below it to keep actions reachable
// over, so pinning its header only reserves a strip across the figures
// the page is opened to read.
test('the header is not pinned - it scrolls away with the rest of the page', () => {
  const { container } = render(<HomeView {...makeProps()} />);
  const toolbar = container.querySelector('.page-toolbar');
  expect(toolbar).toHaveClass('is-static');
  expect(toolbar).not.toHaveClass('is-sticky');
});

// The hint used to be positioned into the card's title row, where it was
// accent-coloured text drawn behind the heading and its underline.
test('each card carries its own redirect hint, as a separate element from the title', () => {
  const { container } = render(<HomeView {...makeProps({ onNavigate: noop })} />);
  const links = Array.from(container.querySelectorAll('.summary-card-link'));
  expect(links.length).toBeGreaterThan(0);

  links.forEach((link) => {
    const hint = link.querySelector('.summary-card-link-hint');
    expect(hint).not.toBeNull();
    expect(hint.textContent).toMatch(/הצגת הפירוט/);
    // Decorative: the button already says where it goes via its own title,
    // so announcing the hint as well would just repeat it.
    expect(hint).toHaveAttribute('aria-hidden', 'true');
    expect(link.querySelector('.summary-section-title')).not.toBe(hint);
  });
});

// The system is a sandbox, and the dashboard is the first thing opened in
// it - so the warning is on the page, not only in the modal that was
// dismissed on arrival.
test('carries the beta warning on the page itself', () => {
  const { container } = render(<HomeView {...makeProps()} />);
  expect(container.querySelector('.beta-banner')).not.toBeNull();
});

// An empty portfolio offers the demo portfolio, so a first visit can see
// every page working without typing anything.
test('offers to load a sample portfolio when the portfolio is empty', () => {
  const onLoadSamplePortfolio = jest.fn();
  const { getByRole } = render(
    <HomeView
      {...makeProps({
        israeliStocks: [],
        americanStocks: [],
        pensionFunds: [],
        cashFunds: [],
        bankBalances: [],
        onLoadSamplePortfolio
      })}
    />
  );
  fireEvent.click(getByRole('button', { name: 'טען תיק לדוגמה' }));
  expect(onLoadSamplePortfolio).toHaveBeenCalledTimes(1);
});

test('does not offer the sample portfolio once there is data, and marks a loaded sample', () => {
  const { queryByRole, getByText } = render(
    <HomeView {...makeProps({ onLoadSamplePortfolio: noop, isSamplePortfolio: true })} />
  );
  expect(queryByRole('button', { name: 'טען תיק לדוגמה' })).toBeNull();
  expect(getByText(/זהו תיק לדוגמה/)).toBeInTheDocument();
});
