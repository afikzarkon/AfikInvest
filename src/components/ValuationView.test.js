import { render, screen, fireEvent, within, waitFor } from '@testing-library/react';
import ValuationView, { mergeRuleEdits, rulesWithEdits } from './ValuationView';
import { evaluateDcf, reproduceFromCard, DEFAULT_RULES } from '../shared/dcfRules';
import avgoSnapshot from '../shared/fixtures/dcf-snapshot-avgo.json';

const payload = (overrides = {}) => ({
  symbol: 'AVGO',
  name: 'Broadcom Inc.',
  sector: 'Technology',
  industry: 'Semiconductors',
  currency: 'USD',
  financialCurrency: 'USD',
  price: 328.75,
  marketCap: 1.569e12,
  multiples: [
    { metric: 'PE', current: 30, avg5y: 25, median5y: 24, min5y: 15, max5y: 40, percentile5y: 70, samples: 55, totalMonths: 60, sectorMedian: 28, peerCount: 4, vsHistoryPct: 20, vsSectorPct: 7 },
    { metric: 'PS', current: 5, avg5y: 4, median5y: 4, min5y: 3, max5y: 6, percentile5y: 80, samples: 60, totalMonths: 60, sectorMedian: 6, peerCount: 4, vsHistoryPct: 25, vsSectorPct: -17 },
    { metric: 'PFCF', current: null, avg5y: null, median5y: null, min5y: null, max5y: null, percentile5y: null, samples: 0, totalMonths: 60, sectorMedian: null, peerCount: 0, vsHistoryPct: null, vsSectorPct: null }
  ],
  warnings: [],
  sources: { statements: 'yahoo' },
  asOf: '2026-10-18T00:00:00Z',
  ...overrides
});

// The two endpoints the page reads: the multiples and the DCF snapshot.
function mockApi({ valuation = payload(), snapshot = avgoSnapshot } = {}) {
  global.fetch = jest.fn(async (url) => ({ ok: true, json: async () => (String(url).endsWith('/dcf') ? snapshot : valuation) }));
}

beforeEach(() => mockApi());

const expected = () => evaluateDcf({ mode: 'auto', snapshot: avgoSnapshot, valuationDate: new Date().toISOString().slice(0, 10) });
const money = (v) => `${v.toFixed(2)} USD`;

test('loads the first held symbol and shows its multiples', async () => {
  render(<ValuationView americanStocks={[{ stockName: 'xyz' }, { stockName: 'ABC' }]} />);
  expect(global.fetch.mock.calls[0][0]).toMatch(/\/api\/valuation\/ABC$/);
  const table = await screen.findByRole('table', { name: 'מכפילים' });
  expect(within(table).getByText('30.0x')).toBeInTheDocument();
  expect(within(table).getAllByText('N/M').length).toBeGreaterThan(0);
  expect(within(table).getByText('70')).toBeInTheDocument();
});

test('auto DCF: three scenarios and the weighted value, straight from the engine; centre of the grid = the result', async () => {
  render(<ValuationView americanStocks={[{ stockName: 'AVGO' }]} />);
  const e = expected();
  expect(await screen.findByTestId('dcf-value-base')).toHaveTextContent(money(e.results.base.perShare));
  expect(screen.getByTestId('dcf-value-bear')).toHaveTextContent(money(e.results.bear.perShare));
  expect(screen.getByTestId('dcf-value-bull')).toHaveTextContent(money(e.results.bull.perShare));
  expect(screen.getByTestId('dcf-value-weighted')).toHaveTextContent(money(e.weighted));
  const grid = screen.getByRole('table', { name: 'רגישות' });
  expect(within(grid).getByText(e.main.perShare.toFixed(2))).toHaveClass('cell-current');
  // The inputs are visible, not editable, in auto mode.
  expect(screen.getByLabelText('ריבית חסרת סיכון (rf)')).toHaveAttribute('readonly');
});

test('the summary reads the auto base case, with the implied return', async () => {
  render(<ValuationView americanStocks={[{ stockName: 'AVGO' }]} />);
  const summary = await screen.findByRole('region', { name: 'בשורה התחתונה' });
  const e = expected();
  await waitFor(() => expect(within(summary).getByText(/התשואה השנתית הצפויה היא כ-/)).toBeInTheDocument());
  expect(within(summary).getByText(new RegExp(`כ-${(e.irr * 100).toFixed(1)}%`))).toBeInTheDocument();
  expect(within(summary).getByText('יקרה מהרגיל')).toBeInTheDocument();
  expect(screen.getByText(/על כל דולר של רווח שנתי/)).toBeInTheDocument();
});

test('editing turns the model manual ("custom"), and the value follows the edit at once', async () => {
  render(<ValuationView americanStocks={[{ stockName: 'AVGO' }]} />);
  const before = (await screen.findByTestId('dcf-value-base')).textContent;
  fireEvent.click(screen.getByRole('button', { name: /^ידני/ }));
  expect(screen.getByRole('button', { name: 'ידני - מותאם אישית' })).toHaveAttribute('aria-pressed', 'true');
  const firstGrowth = screen.getByLabelText('צמיחת הכנסות, FY27');
  fireEvent.change(firstGrowth, { target: { value: '90' } });
  expect(screen.getByTestId('dcf-value-base').textContent).not.toBe(before);
  expect(Number.parseFloat(screen.getByTestId('dcf-value-base').textContent)).toBeGreaterThan(Number.parseFloat(before));
});

test('the AVGO preset gives DCF_METHOD.md\'s 117 / 234 / 326', async () => {
  render(<ValuationView americanStocks={[{ stockName: 'AVGO' }]} />);
  await screen.findByTestId('dcf-value-base');
  fireEvent.click(screen.getByRole('button', { name: 'פריסט AVGO (DCF_METHOD.md)' }));
  expect(screen.getByTestId('dcf-value-conservative')).toHaveTextContent('117.10 USD');
  expect(screen.getByTestId('dcf-value-base')).toHaveTextContent('233.98 USD');
  expect(screen.getByTestId('dcf-value-management')).toHaveTextContent('325.78 USD');
  expect(screen.getAllByText('11.25%', { selector: 'bdi' }).length).toBeGreaterThan(0);
});

test('the exported input card reproduces the page\'s numbers offline', async () => {
  let blob;
  global.URL.createObjectURL = jest.fn((b) => {
    blob = b;
    return 'blob:card';
  });
  global.URL.revokeObjectURL = jest.fn();
  render(<ValuationView americanStocks={[{ stockName: 'AVGO' }]} />);
  const shown = (await screen.findByTestId('dcf-value-base')).textContent;
  fireEvent.click(screen.getByRole('button', { name: 'ייצוא כרטיס קלטים' }));
  const text = await new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.readAsText(blob);
  });
  const card = JSON.parse(text);
  expect(card).toMatchObject({ ticker: 'AVGO', mode: 'auto', price: 328.75 });
  expect(money(card.results.scenarios.base.perShare)).toBe(shown.trim());
  const { fromInputs, fromRaw } = reproduceFromCard(card);
  expect(fromInputs.results.base.perShare).toBe(card.results.scenarios.base.perShare);
  expect(fromRaw.results.base.perShare).toBe(card.results.scenarios.base.perShare);
});

test('a bank is not valued by DCF: a reason, no number', async () => {
  mockApi({ snapshot: { ...avgoSnapshot, profile: { sector: 'Financial Services', industry: 'Banks - Diversified' } } });
  render(<ValuationView americanStocks={[{ stockName: 'AVGO' }]} />);
  expect(await screen.findByText(/מודל DCF על תזרים חופשי אינו מתאים לבנקים/, { selector: '.dcf-unsuitable' })).toBeInTheDocument();
  expect(screen.queryByTestId('dcf-value-base')).toBeNull();
  const summary = screen.getByRole('region', { name: 'בשורה התחתונה' });
  expect(within(summary).getByText('לא מתאים ל-DCF')).toBeInTheDocument();
});

test('any symbol can be typed; errors are shown', async () => {
  global.fetch = jest.fn(async () => ({ ok: false, json: async () => ({ error: 'לא ניתן היה לטעון' }) }));
  render(<ValuationView americanStocks={[]} />);
  fireEvent.change(screen.getByLabelText('או הקלידו סימול של מניה'), { target: { value: 'msft' } });
  fireEvent.click(screen.getByRole('button', { name: 'הצגה' }));
  await waitFor(() => expect(global.fetch.mock.calls[0][0]).toMatch(/\/api\/valuation\/MSFT$/));
  expect(await screen.findByText('לא ניתן היה לטעון')).toBeInTheDocument();
});

test('a P/E driven by tiny earnings is called out instead of read', async () => {
  const base = payload();
  mockApi({ valuation: payload({ multiples: [{ ...base.multiples[0], current: 911, avg5y: 184, min5y: 46, max5y: 988, vsHistoryPct: 394 }, ...base.multiples.slice(1)] }) });
  render(<ValuationView americanStocks={[{ stockName: 'AVGO' }]} />);
  const card = await screen.findByRole('article', { name: 'מחיר מול רווח' });
  expect(within(card).getByText(/לא משמעותי כרגע/)).toBeInTheDocument();
  expect(within(card).queryByText('יקר מהרגיל')).toBeNull();
});

// ---------------------------------------------------------------------------
// Rules v2 on the page, with NOW (fixtures/dcf-snapshot-now.json).
describe('NOW: added figures, the FCF basis, presets, peers', () => {
  const nowSnapshot = require('../shared/fixtures/dcf-snapshot-now.json');
  const peers = [
    { symbol: 'CRM', PE: 40, PS: 7, PFCF: 25 },
    { symbol: 'WDAY', PE: 45, PS: 6.5, PFCF: 22 },
    { symbol: 'ADBE', PE: 30, PS: 8, PFCF: 24 },
    { symbol: 'INTU', PE: 55, PS: 9, PFCF: 30 },
    { symbol: 'PLTR', PE: 400, PS: 70, PFCF: 240 }
  ];
  const nowPayload = payload({ symbol: 'NOW', name: 'ServiceNow, Inc.', price: 141.97, peers });
  const day = () => new Date().toISOString().slice(0, 10);
  const auto = (overrides, rules) => evaluateDcf({ mode: 'auto', snapshot: nowSnapshot, overrides, rules, valuationDate: day() });
  const renderNow = async (snapshot = nowSnapshot) => {
    mockApi({ valuation: nowPayload, snapshot });
    render(<ValuationView americanStocks={[{ stockName: 'NOW' }]} />);
    await screen.findByTestId('dcf-value-base');
  };
  const warnings = () => screen.getByRole('list', { name: 'אזהרות' }).textContent;

  test('auto: cash 6.707 in three parts, the two warnings, and the implied growth beside the IRR', async () => {
    await renderNow();
    const e = auto();
    expect(screen.getByTestId('dcf-value-base')).toHaveTextContent(money(e.results.base.perShare));
    expect(warnings()).toMatch(/צמיחה ב-FY\+2 אינה מקונצנזוס/);
    // A technology company: the trailing margin held flat, and said so.
    expect(warnings()).toMatch(/אין הנחיית שוליים - שולי 12 החודשים מוחזקים קבועים \(סקטור Technology\)/);
    expect(screen.getByTestId('dcf-implied-growth')).toHaveTextContent(`${(e.impliedGrowth * 100).toFixed(1)}%`);
    const sources = screen.getByRole('table', { name: 'נתוני מקור' });
    expect(within(sources).getByText('6.71B USD')).toBeInTheDocument();
    expect(within(sources).getByText('↳ השקעות לטווח קצר')).toBeInTheDocument();
    expect(within(sources).getByText('2.16B USD')).toBeInTheDocument();
    expect(within(sources).getByText('2.04B USD')).toBeInTheDocument();
  });

  test('a consensus FY+2 growth: used, its source shown, the warning gone, the value moves', async () => {
    await renderNow();
    fireEvent.change(screen.getByLabelText('צמיחה מקונצנזוס / הנחיה, FY28'), { target: { value: '18.6' } });
    fireEvent.change(screen.getByLabelText('מקור הצמיחה שהוזנה'), { target: { value: 'קונצנזוס' } });
    const e = auto({ growth: [null, { value: 0.186, source: 'קונצנזוס', asOf: day() }, null, null, null] });
    expect(screen.getByTestId('dcf-value-base')).toHaveTextContent(money(e.results.base.perShare));
    expect(warnings()).not.toMatch(/FY\+2 אינה מקונצנזוס/);
    expect(screen.getAllByText('קונצנזוס', { selector: '.val-badge' }).length).toBeGreaterThanOrEqual(2);
  });

  test('guided margins: held after the last guided year; the generic-rule warning goes', async () => {
    await renderNow();
    fireEvent.change(screen.getByLabelText('שולי FCF מהנחיה / קונצנזוס, FY27'), { target: { value: '36' } });
    const e = auto({ fcfMargin: [{ value: 0.36, source: '', asOf: day() }, null, null, null, null] });
    expect(screen.getByTestId('dcf-value-base')).toHaveTextContent(money(e.results.base.perShare));
    expect(warnings()).not.toMatch(/אין הנחיית שוליים/);
    expect(screen.getAllByText('מוחזק', { selector: '.val-badge' })).toHaveLength(4);
  });

  test('the normalized FCF basis, once entered and chosen', async () => {
    await renderNow();
    const before = screen.getByTestId('dcf-value-base').textContent;
    fireEvent.change(screen.getByLabelText('FCF מנורמל, 12 חודשים'), { target: { value: '4.92' } });
    expect(screen.getByTestId('dcf-value-base').textContent).toBe(before); // the default basis stays
    fireEvent.click(screen.getByRole('radio', { name: /FCF מנורמל של החברה/ }));
    const e = auto({ normalizedFcfTtm: { value: 4.92e9, source: '', asOf: day() }, fcfBasis: 'normalized' });
    expect(e.derived.fcfBasis).toBe('normalized');
    expect(screen.getByTestId('dcf-value-base')).toHaveTextContent(money(e.results.base.perShare));
  });

  test('the NOW preset: 60.08 / 127.35 / 166.53, weighted 120.33', async () => {
    await renderNow();
    fireEvent.click(screen.getByRole('button', { name: /^פריסט NOW/ }));
    expect(screen.getByTestId('dcf-value-bear')).toHaveTextContent('60.08 USD');
    expect(screen.getByTestId('dcf-value-base')).toHaveTextContent('127.35 USD');
    expect(screen.getByTestId('dcf-value-bull')).toHaveTextContent('166.53 USD');
    expect(screen.getByTestId('dcf-value-weighted')).toHaveTextContent('120.33 USD');
  });

  // One rule set: the first version is gone, not offered as a switch.
  test('no legacy switch: the page always values on the current rules', async () => {
    await renderNow();
    expect(screen.queryByRole('checkbox', { name: /legacy/ })).toBeNull();
    expect(screen.getByTestId('dcf-value-base')).toHaveTextContent(money(auto().results.base.perShare));
  });

  // Each new rule is a control on the page, and each one moves the number
  // to exactly what the rules give with that setting.
  test('the flat margin and the terminal method are controls, and each gives the rules\' own result', async () => {
    await renderNow();
    fireEvent.click(screen.getByRole('checkbox', { name: /שוליים קבועים לטכנולוגיה וצמיחה/ }));
    const faded = auto(undefined, Object.assign({}, DEFAULT_RULES, { flatMargin: false }));
    expect(screen.getByTestId('dcf-value-base')).toHaveTextContent(money(faded.results.base.perShare));

    fireEvent.change(screen.getByLabelText('שיטת הערך הסופי'), { target: { value: 'exit' } });
    const exit = auto(undefined, Object.assign({}, DEFAULT_RULES, { flatMargin: false, terminalMethod: 'exit', exitMultiple: 25 }));
    expect(screen.getByTestId('dcf-value-base')).toHaveTextContent(money(exit.results.base.perShare));
    fireEvent.change(screen.getByLabelText('מכפיל יציאה (על ה-FCF של שנה 5)'), { target: { value: '20' } });
    const exit20 = auto(undefined, Object.assign({}, DEFAULT_RULES, { flatMargin: false, terminalMethod: 'exit', exitMultiple: 20 }));
    expect(screen.getByTestId('dcf-value-base')).toHaveTextContent(money(exit20.results.base.perShare));
  });

  test('peers: all five listed, the median labelled as the one compared with, the mean beside it', async () => {
    await renderNow();
    const list = screen.getByRole('table', { name: 'חברות להשוואה' });
    ['CRM', 'WDAY', 'ADBE', 'INTU', 'PLTR'].forEach((s) => expect(within(list).getByText(s)).toBeInTheDocument());
    expect(within(list).getByText('חציון (להשוואה)')).toBeInTheDocument();
    expect(within(list).getByText('ממוצע')).toBeInTheDocument();
  });

  test('an outlier pulling the mean to 3x the median is flagged on the card', async () => {
    mockApi({ valuation: payload({ symbol: 'NOW', peers: peers.map((p) => (p.symbol === 'PLTR' ? { ...p, PS: 500 } : p)) }), snapshot: nowSnapshot });
    render(<ValuationView americanStocks={[{ stockName: 'NOW' }]} />);
    const card = await screen.findByRole('article', { name: 'מחיר מול מכירות' });
    expect(within(card).getByRole('note')).toHaveTextContent(/ההשוואה היא לפי החציון/);
  });

  test('no rate today and none saved: no number, and a field to enter it', async () => {
    mockApi({ valuation: nowPayload, snapshot: { ...nowSnapshot, rf: null, rfLastSaved: null } });
    render(<ValuationView americanStocks={[{ stockName: 'NOW' }]} />);
    // Said in the summary and in the calculator alike.
    expect((await screen.findAllByText(/אין ערך עדכני ואין ערך שמור/)).length).toBe(2);
    expect(screen.queryByTestId('dcf-value-base')).toBeNull();
    fireEvent.change(screen.getByLabelText(/ריבית חסרת סיכון \(אג"ח/), { target: { value: '5.098' } });
    expect(screen.getByTestId('dcf-value-base')).toHaveTextContent(money(auto().results.base.perShare));
  });

  test('the card carries the added figures and reproduces them', async () => {
    let blob;
    global.URL.createObjectURL = jest.fn((b) => {
      blob = b;
      return 'blob:card';
    });
    global.URL.revokeObjectURL = jest.fn();
    await renderNow();
    fireEvent.change(screen.getByLabelText('צמיחה מקונצנזוס / הנחיה, FY28'), { target: { value: '18.6' } });
    fireEvent.click(screen.getByRole('button', { name: 'ייצוא כרטיס קלטים' }));
    const card = JSON.parse(
      await new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.readAsText(blob);
      })
    );
    expect(card.overrides.growth[1].value).toBeCloseTo(0.186, 12);
    expect(card.sources.growth[1].kind).toBe('consensus');
    expect(card.cash.parts.shortTermInvestments).toBeCloseTo(2.161e9, 0);
    const { fromRaw } = reproduceFromCard(card);
    expect(fromRaw.results.base.perShare).toBe(card.results.scenarios.base.perShare);
  });
});

// The rules panel's edits, field by field, onto the defaults.
describe('rule edits', () => {
  test('a beta cap edited or switched off per tier; the others stay', () => {
    const one = rulesWithEdits(mergeRuleEdits({}, { betaCaps: { 200000000000: 1.6 } }));
    expect(one.betaCaps.map((t) => t.betaCap)).toEqual([1.25, 1.6]);
    const off = rulesWithEdits(mergeRuleEdits({ betaCaps: { 200000000000: 1.6 } }, { betaCaps: { 1000000000000: 'off' } }));
    expect(off.betaCaps.map((t) => t.betaCap)).toEqual([1.6]);
  });

  test('the WACC band edited one edge at a time; empty is no edge on that side', () => {
    expect(rulesWithEdits({}).waccBand).toEqual({ min: null, max: 0.115 });
    const min = mergeRuleEdits({}, { waccBand: { min: 0.08 } });
    const both = mergeRuleEdits(min, { waccBand: { max: 0.12 } });
    expect(rulesWithEdits(both).waccBand).toEqual({ min: 0.08, max: 0.12 });
    expect(rulesWithEdits(mergeRuleEdits(both, { waccBand: { max: null } })).waccBand).toEqual({ min: 0.08, max: null });
  });

  test('the SBC share is kept inside 0..1; no edits is the defaults', () => {
    expect(rulesWithEdits({ sbcShareTechGrowth: 3 }).sbcShareTechGrowth).toBe(1);
    expect(rulesWithEdits({})).toEqual(DEFAULT_RULES);
  });
});
