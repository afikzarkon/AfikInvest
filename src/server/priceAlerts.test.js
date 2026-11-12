/**
 * @jest-environment node
 */
const fs = require('fs');
const path = require('path');
const { initFeatureStore } = require('./featureStore');
const { marketSessionState, runPriceAlertCheck, createPriceAlertJobHandlers, prevCloseFrom } = require('./priceAlerts');
const { tradeDateFromYahooMeta } = require('./marketCalendar');
const { STORE_FACTORIES } = require('./testUtils/stores');

// Recorded Yahoo chart responses from day-trader-skill's trader-alerts tests.
function yahooFixtureQuote(symbol) {
  const doc = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'price-alerts', `yahoo-${symbol}.json`), 'utf8'));
  const result = doc.chart.result;
  if (!result || !result.length) return { price: null };
  const meta = result[0].meta;
  return { price: meta.regularMarketPrice, prevClose: meta.previousClose || meta.chartPreviousClose, tradeDate: tradeDateFromYahooMeta(meta) };
}

// TSLA's quote is from Monday 2026-10-19 10:52 New York.
const MON_OPEN = new Date('2026-10-19T14:53:00Z');

function fakeQuotes(map) {
  const calls = [];
  return {
    calls,
    async getQuote(market, symbol) {
      calls.push(`${market}:${symbol}`);
      const q = map[`${market}:${symbol}`];
      if (q instanceof Error) throw q;
      return q === undefined ? { price: null } : q;
    }
  };
}

describe('marketSessionState', () => {
  test('NYSE regular session, early close, holiday, weekend, grace', () => {
    expect(marketSessionState('US', MON_OPEN)).toMatchObject({ date: '2026-10-19', open: true });
    expect(marketSessionState('US', new Date('2026-10-19T13:00:00Z'))).toMatchObject({ open: false, reason: 'before the open' });
    expect(marketSessionState('US', new Date('2026-10-19T20:10:00Z'))).toMatchObject({ open: false, inGrace: true });
    expect(marketSessionState('US', new Date('2026-10-19T20:30:00Z'))).toMatchObject({ open: false, inGrace: false });
    expect(marketSessionState('US', new Date('2026-11-26T16:00:00Z'))).toMatchObject({ open: false, reason: 'closed today' });
    // Day after Thanksgiving closes at 13:00 New York (18:00 UTC in EST).
    expect(marketSessionState('US', new Date('2026-11-27T17:50:00Z')).open).toBe(true);
    expect(marketSessionState('US', new Date('2026-11-27T18:05:00Z')).open).toBe(false);
    expect(marketSessionState('US', new Date('2026-10-17T15:00:00Z')).open).toBe(false); // Saturday
  });

  test('TASE Monday-Friday week since 2026, earlier on Friday', () => {
    expect(marketSessionState('TASE', new Date('2026-10-19T09:00:00Z'))).toMatchObject({ date: '2026-10-19', open: true });
    expect(marketSessionState('TASE', new Date('2026-10-18T09:00:00Z')).open).toBe(false); // Sunday
    expect(marketSessionState('TASE', new Date('2026-10-23T09:00:00Z')).open).toBe(true); // Friday morning
    expect(marketSessionState('TASE', new Date('2026-10-23T12:00:00Z')).open).toBe(false); // Friday 15:00 Israel
    expect(marketSessionState('TASE', new Date('2025-10-19T09:00:00Z')).open).toBe(true); // a Sunday under the old week
  });

  test('previous close from a price and its percent change', () => {
    expect(prevCloseFrom(110, 10)).toBeCloseTo(100);
    expect(prevCloseFrom(110, null)).toBeNull();
  });
});

describe.each(STORE_FACTORIES)('price alerts store + job (%s)', (_name, makeStore) => {
  let store;
  let features;
  let alice;
  let bob;

  beforeEach(async () => {
    store = await makeStore();
    features = await initFeatureStore(store);
    ({ id: alice } = await store.insertUser('alice@example.com', 'x'));
    ({ id: bob } = await store.insertUser('bob@example.com', 'x'));
  });
  afterEach(async () => {
    await store.close();
  });

  const create = (userId, fields) =>
    features.createPriceAlert(Object.assign({ userId, market: 'US', currency: 'USD', note: '' }, fields));

  test('store: create, list per user, update, re-arm, delete', async () => {
    const r = await create(alice, { symbol: 'TSLA', name: 'Tesla', ruleType: 'above', value: 370.04, note: 'target', lastPrice: 366.475 });
    expect(r).toMatchObject({ userId: alice, symbol: 'TSLA', ruleType: 'above', value: 370.04, status: 'active', note: 'target', lastPrice: 366.475, triggeredAt: null });
    await create(bob, { symbol: 'KO', ruleType: 'below', value: 80 });
    expect(await features.listPriceAlerts(alice)).toHaveLength(1);
    expect(await features.countPriceAlerts(bob)).toBe(1);
    expect(await features.getPriceAlert(bob, r.id)).toBeNull();

    const updated = await features.updatePriceAlert(alice, r.id, { value: 375, note: '' });
    expect(updated).toMatchObject({ value: 375, note: '', status: 'active' });
    expect(await features.updatePriceAlert(bob, r.id, { value: 1 })).toBeNull();

    expect(await features.markPriceAlertTriggered(r.id, { price: 376, at: '2026-10-19T15:00:00.000Z' })).toBe(true);
    expect(await features.markPriceAlertTriggered(r.id, { price: 377 })).toBe(false); // rings once
    expect(await features.getPriceAlert(alice, r.id)).toMatchObject({ status: 'triggered', triggeredPrice: 376, triggeredAt: '2026-10-19T15:00:00.000Z' });
    expect((await features.listActivePriceAlertsAll()).map((x) => x.symbol)).toEqual(['KO']);

    const rearmed = await features.updatePriceAlert(alice, r.id, { rearm: true, updatedAt: '2026-10-20T10:00:00.000Z' });
    expect(rearmed).toMatchObject({ status: 'active', triggeredAt: null, triggeredPrice: null, armedAt: '2026-10-20T10:00:00.000Z' });

    expect(await features.deletePriceAlert(bob, r.id)).toBe(false);
    expect(await features.deletePriceAlert(alice, r.id)).toBe(true);
    expect(await features.listPriceAlerts(alice)).toEqual([]);
  });

  test('job: one quote per symbol, rings once, alert in the list and the unread badge', async () => {
    const tslaAbove = await create(alice, { symbol: 'TSLA', ruleType: 'above', value: 370.04 });
    const tslaPct = await create(alice, { symbol: 'TSLA', name: 'Tesla', ruleType: 'pct_up', value: 3, note: 'מומנטום' });
    const tslaBob = await create(bob, { symbol: 'TSLA', ruleType: 'below', value: 380 });
    const tslaPctTooFar = await create(bob, { symbol: 'TSLA', ruleType: 'pct_up', value: 3.5 });
    const quotes = fakeQuotes({ 'US:TSLA': yahooFixtureQuote('TSLA') });

    const summary = await runPriceAlertCheck({ store, features, quotes, now: MON_OPEN });
    expect(quotes.calls).toEqual(['US:TSLA']);
    expect(summary).toMatchObject({ rules: 4, symbols: 1, checked: 1, triggered: 2, alertsCreated: 2, failures: [] });

    expect(await features.getPriceAlert(alice, tslaAbove.id)).toMatchObject({ status: 'active', lastPrice: 366.475 });
    expect(await features.getPriceAlert(alice, tslaPct.id)).toMatchObject({ status: 'triggered', triggeredPrice: 366.475, triggeredPrevClose: 354.72 });
    expect(await features.getPriceAlert(bob, tslaBob.id)).toMatchObject({ status: 'triggered' });
    expect(await features.getPriceAlert(bob, tslaPctTooFar.id)).toMatchObject({ status: 'active' });

    const aliceAlerts = await features.listAlerts(alice);
    expect(aliceAlerts).toHaveLength(1);
    expect(aliceAlerts[0]).toMatchObject({ type: 'PRICE_TARGET', severity: 'warning', priceAlertId: tslaPct.id, title: 'Tesla (TSLA) עלתה +3.31% מהסגירה הקודמת' });
    expect(await features.countUnreadAlerts(alice)).toBe(1);

    // Same price again: nothing rings twice.
    const again = await runPriceAlertCheck({ store, features, quotes, now: new Date(MON_OPEN.getTime() + 15 * 60000) });
    expect(again).toMatchObject({ triggered: 0, alertsCreated: 0 });
    expect(await features.listAlerts(alice)).toHaveLength(1);

    // The price crosses the level later: the above rule rings (and Bob's
    // 3.5% rule, now +4.59%).
    const later = fakeQuotes({ 'US:TSLA': { price: 371, prevClose: 354.72, tradeDate: '2026-10-19' } });
    expect((await runPriceAlertCheck({ features, quotes: later, now: new Date(MON_OPEN.getTime() + 30 * 60000) })).triggered).toBe(2);
    expect(await features.getPriceAlert(bob, tslaPctTooFar.id)).toMatchObject({ status: 'triggered' });
    expect(await features.listAlerts(alice)).toHaveLength(2);

    // Re-armed, it can ring again (a new dedup key).
    await features.updatePriceAlert(alice, tslaPct.id, { rearm: true, updatedAt: '2026-10-19T16:00:00.000Z' });
    expect((await runPriceAlertCheck({ features, quotes: later, now: new Date(MON_OPEN.getTime() + 75 * 60000) })).triggered).toBe(1);
    expect(await features.listAlerts(alice)).toHaveLength(3);
  });

  test('job: skips closed markets, stale sessions and failed quotes', async () => {
    await create(alice, { symbol: 'TSLA', ruleType: 'above', value: 1 });
    await create(alice, { symbol: 'ZZZZ', ruleType: 'above', value: 1 });
    await create(alice, { symbol: 'KO', ruleType: 'above', value: 1 });
    await create(alice, { market: 'TASE', currency: 'ILS', symbol: '629014', ruleType: 'above', value: 1 });
    const quotes = fakeQuotes({
      'US:TSLA': yahooFixtureQuote('TSLA'),
      'US:ZZZZ': yahooFixtureQuote('ZZZZ'),
      'US:KO': yahooFixtureQuote('KO'), // last traded 2026-10-13
      'TASE:629014': new Error('HTTP 503')
    });

    // Saturday: nothing fetched at all.
    const saturday = await runPriceAlertCheck({ features, quotes, now: new Date('2026-10-17T15:00:00Z') });
    expect(quotes.calls).toEqual([]);
    expect(saturday.skipped).toHaveLength(4);

    const monday = await runPriceAlertCheck({ features, quotes, now: MON_OPEN });
    expect(monday.checked).toBe(1);
    expect(monday.triggered).toBe(1);
    expect(monday.skipped).toEqual([{ key: 'US:KO', reason: 'no trade today (last 2026-10-13)' }]);
    expect(monday.failures.map((f) => f.key).sort()).toEqual(['TASE:629014', 'US:ZZZZ']);

    // force (manual run) ignores the clock and the session date.
    const forced = await runPriceAlertCheck({ features, quotes, now: new Date('2026-10-17T15:00:00Z'), force: true });
    expect(forced.triggered).toBe(1); // KO
  });

  test('job handler factory', async () => {
    await create(alice, { symbol: 'TSLA', ruleType: 'pct_up', value: 3 });
    const handlers = createPriceAlertJobHandlers({ store, features, quotes: fakeQuotes({ 'US:TSLA': yahooFixtureQuote('TSLA') }), now: () => MON_OPEN, pauseMs: 0 });
    expect(Object.keys(handlers)).toEqual(['price-alerts.check']);
    expect(await handlers['price-alerts.check']({})).toMatchObject({ triggered: 1 });
  });
});

describe('unknownSymbolError', () => {
  const { unknownSymbolError } = require('./priceAlerts');
  const chainError = (failures) => Object.assign(new Error('quote: every source failed'), { failures });
  test('every source saying 404 / no data means the symbol does not exist', () => {
    expect(unknownSymbolError(chainError(['yahoo-chart: HTTP 404']))).toBe(true);
    expect(unknownSymbolError(chainError(['finnhub: no usable data', 'yahoo-chart: HTTP 404']))).toBe(true);
  });
  test('an outage is not an unknown symbol', () => {
    expect(unknownSymbolError(chainError(['yahoo-chart: HTTP 429']))).toBe(false);
    expect(unknownSymbolError(chainError(['finnhub: no usable data', 'yahoo-chart: HTTP 503']))).toBe(false);
    expect(unknownSymbolError(new Error('timeout'))).toBe(false);
    expect(unknownSymbolError(chainError([]))).toBe(false);
  });
});
