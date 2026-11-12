/**
 * @jest-environment node
 */
const {
  validatePriceAlertInput,
  evaluatePriceAlert,
  buildPriceAlert,
  describeRule,
  movePct
} = require('./priceAlertRules');

describe('validatePriceAlertInput', () => {
  test('accepts and normalizes a US level rule', () => {
    expect(validatePriceAlertInput({ market: 'us', symbol: ' tsla ', ruleType: 'above', value: '370.04', note: ' target ' })).toEqual({
      market: 'US',
      symbol: 'TSLA',
      ruleType: 'above',
      value: 370.04,
      note: 'target',
      name: '',
      currency: 'USD'
    });
  });

  test('accepts a TASE security id with a percent rule', () => {
    const r = validatePriceAlertInput({ market: 'TASE', symbol: '629014', ruleType: 'pct_down', value: 3, name: 'טבע' });
    expect(r).toMatchObject({ market: 'TASE', symbol: '629014', ruleType: 'pct_down', value: 3, name: 'טבע', currency: 'ILS' });
  });

  test.each([
    [{ market: 'LSE', symbol: 'X', ruleType: 'above', value: 1 }, /שוק/],
    [{ market: 'US', symbol: '', ruleType: 'above', value: 1 }, /סימול/],
    [{ market: 'US', symbol: 'AA PL', ruleType: 'above', value: 1 }, /סימול לא תקין/],
    [{ market: 'TASE', symbol: 'TEVA', ruleType: 'above', value: 1 }, /מספר נייר ערך/],
    [{ market: 'US', symbol: 'KO', ruleType: 'cross', value: 1 }, /סוג התראה/],
    [{ market: 'US', symbol: 'KO', ruleType: 'below', value: 0 }, /מחיר חיובי/],
    [{ market: 'US', symbol: 'KO', ruleType: 'below', value: '' }, /מחיר חיובי/],
    [{ market: 'US', symbol: 'KO', ruleType: 'pct_up', value: 0.01 }, /בין 0.1 ל-100/],
    [{ market: 'US', symbol: 'KO', ruleType: 'pct_down', value: 150 }, /בין 0.1 ל-100/],
    [{ market: 'US', symbol: 'KO', ruleType: 'above', value: 5, note: 'x'.repeat(201) }, /ארוכה מדי/]
  ])('rejects %j', (input, message) => {
    expect(() => validatePriceAlertInput(input)).toThrow(message);
  });

  test('an update merges over the existing rule', () => {
    const base = { market: 'US', symbol: 'KO', ruleType: 'above', value: 160, note: 'n', name: 'Coca-Cola' };
    expect(validatePriceAlertInput({ value: 65 }, base)).toMatchObject({ symbol: 'KO', ruleType: 'above', value: 65, note: 'n', name: 'Coca-Cola' });
    expect(() => validatePriceAlertInput({ ruleType: 'pct_up' }, base)).toThrow(/בין 0.1 ל-100/);
  });
});

describe('evaluatePriceAlert', () => {
  const rule = (ruleType, value, extra = {}) => Object.assign({ id: 'r', status: 'active', market: 'US', symbol: 'TSLA', ruleType, value }, extra);

  test('levels ring at or beyond the level', () => {
    expect(evaluatePriceAlert(rule('above', 370.04), { price: 366.475 }).hit).toBe(false);
    expect(evaluatePriceAlert(rule('above', 370.04), { price: 370.04 }).hit).toBe(true);
    expect(evaluatePriceAlert(rule('below', 358.32), { price: 358.1 }).hit).toBe(true);
    expect(evaluatePriceAlert(rule('below', 358.32), { price: 366.475 }).hit).toBe(false);
  });

  test('percent rules use the previous close and the direction (alerts.py: TSLA +3.31%)', () => {
    const q = { price: 366.475, prevClose: 354.72 };
    expect(evaluatePriceAlert(rule('pct_up', 3), q)).toEqual({ hit: true, move: expect.closeTo(3.3139, 3) });
    expect(evaluatePriceAlert(rule('pct_up', 3.5), q).hit).toBe(false);
    expect(evaluatePriceAlert(rule('pct_down', 3), q).hit).toBe(false);
    expect(evaluatePriceAlert(rule('pct_down', 2), { price: 97.9, prevClose: 100 }).hit).toBe(true);
    // No previous close -> a percent rule cannot be judged.
    expect(evaluatePriceAlert(rule('pct_up', 1), { price: 366.475 }).hit).toBe(false);
  });

  test('a triggered rule never hits again (rings once)', () => {
    expect(evaluatePriceAlert(rule('above', 100, { status: 'triggered' }), { price: 200 }).hit).toBe(false);
  });

  test('bad quotes never hit', () => {
    expect(evaluatePriceAlert(rule('below', 100), { price: null }).hit).toBe(false);
    expect(evaluatePriceAlert(rule('below', 100), { price: 0 }).hit).toBe(false);
    expect(movePct(10, 0)).toBeNull();
  });
});

describe('buildPriceAlert', () => {
  test('a PRICE_TARGET warning in Hebrew, deduplicated per arming', () => {
    const r = { id: 'r1', userId: 7, status: 'active', market: 'US', symbol: 'TSLA', name: 'Tesla', ruleType: 'pct_up', value: 3, note: 'לבדוק', armedAt: '2026-10-19T13:00:00.000Z' };
    const a = buildPriceAlert(r, { price: 366.475, prevClose: 354.72, tradeDate: '2026-10-19' }, { now: new Date('2026-10-19T14:53:00Z') });
    expect(a).toMatchObject({
      userId: 7,
      type: 'PRICE_TARGET',
      severity: 'warning',
      sessionDate: '2026-10-19',
      instrument: { symbol: 'TSLA', market: 'US', name: 'Tesla', currency: 'USD' },
      priceAlertId: 'r1',
      movePct: 3.31,
      dedupKey: 'price-alert:r1:2026-10-19T13:00:00.000Z'
    });
    expect(a.title).toBe('Tesla (TSLA) עלתה +3.31% מהסגירה הקודמת');
    expect(a.message).toMatch(/366.48 \$/);
    expect(a.message).toMatch(/הערה: לבדוק/);
    expect(a.message).toMatch(/מושהה/);
  });

  test('TASE levels in shekels', () => {
    const r = { id: 'r2', userId: 7, status: 'active', market: 'TASE', symbol: '629014', name: 'טבע', ruleType: 'below', value: 110, armedAt: 'x' };
    const a = buildPriceAlert(r, { price: 109.5 });
    expect(a.title).toBe('טבע (629014) ירדה ל-109.5 ₪ - מתחת ל-110 ₪');
    expect(a.instrument.currency).toBe('ILS');
    expect(describeRule(r)).toBe('מחיר מתחת ל-110 ₪');
    expect(describeRule({ ruleType: 'pct_up', value: 2.5 })).toBe('עלייה של 2.5% מהסגירה הקודמת');
  });
});
