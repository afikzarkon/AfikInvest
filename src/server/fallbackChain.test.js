/**
 * @jest-environment node
 */
jest.mock('./sourceHealth', () => ({ sourceHealth: { success: jest.fn(), failure: jest.fn() } }));
const { sourceHealth } = require('./sourceHealth');
const { runFallbackChain } = require('./fallbackChain');

const quiet = () => ({ warn: jest.fn() });

describe('runFallbackChain', () => {
  beforeEach(() => {
    sourceHealth.success.mockReset();
    sourceHealth.failure.mockReset();
  });

  test('returns the first answer and stays silent when it came from the first source', async () => {
    const logger = quiet();
    const second = jest.fn();
    const result = await runFallbackChain(
      'x',
      [
        { source: 'a', fn: async () => 1 },
        { source: 'b', fn: second }
      ],
      { logger }
    );
    expect(result).toEqual({ value: 1, source: 'a' });
    expect(second).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
    expect(sourceHealth.success).toHaveBeenCalledWith('a');
  });

  test('falls through a failure, records it, and says which fallback answered and why', async () => {
    const logger = quiet();
    const result = await runFallbackChain(
      'sector NVDA',
      [
        { source: 'yahoo', fn: async () => { throw Object.assign(new Error('x'), { response: { status: 429 } }); } },
        { source: 'finnhub', fn: async () => 'Technology' }
      ],
      { logger }
    );
    expect(result).toEqual({ value: 'Technology', source: 'finnhub' });
    expect(sourceHealth.failure).toHaveBeenCalledWith('yahoo', expect.anything());
    expect(logger.warn.mock.calls[0][0]).toBe('[market-data] sector NVDA: using fallback finnhub (yahoo: HTTP 429)');
  });

  test('a source without a key is skipped, not counted as failing', async () => {
    const fn = jest.fn();
    const result = await runFallbackChain('x', [
      { source: 'tiingo', enabled: false, fn },
      { source: 'yahoo', fn: async () => 'ok' }
    ], { logger: quiet() });
    expect(fn).not.toHaveBeenCalled();
    expect(result.source).toBe('yahoo');
    expect(sourceHealth.failure).not.toHaveBeenCalled();
  });

  // A spent free-plan budget made no request - it says nothing about health.
  test('a budget refusal moves on without counting as a failure', async () => {
    await runFallbackChain('x', [
      { source: 'finnhub', fn: async () => { throw Object.assign(new Error('budget'), { code: 'FINNHUB_BUDGET' }); } },
      { source: 'yahoo', fn: async () => 'ok' }
    ], { logger: quiet() });
    expect(sourceHealth.failure).not.toHaveBeenCalled();
  });

  test('an answer the caller cannot use moves on to the next source', async () => {
    const result = await runFallbackChain(
      'x',
      [
        { source: 'yahoo', fn: async () => [] },
        { source: 'tiingo', fn: async () => [1] }
      ],
      { logger: quiet(), accept: (rows) => rows.length > 0 }
    );
    expect(result).toEqual({ value: [1], source: 'tiingo' });
  });

  test('when every source fails, the error names each reason', async () => {
    await expect(
      runFallbackChain('x', [
        { source: 'a', fn: async () => { throw new Error('down'); } },
        { source: 'b', enabled: false, fn: jest.fn() }
      ], { logger: quiet() })
    ).rejects.toMatchObject({ message: 'x: every source failed (a: down)', failures: ['a: down'] });
  });
});
