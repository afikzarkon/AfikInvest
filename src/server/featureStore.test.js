/**
 * @jest-environment node
 */
const { initFeatureStore } = require('./featureStore');
const { STORE_FACTORIES } = require('./testUtils/stores');

describe.each(STORE_FACTORIES)('featureStore (%s)', (_name, makeStore) => {
  let store;
  let features;
  let userId;

  beforeEach(async () => {
    store = await makeStore();
    features = await initFeatureStore(store);
    ({ id: userId } = await store.insertUser('f@x.com', 'h'));
  });
  afterEach(async () => {
    await store.close();
  });

  const alert = (overrides = {}) =>
    Object.assign(
      {
        userId,
        type: 'PRICE_ANOMALY',
        severity: 'warning',
        sessionDate: '2026-02-15',
        instrument: { symbol: 'AAPL', market: 'US' },
        title: 't',
        message: 'm',
        dedupKey: `${userId}:AAPL:PRICE_ANOMALY:2026-02-15`,
        createdAt: '2026-02-15T21:00:00.000Z'
      },
      overrides
    );

  test('alerts: insert, dedup, list, unread count, mark read', async () => {
    expect(await features.insertAlert(alert())).toBe(true);
    expect(await features.insertAlert(alert())).toBe(false); // same dedup key
    expect(await features.insertAlert(alert({ dedupKey: 'other', createdAt: '2026-02-16T21:00:00.000Z' }))).toBe(true);
    const list = await features.listAlerts(userId);
    expect(list.map((a) => a.dedupKey)).toEqual(['other', `${userId}:AAPL:PRICE_ANOMALY:2026-02-15`]);
    expect(list[1]).toMatchObject({ type: 'PRICE_ANOMALY', severity: 'warning', title: 't', instrument: { symbol: 'AAPL' }, readAt: null });
    expect(await features.countUnreadAlerts(userId)).toBe(2);
    expect(await features.markAlertRead(userId, list[0].id)).toBe(true);
    expect(await features.countUnreadAlerts(userId)).toBe(1);
    expect(await features.markAllAlertsRead(userId)).toBe(1);
    expect(await features.listAlerts(userId, { unreadOnly: true })).toEqual([]);
    expect((await features.recentAlerts(userId, 'AAPL', '2026-02-16T00:00:00.000Z')).length).toBe(1);
  });

  test('market events: upsert and replace future', async () => {
    const ev = (date, status = 'projected') => ({ symbol: 'KO', market: 'US', eventType: 'EX_DIVIDEND', eventDate: date, amountPerShare: 0.5, currency: 'USD', status, confidence: 0.9, source: 'projection' });
    await features.upsertMarketEvents([ev('2026-01-10'), ev('2026-05-10')]);
    await features.replaceFutureMarketEvents('KO', 'US', '2026-03-01', [ev('2026-05-12', 'confirmed')]);
    const events = await features.listMarketEvents([{ symbol: 'KO', market: 'US' }], '2026-01-01', '2026-12-31');
    expect(events.map((e) => [e.eventDate, e.status])).toEqual([
      ['2026-01-10', 'projected'],
      ['2026-05-12', 'confirmed']
    ]);
    expect(events[1]).toMatchObject({ amountPerShare: 0.5, confidence: 0.9 });
    expect(await features.listMarketEvents([{ symbol: 'PEP', market: 'US' }], '2026-01-01', '2026-12-31')).toEqual([]);
  });

  test('alert settings round-trip', async () => {
    expect(await features.getAlertSettings(userId)).toBeNull();
    await features.upsertAlertSettings(userId, { pctMove: 4 });
    await features.upsertAlertSettings(userId, { pctMove: 6 });
    expect(await features.getAlertSettings(userId)).toEqual({ pctMove: 6 });
  });

  test('jobs: idempotent enqueue, claim order, backoff, failure', async () => {
    const a = await features.enqueueJob('x', { n: 1 }, { idempotencyKey: 'k1', runAfter: '2026-01-01T00:00:00.000Z', maxAttempts: 2 });
    const again = await features.enqueueJob('x', { n: 2 }, { idempotencyKey: 'k1' });
    expect(again.id).toBe(a.id);
    await features.enqueueJob('y', {}, { runAfter: '2030-01-01T00:00:00.000Z' });

    const claimed = await features.claimNextJob(null, '2026-06-01T00:00:00.000Z');
    expect(claimed).toMatchObject({ id: a.id, status: 'running', attempts: 1, payload: { n: 1 } });
    expect(await features.claimNextJob(null, '2026-06-01T00:00:00.000Z')).toBeNull(); // y not due, x running

    expect(await features.failJob(claimed, new Error('boom'), new Date('2026-06-01T00:00:00Z'))).toBe('retry');
    const retried = await features.getJob(a.id);
    expect(retried).toMatchObject({ status: 'queued', lastError: 'boom', runAfter: '2026-06-01T00:02:00.000Z' });

    const second = await features.claimNextJob(['x'], '2026-06-01T00:05:00.000Z');
    expect(second.attempts).toBe(2);
    expect(await features.failJob(second, new Error('boom2'))).toBe('failed');
    expect((await features.getJob(a.id)).status).toBe('failed');

    const z = await features.enqueueJob('z', {}, { runAfter: '2026-01-01T00:00:00.000Z' });
    expect(await features.rescheduleJob(z.id, '2026-02-01T00:00:00.000Z')).toBe(true);
    expect(await features.cancelJob(z.id)).toBe(true);
    expect(await features.claimNextJob(['z'], '2027-01-01T00:00:00.000Z')).toBeNull();
    const done = await features.enqueueJob('w', {}, { runAfter: '2026-01-01T00:00:00.000Z' });
    await features.claimNextJob(['w'], '2026-06-01T00:00:00.000Z');
    await features.completeJob(done.id, { ok: 1 });
    expect(await features.getJob(done.id)).toMatchObject({ status: 'done', result: { ok: 1 } });
  });
});
