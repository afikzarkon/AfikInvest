/**
 * @jest-environment node
 */
const { initFeatureStore } = require('./featureStore');
const { runAnomalyScan, runCalendarRefresh, buildUserCalendar, normalizeAlertSettings } = require('./alertEngine');
const { STORE_FACTORIES } = require('./testUtils/stores');

function calmBars(lastDate, last) {
  const bars = [];
  let p = 100;
  const end = Date.parse(`${lastDate}T00:00:00Z`);
  for (let i = 40; i >= 1; i -= 1) {
    p *= 1 + (i % 2 ? 0.004 : -0.003);
    bars.push({ date: new Date(end - i * 86400000).toISOString().slice(0, 10), close: p, volume: 1000000 });
  }
  bars.push(Object.assign({ date: lastDate }, last(p)));
  return bars;
}

function fakeMarketData(barsBySymbol, extra = {}) {
  return Object.assign(
    {
      async getBars(market, symbol) {
        const b = barsBySymbol[`${market}:${symbol}`];
        if (b instanceof Error) throw b;
        return b || [];
      },
      supportsCalendar: (market) => market === 'US',
      async getCalendar() {
        return null;
      },
      async getDividendHistory() {
        return [];
      }
    },
    extra
  );
}

describe.each(STORE_FACTORIES)('alert engine (%s)', (_name, makeStore) => {
  let store;
  let features;
  let alice;
  let bob;

  beforeEach(async () => {
    store = await makeStore();
    features = await initFeatureStore(store);
    alice = (await store.insertUser('alice@x.com', 'h')).id;
    bob = (await store.insertUser('bob@x.com', 'h')).id;
    // Alice: NVDA is ~half of her portfolio. Bob: a tiny NVDA position.
    await store.upsertPortfolio(alice, JSON.stringify({
      americanStocks: [{ id: 1, stockName: 'nvda', quantity: 10, currentPrice: 100, exchangeRate: 3.6, currentExchangeRate: 3.7, purchaseDate: '2025-01-01', purchasePrice: 50 }],
      israeliStocks: [{ id: 2, stockName: '604611', officialName: 'לאומי', quantity: 100, currentPrice: 30, purchaseDate: '2025-01-01', purchasePrice: 20 }],
      bankBalances: [{ id: 3, amount: 700 }]
    }));
    await store.upsertPortfolio(bob, JSON.stringify({
      americanStocks: [{ id: 1, stockName: 'NVDA', quantity: 1, currentPrice: 100, exchangeRate: 3.6, purchaseDate: '2025-01-01', purchasePrice: 50 }],
      bankBalances: [{ id: 3, amount: 100000 }]
    }));
  });
  afterEach(async () => {
    await store.close();
  });

  const now = new Date('2026-02-16T22:00:00Z');
  const shock = () => fakeMarketData({
    'US:NVDA': calmBars('2026-02-16', (p) => ({ close: p * 0.92, volume: 3000000 })),
    'TASE:604611': calmBars('2026-02-16', (p) => ({ close: p * 1.001, volume: 1000000 }))
  });

  test('one security is fetched once and alerts each holder with their own weighting', async () => {
    const md = shock();
    const spy = jest.spyOn(md, 'getBars');
    const summary = await runAnomalyScan({ store, features, marketData: md, now });
    expect(spy).toHaveBeenCalledTimes(2); // NVDA + 604611, not once per holder
    expect(summary).toMatchObject({ securities: 2, scanned: 2, alertsCreated: 2 });

    const [a] = await features.listAlerts(alice);
    expect(a).toMatchObject({ type: 'COMBINED_ANOMALY', severity: 'critical', instrument: { symbol: 'NVDA', market: 'US' }, sessionDate: '2026-02-16' });
    expect(a.position.weightPct).toBeGreaterThan(40);
    expect(a.position.dayPnlILS).toBeLessThan(0);
    const [b] = await features.listAlerts(bob);
    // Same signals, but 0.4% of Bob's portfolio: one step lower.
    expect(b.severity).toBe('warning');
    expect(b.recommendation.action).toBe('NO_ACTION');
  });

  test('the same session is never alerted twice; a new session within 24h is held back', async () => {
    await runAnomalyScan({ store, features, marketData: shock(), now });
    const rerun = await runAnomalyScan({ store, features, marketData: shock(), now: new Date('2026-02-16T23:00:00Z') });
    expect(rerun.alertsCreated).toBe(0);
    // Next session, same size of move, 20h later -> cooldown holds it.
    const next = fakeMarketData({ 'US:NVDA': calmBars('2026-02-17', (p) => ({ close: p * 0.92, volume: 3000000 })) });
    const r2 = await runAnomalyScan({ store, features, marketData: next, now: new Date('2026-02-17T18:00:00Z') });
    expect(r2.alertsCreated).toBe(0);
    // ...but after 24h it is news again.
    const r3 = await runAnomalyScan({ store, features, marketData: next, now: new Date('2026-02-17T23:00:00Z') });
    expect(r3.alertsCreated).toBe(2);
  });

  test('user thresholds and the on/off switch apply', async () => {
    await features.upsertAlertSettings(bob, normalizeAlertSettings({ enabled: false }));
    await features.upsertAlertSettings(alice, normalizeAlertSettings({ pctMove: 20, zWarn: 5, zCritical: 9, volWarn: 5, volCritical: 9 }));
    const s = await runAnomalyScan({ store, features, marketData: shock(), now });
    expect(s.alertsCreated).toBe(1); // alice: z of the -8% day is still far beyond 9 sigma of a calm series
    expect(await features.listAlerts(bob)).toEqual([]);
  });

  test('stale data and fetch failures are skipped and reported', async () => {
    const md = fakeMarketData({ 'US:NVDA': calmBars('2026-02-01', (p) => ({ close: p * 0.8, volume: 1 })), 'TASE:604611': new Error('down') });
    const s = await runAnomalyScan({ store, features, marketData: md, now });
    expect(s).toMatchObject({ scanned: 0, alertsCreated: 0, stale: ['NVDA'], failures: [{ symbol: '604611', market: 'TASE', error: 'down' }] });
  });

  test('calendar refresh stores events for held US securities and sends reminders', async () => {
    const epoch = (d) => Date.parse(`${d}T00:00:00Z`) / 1000;
    const md = fakeMarketData({}, {
      async getCalendar() {
        return { calendarEvents: { earnings: { earningsDate: [epoch('2026-02-23')] }, exDividendDate: epoch('2026-02-18'), dividendDate: epoch('2026-03-05') } };
      },
      async getDividendHistory() {
        return [
          { date: '2025-05-20', amountPerShare: 0.01 },
          { date: '2025-08-19', amountPerShare: 0.01 },
          { date: '2025-11-18', amountPerShare: 0.01 }
        ];
      }
    });
    const s = await runCalendarRefresh({ store, features, marketData: md, now });
    expect(s).toMatchObject({ refreshed: 1, unsupported: ['TASE:604611'] });
    // Earnings 2026-02-23 is T-7, ex-div 2026-02-18 is T-2 -> two reminders each for alice and bob.
    expect(s.remindersCreated).toBe(4);
    const titles = (await features.listAlerts(alice)).map((a) => a.title).sort();
    expect(titles).toEqual(['NVDA: דוחות רבעוניים בעוד 7 ימים', 'NVDA: יום אקס דיבידנד בעוד 2 ימים']);

    const cal = await buildUserCalendar({ store, features, userId: alice, from: '2026-02-01', to: '2026-12-31' });
    const ex = cal.find((e) => e.eventType === 'EX_DIVIDEND' && e.status === 'confirmed');
    expect(ex).toMatchObject({ eventDate: '2026-02-18', units: 10, expectedGross: 0.1 });
    expect(ex.expectedGrossILS).toBeCloseTo(0.37, 6);
    expect(cal.some((e) => e.status === 'projected')).toBe(true);

    // Idempotent: a second run on the same day creates no duplicate reminders.
    expect((await runCalendarRefresh({ store, features, marketData: md, now })).remindersCreated).toBe(0);
  });
});

test('normalizeAlertSettings validates ranges and ordering', () => {
  expect(normalizeAlertSettings({ pctMove: 3, junk: 1 })).toMatchObject({ pctMove: 3, enabled: true });
  expect(normalizeAlertSettings({ pctMove: 3 }).junk).toBeUndefined();
  expect(() => normalizeAlertSettings({ pctMove: 0 })).toThrow(/pctMove/);
  expect(() => normalizeAlertSettings({ zWarn: 3, zCritical: 2 })).toThrow(/zCritical/);
});
