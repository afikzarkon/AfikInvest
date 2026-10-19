import { render, screen, fireEvent, within, waitFor } from '@testing-library/react';
import MonthlyTrackerView from './MonthlyTrackerView';
import { todayISO } from '../utils/portfolioDates';

// The monthly tracker used to be a section of PortfolioAnalysisView, and
// these tests moved here with it when it became its own page. They assert
// the same behaviour they always did - the page's own render wrapper and
// prop set are the only things that changed.

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

function makeProps(overrides = {}) {
  return {
    formatPriceWithSign: (v) => (v ?? 0).toFixed(2),
    americanStocks,
    israeliStocks,
    pensionFunds,
    // No cashFunds/bankBalances by default: those two are valued straight
    // from their own ledgers with no prices involved, so including them
    // would make an auto-fill succeed on ledger rows alone and hide the
    // "no historical prices for this month" path these tests cover. The
    // page itself is given them; a test that wants them passes them.
    // Today's figures, as App.js passes them - what a checkpoint valid for
    // today holds.
    liveBreakdown: { israeli: [{ key: 'TEVA', label: 'TEVA', value: 3500 }], american: [], pension: [], cashFunds: [], bank: [], bankSavings: [] },
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

describe('MonthlyTrackerView', () => {
  beforeEach(() => {
    // Backs the auto-fill's useHistoricalPortfolioValue call with a real
    // (rejecting) fetch rather than mocking the hook, matching how these
    // tests always exercised it. Individual tests that need real history
    // override the implementation.
    global.fetch = jest.fn().mockRejectedValue(new Error('network unavailable in test'));
  });

  afterEach(() => {
    delete global.fetch;
  });

const currentMonthKey = new Date().toISOString().slice(0, 7);
const july = {
  month: '2026-07',
  totalValueILS: 100000,
  breakdown: {
    israeli: [{ key: 'TEVA', label: 'TEVA', value: 20000 }],
    american: [{ key: 'PLTR', label: 'PLTR', value: 30000 }],
    pension: [{ key: 'קופה א', label: 'קופה א', value: 40000 }],
    cashFunds: [{ key: 'קרן X', label: 'קרן X', value: 5000 }],
    bank: [{ key: 'bank-1', label: 'עו"ש', value: 5000 }]
  }
};
const august = {
  month: '2026-08',
  totalValueILS: 110000,
  breakdown: {
    israeli: [{ key: 'TEVA', label: 'TEVA', value: 22000 }],
    american: [{ key: 'PLTR', label: 'PLTR', value: 27000 }],
    pension: [{ key: 'קופה א', label: 'קופה א', value: 44000 }],
    cashFunds: [{ key: 'קרן X', label: 'קרן X', value: 5000 }],
    bank: [{ key: 'bank-1', label: 'עו"ש', value: 12000 }]
  }
};

// Scopes queries to just this section, so "TEVA"/"בורסה ישראלית" etc.
// here can't collide with the same text appearing in other sections of
// this large page (e.g. the "TEVA" fixture stock used at the top of
// this file also shows up under "פיזור לפי מניות").
function monthlyScope() {
  return within(screen.getByText('מעקב חודשי', { selector: '.section-title' }).closest('.analysis-section'));
}

function historyCards() {
  return Array.from(document.body.querySelectorAll('.monthly-history-card'));
}

function manualForm() {
  return document.body.querySelector('.monthly-manual-form');
}

test('with no saved months, shows the empty-state note instead of comparison/history', () => {
  render(<MonthlyTrackerView {...makeProps()} />);
  expect(screen.getByText(/עדיין אין שמירות חודשיות/)).toBeInTheDocument();
  expect(screen.queryByText('השוואה בין חודשים')).toBeNull();
  expect(screen.queryByText('היסטוריית שמירות')).toBeNull();
});

test('clicking the save button calls onSaveMonthlySnapshot with an empty cash-flows object when nothing was entered, and reflects the saving/error state', () => {
  const onSaveMonthlySnapshot = jest.fn();
  const { rerender } = render(<MonthlyTrackerView {...makeProps({ onSaveMonthlySnapshot })} />);
  fireEvent.click(screen.getByText('שמור שמירה חודשית'));
  // Second argument: the day the figures are for (today by default) and
  // the figures themselves.
  expect(onSaveMonthlySnapshot).toHaveBeenCalledWith(
    {},
    expect.objectContaining({ asOfDate: todayISO(), breakdown: expect.objectContaining({ israeli: expect.any(Array) }) })
  );

  rerender(<MonthlyTrackerView {...makeProps({ onSaveMonthlySnapshot, savingMonthly: true })} />);
  expect(screen.getByText('שומר…')).toBeInTheDocument();

  rerender(
    <MonthlyTrackerView
      {...makeProps({ onSaveMonthlySnapshot, saveMonthlyError: 'שמירת השמירה החודשית נכשלה, נסה שוב' })}
    />
  );
  expect(screen.getByText('שמירת השמירה החודשית נכשלה, נסה שוב')).toBeInTheDocument();
});

// Deposits and withdrawals are never typed in here - every account's come
// from its own table, by date.
test('there is no field to type deposits or withdrawals into - they come from the tables', () => {
  render(<MonthlyTrackerView {...makeProps({ onAddManualMonthlySnapshot: jest.fn() })} />);
  expect(document.querySelector('[id*="cashflow"]')).toBeNull();
  expect(monthlyScope().getByText(/הפקדות ומשיכות נלקחות אוטומטית מהטבלאות/)).toBeInTheDocument();
  fireEvent.click(screen.getByText('➕ הוספה ידנית'));
  expect(document.querySelector('[id*="cashflow"]')).toBeNull();
});

test('shows whether the current month is already saved', () => {
  const { rerender } = render(<MonthlyTrackerView {...makeProps()} />);
  expect(screen.getByText(`החודש (${formatMonthLabelForTest(currentMonthKey)}) עדיין לא נשמר`)).toBeInTheDocument();

  rerender(
    <MonthlyTrackerView
      {...makeProps({ monthlySnapshots: [{ month: currentMonthKey, totalValueILS: 1, breakdown: {} }] })}
    />
  );
  expect(screen.getByText(`החודש (${formatMonthLabelForTest(currentMonthKey)}) נשמר`)).toBeInTheDocument();
  expect(screen.getByText('עדכן שמירה חודשית')).toBeInTheDocument();
});

describe('"➕ הוספה ידנית" (manual backfill of a forgotten past month)', () => {
  test('is not rendered when onAddManualMonthlySnapshot is not provided', () => {
    render(<MonthlyTrackerView {...makeProps({ onAddManualMonthlySnapshot: undefined })} />);
    expect(screen.queryByText('➕ הוספה ידנית')).toBeNull();
  });

  test('clicking the button opens the form (month picker + the two sections), clicking again closes it', () => {
    render(<MonthlyTrackerView {...makeProps({ onAddManualMonthlySnapshot: jest.fn() })} />);
    expect(screen.queryByLabelText('חודש')).toBeNull();

    fireEvent.click(screen.getByText('➕ הוספה ידנית'));
    expect(screen.getByLabelText('חודש')).toBeInTheDocument();
    // The form is split in two: what the app works out for itself, and
    // what only the user can know.
    expect(within(manualForm()).getByText('נתונים שנמשכים אוטומטית מהטבלאות הראשיות')).toBeInTheDocument();
    expect(within(manualForm()).getByText('נתונים להזנה ידנית (נכסים נזילים)')).toBeInTheDocument();
    expect(within(manualForm()).getByText('עו"ש', { selector: 'span' })).toBeInTheDocument();

    fireEvent.click(screen.getByText('➕ הוספה ידנית'));
    expect(screen.queryByLabelText('חודש')).toBeNull();
  });

  // The refactor: stocks and provident funds can be worked out exactly
  // from the main tables, so the backfill form no longer offers a place
  // to retype them - a second source for one number could only ever
  // disagree with the first.
  test('offers NO typed rows for stocks or provident funds - only for the liquid accounts', () => {
    render(<MonthlyTrackerView {...makeProps({ onAddManualMonthlySnapshot: jest.fn() })} />);
    fireEvent.click(screen.getByText('➕ הוספה ידנית'));

    const manualSection = within(manualForm())
      .getByText('נתונים להזנה ידנית (נכסים נזילים)')
      .closest('.monthly-manual-entry-section');
    const typedCategories = Array.from(
      manualSection.querySelectorAll('.monthly-manual-category-header > span:first-child')
    ).map((el) => el.textContent);

    expect(typedCategories).toEqual(['קרנות כספיות', 'עו"ש', 'קופת חיסכון בבנק']);
    expect(typedCategories).not.toContain('בורסה ישראלית');
    expect(typedCategories).not.toContain('בורסה אמריקאית');
    expect(typedCategories).not.toContain('קופות גמל');
  });

  test('the auto-derived section lists the stock and provident-fund categories, read-only', async () => {
    global.fetch.mockImplementation((url) => {
      const u = String(url);
      if (u.includes('israeli-stocks-history')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ history: { TEVA: [{ date: '2023-01-15', close: 10000 }] } })
        });
      }
      return Promise.resolve({
        ok: true,
        json: async () => ({ history: u.includes('exchange-rate') ? [] : {} })
      });
    });

    render(
      <MonthlyTrackerView
        {...makeProps({ americanStocks: [], onAddManualMonthlySnapshot: jest.fn() })}
      />
    );
    await waitFor(() => expect(screen.queryByText('טוען נתונים היסטוריים למילוי אוטומטי…')).toBeNull());

    fireEvent.click(screen.getByText('➕ הוספה ידנית'));
    fireEvent.change(screen.getByLabelText('חודש'), { target: { value: '2024-03' } });

    const autoSection = within(manualForm())
      .getByText('נתונים שנמשכים אוטומטית מהטבלאות הראשיות')
      .closest('.monthly-manual-auto-section');

    // 100 shares at a carried-forward 10,000-agorot close = 10,000 ILS -
    // shown twice (the row and its category total), and as text with no
    // input anywhere to retype it.
    expect(within(autoSection).getAllByText('10000.00 ₪').length).toBe(2);
    expect(autoSection.querySelectorAll('input').length).toBe(0);
    expect(within(autoSection).getAllByText('· נגזר אוטומטית').length).toBe(3);
  });

  test('filling in the liquid rows and submitting sends them together with the derived stock/pension rows, then closes the form', async () => {
    const onAddManualMonthlySnapshot = jest.fn().mockResolvedValue(true);
    render(<MonthlyTrackerView {...makeProps({ onAddManualMonthlySnapshot })} />);
    fireEvent.click(screen.getByText('➕ הוספה ידנית'));

    fireEvent.change(screen.getByLabelText('חודש'), { target: { value: '2026-03' } });

    const bankSection = within(manualForm())
      .getByText('עו"ש', { selector: 'span' })
      .closest('.monthly-manual-category');
    fireEvent.click(within(bankSection).getByText('+ הוסף פריט'));
    fireEvent.change(within(bankSection).getByPlaceholderText('שם (למשל עו"ש)'), { target: { value: 'עו"ש' } });
    fireEvent.change(within(bankSection).getByPlaceholderText('שווי (₪)'), { target: { value: '3000' } });

    fireEvent.click(screen.getByText('שמור'));
    expect(onAddManualMonthlySnapshot).toHaveBeenCalledTimes(1);
    const [month, totalValueILS, breakdown] = onAddManualMonthlySnapshot.mock.calls[0];
    expect(month).toBe('2026-03');
    expect(totalValueILS).toBe(3000);
    expect(breakdown.bank).toEqual([{ key: 'עו"ש', label: 'עו"ש', value: 3000 }]);
    // The derived categories are still present in the saved shape -
    // they're just filled from the tables, not from the form. No
    // historical prices resolve in this test, so they come back empty
    // rather than fabricated.
    expect(breakdown.israeli).toEqual([]);
    expect(breakdown.american).toEqual([]);
    expect(breakdown.pension).toEqual([]);
    // No flows are declared by hand any more.
    expect(breakdown.cashFlows).toBeUndefined();

    // the await inside handleSubmitManualAdd resolves asynchronously and
    // then closes the form - wait for that state update to flush
    // (inside act) rather than asserting on it synchronously
    await waitFor(() => expect(screen.queryByLabelText('חודש')).toBeNull());
  });


  test('a row with no value entered yet is dropped, not saved as a fake 0', async () => {
    const onAddManualMonthlySnapshot = jest.fn().mockResolvedValue(true);
    render(<MonthlyTrackerView {...makeProps({ onAddManualMonthlySnapshot })} />);
    fireEvent.click(screen.getByText('➕ הוספה ידנית'));
    fireEvent.change(screen.getByLabelText('חודש'), { target: { value: '2026-03' } });

    const bankSection = within(manualForm())
      .getByText('עו"ש', { selector: 'span' })
      .closest('.monthly-manual-category');
    fireEvent.click(within(bankSection).getByText('+ הוסף פריט'));
    fireEvent.change(within(bankSection).getByPlaceholderText('שם (למשל עו"ש)'), { target: { value: 'עו"ש' } });
    // value left empty

    fireEvent.click(screen.getByText('שמור'));
    const [, totalValueILS, breakdown] = onAddManualMonthlySnapshot.mock.calls[0];
    expect(totalValueILS).toBe(0);
    expect(breakdown.bank).toEqual([]);

    // let the mocked promise's resolution (and the resulting
    // setShowManualAddForm) settle inside act before the test ends,
    // instead of leaking into whichever test runs next
    await waitFor(() => expect(screen.queryByLabelText('חודש')).toBeNull());
  });

  test('submit is disabled until a month is chosen, and once that month already has a save (shows a warning instead)', () => {
    const onAddManualMonthlySnapshot = jest.fn();
    render(
      <MonthlyTrackerView
        {...makeProps({
          onAddManualMonthlySnapshot,
          monthlySnapshots: [{ month: '2026-03', totalValueILS: 1000, breakdown: {} }]
        })}
      />
    );
    fireEvent.click(screen.getByText('➕ הוספה ידנית'));
    expect(screen.getByText('שמור')).toBeDisabled();

    fireEvent.change(screen.getByLabelText('חודש'), { target: { value: '2026-03' } });
    expect(screen.getByText(/כבר קיימת שמירה לחודש זה/)).toBeInTheDocument();
    expect(screen.getByText('שמור')).toBeDisabled();

    fireEvent.click(screen.getByText('שמור'));
    expect(onAddManualMonthlySnapshot).not.toHaveBeenCalled();
  });

  test('shows addManualError when present', () => {
    render(
      <MonthlyTrackerView
        {...makeProps({
          onAddManualMonthlySnapshot: jest.fn(),
          addManualError: 'הוספת השמירה החודשית נכשלה, נסה שוב'
        })}
      />
    );
    expect(screen.getByText('הוספת השמירה החודשית נכשלה, נסה שוב')).toBeInTheDocument();
  });
});

// One category of the selected month's panel, by its label.
function categoryRow(label) {
  return Array.from(document.body.querySelectorAll('.mt-cat')).find(
    (el) => el.querySelector('.mt-cat-name').textContent === label
  );
}

function timelineButton(monthLabel) {
  return within(document.body.querySelector('.mt-timeline')).getByText(monthLabel).closest('button');
}

test('the selected month shows each category with its value, the value before and its change - per-item rows only after "פתח פירוט מלא"', () => {
  render(<MonthlyTrackerView {...makeProps({ monthlySnapshots: [july, august] })} />);
  const scope = monthlyScope();

  const israeli = categoryRow('בורסה ישראלית');
  expect(israeli.textContent).toContain('22000.00');
  expect(israeli.textContent).toContain('קודם 20000.00');
  expect(israeli.textContent).toContain('+10.0%');

  expect(categoryRow('עו"ש').textContent).toContain('+140.0%');

  // The month as a whole, deposits netted out.
  expect(document.body.querySelector('.mt-panel-change').textContent).toContain('+10.0%');

  // per-item detail not shown yet
  expect(scope.queryByText(/TEVA/)).toBeNull();
  expect(scope.queryByText(/PLTR/)).toBeNull();
});

test('a mid-period stock purchase is netted out of the naive % change, with the net contribution shown', () => {
  // A live TEVA lot purchased mid-period (2026-08-15, inside the
  // compare month) - the saved breakdown values themselves
  // (20,000 -> 22,000) are unchanged, but the comparison should net
  // this 1,000 ILS purchase out of the naive +10% instead of counting
  // it as growth. (A purchase dated within the *base* month instead
  // would already be reflected in the base snapshot's own value and
  // must NOT be netted out again - see monthlySnapshotComparison.js's
  // periodStart comment.)
  const israeliStocksWithMidPeriodPurchase = [
    ...israeliStocks,
    { stockName: 'TEVA', quantity: 10, purchasePrice: 100, currentPrice: 3500, purchaseDate: '2026-08-15' }
  ];
  render(
    <MonthlyTrackerView
      {...makeProps({ monthlySnapshots: [july, august], israeliStocks: israeliStocksWithMidPeriodPurchase })}
    />
  );
  const israeli = categoryRow('בורסה ישראלית');
  expect(israeli.textContent).not.toContain('+10.0%');
  expect(israeli.textContent).toContain('1000.00 ₪');
  expect(israeli.textContent).toMatch(/הופקדו\/נרכשו בתקופה/);
});

test('"פתח פירוט מלא" reveals per-item rows (e.g. individual stocks) with their own change, and toggles its own label', () => {
  render(<MonthlyTrackerView {...makeProps({ monthlySnapshots: [july, august] })} />);
  const scope = monthlyScope();

  fireEvent.click(scope.getByText('פתח פירוט מלא'));
  expect(scope.getByText('קבץ לפי קטגוריות')).toBeInTheDocument();

  const tevaRow = within(categoryRow('בורסה ישראלית')).getByText('TEVA').closest('li');
  expect(tevaRow.textContent).toContain('20000.00');
  expect(tevaRow.textContent).toContain('22000.00');
  expect(tevaRow.textContent).toContain('+10.0%');

  fireEvent.click(scope.getByText('קבץ לפי קטגוריות'));
  expect(scope.queryByText(/TEVA/)).toBeNull();
});

// THE TIMELINE: every saved month as a pressable bar, with its change from
// the month before.
test('the timeline lists every saved month with its change, and selects the latest by default', () => {
  render(<MonthlyTrackerView {...makeProps({ monthlySnapshots: [july, august] })} />);

  expect(timelineButton('יולי 2026')).toHaveAttribute('aria-pressed', 'false');
  expect(timelineButton('אוגוסט 2026')).toHaveAttribute('aria-pressed', 'true');
  expect(timelineButton('יולי 2026').textContent).toContain('חודש ראשון');
  expect(timelineButton('אוגוסט 2026').textContent).toContain('+10.0%');

  // One panel, for the selected month.
  const cards = historyCards();
  expect(cards).toHaveLength(1);
  expect(within(cards[0]).getByText('אוגוסט 2026', { selector: '.mt-panel-title' })).toBeInTheDocument();
});

test('pressing a month in the timeline shows that month - the first one on its own, with nothing to compare it with', () => {
  render(<MonthlyTrackerView {...makeProps({ monthlySnapshots: [july, august] })} />);
  fireEvent.click(timelineButton('יולי 2026'));

  expect(timelineButton('יולי 2026')).toHaveAttribute('aria-pressed', 'true');
  const cards = historyCards();
  expect(cards).toHaveLength(1);
  expect(within(cards[0]).getByText('יולי 2026', { selector: '.mt-panel-title' })).toBeInTheDocument();
  expect(categoryRow('בורסה ישראלית').textContent).toContain('20000.00');
  expect(document.body.querySelector('.mt-panel-change')).toBeNull();
});

// Comparing with a month other than the one right before it.
test('"השוואה מול" defaults to the month before, and can be pointed at any other saved month', () => {
  const september = {
    ...august,
    month: '2026-09',
    totalValueILS: 120000,
    breakdown: { ...august.breakdown, israeli: [{ key: 'TEVA', label: 'TEVA', value: 24000 }] }
  };
  render(<MonthlyTrackerView {...makeProps({ monthlySnapshots: [july, august, september] })} />);
  const base = screen.getByLabelText('השוואה מול');
  expect(base).toHaveValue('2026-08');
  expect(categoryRow('בורסה ישראלית').textContent).toContain('קודם 22000.00');

  fireEvent.change(base, { target: { value: '2026-07' } });
  expect(categoryRow('בורסה ישראלית').textContent).toContain('קודם 20000.00');
  expect(categoryRow('בורסה ישראלית').textContent).toContain('+20.0%');
});

test('without onUpdateMonthlySnapshot, the history card shows no "ערוך" button', () => {
  render(<MonthlyTrackerView {...makeProps({ monthlySnapshots: [july, august], onUpdateMonthlySnapshot: undefined })} />);
  expect(monthlyScope().queryByText('ערוך')).toBeNull();
});

test('editing the shown month: "ערוך" turns every row into inputs, and saving sends the updated breakdown/total, then exits edit mode', async () => {
  const onUpdateMonthlySnapshot = jest.fn().mockResolvedValue(true);
  render(<MonthlyTrackerView {...makeProps({ monthlySnapshots: [july, august], onUpdateMonthlySnapshot })} />);

  const card = historyCards()[0]; // defaults to august
  fireEvent.click(within(card).getByText('ערוך'));

  // Rows are plain always-on inputs while editing - no cell to open
  // first, which is what removed the focus-juggling entirely.
  const input = within(card).getByDisplayValue('27000');
  fireEvent.change(input, { target: { value: '29000' } });

  fireEvent.click(within(card).getByText('שמור עריכה'));
  expect(onUpdateMonthlySnapshot).toHaveBeenCalledTimes(1);
  const [month, totalValueILS, breakdown] = onUpdateMonthlySnapshot.mock.calls[0];
  expect(month).toBe('2026-08');
  expect(breakdown.american.find((i) => i.key === 'PLTR').value).toBe(29000);
  // total recomputed as the sum of all (possibly edited) items
  expect(totalValueILS).toBe(22000 + 29000 + 44000 + 5000 + 12000);
  expect(breakdown.cashFlows).toEqual({});

  // the await inside handleSaveEditedMonth resolves asynchronously and
  // then exits edit mode - wait for that state update to flush (inside
  // act) rather than asserting on it synchronously
  await waitFor(() => expect(within(card).queryByText('שמור עריכה')).toBeNull());
  expect(within(card).getByText('ערוך')).toBeInTheDocument();
});

// THE TYPING BUG. Rows used to be keyed by item.key while renaming a row
// rewrote item.key to whatever had been typed so far - so every
// keystroke changed the key React identified the row by, React tore the
// <input> down and built a new one, and the caret was thrown out of the
// field after a single character. These two tests pin both halves: the
// element must survive typing, and the typed text must accumulate.
test('typing into a row name keeps focus on the same input across keystrokes', () => {
  render(
    <MonthlyTrackerView
      {...makeProps({ monthlySnapshots: [july, august], onUpdateMonthlySnapshot: jest.fn() })}
    />
  );
  const card = historyCards()[0];
  fireEvent.click(within(card).getByText('ערוך'));

  const input = within(card).getByDisplayValue('PLTR');
  input.focus();
  expect(document.activeElement).toBe(input);

  'PLTR-NEW'.split('').forEach((_, i) => {
    fireEvent.change(document.activeElement, { target: { value: 'PLTR-NEW'.slice(0, i + 1) } });
    // Same DOM node throughout: never unmounted and replaced.
    expect(document.activeElement).toBe(input);
  });

  expect(input.value).toBe('PLTR-NEW');
});

test('typing into a row value keeps focus, and a half-typed value never poisons the total with NaN', () => {
  render(
    <MonthlyTrackerView
      {...makeProps({ monthlySnapshots: [july, august], onUpdateMonthlySnapshot: jest.fn() })}
    />
  );
  const card = historyCards()[0];
  fireEvent.click(within(card).getByText('ערוך'));

  const input = within(card).getByDisplayValue('27000');
  input.focus();

  // An emptied field and a lone "-" are both states a number input
  // passes through while being typed into. Parsing on every keystroke
  // turned them into NaN, which spread to the category subtotal and the
  // card total.
  ['', '-', '-3', '-35000'].forEach((value) => {
    fireEvent.change(document.activeElement, { target: { value } });
    expect(document.activeElement).toBe(input);
    expect(within(card).queryByText(/NaN/)).toBeNull();
  });

  expect(input.value).toBe('-35000');
});

// Row MANAGEMENT, not just revaluing: a saved checkpoint may need a row
// the portfolio no longer has (an account since closed), or be missing
// one that existed at the time. Editing values alone couldn't express
// either.
test('editing a month can ADD a row to any category, and the new row is included in the saved breakdown/total', async () => {
  const onUpdateMonthlySnapshot = jest.fn().mockResolvedValue(true);
  render(<MonthlyTrackerView {...makeProps({ monthlySnapshots: [july, august], onUpdateMonthlySnapshot })} />);

  const card = historyCards()[0]; // august
  fireEvent.click(within(card).getByText('ערוך'));

  // One "+ הוסף שורה" button per category, in the category headers.
  const addButtons = within(card).getAllByText('+ הוסף שורה');
  expect(addButtons.length).toBe(6);

  // The Israeli category is the first one. A new row starts blank.
  fireEvent.click(addButtons[0]);

  const israeliCategory = within(card).getAllByText('בורסה ישראלית')[0].closest('.monthly-history-category');
  const blankRow = within(israeliCategory)
    .getAllByPlaceholderText('שם הפריט')
    .find((el) => el.value === '');
  fireEvent.change(blankRow, { target: { value: 'ICL' } });

  const blankValue = within(israeliCategory)
    .getAllByPlaceholderText('שווי (₪)')
    .find((el) => el.value === '');
  fireEvent.change(blankValue, { target: { value: '3000' } });

  fireEvent.click(within(card).getByText('שמור עריכה'));

  const [, totalValueILS, breakdown] = onUpdateMonthlySnapshot.mock.calls[0];
  expect(breakdown.israeli).toEqual([
    { key: 'TEVA', label: 'TEVA', value: 22000 },
    { key: 'ICL', label: 'ICL', value: 3000 }
  ]);
  expect(totalValueILS).toBe(22000 + 3000 + 27000 + 44000 + 5000 + 12000);
  await waitFor(() => expect(within(card).queryByText('שמור עריכה')).toBeNull());
});

test('editing a month can REMOVE a row, and the total drops by exactly that row', async () => {
  const onUpdateMonthlySnapshot = jest.fn().mockResolvedValue(true);
  render(<MonthlyTrackerView {...makeProps({ monthlySnapshots: [july, august], onUpdateMonthlySnapshot })} />);

  const card = historyCards()[0];
  fireEvent.click(within(card).getByText('ערוך'));

  // Remove the cash-fund row (קרן X, 5000).
  const cashRow = within(card).getByDisplayValue('קרן X').closest('.monthly-history-item-row');
  fireEvent.click(within(cashRow).getByText('הסר'));

  fireEvent.click(within(card).getByText('שמור עריכה'));

  const [, totalValueILS, breakdown] = onUpdateMonthlySnapshot.mock.calls[0];
  expect(breakdown.cashFunds).toEqual([]);
  expect(totalValueILS).toBe(22000 + 27000 + 44000 + 12000);
  await waitFor(() => expect(within(card).queryByText('שמור עריכה')).toBeNull());
});

test('renaming a row re-keys it, so it still matches the same holding when two months are compared', async () => {
  const onUpdateMonthlySnapshot = jest.fn().mockResolvedValue(true);
  render(<MonthlyTrackerView {...makeProps({ monthlySnapshots: [july, august], onUpdateMonthlySnapshot })} />);

  const card = historyCards()[0];
  fireEvent.click(within(card).getByText('ערוך'));
  fireEvent.change(within(card).getByDisplayValue('קופה א'), { target: { value: 'קופת גמל מור' } });
  fireEvent.click(within(card).getByText('שמור עריכה'));

  const [, , breakdown] = onUpdateMonthlySnapshot.mock.calls[0];
  expect(breakdown.pension).toEqual([{ key: 'קופת גמל מור', label: 'קופת גמל מור', value: 44000 }]);
  await waitFor(() => expect(within(card).queryByText('שמור עריכה')).toBeNull());
});

// Rows must be visible while editing regardless of the detail toggle -
// otherwise there is nothing to add to or remove from.
test('rows are shown while editing even when the detail view is collapsed', () => {
  const onUpdateMonthlySnapshot = jest.fn();
  render(<MonthlyTrackerView {...makeProps({ monthlySnapshots: [july, august], onUpdateMonthlySnapshot })} />);

  const card = historyCards()[0];
  // Detail view is off by default.
  expect(within(card).queryByText('↳ TEVA')).toBeNull();

  fireEvent.click(within(card).getByText('ערוך'));
  expect(within(card).getByDisplayValue('TEVA')).toBeInTheDocument();
});

test('the categories whose figures are derived are marked as such while editing', () => {
  render(
    <MonthlyTrackerView
      {...makeProps({ monthlySnapshots: [july, august], onUpdateMonthlySnapshot: jest.fn() })}
    />
  );
  const card = historyCards()[0];
  fireEvent.click(within(card).getByText('ערוך'));
  // israeli / american / pension
  expect(within(card).getAllByText('· נגזר אוטומטית').length).toBe(3);
});

// A month saved before stock/pension flows became derived still carries
// the flows that were declared at the time. Opening it to correct an
// unrelated figure must not quietly throw them away - the comparison
// that month feeds has to keep producing the number it always did.
test('editing a legacy month preserves every flow it was saved with by hand, none of which has a field now', async () => {
  const onUpdateMonthlySnapshot = jest.fn().mockResolvedValue(true);
  const legacyAugust = {
    ...august,
    breakdown: { ...august.breakdown, cashFlows: { israeli: 5000, pension: 2000, bank: 1000 } }
  };
  render(
    <MonthlyTrackerView
      {...makeProps({ monthlySnapshots: [july, legacyAugust], onUpdateMonthlySnapshot })}
    />
  );

  const card = historyCards()[0];
  fireEvent.click(within(card).getByText('ערוך'));

  // Correct something unrelated.
  fireEvent.change(within(card).getByDisplayValue('27000'), { target: { value: '28000' } });
  fireEvent.click(within(card).getByText('שמור עריכה'));

  const [, , breakdown] = onUpdateMonthlySnapshot.mock.calls[0];
  expect(breakdown.cashFlows).toEqual({ israeli: 5000, pension: 2000, bank: 1000 });

  await waitFor(() => expect(within(card).queryByText('שמור עריכה')).toBeNull());
});


test('re-saving the current month also preserves its legacy declared flows', () => {
  const onSaveMonthlySnapshot = jest.fn();
  const thisMonth = todayISO().slice(0, 7);
  render(
    <MonthlyTrackerView
      {...makeProps({
        onSaveMonthlySnapshot,
        monthlySnapshots: [
          {
            month: thisMonth,
            totalValueILS: 1000,
            breakdown: { cashFlows: { american: 7000, bank: 100 } }
          }
        ]
      })}
    />
  );

  fireEvent.click(monthlyScope().getByText('עדכן שמירה חודשית'));
  expect(onSaveMonthlySnapshot).toHaveBeenCalledWith({ american: 7000, bank: 100 }, expect.objectContaining({ asOfDate: todayISO() }));
});

test('the edit form has no cash-flow fields', () => {
  render(
    <MonthlyTrackerView
      {...makeProps({ monthlySnapshots: [july, august], onUpdateMonthlySnapshot: jest.fn() })}
    />
  );
  fireEvent.click(within(historyCards()[0]).getByText('ערוך'));
  expect(document.querySelector('[id*="cashflow"]')).toBeNull();
});

// AUTOMATIC FILL: the monthly tracker stops being a typing exercise.
test('an automatic fill is offered in both the edit and the manual-backfill flow', () => {
  render(
    <MonthlyTrackerView
      {...makeProps({
        monthlySnapshots: [july, august],
        onUpdateMonthlySnapshot: jest.fn(),
        onAddManualMonthlySnapshot: jest.fn()
      })}
    />
  );

  const card = historyCards()[0];
  fireEvent.click(within(card).getByText('ערוך'));
  expect(within(card).getByText('⚡ מלא אוטומטית מהטבלאות')).toBeInTheDocument();

  fireEvent.click(within(card).getByText('ביטול'));
  fireEvent.click(monthlyScope().getByText('➕ הוספה ידנית'));
  // In the backfill form only the liquid rows are fillable - the rest
  // are derived and shown read-only, so the button says what it does.
  expect(monthlyScope().getByText('⚡ מלא מהפנקסים')).toBeInTheDocument();
});

test('auto-fill says so plainly when the historical prices for that month are not available, instead of writing zeroes over the saved data', () => {
  const onUpdateMonthlySnapshot = jest.fn();
  render(<MonthlyTrackerView {...makeProps({ monthlySnapshots: [july, august], onUpdateMonthlySnapshot })} />);

  const card = historyCards()[0];
  fireEvent.click(within(card).getByText('ערוך'));
  // global.fetch rejects in this suite's default set-up, so no
  // historical data is available.
  fireEvent.click(within(card).getByText('⚡ מלא אוטומטית מהטבלאות'));

  expect(
    within(card).getByText(/אין עדיין נתונים היסטוריים לתאריך הזה/)
  ).toBeInTheDocument();
  // The saved values are untouched.
  expect(within(card).getByDisplayValue('22000')).toBeInTheDocument();
});

test('auto-fill replaces the rows with values derived from the historical closes and the account ledgers', async () => {
  global.fetch.mockImplementation((url) => {
    const u = String(url);
    if (u.includes('israeli-stocks-history')) {
      return Promise.resolve({
        ok: true,
        json: async () => ({ history: { TEVA: [{ date: '2023-01-15', close: 10000 }] } })
      });
    }
    return Promise.resolve({
      ok: true,
      json: async () => ({ history: u.includes('exchange-rate') ? [] : {} })
    });
  });

  const onUpdateMonthlySnapshot = jest.fn().mockResolvedValue(true);
  render(
    <MonthlyTrackerView
      {...makeProps({
        americanStocks: [],
        monthlySnapshots: [july, august],
        onUpdateMonthlySnapshot
      })}
    />
  );

  // Wait for the page's own historical-price load to settle - the
  // auto-fill reads from exactly that fetched data.
  await waitFor(() => expect(screen.queryByText('טוען נתונים היסטוריים למילוי אוטומטי…')).toBeNull());

  const card = historyCards()[0];
  fireEvent.click(within(card).getByText('ערוך'));
  fireEvent.click(within(card).getByText('⚡ מלא אוטומטית מהטבלאות'));

  // 100 shares at a 10000-agorot close = 10,000 ILS, derived rather
  // than typed - replacing the 22,000 that was saved for this month.
  expect(within(card).getByDisplayValue('10000')).toBeInTheDocument();
  expect(within(card).queryByDisplayValue('22000')).toBeNull();
  expect(within(card).getByDisplayValue('TEVA')).toBeInTheDocument();
});

test('editing the shown month: "ביטול" discards changes without calling onUpdateMonthlySnapshot', () => {
  const onUpdateMonthlySnapshot = jest.fn();
  render(<MonthlyTrackerView {...makeProps({ monthlySnapshots: [july, august], onUpdateMonthlySnapshot })} />);
  const scope = monthlyScope();
  fireEvent.click(scope.getByText('פתח פירוט מלא'));

  const card = historyCards()[0];
  fireEvent.click(within(card).getByText('ערוך'));
  fireEvent.click(within(card).getByText('ביטול'));

  expect(onUpdateMonthlySnapshot).not.toHaveBeenCalled();
  expect(within(card).getByText('ערוך')).toBeInTheDocument();
});

test('editing a month that was saved with declared cash flows keeps them as they were', async () => {
  const augustWithCashFlows = { ...august, breakdown: { ...august.breakdown, cashFlows: { bank: 6000 } } };
  const onUpdateMonthlySnapshot = jest.fn().mockResolvedValue(true);
  render(
    <MonthlyTrackerView
      {...makeProps({ monthlySnapshots: [july, augustWithCashFlows], onUpdateMonthlySnapshot })}
    />
  );
  const card = historyCards()[0];
  fireEvent.click(within(card).getByText('ערוך'));
  fireEvent.click(within(card).getByText('שמור עריכה'));
  const [, , breakdown] = onUpdateMonthlySnapshot.mock.calls[0];
  expect(breakdown.cashFlows).toEqual({ bank: 6000 });
  await waitFor(() => expect(within(card).queryByText('שמור עריכה')).toBeNull());
});

test('shows updateMonthlyError and the "שומר…" state for the month currently being updated', () => {
  const { rerender } = render(
    <MonthlyTrackerView
      {...makeProps({
        monthlySnapshots: [july, august],
        onUpdateMonthlySnapshot: jest.fn(),
        updateMonthlyError: 'עדכון השמירה החודשית נכשל, נסה שוב'
      })}
    />
  );
  expect(screen.getByText('עדכון השמירה החודשית נכשל, נסה שוב')).toBeInTheDocument();

  const card = historyCards()[0];
  fireEvent.click(within(card).getByText('ערוך'));
  rerender(
    <MonthlyTrackerView
      {...makeProps({
        monthlySnapshots: [july, august],
        onUpdateMonthlySnapshot: jest.fn(),
        updatingMonth: '2026-08'
      })}
    />
  );
  // re-render replaces the tree, but the "ערוך" click above set local
  // editing state that survives re-render (same component instance)
  const cardAfter = historyCards()[0];
  expect(within(cardAfter).getByText('שומר…')).toBeInTheDocument();
});

test('without onDeleteMonthlySnapshot, the history card shows no "מחק" button', () => {
  render(<MonthlyTrackerView {...makeProps({ monthlySnapshots: [july, august], onDeleteMonthlySnapshot: undefined })} />);
  expect(monthlyScope().queryByText('מחק')).toBeNull();
});

test('"מחק" asks for confirmation and, once confirmed, calls onDeleteMonthlySnapshot with the shown month', () => {
  const confirmSpy = jest.spyOn(window, 'confirm').mockReturnValue(true);
  const onDeleteMonthlySnapshot = jest.fn().mockResolvedValue(true);
  render(<MonthlyTrackerView {...makeProps({ monthlySnapshots: [july, august], onDeleteMonthlySnapshot })} />);

  fireEvent.click(within(historyCards()[0]).getByText('מחק'));
  expect(confirmSpy).toHaveBeenCalled();
  expect(onDeleteMonthlySnapshot).toHaveBeenCalledWith('2026-08');
  confirmSpy.mockRestore();
});

test('declining the confirmation does not call onDeleteMonthlySnapshot', () => {
  const confirmSpy = jest.spyOn(window, 'confirm').mockReturnValue(false);
  const onDeleteMonthlySnapshot = jest.fn();
  render(<MonthlyTrackerView {...makeProps({ monthlySnapshots: [july, august], onDeleteMonthlySnapshot })} />);

  fireEvent.click(within(historyCards()[0]).getByText('מחק'));
  expect(onDeleteMonthlySnapshot).not.toHaveBeenCalled();
  confirmSpy.mockRestore();
});

test('shows the "מוחק…" loading state and deleteMonthlyError', () => {
  render(
    <MonthlyTrackerView
      {...makeProps({
        monthlySnapshots: [july, august],
        onDeleteMonthlySnapshot: jest.fn(),
        deletingMonth: '2026-08',
        deleteMonthlyError: 'מחיקת השמירה החודשית נכשלה, נסה שוב'
      })}
    />
  );
  expect(within(historyCards()[0]).getByText('מוחק…')).toBeInTheDocument();
  expect(screen.getByText('מחיקת השמירה החודשית נכשלה, נסה שוב')).toBeInTheDocument();
});

test('a month saved before itemized detail existed (a flat category number) shows a friendly "no detail" note instead of a fake single item, both compared and on its own', () => {
  // both months legacy (flat numbers, no per-item detail) - the case
  // from the screenshot this was reported from. A legacy-vs-itemized
  // mix is a separate, intentionally different case (see
  // monthlySnapshotComparison.test.js's backward-compat test): there,
  // the itemized side's real items still show normally.
  const legacyJuly = {
    month: '2026-07',
    totalValueILS: 100000,
    breakdown: { israeli: 20000, american: 30000, pension: 40000, cashFunds: 5000, bank: 5000 }
  };
  const legacyAugust = {
    month: '2026-08',
    totalValueILS: 110000,
    breakdown: { israeli: 22000, american: 27000, pension: 44000, cashFunds: 5000, bank: 12000 }
  };
  render(<MonthlyTrackerView {...makeProps({ monthlySnapshots: [legacyJuly, legacyAugust] })} />);
  const scope = monthlyScope();
  fireEvent.click(scope.getByText('פתח פירוט מלא'));

  const note = 'אין פירוט פריטים זמין להשוואה זו (אחד החודשים נשמר לפני שנוסף פירוט מלא)';
  expect(scope.getAllByText(note).length).toBeGreaterThan(0);

  fireEvent.click(within(document.body.querySelector('.mt-timeline')).getByText('יולי 2026').closest('button'));
  expect(
    within(historyCards()[0]).getAllByText('אין פירוט פריטים לשמירה זו (נשמרה לפני שנוסף פירוט מלא)').length
  ).toBeGreaterThan(0);
});
});

// The Hebrew month label the page renders, derived the same way the page
// derives it - so the assertion doesn't hard-code a month name that would
// only be right in one locale, or in one month of the year.
function formatMonthLabelForTest(monthKey) {
  const [year, month] = monthKey.split('-').map(Number);
  return new Date(year, month - 1, 1).toLocaleDateString('he-IL', { month: 'long', year: 'numeric' });
}

// THE EXPLICIT AS-OF DATE
describe('as-of date', () => {
beforeEach(() => {
  global.fetch = jest.fn().mockRejectedValue(new Error('network unavailable in test'));
});
afterEach(() => {
  delete global.fetch;
});

test('the save form offers an as-of date limited to this month and not past today', () => {
  render(<MonthlyTrackerView {...makeProps()} />);
  const input = document.getElementById('save-as-of');
  const today = todayISO();
  expect(input).toHaveValue(today);
  expect(input).toHaveAttribute('min', `${today.slice(0, 7)}-01`);
  expect(input).toHaveAttribute('max', today);
});

test("an earlier as-of date is never saved with today's figures - without its history it says so and saves nothing", () => {
  const onSaveMonthlySnapshot = jest.fn();
  const today = todayISO();
  render(<MonthlyTrackerView {...makeProps({ onSaveMonthlySnapshot })} />);
  // global.fetch rejects in this suite, so there is no history for any
  // earlier day. (On the 1st of a month there is no earlier day to pick.)
  if (today.slice(8) === '01') return;
  fireEvent.change(document.getElementById('save-as-of'), { target: { value: `${today.slice(0, 7)}-01` } });
  fireEvent.click(screen.getByText('שמור שמירה חודשית'));
  expect(onSaveMonthlySnapshot).not.toHaveBeenCalled();
  expect(screen.getByText(/אין עדיין נתונים היסטוריים לתאריך הזה/)).toBeInTheDocument();
});

test("the current-account and money-market rows are synced from their ledgers up to the as-of date", () => {
  const onSaveMonthlySnapshot = jest.fn();
  const today = todayISO();
  const bank = [{ id: 7, currentValue: 1000, currentValueDate: '2020-01-01', amount: 1000, deposits: [{ date: today, amount: 250 }] }];
  render(<MonthlyTrackerView {...makeProps({ onSaveMonthlySnapshot, bankBalances: bank })} />);
  fireEvent.click(screen.getByText('שמור שמירה חודשית'));
  const [, { breakdown }] = onSaveMonthlySnapshot.mock.calls[0];
  // The recorded balance plus the movement recorded after it.
  expect(breakdown.bank).toEqual([{ key: 'bank-1', label: 'עו"ש', value: 1250 }]);
});

test('each provident fund is checked against the as-of date: a matching statement, or an older one', () => {
  const today = todayISO();
  const funds = [
    { id: 1, fundName: 'גמל א', currentValue: 100, currentValueDate: today, deposits: [] },
    { id: 2, fundName: 'גמל ב', currentValue: 100, currentValueDate: '2020-01-31', deposits: [] }
  ];
  render(<MonthlyTrackerView {...makeProps({ pensionFunds: funds })} />);
  expect(screen.getByText(/1 לא תואמות/)).toBeInTheDocument();
  expect(screen.getByText(/תואם - דוח מ-/)).toBeInTheDocument();
  expect(screen.getByText(/דוח מוקדם יותר \(31\/01\/2020/)).toBeInTheDocument();
});

test('the comparison names the two as-of dates it measures between', () => {
  const a = { month: '2026-07', asOfDate: '2026-07-06', totalValueILS: 100, breakdown: { asOfDate: '2026-07-06' } };
  const b = { month: '2026-08', asOfDate: '2026-08-05', totalValueILS: 110, breakdown: { asOfDate: '2026-08-05' } };
  render(<MonthlyTrackerView {...makeProps({ monthlySnapshots: [a, b] })} />);
  expect(screen.getByText(/התקופה הנמדדת: 06\/07\/2026 ← 05\/08\/2026 \(30 ימים\)/)).toBeInTheDocument();
});
});
