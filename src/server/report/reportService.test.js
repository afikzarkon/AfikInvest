/**
 * @jest-environment node
 */
// The whole event-driven flow on a real store, with a fake clock, memory
// storage and a fake PDF renderer.
const { initFeatureStore } = require('../featureStore');
const { createJobRunner } = require('../jobRunner');
const { createJobHandlers } = require('../jobs');
const { createReportService, createEmailNotifier, breakdownFromPortfolio } = require('./reportService');
const { createMemoryStorage } = require('./reportStorage');
const { STORE_FACTORIES } = require('../testUtils/stores');

const marketData = { async getBars() { return []; }, supportsCalendar: () => false };

describe.each(STORE_FACTORIES)('monthly report flow (%s)', (_name, makeStore) => {
  let store;
  let features;
  let storage;
  let renderer;
  let notifier;
  let clock;
  let service;
  let runner;
  let userId;

  const portfolio = (pensionDate, pensionValue = 100000, bankDate = '2026-09-02') => ({
    israeliStocks: [{ id: 1, stockName: '604611', officialName: 'לאומי', quantity: 100, currentPrice: 30, purchaseDate: '2025-01-01', purchasePrice: 20 }],
    pensionFunds: [{ id: 5, fundName: 'גמל', currentValue: pensionValue, currentValueDate: pensionDate, deposits: [] }],
    bankBalances: [{ id: 6, amount: 5000, currentValueDate: bankDate }]
  });
  const save = async (p) => {
    await store.upsertPortfolio(userId, JSON.stringify(p));
    return service.onPortfolioSaved(userId);
  };
  const advance = (minutes) => {
    clock = new Date(clock.getTime() + minutes * 60000);
  };
  const drain = () => runner.runDue({ now: () => clock.toISOString() });

  beforeEach(async () => {
    store = await makeStore();
    features = await initFeatureStore(store);
    storage = createMemoryStorage();
    renderer = { render: jest.fn(async (html) => Buffer.from(`%PDF fake ${html.length}`)) };
    notifier = { reportReady: jest.fn(async () => {}) };
    clock = new Date('2026-09-05T08:00:00Z'); // syncing August
    service = createReportService({ store, features, storage, renderer, notifier, now: () => clock, getUsdRate: async () => 3.7, logger: { error() {} } });
    runner = createJobRunner({ features, handlers: createJobHandlers({ store, features, marketData, reports: service }), logger: { error() {} } });
    ({ id: userId } = await store.insertUser('r@x.com', 'h'));
  });
  afterEach(async () => {
    await store.close();
  });

  test('waits for every manual account, then completes on its own and renders after the debounce', async () => {
    // Only the bank is updated for August: in progress, no report.
    expect(await save(portfolio('2026-07-31'))).toMatchObject({ month: '2026-08', action: 'state', state: 'IN_PROGRESS' });
    expect(await drain()).toEqual([]);

    // The pension statement arrives: complete -> checkpoint + job 10 min out.
    const done = await save(portfolio('2026-09-03'));
    expect(done).toMatchObject({ action: 'completed' });
    expect(done.result.snapshot).toBe('created');
    expect(done.result.scheduled).toMatchObject({ version: 1, debounced: false });
    const snapshots = await store.listMonthlySnapshots(userId);
    expect(snapshots.map((s) => [s.month, s.totalValueILS])).toEqual([['2026-08', 3000 + 100000 + 5000]]);

    expect(await drain()).toEqual([]); // not due yet
    advance(11);
    const results = await drain();
    expect(results).toEqual([expect.objectContaining({ name: 'report.render', status: 'done' })]);
    expect(renderer.render).toHaveBeenCalledTimes(1);
    expect(renderer.render.mock.calls[0][0]).toContain('דוח חודשי - אוגוסט 2026');

    const [report] = await features.listReports(userId);
    expect(report).toMatchObject({ month: '2026-08', version: 1, status: 'ready', storageKey: `reports/${userId}/2026-08/v1.pdf`, reused: false });
    expect(storage.files.get(report.storageKey).toString()).toMatch(/^%PDF/);
    const alerts = await features.listAlerts(userId);
    expect(alerts[0]).toMatchObject({ type: 'REPORT_READY', title: 'הדוח החודשי לאוגוסט 2026 מוכן' });
    expect(notifier.reportReady).not.toHaveBeenCalled(); // e-mail is opt-in
  });

  test('a correction inside the 10-minute window only pushes the job back', async () => {
    await save(portfolio('2026-09-03'));
    advance(8);
    const r = await save(portfolio('2026-09-03', 100500));
    expect(r).toMatchObject({ action: 'rescheduled', result: { version: 1, debounced: true } });
    advance(5); // 13 min after completion, 5 after the correction
    expect(await drain()).toEqual([]);
    advance(6);
    expect(await drain()).toHaveLength(1);
    expect((await features.listReports(userId)).map((x) => x.version)).toEqual([1]);
    // The correction reached the checkpoint the report reads.
    const [snap] = await store.listMonthlySnapshots(userId);
    expect(snap.breakdown.pension[0].value).toBe(100500);
  });

  test('a correction after the report was rendered produces a new version; no change produces none', async () => {
    await save(portfolio('2026-09-03'));
    advance(11);
    await drain();
    expect(await save(portfolio('2026-09-03'))).toMatchObject({ action: 'none' });
    const r = await save(portfolio('2026-09-04', 101000));
    expect(r).toMatchObject({ action: 'rescheduled', result: { version: 2, debounced: false } });
    advance(11);
    await drain();
    expect((await features.listReports(userId)).map((x) => [x.version, x.status])).toEqual([[2, 'ready'], [1, 'ready']]);
    expect(renderer.render).toHaveBeenCalledTimes(2);
  });

  test('"Finished monthly update" completes a month that is not fully updated; identical content reuses the file', async () => {
    await save(portfolio('2026-07-31'));
    const status = await service.getStatus(userId, '2026-08');
    expect(status).toMatchObject({ state: 'IN_PROGRESS', requiredCount: 2, updatedCount: 1 });

    const done = await service.completeMonth(userId, '2026-08', { by: 'user' });
    expect(done.scheduled.version).toBe(1);
    advance(11);
    await drain();
    await service.regenerate(userId, '2026-08');
    advance(11);
    await drain();
    const reports = await features.listReports(userId);
    expect(reports.map((x) => [x.version, x.reused])).toEqual([[2, true], [1, false]]);
    expect(reports[0].storageKey).toBe(reports[1].storageKey);
    expect(renderer.render).toHaveBeenCalledTimes(1);
    expect((await service.getStatus(userId, '2026-08')).completedBy).toBe('user');
  });

  test('a transaction recorded after the report produces a new version', async () => {
    await save(portfolio('2026-09-03'));
    advance(11);
    await drain();
    const div = { id: 'd1', type: 'DIVIDEND', date: '2026-08-20', assetClass: 'israeli', assetId: '604611', amount: 50, taxWithheld: 12.5, currency: 'ILS', fxRate: 1 };
    await store.applyLedgerChange(userId, ({ portfolio: p }) => ({ portfolio: p, insert: div }));
    expect(await service.onPortfolioSaved(userId, { months: ['2026-08'] })).toMatchObject({ action: 'rescheduled', result: { version: 2 } });
    advance(11);
    await drain();
    expect((await features.listReports(userId)).map((x) => x.version)).toEqual([2, 1]);
    expect(renderer.render.mock.calls[1][0]).toContain('₪38');
  });

  test('a transaction for last month refreshes last month\'s completed report', async () => {
    await save(portfolio('2026-09-03'));
    advance(11);
    await drain(); // August v1
    clock = new Date('2026-09-15T08:00:00Z'); // now syncing September
    const div = { id: 'd1', type: 'DIVIDEND', date: '2026-08-20', assetClass: 'israeli', assetId: '604611', amount: 50, taxWithheld: 12.5, currency: 'ILS', fxRate: 1 };
    await store.applyLedgerChange(userId, ({ portfolio: p }) => ({ portfolio: p, insert: div }));
    const r = await service.onPortfolioSaved(userId, { months: ['2026-08'] });
    expect(r.month).toBe('2026-09');
    expect(r.others).toEqual([expect.objectContaining({ month: '2026-08', action: 'rescheduled', result: expect.objectContaining({ version: 2 }) })]);
    advance(11);
    await drain();
    const august = (await features.listReports(userId)).filter((x) => x.month === '2026-08');
    expect(august.map((x) => [x.version, x.status])).toEqual([[2, 'ready'], [1, 'ready']]);
  });

  test('months that are not complete are never auto-completed by a later change', async () => {
    const r = await service.onPortfolioSaved(userId, { months: ['2026-06'] });
    expect(r.others).toBeUndefined();
    expect(await features.getSyncStatus(userId, '2026-06')).toBeNull();
  });

  test('unrecorded US dividends appear in the report as estimates', async () => {
    service = createReportService({
      store,
      features,
      storage,
      renderer,
      notifier,
      now: () => clock,
      getUsdRate: async () => 3.7,
      getDividendHistory: async () => [{ date: '2026-08-12', amountPerShare: 0.25 }],
      logger: { error() {} }
    });
    runner = createJobRunner({ features, handlers: createJobHandlers({ store, features, marketData, reports: service }), logger: { error() {} } });
    const p = portfolio('2026-09-03');
    p.americanStocks = [{ id: 9, stockName: 'KO', quantity: 100, currentPrice: 60, exchangeRate: 3.6, purchaseDate: '2025-01-01', purchasePrice: 50 }];
    await save(p);
    advance(11);
    await drain();
    const html = renderer.render.mock.calls[0][0];
    expect(html).toContain('דיבידנדים משוערים (לא נרשמו בעסקאות)');
    expect(html).toContain('25.00 USD');
  });

  test('excluding an account lets the rest complete the month', async () => {
    await save(portfolio('2026-07-31'));
    const status = await service.setExcluded(userId, '2026-08', ['pension:5']);
    expect(status.accounts.find((a) => a.key === 'pension:5').excluded).toBe(true);
    expect(await save(portfolio('2026-07-31', 100001))).toMatchObject({ action: 'completed' });
  });

  test('a failed render marks the report failed and the job retries', async () => {
    renderer.render.mockRejectedValueOnce(new Error('chrome crashed'));
    await save(portfolio('2026-09-03'));
    advance(11);
    const [first] = await drain();
    expect(first).toMatchObject({ status: 'retry', error: 'chrome crashed' });
    expect((await features.listReports(userId))[0]).toMatchObject({ status: 'failed', error: 'chrome crashed' });
    advance(3); // backoff 2^1 minutes
    const [second] = await drain();
    expect(second.status).toBe('done');
    expect((await features.listReports(userId))[0].status).toBe('ready');
  });

  test('e-mail when the user opted in', async () => {
    await features.setPreferences(userId, 'reports', { emailOnReady: true });
    await save(portfolio('2026-09-03'));
    advance(11);
    await drain();
    expect(notifier.reportReady).toHaveBeenCalledWith(expect.objectContaining({ to: 'r@x.com', month: '2026-08', version: 1, link: null }));
  });

  test('download is only for the owner and only when ready', async () => {
    await save(portfolio('2026-09-03'));
    advance(11);
    await drain();
    const [report] = await features.listReports(userId);
    expect((await service.downloadTarget(userId, report.id)).target.type).toBe('buffer');
    const { id: other } = await store.insertUser('o@x.com', 'h');
    expect(await service.downloadTarget(other, report.id)).toBeNull();
  });
});

test('breakdownFromPortfolio mirrors the tracker breakdown shape', () => {
  const b = breakdownFromPortfolio(
    {
      israeliStocks: [{ stockName: '1', officialName: 'X', quantity: 2, currentPrice: 10 }, { stockName: '1', quantity: 1, currentPrice: 10 }],
      americanStocks: [{ stockName: 'A', quantity: 1, currentPrice: 10, exchangeRate: 3, currentExchangeRate: 4 }],
      bankBalances: [{ amount: 5 }, { amount: 6 }],
      bankSavingsFunds: [{ id: 1, fundName: 'S', interestRate: 0, deposits: [{ date: '2020-01-01', amount: 100 }] }]
    },
    new Date('2026-01-01T00:00:00Z')
  );
  expect(b.israeli).toEqual([{ key: '1', label: 'X (1)', value: 30 }]);
  expect(b.american).toEqual([{ key: 'A', label: 'A', value: 40 }]);
  expect(b.bank.map((x) => x.key)).toEqual(['bank-1', 'bank-2']);
  expect(b.bankSavings[0].value).toBe(100);
});

test('the e-mail notifier is off without configuration and sends a link, never the PDF', async () => {
  expect(createEmailNotifier({}).enabled).toBe(false);
  const post = jest.fn(async () => ({}));
  const n = createEmailNotifier({ RESEND_API_KEY: 'k', REPORT_EMAIL_FROM: 'a@b.c', APP_URL: 'https://app.example/' }, { post });
  await n.reportReady({ to: 'u@x.com', monthLabel: 'אוגוסט 2026', version: 2, link: null });
  const [url, body, config] = post.mock.calls[0];
  expect(url).toBe('https://api.resend.com/emails');
  expect(body).toMatchObject({ from: 'a@b.c', to: 'u@x.com' });
  expect(body.html).toContain('https://app.example/reports');
  expect(body.attachments).toBeUndefined();
  expect(config.headers.Authorization).toBe('Bearer k');
});
