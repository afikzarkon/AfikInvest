/**
 * @jest-environment node
 */
// Ported from day-trader-skill (MIT, Jake Schincariol): tests/test_news.py,
// on the same recorded feeds (fixtures/news/).
const fs = require('fs');
const path = require('path');
const news = require('./newsService');

const DIR = path.join(__dirname, 'fixtures', 'news');
const raw = (name) => fs.readFileSync(path.join(DIR, name));

describe('feeds', () => {
  test('Yahoo RSS', () => {
    const items = news.parseRss(raw('yahoo-AAPL.xml'), 'AAPL');
    expect(items).toHaveLength(6);
    const first = items[0];
    expect(first.title).toBe('Apple may have a way to dominate the smart home space');
    expect(first.time).toBe('2026-10-13T19:46:52.000Z');
    expect(first.link.startsWith('https://finance.yahoo.com/')).toBe(true);
    expect(first.id.startsWith('rss:')).toBe(true);
    expect(first.source).toBe('yahoo');
    // entities decoded
    const tsla = news.parseRss(raw('yahoo-TSLA.xml'), 'TSLA');
    expect(tsla.some((i) => i.title === 'Tesla Stock vs. the S&P 500: Which Investment Wins Through 2030?')).toBe(true);
    expect(items.every((i) => !i.link.includes('&amp;'))).toBe(true);
  });

  test('SEC 8-K Atom', () => {
    const items = news.parseSecAtom(raw('sec-8-K-0000320193.xml'), 'AAPL');
    expect(items.map((i) => i.form)).toEqual(['8-K/A', '8-K', '8-K']);
    const earn = items[1];
    expect(earn.items).toEqual(['2.02', '9.01']);
    expect(earn.important).toBe(true);
    expect(earn.title).toBe('Apple Inc. הגישה דיווח 8-K: תוצאות כספיות');
    expect(earn.id).toBe('sec:0000320193-26-000018');
    expect(earn.accession).toBe('0000320193-26-000018');
    expect(earn.link).toContain('000032019326000018');
    // 16:30:28 New York time is 20:30:28 UTC
    expect(earn.time).toBe('2026-07-30T20:30:28.000Z');
    expect(items[0].title).toBe('Apple Inc. הגישה דיווח 8-K/A: שינוי בדירקטוריון / בהנהלה');
    expect(items[0].source).toBe('sec');
  });

  test('invalid feeds throw', () => {
    expect(() => news.parseRss('<html>nope</html>', 'X')).toThrow(news.NewsError);
    expect(() => news.parseSecAtom('not xml', 'X')).toThrow(news.NewsError);
  });

  test('times', () => {
    expect(new Date(news.parseTime('Tue, 13 Oct 2026 20:02:03 +0000')).getUTCHours()).toBe(20);
    expect(new Date(news.parseTime('2026-09-01T16:30:35-04:00')).getUTCHours()).toBe(20);
    expect(news.parseTime('soon')).toBeNull();
    expect(news.parseTime('')).toBeNull();
  });

  test('symbols and the SEC ticker list', () => {
    expect(news.yahooSymbol('BRK.B')).toBe('BRK-B');
    expect(news.normalizeTicker(' aapl ')).toBe('AAPL');
    expect(news.normalizeTicker('1234')).toBeNull();
    expect(news.normalizeTicker('A;DROP')).toBeNull();
    const ciks = news.parseCompanyTickers(raw('company_tickers.json'));
    expect(ciks.AAPL).toBe('0000320193');
    expect(ciks['BRK.B']).toBe('0001067983');
    expect(ciks.KO).toBe('0000021344');
  });

  test('SEC User-Agent must carry contact details', () => {
    expect(news.secUserAgentFrom('')).toBeNull();
    expect(news.secUserAgentFrom('Your Name you@example.com')).toBeNull();
    expect(news.secUserAgentFrom('no email here')).toBeNull();
    expect(news.secUserAgentFrom('Ada ada@example.org')).toBe('Ada ada@example.org');
  });
});

describe('tagging', () => {
  test('touches and tags', () => {
    const items = news.parseRss(raw('yahoo-KO.xml'), 'KO');
    news.tagItems(items, { KO: 'Coca-Cola', CVX: 'Chevron', AAPL: 'Apple' });
    const by = Object.fromEntries(items.map((i) => [i.title.slice(0, 20), i]));
    const chevron = by['Coca-Cola or Chevron'];
    expect(chevron.touches).toEqual(['CVX', 'KO']);
    expect(chevron.tags).toContain('capital'); // dividend
    expect(by['Is Coca-Cola (KO) St'].touches).toEqual(['KO']);
  });

  test('official company names match the short form in headlines', () => {
    expect(news.shortCompanyName('Apple Inc.')).toBe('Apple');
    expect(news.shortCompanyName('The Coca-Cola Company')).toBe('Coca-Cola');
    const items = news.parseRss(raw('yahoo-KO.xml'), 'KO');
    news.tagItems(items, { KO: null, CVX: 'Chevron Corporation' });
    expect(items[0].touches).toEqual(['CVX', 'KO']);
  });

  test('earnings filings are tagged; 8.01 is not important', () => {
    const items = news.tagItems(news.parseSecAtom(raw('sec-8-K-0000021344.xml'), 'KO'), { KO: null });
    expect(items[0].tags[0]).toBe('earnings');
    expect(items[1].important).toBe(false);
    expect(items[2].tags).toContain('people'); // 5.02
  });

  test('day-trading tags', () => {
    const items = [{ id: 'x', source: 'yahoo', kind: 'headline', ticker: 'TSLA', title: 'Trading halted in XYZ after FDA approval; futures rise before CPI', summary: '', link: '', time: null }];
    const { tags } = news.tagItems(items, { TSLA: null })[0];
    ['halt', 'regulatory', 'macro'].forEach((t) => expect(tags).toContain(t));
  });

  test('dedupe merges the same story', () => {
    const a = news.parseRss(raw('yahoo-AAPL.xml'), 'AAPL');
    const b = news.parseRss(raw('yahoo-AAPL.xml'), 'GOOGL');
    const items = news.dedupe(news.tagItems(a.concat(b), { AAPL: null, GOOGL: null }));
    expect(items).toHaveLength(6);
    expect(items[0].touches).toEqual(['AAPL', 'GOOGL']);
  });

  test('filing severity', () => {
    expect(news.filingSeverity({ items: ['2.02', '9.01'] })).toBe('info');
    expect(news.filingSeverity({ items: ['5.02', '2.02'] })).toBe('warning');
    expect(news.filingSeverity({ items: ['1.03'] })).toBe('critical');
    expect(news.filingSeverity({ items: ['8.01', '9.01'] })).toBeNull();
  });
});

describe('window', () => {
  test('the reel: TSLA morning, 16 of 18 headlines by 10:15 ET, newest first', () => {
    const items = news.parseRss(raw('yahoo-TSLA.xml'), 'TSLA');
    expect(items).toHaveLength(18);
    const shown = news.selectWindow(news.tagItems(items, { TSLA: null }), new Date('2026-10-19T10:15:00-04:00'), 6);
    expect(shown).toHaveLength(16);
    const times = shown.map((i) => i.time);
    expect(times).toEqual([...times].sort().reverse());
    const merger = shown.find((i) => i.title === 'Tesla-SpaceX Merger Mania Strikes Wall Street Ahead of Earnings');
    expect(merger.time).toBe('2026-10-19T12:04:00.000Z');
    expect(merger.tags).toEqual(expect.arrayContaining(['earnings', 'deal']));
  });
});

describe('createNewsService', () => {
  const fixtureFetchers = () => {
    const calls = { yahoo: [], sec: [], tickers: 0 };
    return {
      calls,
      fetchers: {
        async yahooRss(symbol) {
          calls.yahoo.push(symbol);
          return raw(`yahoo-${symbol}.xml`).toString('utf8');
        },
        async secAtom(cik, form, { userAgent }) {
          calls.sec.push({ cik, form, userAgent });
          return raw(`sec-${form}-${cik}.xml`).toString('latin1');
        },
        async companyTickers() {
          calls.tickers += 1;
          return raw('company_tickers.json').toString('utf8');
        }
      }
    };
  };

  test('headlines + filings, merged, newest first, cached per symbol', async () => {
    const { calls, fetchers } = fixtureFetchers();
    const svc = news.createNewsService({ fetchers, secUserAgent: 'Test test@example.org', secGapMs: 0 });
    const now = new Date('2026-10-14T00:00:00Z');
    const r = await svc.getNews({ symbols: ['AAPL', 'KO'], names: { KO: 'The Coca-Cola Company' }, hours: 24 * 200, now });
    expect(r.secConfigured).toBe(true);
    expect(r.errors).toEqual([]);
    expect(r.items.filter((i) => i.source === 'sec')).toHaveLength(6);
    expect(r.items.filter((i) => i.source === 'yahoo')).toHaveLength(10);
    const times = r.items.map((i) => i.time);
    expect(times).toEqual([...times].sort().reverse());
    expect(calls.sec[0].userAgent).toBe('Test test@example.org');

    // 24h window: filings are older, 6 Apple + 4 Coca-Cola headlines
    const day = await svc.getNews({ symbols: ['AAPL', 'KO'], hours: 24, now });
    expect(day.items).toHaveLength(10);
    // served from cache
    expect(calls.yahoo).toEqual(['AAPL', 'KO']);
    expect(calls.sec).toHaveLength(2);
    expect(calls.tickers).toBe(1);
  });

  test('without SEC_USER_AGENT, SEC is never called', async () => {
    const { calls, fetchers } = fixtureFetchers();
    const svc = news.createNewsService({ fetchers, secUserAgent: () => undefined });
    const r = await svc.getNews({ symbols: ['AAPL'], hours: 24, now: new Date('2026-10-14T00:00:00Z') });
    expect(r.secConfigured).toBe(false);
    expect(r.items).toHaveLength(6);
    expect(calls.sec).toHaveLength(0);
    expect(calls.tickers).toBe(0);
    await expect(svc.getFilings('AAPL')).rejects.toThrow(/SEC_USER_AGENT/);
  });

  test('a failing source is reported per symbol and briefly negative-cached', async () => {
    let t = 0;
    let n = 0;
    const svc = news.createNewsService({
      fetchers: {
        async yahooRss() {
          n += 1;
          throw new Error('HTTP 429');
        }
      },
      secUserAgent: '',
      clock: () => t
    });
    const now = new Date('2026-10-14T00:00:00Z');
    const r = await svc.getNews({ symbols: ['ZZZ'], now });
    expect(r.errors).toEqual([{ symbol: 'ZZZ', source: 'yahoo', message: 'HTTP 429' }]);
    await svc.getNews({ symbols: ['ZZZ'], now });
    expect(n).toBe(1);
    t = 3 * 60 * 1000;
    await svc.getNews({ symbols: ['ZZZ'], now });
    expect(n).toBe(2);
  });

  test('a ticker SEC does not know gets headlines only', async () => {
    const { calls, fetchers } = fixtureFetchers();
    fetchers.yahooRss = async () => raw('yahoo-KO.xml').toString('utf8');
    const svc = news.createNewsService({ fetchers, secUserAgent: 'Test test@example.org', secGapMs: 0 });
    const r = await svc.getNews({ symbols: ['NOPE'], hours: 24, now: new Date('2026-10-14T00:00:00Z') });
    expect(r.errors).toEqual([]);
    expect(calls.sec).toHaveLength(0);
    expect(r.items.length).toBeGreaterThan(0);
  });
});

describe('mentioned: stories that name a holding vs general market stories', () => {
  const item = (title, ticker = 'NVDA') => ({ id: title, kind: 'headline', source: 'yahoo', ticker, title, summary: '' });
  test('the company name in any case, the bare ticker, or a filing count as mentioned', () => {
    const items = news.tagItems(
      [
        item('5-star analyst revamps Nvidia stock target'),
        item('NVDA slips after the bell'),
        item('EyePoint Pharmaceuticals Q3 2026 Earnings Call Summary'),
        Object.assign(item('NVIDIA הגישה דיווח 8-K'), { kind: 'filing', source: 'sec' })
      ],
      { NVDA: 'NVIDIA CORP' }
    );
    expect(items.map((i) => i.mentioned)).toEqual([true, true, false, true]);
    // The feed's own ticker still shows on every item.
    expect(items[2].touches).toEqual(['NVDA']);
  });
  test('a two-letter ticker is not matched as a bare word', () => {
    const [it] = news.tagItems([item('KO means knockout here', 'KO')], { KO: null });
    expect(it.mentioned).toBe(false);
  });
  test('parseCompanyDirectory keeps SEC titles beside the CIKs', () => {
    const dir = news.parseCompanyDirectory(raw('company_tickers.json'));
    expect(Object.keys(dir.ciks).length).toBeGreaterThan(0);
    const t = Object.keys(dir.ciks)[0];
    expect(typeof dir.names[t]).toBe('string');
  });
});
