// Ported from day-trader-skill (MIT, Jake Schincariol)
//
// News on the user's holdings: Yahoo Finance headline RSS per US ticker and
// each company's 8-K filings from SEC EDGAR, tagged (earnings, analyst, deal,
// halt, regulatory, macro, ... and the 8-K item codes in Hebrew), merged so
// one story shows once, newest first, with times as ISO strings.
//
// Sources, one request each per ticker (cached per symbol, see
// createNewsService):
//   https://feeds.finance.yahoo.com/rss/2.0/headline?s=<TICKER>&region=US&lang=en-US
//   https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=<CIK>&type=8-K&count=10&output=atom
//   https://www.sec.gov/files/company_tickers.json   (ticker -> CIK, cached a day)
//
// SEC asks every automated client for a User-Agent with contact details.
// It comes from SEC_USER_AGENT; without one (or with a placeholder) SEC is
// never called and callers get secConfigured: false.
//
// The parsing functions are pure and exported, and are tested against
// feeds recorded by the original Python tool (fixtures/news/).
const { ITEMS_8K_HE } = require('../shared/newsTags');

const YAHOO_RSS = 'https://feeds.finance.yahoo.com/rss/2.0/headline?s=%s&region=US&lang=en-US';
const SEC_FEED = 'https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=%c&type=%f&dateb=&owner=include&count=%n&output=atom';
const TICKERS_URL = 'https://www.sec.gov/files/company_tickers.json';
const PLACEHOLDER = 'you@example.com';
const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const IMPORTANT_ITEMS = new Set(['1.03', '1.05', '2.02', '2.04', '2.06', '3.01', '4.02', '5.01', '5.02']);

// Which 8-K items raise a holder alert, and how loud. Items not listed
// (7.01 Reg FD, 8.01 other events, 9.01 exhibits, 5.07 vote results, ...)
// show in the feed but do not alert.
const FILING_SEVERITY = {
  '1.03': 'critical', // bankruptcy
  '4.02': 'critical', // past financials no longer reliable
  '3.01': 'critical', // delisting notice
  '1.05': 'critical', // cybersecurity incident
  '2.04': 'critical', // debt acceleration
  '5.01': 'critical', // change in control
  '5.02': 'warning', // director or officer change
  '1.01': 'warning', // material agreement (M&A)
  '2.01': 'warning', // acquisition or sale of assets
  '2.06': 'warning', // impairment
  '2.05': 'warning', // restructuring
  '1.02': 'warning', // material agreement ended
  '4.01': 'warning', // auditor change
  '2.02': 'info', // earnings results (expected, on the calendar)
  '2.03': 'info', // new debt
  '3.03': 'info' // shareholder rights change
};
const SEVERITY_RANK = { info: 1, warning: 2, critical: 3 };

const KEYWORDS = [
  ['earnings', /\bearnings\b|\bresults\b|\bEPS\b|\bguidance\b|\bforecast\b/i],
  ['analyst', /\bupgrade[sd]?\b|\bdowngrade[sd]?\b|price target|\boutperform\b|\bunderperform\b/i],
  ['legal', /\blawsuit\b|\bsued\b|\bprobe\b|\binvestigation\b|\bSEC charges\b|\bantitrust\b|\bjudge\b|\bcourt\b/i],
  ['deal', /\bacqui(?:re|res|red|sition)\b|\bmerger\b|\bbuyout\b|\btakeover\b|\bdeal\b/i],
  ['capital', /\bdividend\b|\bbuyback\b|\brepurchase\b|\bstock split\b|\boffering\b/i],
  ['people', /\bCEO\b|\bCFO\b|\bresign|\bsteps down\b|\bappoint/i],
  ['risk', /\brecall\b|\bbankrupt|\bdefault\b|\bdelist|\bhack|\bbreach\b|\boutage\b/i],
  ['halt', /\bhalt(?:s|ed)?\b|\btrading (?:pause|suspen)/i],
  ['regulatory', /\bFDA\b|\bapproval\b|\bapproves\b|\bclinical\b|\bFTC\b|\bDOJ\b/i],
  ['macro', /\bFed\b|\bFOMC\b|\bCPI\b|\binflation\b|\bjobs report\b|\bpayrolls\b|\btariffs?\b|\bfutures\b/i]
];

// 8-K items that imply a tag even when the wording does not.
const ITEM_TAGS = { '2.02': 'earnings', '5.02': 'people', '1.01': 'deal', '2.01': 'deal', '5.01': 'deal', '1.03': 'risk', '3.01': 'risk', '4.02': 'risk', '1.05': 'risk' };

class NewsError extends Error {}

// ---------------------------------------------------------------- helpers

const TICKER_RE = /^[A-Z][A-Z0-9]{0,6}(?:[.-][A-Z0-9]{1,3})?$/;

function normalizeTicker(raw) {
  const t = String(raw || '').trim().toUpperCase();
  return TICKER_RE.test(t) ? t : null;
}

// Yahoo writes share classes with a dash, SEC's list with a dash too, the
// app's lots with whatever the user typed; compare on the dotted form.
const yahooSymbol = (ticker) => String(ticker).toUpperCase().replace(/\./g, '-');
const dottedSymbol = (ticker) => String(ticker).toUpperCase().replace(/-/g, '.');

function secUserAgentFrom(value) {
  const ua = String(value || '').trim();
  if (!ua || !ua.includes('@') || ua.includes(PLACEHOLDER)) return null;
  return ua;
}

// RFC 822 (RSS) or ISO 8601 (Atom) -> ISO string in UTC, or null.
function parseTime(value) {
  const v = String(value || '').trim();
  if (!v || !/\d/.test(v)) return null;
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

// ---------------------------------------------------------------- XML

const NAMED_ENTITIES = { lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function decodeXml(raw) {
  const s = String(raw || '');
  const cdata = s.match(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/);
  if (cdata) return cdata[1];
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_m, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_m, d) => String.fromCodePoint(Number(d)))
    .replace(/&(lt|gt|quot|apos|nbsp);/g, (_m, n) => NAMED_ENTITIES[n])
    .replace(/&amp;/g, '&');
}

function blocks(xml, tag) {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'g');
  const out = [];
  let m;
  while ((m = re.exec(xml))) out.push(m[1]);
  return out;
}

function childText(block, tag) {
  const m = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`).exec(block);
  return m ? decodeXml(m[1]).trim() : '';
}

function childAttr(block, tag, name) {
  const m = new RegExp(`<${tag}\\s[^>]*\\b${name}="([^"]*)"`).exec(block);
  return m ? decodeXml(m[1]) : '';
}

const stripHtml = (s) => decodeXml(String(s || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
const clip = (s, n = 400) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

function asText(data) {
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  return String(data || '');
}

// ---------------------------------------------------------------- parsing

// Yahoo headline RSS -> items.
function parseRss(data, ticker) {
  const xml = asText(data);
  if (!/<rss[\s>]/.test(xml) && !/<channel[\s>]/.test(xml)) throw new NewsError(`RSS for ${ticker} is not valid`);
  return blocks(xml, 'item').map((it) => {
    const link = childText(it, 'link');
    const guid = childText(it, 'guid') || link;
    return {
      id: `rss:${guid}`,
      source: 'yahoo',
      kind: 'headline',
      ticker,
      title: stripHtml(childText(it, 'title')),
      summary: clip(stripHtml(childText(it, 'description'))),
      link,
      time: parseTime(childText(it, 'pubDate'))
    };
  });
}

// EDGAR company filings Atom -> items.
function parseSecAtom(data, ticker) {
  const xml = asText(data);
  if (!/<feed[\s>]/.test(xml)) throw new NewsError(`SEC feed for ${ticker} is not valid`);
  const company = childText(xml, 'conformed-name');
  return blocks(xml, 'entry').map((entry) => {
    const form = childText(entry, 'filing-type');
    const accession = childText(entry, 'accession-number');
    const items = childText(entry, 'items-desc').match(/\d+\.\d+/g) || [];
    const itemLabels = items.filter((i) => i !== '9.01').map((i) => ITEMS_8K_HE[i] || `סעיף ${i}`);
    let title = `${company || ticker} הגישה דיווח ${form}`;
    if (itemLabels.length) title += `: ${itemLabels.join(', ')}`;
    return {
      id: `sec:${accession}`,
      source: 'sec',
      kind: 'filing',
      form,
      accession,
      company,
      ticker,
      title,
      summary: childText(entry, 'form-name'),
      items,
      itemLabels,
      important: items.some((i) => IMPORTANT_ITEMS.has(i)),
      link: childAttr(entry, 'link', 'href') || childText(entry, 'filing-href'),
      time: parseTime(childText(entry, 'updated'))
    };
  });
}

// SEC company_tickers.json -> { 'BRK.B': '0001067983', ... } (first listing wins).
function parseCompanyTickers(data) {
  const doc = typeof data === 'string' || Buffer.isBuffer(data) ? JSON.parse(asText(data)) : data;
  const out = {};
  Object.values(doc || {}).forEach((v) => {
    if (!v || !v.ticker || v.cik_str === undefined) return;
    const key = dottedSymbol(v.ticker);
    if (!out[key]) out[key] = String(v.cik_str).padStart(10, '0');
  });
  return out;
}

// ---------------------------------------------------------------- tagging

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const NAME_SUFFIX_RE = /[\s,]+(inc|incorporated|corp|corporation|co|company|ltd|limited|plc|holdings?|group|n\.?v|s\.?a|ag|se|class [a-c]|\/[a-z]+\/?)\.?$/i;

// "Apple Inc." -> "Apple", "The Coca-Cola Company" -> "Coca-Cola".
function shortCompanyName(name) {
  let n = String(name || '').trim().replace(/^the\s+/i, '');
  for (let i = 0; i < 3; i += 1) n = n.replace(NAME_SUFFIX_RE, '').trim();
  return n.replace(/[.,]+$/, '');
}

function mentionPatterns(watch) {
  const pats = {};
  Object.entries(watch || {}).forEach(([t, name]) => {
    const e = escapeRe(t);
    const alts = [`\\(${e}\\)`, `\\$${e}\\b`, `\\b(?:NYSE|NASDAQ|Nasdaq)\\s*:\\s*${e}\\b`];
    const short = shortCompanyName(name);
    if (short && short.length >= 4) alts.push(`\\b${escapeRe(short).replace(/ /g, '[\\s-]')}\\b`);
    pats[t] = new RegExp(alts.join('|'));
  });
  return pats;
}

// watch: { TICKER: companyName | null }. Adds touches (which of the
// tickers each item mentions) and tags (topic keys, see shared/newsTags.js).
function tagItems(items, watch) {
  const pats = mentionPatterns(watch);
  items.forEach((it) => {
    const hay = `${it.title} ${it.summary || ''}`;
    const touches = new Set(watch && Object.prototype.hasOwnProperty.call(watch, it.ticker) ? [it.ticker] : []);
    Object.entries(pats).forEach(([t, rx]) => {
      if (rx.test(hay)) touches.add(t);
    });
    it.touches = [...touches].sort();
    // A filing's title is generated in Hebrew; tag on its English form name and items only.
    const tagHay = it.kind === 'filing' ? it.summary || '' : hay;
    const tags = KEYWORDS.filter(([, rx]) => rx.test(tagHay)).map(([label]) => label);
    if (it.kind === 'filing') {
      (it.items || []).forEach((code) => {
        const t = ITEM_TAGS[code];
        if (t && !tags.includes(t)) tags.push(t);
      });
      if ((it.items || []).includes('2.02')) tags.sort((a, b) => (a === 'earnings' ? -1 : b === 'earnings' ? 1 : 0));
    }
    it.tags = tags;
  });
  return items;
}

const normTitle = (title) => String(title || '').toLowerCase().replace(/[^\p{L}\p{N}_]+/gu, ' ').trim();

// One item per story: same id, or same link, or same title the same day.
function dedupe(items) {
  const seen = new Map();
  const out = [];
  items.forEach((it) => {
    const keys = [it.id, it.link, `${normTitle(it.title)}|${it.time ? it.time.slice(0, 10) : ''}`].filter(Boolean);
    const hit = keys.map((k) => seen.get(k)).find(Boolean);
    if (hit) {
      (it.touches || []).forEach((t) => {
        if (!hit.touches.includes(t)) hit.touches.push(t);
      });
      hit.touches.sort();
      return;
    }
    keys.forEach((k) => seen.set(k, it));
    out.push(it);
  });
  return out;
}

// Items inside the window (nothing from after `now`, allowing 10 minutes of
// clock skew), newest first. Items with no time are kept and sort as `now`.
function selectWindow(items, now, hours = 72) {
  const nowMs = now.getTime();
  const cutoff = nowMs - hours * 3600 * 1000;
  const ahead = nowMs + 10 * 60 * 1000;
  const ms = (it) => (it.time ? Date.parse(it.time) : nowMs);
  return items
    .filter((it) => {
      if (!it.time) return true;
      const t = Date.parse(it.time);
      return t >= cutoff && t <= ahead;
    })
    .sort((a, b) => ms(b) - ms(a));
}

// The alert severity of a filing (highest of its items), or null when none
// of its items is material.
function filingSeverity(filing) {
  let best = null;
  (filing.items || []).forEach((code) => {
    const s = FILING_SEVERITY[code];
    if (s && (!best || SEVERITY_RANK[s] > SEVERITY_RANK[best])) best = s;
  });
  return best;
}

// ---------------------------------------------------------------- fetching

function defaultFetchers() {
  const axios = require('axios');
  const getText = async (url, headers) => {
    const r = await axios.get(url, { timeout: 12000, responseType: 'text', transformResponse: (d) => d, headers, maxContentLength: 5 * 1024 * 1024 });
    return r.data;
  };
  return {
    yahooRss: (symbol) =>
      getText(YAHOO_RSS.replace('%s', encodeURIComponent(yahooSymbol(symbol))), {
        'User-Agent': BROWSER_UA,
        Accept: 'application/rss+xml, application/xml, text/xml'
      }),
    secAtom: (cik, form, { userAgent, count = 10 }) =>
      getText(SEC_FEED.replace('%c', cik).replace('%f', encodeURIComponent(form)).replace('%n', String(count)), {
        'User-Agent': userAgent,
        Accept: 'application/atom+xml, application/xml'
      }),
    companyTickers: ({ userAgent }) => getText(TICKERS_URL, { 'User-Agent': userAgent, Accept: 'application/json' })
  };
}

async function mapLimit(list, limit, fn) {
  const out = new Array(list.length);
  let next = 0;
  const worker = async () => {
    while (next < list.length) {
      const i = next;
      next += 1;
      out[i] = await fn(list[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, list.length) }, worker));
  return out;
}

// fetchers: { yahooRss(symbol) -> xml, secAtom(cik, form, { userAgent }) -> xml,
//             companyTickers({ userAgent }) -> json } (tests inject these).
// secUserAgent: string or () => string; defaults to process.env.SEC_USER_AGENT.
function createNewsService({
  fetchers = null,
  secUserAgent = () => process.env.SEC_USER_AGENT,
  cacheTtlMs = 12 * 60 * 1000,
  errorTtlMs = 2 * 60 * 1000,
  cikTtlMs = 24 * 3600 * 1000,
  secGapMs = 150,
  yahooConcurrency = 4,
  clock = () => Date.now()
} = {}) {
  const f = Object.assign({}, fetchers ? {} : defaultFetchers(), fetchers || {});
  const cache = new Map(); // key -> { ts, ttl, value, error }
  const inFlight = new Map();
  let lastSec = 0;
  let secQueue = Promise.resolve();

  const userAgent = () => secUserAgentFrom(typeof secUserAgent === 'function' ? secUserAgent() : secUserAgent);

  async function cached(key, ttl, load) {
    const hit = cache.get(key);
    if (hit && clock() - hit.ts < (hit.error ? errorTtlMs : ttl)) {
      if (hit.error) throw hit.error;
      return hit.value;
    }
    if (inFlight.has(key)) return inFlight.get(key);
    const p = (async () => {
      try {
        const value = await load();
        cache.set(key, { ts: clock(), value });
        return value;
      } catch (err) {
        const error = err instanceof NewsError ? err : new NewsError(String((err && err.message) || err));
        cache.set(key, { ts: clock(), error });
        throw error;
      } finally {
        inFlight.delete(key);
      }
    })();
    inFlight.set(key, p);
    return p;
  }

  // SEC allows 10 requests a second; stay far below by queueing ours.
  function secCall(fn) {
    const run = secQueue.then(async () => {
      const wait = lastSec + secGapMs - clock();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      lastSec = clock();
      return fn();
    });
    secQueue = run.catch(() => {});
    return run;
  }

  async function cikMap() {
    const ua = userAgent();
    if (!ua) throw new NewsError('SEC_USER_AGENT not set');
    return cached('sec:tickers', cikTtlMs, async () => parseCompanyTickers(await secCall(() => f.companyTickers({ userAgent: ua }))));
  }

  function headlines(symbol) {
    return cached(`yahoo:${symbol}`, cacheTtlMs, async () => parseRss(await f.yahooRss(symbol), symbol));
  }

  async function filings(symbol, form = '8-K') {
    const ua = userAgent();
    if (!ua) throw new NewsError('SEC_USER_AGENT not set');
    const ciks = await cikMap();
    const cik = ciks[dottedSymbol(symbol)];
    if (!cik) return [];
    return cached(`sec:${form}:${cik}:${symbol}`, cacheTtlMs, async () =>
      parseSecAtom(await secCall(() => f.secAtom(cik, form, { userAgent: ua })), symbol)
    );
  }

  // symbols: tickers; names: { TICKER: company name } for mention matching.
  async function getNews({ symbols, names = {}, hours = 72, now = new Date(clock()) }) {
    const list = [...new Set((symbols || []).map(normalizeTicker).filter(Boolean))];
    const secConfigured = Boolean(userAgent());
    const errors = [];
    let items = [];

    const yahoo = await mapLimit(list, yahooConcurrency, async (s) => {
      try {
        return await headlines(s);
      } catch (err) {
        errors.push({ symbol: s, source: 'yahoo', message: err.message });
        return [];
      }
    });
    yahoo.forEach((arr) => {
      items = items.concat(arr);
    });

    let secReady = secConfigured;
    if (secReady && list.length) {
      try {
        await cikMap();
      } catch (err) {
        errors.push({ symbol: null, source: 'sec', message: `SEC ticker list: ${err.message}` });
        secReady = false;
      }
    }
    if (secReady) {
      for (const s of list) {
        try {
          items = items.concat(await filings(s));
        } catch (err) {
          errors.push({ symbol: s, source: 'sec', message: err.message });
        }
      }
    }

    const watch = {};
    list.forEach((s) => {
      watch[s] = names[s] || null;
    });
    // Copies: the cached arrays are shared between users with different watches.
    const tagged = tagItems(items.map((it) => Object.assign({}, it)), watch);
    return { items: selectWindow(dedupe(tagged), now, hours), errors, secConfigured };
  }

  return {
    getNews,
    getFilings: filings,
    getHeadlines: headlines,
    isSecConfigured: () => Boolean(userAgent()),
    clearCache: () => cache.clear()
  };
}

module.exports = {
  NewsError,
  FILING_SEVERITY,
  IMPORTANT_ITEMS,
  normalizeTicker,
  yahooSymbol,
  dottedSymbol,
  secUserAgentFrom,
  parseTime,
  decodeXml,
  parseRss,
  parseSecAtom,
  parseCompanyTickers,
  shortCompanyName,
  tagItems,
  dedupe,
  selectWindow,
  filingSeverity,
  createNewsService
};
