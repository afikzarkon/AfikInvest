/**
 * @jest-environment node
 */
// Ported from day-trader-skill (MIT, Jake Schincariol): trader-pelosi's
// tests/test_pelosi.py, on the same recorded fixtures.
const fs = require('fs');
const path = require('path');
const JSZip = require('jszip');
const c = require('./congressService');

const DIR = path.join(__dirname, 'fixtures', 'congress');
const ZIP = fs.readFileSync(path.join(DIR, '2026FD.zip'));
const text = (name) => fs.readFileSync(path.join(DIR, name), 'utf8');
const items = (name) => JSON.parse(text(name));

describe('the yearly index', () => {
  let rows;
  beforeAll(async () => {
    rows = await c.parseIndexArchive(ZIP, 2026);
  });

  test("finds Pelosi's four 2026 PTRs, newest first, with PDF URLs", () => {
    const hers = c.selectFilings(rows, { members: ['pelosi'] });
    expect(hers.map((r) => r.docId)).toEqual(['20035553', '20035143', '20034836', '20033725']);
    expect(hers.map((r) => r.filed)).toEqual(['2026-10-02', '2026-08-21', '2026-06-23', '2026-01-23']);
    expect(hers[1].url).toBe('https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2026/20035143.pdf');
    expect(hers[0].district).toBe('CA11');
    expect(hers[0].name).toBe('Hon. Nancy Pelosi');
  });

  test('member names in any order', () => {
    for (const m of ['pelosi', 'Nancy Pelosi', 'Pelosi, Nancy', 'PELOSI']) {
      expect(c.selectFilings(rows, { members: [m] })).toHaveLength(4);
    }
    expect(c.selectFilings(rows, { members: ['Paul Pelosi'] })).toEqual([]);
    expect(c.selectFilings(rows, { members: ['pelosi', 'gottheimer'] })).toHaveLength(5);
  });

  test('only PTRs unless asked; other filings link to financial-pdfs', () => {
    const ptrs = c.selectFilings(rows);
    expect(ptrs.every((r) => r.type === 'P')).toBe(true);
    const everything = c.selectFilings(rows, { kind: null });
    expect(everything.length).toBeGreaterThan(ptrs.length);
    expect(everything.find((r) => r.type === 'C').url).toContain('/financial-pdfs/2026/');
  });

  test('since and newest first', () => {
    const recent = c.selectFilings(rows, { since: '2026-10-07' });
    expect(recent.every((r) => ['2026-10-07', '2026-10-12'].includes(r.filed))).toBe(true);
    expect(recent[0].filed).toBe('2026-10-12');
    expect(recent.map((r) => r.last)).toContain('Salazar');
  });

  test('reads the XML inside (with its BOM) or alone, and the TXT form', async () => {
    const zip = await JSZip.loadAsync(ZIP);
    const raw = await zip.file('2026FD.xml').async('nodebuffer');
    expect([...raw.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(await c.parseIndexArchive(raw, 2026)).toHaveLength(rows.length);
    await expect(c.parseIndexArchive(Buffer.from('not xml'), 2026)).rejects.toThrow();

    const txt = 'Prefix\tLast\tFirst\tSuffix\tFilingType\tStateDst\tYear\tFilingDate\tDocID\r\nHon.\tPelosi\tNancy\t\tP\tCA11\t2026\t10/2/2026\t20035553\r\n';
    const txtZip = new JSZip();
    txtZip.file('2026FD.txt', txt);
    const fromTxt = await c.parseIndexArchive(await txtZip.generateAsync({ type: 'nodebuffer' }), 2026);
    expect(fromTxt).toEqual([expect.objectContaining({ docId: '20035553', filed: '2026-10-02', name: 'Hon. Nancy Pelosi', type: 'P' })]);
  });
});

describe('parsing a PTR (pdftotext -layout text)', () => {
  test('the Bloom Energy calls', () => {
    const rep = c.parsePtrText(text('ptr-20035143.txt'));
    expect(rep).toMatchObject({ name: 'Hon. Nancy Pelosi', status: 'Member', district: 'CA11', docId: '20035143', filed: '2026-08-21' });
    expect(rep.rows).toHaveLength(7);
    const calls = rep.rows.filter((r) => r.ticker === 'BE' && r.assetType === 'OP');
    expect(calls).toHaveLength(2);
    const big = calls[0];
    expect(big).toMatchObject({
      owner: 'SP',
      ownerName: 'spouse',
      type: 'P',
      date: '2026-07-24',
      notified: '2026-07-24',
      amount: '$1,000,001 - $5,000,000',
      amountLow: 1000001,
      amountHigh: 5000000,
      daysToDisclose: 28,
      late: false,
      asset: 'Bloom Energy Corporation Class A Common Stock'
    });
    expect(big.option).toEqual({ contracts: 100, kind: 'call', strike: 100, expires: '2027-06-17', exercised: false });
    expect(rep.rows.filter((r) => r.ticker === 'BE' && r.assetType === 'ST').map((r) => r.shares)).toEqual([10000, 5000]);
    const llc = rep.rows[rep.rows.length - 1];
    expect(llc.ticker).toBeNull();
    expect(llc.assetType).toBe('AB');
    expect(llc.description).toContain('luxury hotel');
  });

  test('joint owner and account', () => {
    const rep = c.parsePtrText(text('ptr-20035590.txt'));
    expect(rep.rows.map((r) => [r.ticker, r.owner, r.type])).toEqual([
      ['AMAT', 'JT', 'S'],
      ['MCD', 'JT', 'S (partial)']
    ]);
    expect(rep.rows[0].account).toBe('Morgan Stanley - Select UMA Account # 1');
    expect(rep.rows[0].notified).toBe('2026-10-06');
  });

  test('self-owned partial sales and crowded columns', () => {
    const rep = c.parsePtrText(text('ptr-20035562-excerpt.txt'));
    expect(rep.rows.map((r) => r.ticker)).toEqual(['BRK.B', 'BIIB', 'BA', 'BEP', 'CVX', 'CB', 'GLW', 'IBM']);
    expect(rep.rows.every((r) => r.owner === '' && r.ownerName === 'self')).toBe(true);
    expect(rep.rows[0].typeName).toBe('partial sale');
    expect(rep.rows[0].account).toBe('UBS IRA Account');
    expect([rep.rows[6].type, rep.rows[6].asset]).toEqual(['P', 'Corning Incorporated Common Stock']);
    expect(rep.rows[7].asset).toBe('International Business Machines Corporation Common Stock');
  });

  test('page breaks, exercises and exchanges', () => {
    const rep = c.parsePtrText(text('ptr-20033725-excerpt.txt'));
    const by = Object.fromEntries(rep.rows.map((r) => [r.ticker, r]));
    expect(Object.keys(by).sort()).toEqual(['NVDA', 'PYPL', 'TEM', 'VSNT', 'VST']);
    expect(by.TEM.asset).toBe('Tempus AI, Inc. - Class A Common Stock');
    expect(by.TEM.amount).toBe('$50,001 - $100,000');
    expect(by.TEM.option.exercised).toBe(true);
    expect(by.TEM.option.strike).toBe(20);
    expect(by.PYPL.date).toBe('2025-12-30');
    expect(by.PYPL.shares).toBe(5000);
    expect(by.VSNT.typeName).toBe('exchange');
  });

  test('late filings are flagged', () => {
    const rep = c.parsePtrText(text('ptr-20035590.txt'), '2026-11-15');
    expect(rep.rows.every((r) => r.late)).toBe(true);
  });

  test('labels with their small caps kept (as pdfjs may read them)', () => {
    const t = text('ptr-20035590.txt')
      .replace(/F\s+S\s+:/g, 'FILING STATUS:')
      .replace(/S\s+O :/g, 'S UBHOLDING O F:');
    const rep = c.parsePtrText(t);
    expect(rep.rows.map((r) => [r.ticker, r.status, r.account])).toEqual([
      ['AMAT', 'New', 'Morgan Stanley - Select UMA Account # 1'],
      ['MCD', 'New', 'Morgan Stanley - Select UMA Account # 1']
    ]);
  });

  test('dates', () => {
    expect(c.iso('8/21/2026')).toBe('2026-08-21');
    expect(c.iso('6/17/27')).toBe('2027-06-17');
    expect(c.iso('13/45/2026')).toBeNull();
  });
});

describe('PDF text (pdfjs items -> layout -> rows)', () => {
  // Items recorded from pdfjs-dist reading PDFs drawn in a proportional font
  // with each column at its pdftotext position; the parse must match the
  // pdftotext fixture exactly.
  test.each([['ptr-20035143'], ['ptr-20033725-excerpt']])('%s parses the same as pdftotext', (name) => {
    const fromPdf = c.parsePtrText(c.layoutFromItems(items(`${name}.pdfjs-items.json`)));
    const fromTxt = c.parsePtrText(text(`${name}.txt`));
    expect(fromPdf).toEqual(fromTxt);
    expect(fromPdf.rows.length).toBeGreaterThan(0);
  });

  test('readPtrPdf: parsed, scanned (no text) and broken PDFs', async () => {
    const pdf = Buffer.from('%PDF-1.7 ...');
    const pages = items('ptr-20035143.pdfjs-items.json');
    const ok = await c.readPtrPdf(pdf, { filed: '2026-08-21', extractItems: async () => ({ pages }) });
    expect(ok.status).toBe('parsed');
    expect(ok.rows).toHaveLength(7);
    expect(ok.report.docId).toBe('20035143');

    const scanned = await c.readPtrPdf(pdf, { extractItems: async () => ({ pages: [[], [{ str: ' ', x: 1, y: 1 }]] }) });
    expect(scanned).toMatchObject({ status: 'no_text', rows: [] });

    const broken = await c.readPtrPdf(pdf, {
      extractItems: async () => {
        throw new Error('Invalid PDF structure.');
      }
    });
    expect(broken).toMatchObject({ status: 'error', rows: [], error: 'Invalid PDF structure.' });
    expect((await c.readPtrPdf(Buffer.from('<html>'), {})).status).toBe('error');
  });
});

test('default fetchers send a User-Agent, a timeout and If-Modified-Since', async () => {
  const calls = [];
  const http = {
    async get(url, opts) {
      calls.push({ url, opts });
      if (opts.headers['If-Modified-Since']) return { status: 304, data: null, headers: {} };
      return { status: 200, data: new Uint8Array([80, 75]).buffer, headers: { 'last-modified': 'Tue, 13 Oct 2026 21:29:00 GMT' } };
    }
  };
  const f = c.createDefaultFetchers({ http });
  const first = await f.fetchIndexZip(2026);
  expect(first).toMatchObject({ notModified: false, lastModified: 'Tue, 13 Oct 2026 21:29:00 GMT' });
  expect(calls[0].url).toBe('https://disclosures-clerk.house.gov/public_disc/financial-pdfs/2026FD.zip');
  expect(calls[0].opts.timeout).toBeGreaterThan(0);
  expect(calls[0].opts.headers['User-Agent']).toMatch(/AfikInvest/);
  expect((await f.fetchIndexZip(2026, { ifModifiedSince: first.lastModified })).notModified).toBe(true);
});
