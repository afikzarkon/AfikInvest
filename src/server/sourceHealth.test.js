/**
 * @jest-environment node
 */
const { createSourceHealth, FAILURE_ALERT_THRESHOLD } = require('./sourceHealth');

const quietLogger = () => ({ error: jest.fn(), warn: jest.fn() });

describe('sourceHealth', () => {
  test('lists every known source, as unknown until it has been used', () => {
    const health = createSourceHealth({ logger: quietLogger() });
    const rows = health.snapshot();
    expect(rows.map((r) => r.name)).toEqual(expect.arrayContaining(['yahoo-chart', 'yahoo-summary', 'tase-api', 'cbs']));
    rows.forEach((r) => expect(r.status).toBe('unknown'));
  });

  test('a failure after successes is degraded, and a success clears it', () => {
    const health = createSourceHealth({ logger: quietLogger() });
    health.success('tase-api');
    health.failure('tase-api', { message: 'timeout', response: { status: 503 } });
    let row = health.snapshot().find((r) => r.name === 'tase-api');
    expect(row.status).toBe('degraded');
    expect(row.lastError).toBe('HTTP 503: timeout');

    health.success('tase-api');
    row = health.snapshot().find((r) => r.name === 'tase-api');
    expect(row.status).toBe('ok');
    expect(row.consecutiveFailures).toBe(0);
    expect(row.successes).toBe(2);
    expect(row.failures).toBe(1);
  });

  // The admin alert: one error line when an outage begins, one warning when
  // it ends - not one per failed request.
  test('reports once when a source crosses the threshold, and once when it recovers', () => {
    const logger = quietLogger();
    const health = createSourceHealth({ logger });
    for (let i = 0; i < FAILURE_ALERT_THRESHOLD + 3; i += 1) health.failure('yahoo-summary', new Error('Request failed with status code 429'));

    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error.mock.calls[0][0]).toContain('yahoo-summary is failing');
    expect(health.snapshot().find((r) => r.name === 'yahoo-summary').status).toBe('down');

    health.success('yahoo-summary');
    expect(logger.warn).toHaveBeenCalledWith('[source-health] yahoo-summary recovered');
  });

  test('track records the outcome and passes the result or error through', async () => {
    const health = createSourceHealth({ logger: quietLogger() });
    await expect(health.track('cbs', async () => 42)).resolves.toBe(42);
    await expect(health.track('cbs', async () => { throw new Error('down'); })).rejects.toThrow('down');
    const row = health.snapshot().find((r) => r.name === 'cbs');
    expect(row.successes).toBe(1);
    expect(row.failures).toBe(1);
  });

  test('extra fields are merged into a source row', () => {
    const health = createSourceHealth({ logger: quietLogger() });
    const row = health.snapshot({ 'yahoo-summary': { cooldownUntil: '2026-10-19T10:00:00.000Z' } }).find((r) => r.name === 'yahoo-summary');
    expect(row.cooldownUntil).toBe('2026-10-19T10:00:00.000Z');
  });
});
