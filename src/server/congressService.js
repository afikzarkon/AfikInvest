// Ported from day-trader-skill (MIT, Jake Schincariol)
//
// Congress stock trades: the Periodic Transaction Reports (PTRs) members of
// the House file under the STOCK Act when they, a spouse or a dependent child
// buy or sell a security.
//
//   - The index: https://disclosures-clerk.house.gov/public_disc/financial-pdfs/<YEAR>FD.zip
//     (a ZIP with <YEAR>FD.xml and <YEAR>FD.txt: one record per filing,
//     FilingType P = PTR).
//   - Each PTR: https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/<YEAR>/<DocID>.pdf
//
// The row parser is a port of trader-pelosi/ptr.py, which reads
// `pdftotext -layout` output. That binary is not on the Render host, so PDF
// text comes from pdfjs-dist (pure JS) and the layout is rebuilt from each
// text item's x/y position (layoutFromItems) closely enough for the same
// parser to work. Some PTRs are scanned images with no text layer: those are
// kept as filings with no rows and status 'no_text'.
//
// A PTR is a PUBLIC disclosure, due within 30 days of the member learning of
// the trade and never later than 45 days after it. Amounts are ranges. The
// Senate (efdsearch.senate.gov, behind a click-through agreement) is not
// covered.
const axios = require('axios');
const JSZip = require('jszip');
const { buildHoldingsIndex, loadPortfolios } = require('./holdingsIndex');

const INDEX_URL = (year) => `https://disclosures-clerk.house.gov/public_disc/financial-pdfs/${year}FD.zip`;
const PTR_URL = (year, docId) => `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/${year}/${docId}.pdf`;
const FD_URL = (year, docId) => `https://disclosures-clerk.house.gov/public_disc/financial-pdfs/${year}/${docId}.pdf`;
const USER_AGENT = 'AfikInvest/1.0 (portfolio tracker; congress disclosures reader)';
const REQUEST_TIMEOUT_MS = 30000;

const FILING_TYPES = {
  P: 'Periodic Transaction Report',
  O: 'Annual report',
  A: 'Amendment',
  C: 'Candidate report',
  X: 'Extension',
  T: 'Termination report',
  W: 'Waiver',
  D: 'Disclosure (new member or candidate)',
  H: 'New filer report'
};
const TXN_TYPES = { P: 'purchase', S: 'sale', 'S (partial)': 'partial sale', E: 'exchange' };
const OWNERS = { SP: 'spouse', JT: 'joint', DC: 'dependent child', '': 'self' };
const LATE_DAYS = 45;

class CongressError extends Error {}

// ---------------------------------------------------------------- dates

// '8/21/2026' or '08/21/2026' -> '2026-08-21' (two-digit years -> 20xx).
function iso(mdy) {
  const m = /^\s*(\d{1,2})\/(\d{1,2})\/(\d{2,4})\s*$/.exec(mdy || '');
  if (!m) return null;
  const month = Number(m[1]);
  const day = Number(m[2]);
  let year = Number(m[3]);
  if (year < 100) year += 2000;
  const d = new Date(Date.UTC(year, month - 1, day));
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) return null;
  return d.toISOString().slice(0, 10);
}

const daysBetween = (fromIso, toIso) => Math.round((Date.parse(`${toIso}T00:00:00Z`) - Date.parse(`${fromIso}T00:00:00Z`)) / 86400000);

// ---------------------------------------------------------------- the index

const XML_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const decodeXml = (s) =>
  String(s).replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (all, ent) => {
    const e = ent.toLowerCase();
    if (e[0] === '#') {
      const code = e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : all;
    }
    return XML_ENTITIES[e] || all;
  });

function recordToFiling(f, year) {
  const doc = f.DocID || '';
  const kind = f.FilingType || '';
  const y = Number(f.Year) || year;
  const url = kind === 'P' ? PTR_URL(y, doc) : FD_URL(y, doc);
  const name = [f.Prefix, f.First, f.Last, f.Suffix].filter(Boolean).join(' ');
  return {
    docId: doc,
    type: kind,
    typeName: FILING_TYPES[kind] || kind,
    last: f.Last || '',
    first: f.First || '',
    name,
    district: f.StateDst || '',
    year: y,
    filed: iso(f.FilingDate || ''),
    url
  };
}

const newestFirst = (a, b) => {
  const ka = `${a.filed || ''}|${a.docId}`;
  const kb = `${b.filed || ''}|${b.docId}`;
  return ka < kb ? 1 : ka > kb ? -1 : 0;
};

// Every filing in a <YEAR>FD.xml, newest first.
function parseIndexXml(xml, year) {
  const text = String(xml).replace(/^﻿/, '');
  if (!/<FinancialDisclosure[\s>/]/.test(text)) throw new CongressError('index is not valid XML');
  const out = [];
  const memberRe = /<Member>([\s\S]*?)<\/Member>/g;
  let m;
  while ((m = memberRe.exec(text))) {
    const f = {};
    const fieldRe = /<(\w+)\s*(?:\/>|>([\s\S]*?)<\/\1>)/g;
    let fm;
    while ((fm = fieldRe.exec(m[1]))) f[fm[1]] = decodeXml((fm[2] || '').trim());
    out.push(recordToFiling(f, year));
  }
  return out.sort(newestFirst);
}

// The same index as the tab-separated <YEAR>FD.txt (header row first).
function parseIndexTxt(txt, year) {
  const lines = String(txt).replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) return [];
  const header = lines[0].split('\t').map((h) => h.trim());
  if (!header.includes('DocID')) throw new CongressError('index TXT has no DocID column');
  return lines
    .slice(1)
    .map((line) => {
      const cells = line.split('\t');
      const f = {};
      header.forEach((h, i) => {
        f[h] = (cells[i] || '').trim();
      });
      return recordToFiling(f, year);
    })
    .sort(newestFirst);
}

// Filings from the index ZIP (or a bare XML/TXT buffer), newest first.
async function parseIndexArchive(data, year) {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  if (buf.slice(0, 2).toString('latin1') !== 'PK') {
    const text = buf.toString('utf8');
    return /<FinancialDisclosure/.test(text) ? parseIndexXml(text, year) : parseIndexTxt(text, year);
  }
  let zip;
  try {
    zip = await JSZip.loadAsync(buf);
  } catch (err) {
    throw new CongressError(`index ZIP could not be read: ${err.message}`);
  }
  const names = Object.keys(zip.files);
  const xmlName = names.find((n) => n.toLowerCase().endsWith('.xml'));
  if (xmlName) return parseIndexXml(await zip.file(xmlName).async('string'), year);
  const txtName = names.find((n) => n.toLowerCase().endsWith('.txt'));
  if (txtName) return parseIndexTxt(await zip.file(txtName).async('string'), year);
  throw new CongressError(`no XML inside the ZIP (files: ${names.join(', ')})`);
}

// 'pelosi', 'Nancy Pelosi' or 'Pelosi, Nancy' against an index filing.
function memberMatch(filing, member) {
  const q = String(member || '').trim().toLowerCase();
  if (!q) return true;
  let last;
  let first;
  if (q.includes(',')) {
    [last, first] = q.split(/,(.*)/s).map((x) => (x || '').trim());
  } else {
    const parts = q.split(/\s+/);
    last = parts[parts.length - 1];
    first = parts.slice(0, -1).join(' ');
  }
  if (String(filing.last || '').toLowerCase() !== last) return false;
  return !first || String(filing.first || '').toLowerCase().startsWith(first);
}

function selectFilings(filings, { members = null, kind = 'P', since = null } = {}) {
  return filings.filter((r) => {
    if (kind && r.type !== kind) return false;
    if (members && members.length && !members.some((m) => memberMatch(r, m))) return false;
    if (since && (r.filed || '') < since) return false;
    return true;
  });
}

// ---------------------------------------------------------------- parsing a PTR

const TXN =
  /^\s*(?:(?<owner>SP|JT|DC)\s+)?(?<asset>.*?)\s+(?<type>S \(partial\)|P|S|E)\s+(?<date>\d{2}\/\d{2}\/\d{4})\s+(?<notified>\d{2}\/\d{2}\/\d{4})\s+(?<amount>\S.*?)\s*$/;
// pdftotext drops the small-caps letters of these labels ("F   S   :"); a
// text layer read with pdfjs may keep them ("FILING STATUS:" or split as
// "F ILING S TATUS:"), so each word's tail is optional and may be detached.
const LABELS = [
  ['status', /^\s*F\s*(?:ILING)?\s+S\s*(?:TATUS)?\s*:\s*(.*)$/i],
  ['description', /^\s*D\s*(?:ESCRIPTION)?\s*:\s*(.*)$/i],
  ['account', /^\s*S\s*(?:UBHOLDING)?\s+O\s*(?:F)?\s*:\s*(.*)$/i],
  ['location', /^\s*L\s*(?:OCATION)?\s*:\s*(.*)$/i]
];
// Column headers repeat at the top of every page, sometimes in the middle of
// a row that continues on the next page: skip them without ending the row.
const PAGE_HEADER = /^\s*(ID\s+Owner\s+Asset|Type\s+Date\b|Type$|Date$|Gains >$|\$200\?$)/i;
const END = /^\s*(\* For the complete|I CERTIFY|Digitally Signed|Filing ID #)/i;
const OPTION = /([\d,]+)\s+(call|put)\s+options?\b.*?strike price of \$([\d,.]+).*?expiration date of (\d{1,2}\/\d{1,2}\/\d{2,4})/is;
const SHARES = /(?:purchased|sold|bought)\s+([\d,]+)\s+shares/i;

const squash = (s) => String(s || '').split(/\s+/).filter(Boolean).join(' ');
const toInt = (s) => parseInt(String(s).replace(/,/g, ''), 10);
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\/-]/g, '\\$&');
const stripChars = (s, chars) => {
  let a = 0;
  let b = s.length;
  while (a < b && chars.includes(s[a])) a += 1;
  while (b > a && chars.includes(s[b - 1])) b -= 1;
  return s.slice(a, b);
};

function amountRange(text) {
  const nums = [...String(text || '').matchAll(/\$([\d,]+)/g)].map((m) => toInt(m[1]));
  return [nums.length ? nums[0] : null, nums.length > 1 ? nums[1] : null];
}

function finishRow(row, filed) {
  const asset = squash(row._asset);
  delete row._asset;
  const ticks = [...asset.matchAll(/\(([A-Z][A-Z0-9.\-/]{0,9})\)/g)].map((m) => m[1]);
  const codes = [...asset.matchAll(/\[([A-Z]{2})\]/g)].map((m) => m[1]);
  row.ticker = ticks.length ? ticks[ticks.length - 1] : null;
  row.assetType = codes.length ? codes[codes.length - 1] : null;
  let name = asset.replace(/\s*\[[A-Z]{2}\]/g, '');
  if (row.ticker) name = name.replace(new RegExp(`\\s*\\(${escapeRe(row.ticker)}\\)`, 'g'), '');
  row.asset = stripChars(name.trim(), ' -');
  row.amount = squash(row.amount);
  [row.amountLow, row.amountHigh] = amountRange(row.amount);
  row.description = squash(row.description) || null;
  const opt = OPTION.exec(row.description || '');
  if (opt) {
    row.option = {
      contracts: toInt(opt[1]),
      kind: opt[2].toLowerCase(),
      strike: parseFloat(opt[3].replace(/,/g, '')),
      expires: iso(opt[4]),
      exercised: /^\s*exercised\b/i.test(row.description)
    };
  }
  const sh = SHARES.exec(row.description || '');
  if (sh) row.shares = toInt(sh[1]);
  if (filed && row.date) {
    const days = daysBetween(row.date, filed);
    row.daysToDisclose = days;
    row.late = days > LATE_DAYS;
  }
  return row;
}

// Like Python's str.splitlines(): pdftotext separates pages with \f.
// eslint-disable-next-line no-control-regex
const splitLines = (text) => String(text || '').split(/\r\n|[\n\r\v\f\x1c-\x1e\x85\u2028\u2029]/);

// Rows from the `pdftotext -layout` style text of a House PTR.
// Returns { name, status, district, docId, filed, rows: [...] }. Each row:
// owner, ownerName, asset, ticker, assetType, type, typeName, date,
// notified, amount, amountLow, amountHigh, status, description, account,
// option { contracts, kind, strike, expires, exercised }, shares,
// daysToDisclose, late.
function parsePtrText(text, filed = null) {
  const head = { name: null, status: null, district: null, docId: null, filed };
  const rows = [];
  let cur = null;
  let mode = null;
  let amountOpen = false;
  for (const raw of splitLines(text)) {
    const line = raw.replace(/\s+$/, '');
    const s = line.trim();
    let m = /^Name:\s+(.*)$/.exec(s);
    if (m && !head.name) {
      head.name = m[1].trim();
      continue;
    }
    m = /^Status:\s+(.*)$/.exec(s);
    if (m && !head.status) {
      head.status = m[1].trim();
      continue;
    }
    m = /^State\/District:\s*(\S+)/.exec(s);
    if (m) {
      head.district = m[1];
      continue;
    }
    m = /Filing ID #(\d+)/.exec(s);
    if (m) {
      head.docId = m[1];
      continue;
    }
    m = /^Digitally Signed:.*?,\s*(\d{2}\/\d{2}\/\d{4})/.exec(s);
    if (m) {
      head.filed = head.filed || iso(m[1]);
      continue;
    }
    const t = TXN.exec(line);
    if (t && iso(t.groups.date)) {
      if (cur) rows.push(cur);
      const owner = t.groups.owner || '';
      cur = {
        owner,
        ownerName: OWNERS[owner] !== undefined ? OWNERS[owner] : owner,
        _asset: t.groups.asset,
        type: t.groups.type,
        typeName: TXN_TYPES[t.groups.type] || t.groups.type,
        date: iso(t.groups.date),
        notified: iso(t.groups.notified),
        amount: t.groups.amount,
        status: null,
        account: null
      };
      amountOpen = cur.amount.endsWith('-');
      mode = 'asset';
      continue;
    }
    if (cur === null) continue;
    if (!s) {
      if (mode === 'description' || mode === 'asset') {
        mode = mode === 'description' || cur._asset.includes('[') ? 'labels' : mode;
      }
      continue;
    }
    if (PAGE_HEADER.test(s)) continue;
    if (END.test(s)) {
      mode = 'labels';
      continue;
    }
    const label = LABELS.map(([k, rx]) => [k, rx.exec(line)]).find(([, lm]) => lm);
    if (label) {
      const [key, lm] = label;
      const value = lm[1].trim();
      if (key === 'description') {
        cur.description = value;
        mode = 'description';
      } else if (key === 'status' || key === 'account') {
        cur[key] = value;
        mode = 'labels';
      } else {
        mode = 'labels';
      }
      continue;
    }
    if (mode === 'asset') {
      const parts = s.split(/\s{2,}/);
      if (amountOpen && /^\$[\d,]+$/.test(parts[parts.length - 1])) {
        cur.amount += ` ${parts.pop()}`;
        amountOpen = false;
      }
      if (parts.length && parts[0]) cur._asset += ` ${parts.join(' ')}`;
    } else if (mode === 'description') {
      cur.description = `${cur.description || ''} ${s}`;
    }
  }
  if (cur) rows.push(cur);
  head.rows = rows.map((r) => finishRow(r, head.filed));
  return head;
}

// ---------------------------------------------------------------- PDF text

const median = (values) => {
  if (!values.length) return null;
  const v = [...values].sort((a, b) => a - b);
  return v[Math.floor(v.length / 2)];
};

// Rebuilds `pdftotext -layout`-like lines from positioned text items:
// pages = [[{ str, x, y, width, fontSize }]] in PDF user space (y grows up).
// Items on the same baseline become one line; horizontal position becomes a
// column (x / average character width), with at least two spaces between
// items that are visibly apart (the parser splits columns on 2+ spaces) and
// a blank line where the vertical gap is larger than the usual line pitch
// (the parser ends a description on a blank line).
function layoutFromItems(pages) {
  const outLines = [];
  (pages || []).forEach((items, pageIndex) => {
    // Small-caps label letters ("FILING STATUS") can come out of pdfjs as NUL
    // characters; as spaces they read like pdftotext's "F      S      :".
    const live = (items || [])
      .filter((it) => it && typeof it.str === 'string')
      .map((it) => (it.str.includes('\u0000') ? Object.assign({}, it, { str: it.str.split('\u0000').join(' ') }) : it))
      .filter((it) => it.str.trim() && Number.isFinite(it.x) && Number.isFinite(it.y));
    if (!live.length) return;
    if (pageIndex > 0 && outLines.length) outLines.push('');
    const widths = live.filter((it) => it.str.length >= 3 && it.width > 0).map((it) => it.width / it.str.length);
    const fontSizes = live.map((it) => it.fontSize || 0).filter((f) => f > 0);
    const fontSize = median(fontSizes) || 10;
    const cw = median(widths) || fontSize * 0.5;

    const sorted = [...live].sort((a, b) => b.y - a.y || a.x - b.x);
    const lines = [];
    sorted.forEach((it) => {
      const tol = Math.max(1.5, (it.fontSize || fontSize) * 0.35);
      const line = lines.find((l) => Math.abs(l.y - it.y) <= tol);
      if (line) line.items.push(it);
      else lines.push({ y: it.y, items: [it] });
    });
    lines.sort((a, b) => b.y - a.y);
    const pitches = [];
    for (let i = 1; i < lines.length; i += 1) pitches.push(lines[i - 1].y - lines[i].y);
    const pitch = median(pitches.filter((p) => p > 0)) || fontSize * 1.2;

    lines.forEach((line, i) => {
      if (i > 0 && lines[i - 1].y - line.y > pitch * 1.6) outLines.push('');
      line.items.sort((a, b) => a.x - b.x);
      let text = '';
      let prevEnd = null;
      line.items.forEach((it) => {
        const col = Math.max(0, Math.round(it.x / cw));
        const str = it.str.replace(/\s+$/, '');
        if (prevEnd === null) {
          text = ' '.repeat(col) + str.replace(/^\s+/, '');
        } else {
          const gap = it.x - prevEnd;
          if (gap < cw * 0.3) {
            text += str;
          } else {
            const minSpaces = gap > cw * 1.5 ? 2 : 1;
            text += ' '.repeat(Math.max(minSpaces, col - text.length)) + str.replace(/^\s+/, '');
          }
        }
        prevEnd = it.x + (it.width > 0 ? it.width : str.length * cw);
      });
      outLines.push(text.replace(/\s+$/, ''));
    });
  });
  return outLines.join('\n');
}

// Text items of every page of a PDF, read with pdfjs-dist (legacy build,
// which runs in Node without a DOM). Loaded lazily: it is an ES module and
// only the scan needs it.
async function readPdfItems(buffer, { maxPages = 40 } = {}) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = pdfjs.getDocument({
    data: new Uint8Array(buffer),
    isEvalSupported: false,
    disableFontFace: true,
    useSystemFonts: false,
    stopAtErrors: false,
    verbosity: 0
  });
  const doc = await task.promise;
  try {
    const pages = [];
    const count = Math.min(doc.numPages, maxPages);
    for (let p = 1; p <= count; p += 1) {
      const page = await doc.getPage(p);
      const content = await page.getTextContent();
      pages.push(
        content.items
          .filter((it) => typeof it.str === 'string')
          .map((it) => ({
            str: it.str,
            x: it.transform[4],
            y: it.transform[5],
            width: it.width,
            fontSize: Math.hypot(it.transform[2], it.transform[3]) || Math.hypot(it.transform[0], it.transform[1])
          }))
      );
      page.cleanup();
    }
    return { pages, pageCount: doc.numPages };
  } finally {
    await task.destroy();
  }
}

// Reads one PTR PDF into { status, rows, report, error }:
//   'parsed'  - text found (rows may still be empty on an odd layout)
//   'no_text' - no text layer: a scanned image, read the PDF itself
//   'error'   - the PDF could not be read
async function readPtrPdf(buffer, { filed = null, extractItems = readPdfItems } = {}) {
  let extracted;
  try {
    if (!buffer || buffer.slice(0, 4).toString('latin1') !== '%PDF') throw new CongressError('not a PDF');
    extracted = await extractItems(buffer);
  } catch (err) {
    return { status: 'error', rows: [], report: null, error: String((err && err.message) || err).slice(0, 300) };
  }
  const itemCount = extracted.pages.reduce((n, items) => n + items.filter((it) => it.str && it.str.trim()).length, 0);
  if (!itemCount) return { status: 'no_text', rows: [], report: null, error: null };
  const text = layoutFromItems(extracted.pages);
  const report = parsePtrText(text, filed);
  return { status: 'parsed', rows: report.rows, report: { name: report.name, status: report.status, district: report.district, docId: report.docId, filed: report.filed }, error: null };
}

// ---------------------------------------------------------------- network

function createDefaultFetchers({ http = axios } = {}) {
  const get = (url, extra = {}) =>
    http.get(url, {
      responseType: 'arraybuffer',
      timeout: REQUEST_TIMEOUT_MS,
      headers: Object.assign({ 'User-Agent': USER_AGENT, Accept: '*/*' }, extra.headers || {}),
      maxContentLength: extra.maxContentLength || 25 * 1024 * 1024,
      validateStatus: (s) => (s >= 200 && s < 300) || s === 304
    });
  return {
    // -> { notModified, data: Buffer, lastModified }
    async fetchIndexZip(year, { ifModifiedSince = null } = {}) {
      const res = await get(INDEX_URL(year), { headers: ifModifiedSince ? { 'If-Modified-Since': ifModifiedSince } : {} });
      if (res.status === 304) return { notModified: true, data: null, lastModified: ifModifiedSince };
      return { notModified: false, data: Buffer.from(res.data), lastModified: (res.headers && res.headers['last-modified']) || null };
    },
    async fetchPdf(url) {
      const res = await get(url, { maxContentLength: 10 * 1024 * 1024 });
      return Buffer.from(res.data);
    }
  };
}

// ---------------------------------------------------------------- the scan

const normTicker = (t) => String(t || '').trim().toUpperCase().replace(/[-/]/g, '.');
const fmtUsd = (n) => `$${Number(n).toLocaleString('en-US')}`;
const TYPE_HE = { P: 'קנייה', S: 'מכירה', 'S (partial)': 'מכירה חלקית', E: 'החלפה' };
const OWNER_HE = { SP: 'בן/בת הזוג', JT: 'משותף', DC: 'ילד/ה', '': 'חבר/ת הקונגרס' };

function buildCongressAlert({ userId, filing, row, rowIndex, security }) {
  const verb = TYPE_HE[row.type] || row.typeName;
  const amount = row.amountLow ? (row.amountHigh ? `${fmtUsd(row.amountLow)}-${fmtUsd(row.amountHigh)}` : `${fmtUsd(row.amountLow)}+`) : row.amount;
  const opt = row.option ? ` (אופציות ${row.option.kind === 'call' ? 'CALL' : 'PUT'}, מחיר מימוש $${row.option.strike}, פקיעה ${row.option.expires})` : '';
  const lag = row.daysToDisclose !== undefined && row.daysToDisclose !== null ? ` דווח ${row.daysToDisclose} ימים אחרי העסקה${row.late ? ' (באיחור, מעל 45 יום)' : ''}.` : '';
  return {
    userId,
    type: 'CONGRESS_TRADE',
    severity: 'info',
    sessionDate: filing.filedDate,
    instrument: { symbol: security.symbol, market: 'US', name: security.name || row.asset, currency: 'USD' },
    title: `${security.symbol}: ${filing.memberName} דיווח/ה על ${verb}`,
    message:
      `${filing.memberName} (${filing.stateDistrict}) דיווח/ה ב-${filing.filedDate} על ${verb} של ${row.asset}${opt} ` +
      `בתאריך ${row.date}, בהיקף ${amount}. בעלים: ${OWNER_HE[row.owner] || row.ownerName}.${lag} ` +
      'דיווח ציבורי לפי חוק STOCK; הסכומים הם טווחים והדיווח מגיע עד 45 יום אחרי העסקה.',
    recommendation: { action: 'NO_ACTION', text: 'מידע ציבורי בלבד, לא ייעוץ השקעות.' },
    congress: { docId: filing.docId, pdfUrl: filing.pdfUrl, ticker: row.ticker, rowIndex, tradeDate: row.date, type: row.type, amount: row.amount },
    dedupKey: `CONGRESS_TRADE:${userId}:${filing.docId}:${row.ticker}:${rowIndex}`
  };
}

const nyToday = (now) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(now);
const addDays = (date, days) => new Date(Date.parse(`${date}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Only one scan at a time per store (the scheduled job and a manual refresh
// can overlap).
const running = new WeakMap();

// Fetches the year's index, stores new PTRs, reads at most `maxParse` of the
// pending PDFs (newest first, one at a time with a pause between them), then
// raises one CONGRESS_TRADE alert per holder of each traded US ticker, for
// filings filed within the last `alertWindowDays`.
async function runCongressScan(opts) {
  const key = opts.congress;
  if (running.has(key)) return Object.assign({ skipped: 'already running' }, await running.get(key));
  const p = scanOnce(opts);
  running.set(key, p);
  try {
    return await p;
  } finally {
    running.delete(key);
  }
}

async function scanOnce({
  store,
  features,
  congress,
  fetchers = createDefaultFetchers(),
  now = new Date(),
  maxParse = 15,
  delayMs = 1500,
  alertWindowDays = 30,
  sleep = defaultSleep,
  extractItems = readPdfItems,
  userIds = null,
  logger = console
}) {
  const today = nyToday(now);
  const year = Number(today.slice(0, 4));
  const years = [year];
  if (today.slice(5, 7) === '01') years.push(year - 1);
  const summary = { years, indexed: 0, newFilings: 0, notModified: [], parsed: 0, noText: 0, failed: 0, alertsCreated: 0, errors: [] };

  for (const y of years) {
    try {
      const metaKey = `index-last-modified:${y}`;
      const prev = await congress.getMeta(metaKey);
      const res = await fetchers.fetchIndexZip(y, { ifModifiedSince: prev });
      if (res.notModified) {
        summary.notModified.push(y);
        continue;
      }
      const ptrs = selectFilings(await parseIndexArchive(res.data, y), { kind: 'P' }).filter((f) => f.docId && f.filed);
      summary.indexed += ptrs.length;
      summary.newFilings += await congress.insertFilings(ptrs);
      if (res.lastModified) await congress.setMeta(metaKey, res.lastModified);
    } catch (err) {
      // A year that is missing (early January) or an outage: keep going with
      // what is already stored.
      summary.errors.push(`index ${y}: ${err.message}`);
    }
  }

  const pending = await congress.listPendingFilings(maxParse);
  const parsedNow = [];
  for (let i = 0; i < pending.length; i += 1) {
    const filing = pending[i];
    if (i > 0 && delayMs > 0) await sleep(delayMs);
    let result;
    try {
      const pdf = await fetchers.fetchPdf(filing.pdfUrl);
      result = await readPtrPdf(pdf, { filed: filing.filedDate, extractItems });
    } catch (err) {
      result = { status: 'error', rows: [], error: String((err && err.message) || err).slice(0, 300) };
    }
    await congress.saveParseResult(filing.docId, result, now.toISOString());
    if (result.status === 'parsed') {
      summary.parsed += 1;
      parsedNow.push(Object.assign({}, filing, { rows: result.rows }));
    } else if (result.status === 'no_text') {
      summary.noText += 1;
    } else {
      summary.failed += 1;
      if (logger && logger.warn) logger.warn(`[congress] ${filing.docId}: ${result.error}`);
    }
  }

  const cutoff = addDays(today, -alertWindowDays);
  const recent = parsedNow.filter((f) => f.filedDate >= cutoff && f.rows.some((r) => r.ticker));
  if (recent.length && features) {
    const { securities } = buildHoldingsIndex(await loadPortfolios(store, userIds));
    const held = new Map(securities.filter((s) => s.market === 'US').map((s) => [normTicker(s.symbol), s]));
    for (const filing of recent) {
      for (let idx = 0; idx < filing.rows.length; idx += 1) {
        const row = filing.rows[idx];
        const security = row.ticker && held.get(normTicker(row.ticker));
        if (!security) continue;
        for (const holder of security.holders) {
          const created = await features.insertAlert(buildCongressAlert({ userId: holder.userId, filing, row, rowIndex: idx, security }));
          if (created) summary.alertsCreated += 1;
        }
      }
    }
  }

  await congress.setMeta('last-scan-at', now.toISOString());
  return summary;
}

// scanOptions: test seams (now, sleep, extractItems, delayMs...).
function createCongressJobHandlers({ store, features, congress, fetchers = null, scanOptions = {} }) {
  return {
    'congress.scan': (payload = {}) =>
      runCongressScan(
        Object.assign(
          {
            store,
            features,
            congress,
            fetchers: fetchers || createDefaultFetchers(),
            now: new Date(),
            maxParse: Math.min(Math.max(Number(payload && payload.maxParse) || 15, 1), 40)
          },
          scanOptions
        )
      )
  };
}

module.exports = {
  INDEX_URL,
  PTR_URL,
  LATE_DAYS,
  CongressError,
  iso,
  parseIndexXml,
  parseIndexTxt,
  parseIndexArchive,
  memberMatch,
  selectFilings,
  parsePtrText,
  layoutFromItems,
  readPdfItems,
  readPtrPdf,
  normTicker,
  buildCongressAlert,
  createDefaultFetchers,
  runCongressScan,
  createCongressJobHandlers
};
