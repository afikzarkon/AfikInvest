/**
 * @jest-environment node
 */
// Reproduces day-trader-skill's tests/test_analyst.py against the same
// recorded SEC fixtures (src/server/fixtures/earnings, copied from
// tests/fixtures/trader-analyst). No network.
const path = require('path');
const fs = require('fs');
const svc = require('./earningsService');
const { buildEarningsSummary } = require('../shared/earningsSummary');

const DIR = path.join(__dirname, 'fixtures', 'earnings');
const load = (name) => JSON.parse(fs.readFileSync(path.join(DIR, name), 'utf8'));

// A fetchJson that answers SEC URLs from the fixture folder.
function fixtureFetch(calls = []) {
  return async (url) => {
    calls.push(url);
    let name;
    if (url === svc.TICKERS_URL) name = 'company_tickers.json';
    else if (/companyfacts\/(CIK\d{10}\.json)$/.test(url)) name = `companyfacts-${url.match(/(CIK\d{10}\.json)$/)[1]}`;
    else if (/submissions\/(CIK\d{10}\.json)$/.test(url)) name = `submissions-${url.match(/(CIK\d{10}\.json)$/)[1]}`;
    else if (/\/(\d{18})\/index\.json$/.test(url)) name = path.join(url.match(/\/(\d{18})\/index\.json$/)[1], 'index.json');
    if (!name || !fs.existsSync(path.join(DIR, name))) throw new svc.EarningsError(`no fixture for ${url}`, 'NOT_FOUND');
    return load(name);
  };
}

describe('Apple (analyse)', () => {
  const r = svc.analyse(load('companyfacts-CIK0000320193.json'), { quarters: 8 });

  test('latest quarter', () => {
    const q = r.rows[0];
    expect(q).toMatchObject({
      end: '2026-06-27',
      fiscal: 'Q3 2026',
      revenue: 109417000000,
      netIncome: 29789000000,
      epsDiluted: 2.02,
      revenueYoy: 16.4,
      epsYoy: 28.7,
      grossMargin: 50.1,
      operatingMargin: 32.6,
      netMargin: 27.2,
      derived: false
    });
  });

  test('fiscal labels come from the first filing', () => {
    expect(r.rows.slice(0, 6).map((x) => x.fiscal)).toEqual(['Q3 2026', 'Q2 2026', 'Q1 2026', 'Q4 2025', 'Q3 2025', 'Q2 2025']);
  });

  test('Q4 is derived from the 10-K', () => {
    const q4 = r.rows.find((x) => x.end === '2025-09-27');
    expect(q4.derived).toBe(true);
    // FY2025 416,161 minus Q1 124,300, Q2 95,359, Q3 94,036
    expect(q4.revenue).toBe(102466000000);
    expect(q4.revenueYoy).toBe(7.9);
  });

  test('trailing twelve months', () => {
    expect(r.ttm.revenue).toBe(466823000000);
    expect(r.ttm.netIncome).toBe(128930000000);
    expect(r.ttm.epsDiluted).toBe(8.71);
  });

  test('gross margin +0.8 points on the quarter before; YoY margin points', () => {
    expect(Math.round((r.rows[0].grossMargin - r.rows[1].grossMargin) * 10) / 10).toBe(0.8);
    expect(r.rows[0].operatingMarginYoyPt).toBe(2.6);
  });

  test('concepts used', () => {
    expect(r.concepts.revenue).toEqual(['RevenueFromContractWithCustomerExcludingAssessedTax']);
    expect(svc.analyse(load('companyfacts-CIK0000320193.json'), { quarters: 4 }).rows).toHaveLength(4);
  });

  test('restated values win but labels stay; 8-K facts ignored', () => {
    const q = svc.quarterly([
      { start: '2025-01-01', end: '2025-03-31', val: 100, fy: 2025, fp: 'Q1', form: '10-Q', filed: '2025-05-01', accn: 'a' },
      { start: '2025-01-01', end: '2025-03-31', val: 90, fy: 2026, fp: 'Q1', form: '10-Q', filed: '2026-05-01', accn: 'b' },
      { start: '2025-01-01', end: '2025-03-31', val: 1, fy: 2025, fp: 'Q1', form: '8-K', filed: '2025-04-20', accn: 'c' }
    ]);
    expect(q['2025-03-31'].value).toBe(90);
    expect([q['2025-03-31'].fy, q['2025-03-31'].fp]).toEqual([2025, 'Q1']);
  });

  test('no revenue and no net income is an error', () => {
    expect(() => svc.analyse({ facts: { 'us-gaap': {} } })).toThrow(/no quarterly/);
  });
});

describe('Coca-Cola', () => {
  const r = svc.analyse(load('companyfacts-CIK0000021344.json'));

  test('revenue falls back to Revenues; latest quarter and TTM', () => {
    expect(r.concepts.revenue).toEqual(['Revenues']);
    expect(r.rows[0]).toMatchObject({ end: '2026-04-03', revenueYoy: 12.1, netIncomeYoy: 17.8, epsYoy: 18.2, operatingMarginYoyPt: 2.1 });
    expect(r.rows.find((x) => x.end === '2025-12-31').derived).toBe(true);
    expect(r.ttm).toMatchObject({ revenue: 49284000000, netIncome: 13701000000, epsDiluted: 3.18 });
  });

  test('says when SEC facts trail a filed 10-Q', async () => {
    const filings = await svc.latestFilings(load('submissions-CIK0000021344.json'), '0000021344', fixtureFetch());
    expect(svc.staleNote(r, filings)).toEqual({
      factsEnd: '2026-04-03',
      form: '10-Q',
      period: '2026-07-03',
      filed: '2026-07-29',
      url: 'https://www.sec.gov/Archives/edgar/data/21344/000162828026050503/ko-20260703.htm'
    });
    // no index.json fixture -> no exhibit, the filing index link remains
    expect(filings.earnings8k.exhibit).toBeNull();
    expect(filings.earnings8k.index).toBe('https://www.sec.gov/Archives/edgar/data/21344/000162828026049922/0001628280-26-049922-index.htm');
  });
});

describe('filings', () => {
  test('latest 10-Q and earnings press release', async () => {
    const f = await svc.latestFilings(load('submissions-CIK0000320193.json'), '0000320193', fixtureFetch());
    expect(f.report.form).toBe('10-Q');
    expect(f.report.period).toBe('2026-06-27');
    expect(f.report.url.endsWith('/000032019326000020/aapl-20260627.htm')).toBe(true);
    expect(f.earnings8k.filed).toBe('2026-07-30');
    expect(f.earnings8k.exhibit).toBe('https://www.sec.gov/Archives/edgar/data/320193/000032019326000018/a8-kex991q3202606272026.htm');
  });

  test('exhibit names seen on EDGAR', () => {
    const pick = svc.exhibitName;
    expect(pick(['axp-20260724.htm', 'q226exhibit991.htm', 'q226exhibit992.htm', 'R1.htm'], 'axp-20260724.htm')).toBe('q226exhibit991.htm');
    expect(pick(['goog-20260722.htm', 'googexhibit991q22026.htm'], 'goog-20260722.htm')).toBe('googexhibit991q22026.htm');
    expect(pick(['a2026q2earningsreleaseex-9.htm', 'ko-20260728.htm'], 'ko-20260728.htm')).toBe('a2026q2earningsreleaseex-9.htm');
    expect(pick(['bac-06302026ex993.htm', 'bac-06302026ex991.htm'])).toBe('bac-06302026ex991.htm');
    expect(pick(['only-8k.htm'], 'only-8k.htm')).toBeNull();
  });

  test('ticker map: cleaned titles, class shares by dot', () => {
    const m = svc.tickerMap(Object.assign(load('company_tickers.json'), { 99: { cik_str: 1067983, ticker: 'BRK-B', title: 'BERKSHIRE HATHAWAY INC' } }));
    expect(m.get('BAC')).toEqual({ cik: '0000070858', name: 'BANK OF AMERICA CORP' });
    expect(m.get('BRK.B').cik).toBe('0001067983');
  });

  test('user agent must carry a real contact', () => {
    expect(svc.userAgentFromEnv({})).toBeNull();
    expect(svc.userAgentFromEnv({ SEC_USER_AGENT: 'Your Name you@example.com' })).toBeNull();
    expect(svc.userAgentFromEnv({ SEC_USER_AGENT: 'nobody' })).toBeNull();
    expect(svc.userAgentFromEnv({ SEC_USER_AGENT: 'Jane Doe jane@doe.test' })).toBe('Jane Doe jane@doe.test');
  });
});

describe('service', () => {
  test('caches the ticker list and the per-CIK result', async () => {
    const calls = [];
    let t = 0;
    const s = svc.createEarningsService({ fetchJson: fixtureFetch(calls), now: () => t });
    const a = await s.getEarnings('aapl');
    expect(a.rows[0].end).toBe('2026-06-27');
    expect(a.entity).toBe('Apple Inc.');
    expect(a.filings.earnings8k.exhibit).toMatch(/a8-kex991/);
    expect(a.staleNote).toBeNull();
    const n = calls.length;
    await s.getEarnings('AAPL');
    expect(calls.length).toBe(n);
    t += 7 * 60 * 60 * 1000;
    await s.getEarnings('AAPL');
    expect(calls.length).toBe(n + 3); // facts + submissions + index; tickers still fresh
    await expect(s.getEarnings('ZZZZ')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  test('not configured without a user agent or fetcher', async () => {
    const s = svc.createEarningsService({ userAgent: null });
    expect(s.configured).toBe(false);
    await expect(s.getEarnings('AAPL')).rejects.toMatchObject({ code: 'NOT_CONFIGURED' });
  });
});

describe('Hebrew summary', () => {
  test('what changed, in numbers', () => {
    const r = svc.analyse(load('companyfacts-CIK0000320193.json'));
    const lines = buildEarningsSummary({ quarters: r.rows, ttm: r.ttm });
    expect(lines[0]).toContain('הכנסות של 109.42 מיליארד דולר, עלייה של 16.4% לעומת הרבעון המקביל אשתקד');
    expect(lines[1]).toContain('רווח מדולל למניה 2.02 דולר (עלייה של 28.7%)');
    expect(lines.some((l) => l.startsWith('שולי הרווח התפעולי 32.6%, עלייה של 2.6 נקודות אחוז לעומת אשתקד'))).toBe(true);
    expect(lines.some((l) => l.includes('מחושב'))).toBe(true);
  });

  test('one-offs and lagging data are flagged', () => {
    const lines = buildEarningsSummary({
      quarters: [{ end: '2026-06-30', derived: false, revenue: 100, netIncome: 90, operatingIncome: 30, epsDiluted: 1, revenueYoy: -3, grossMargin: null, operatingMargin: 30, netMargin: 90 }],
      staleNote: { factsEnd: '2026-04-03', form: '10-Q', period: '2026-07-03', filed: '2026-07-29' }
    });
    expect(lines[0]).toContain('ירידה של 3.0%');
    expect(lines.some((l) => l.includes('גבוה מהרווח התפעולי'))).toBe(true);
    expect(lines.some((l) => l.includes('נעצרים ב-2026-04-03'))).toBe(true);
    expect(buildEarningsSummary({ quarters: [] })).toEqual([]);
  });
});
