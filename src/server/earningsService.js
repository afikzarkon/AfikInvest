// Ported from day-trader-skill (MIT, Jake Schincariol)
//
// Earnings as filed with the SEC: a company's quarterly numbers read straight
// from EDGAR's XBRL "company facts" (its 10-Qs and 10-Ks), laid out quarter by
// quarter - revenue, gross / operating / net margins, net income, diluted EPS -
// each against the same quarter a year earlier, plus the trailing twelve
// months and the latest earnings 8-K (item 2.02) with its press release.
// A port of trader-analyst/facts.py. This is deliberately separate from
// fundamentals.js (Yahoo / FMP statements feeding the valuation page): here
// every number is the one the company tagged in its own filing.
//
// Sources (SEC asks for a User-Agent with contact details, SEC_USER_AGENT;
// without one nothing is fetched and the caller reports "not configured"):
//   https://www.sec.gov/files/company_tickers.json             ticker -> CIK
//   https://data.sec.gov/api/xbrl/companyfacts/CIK##########.json
//   https://data.sec.gov/submissions/CIK##########.json         filings list
//   https://www.sec.gov/Archives/edgar/data/<cik>/<accession>/index.json
//
// How the quarters are built (same rules as facts.py):
//   - A quarter is a reported value covering 80-100 days. When a period was
//     reported more than once, the latest filing's value wins (restatements),
//     while the fiscal label (fy / fp) comes from the first filing.
//   - There is no Q4 10-Q: Q4 = the 10-K year minus the three quarters inside
//     it, marked "derived" (derived EPS is approximate).
//   - Revenue is read from the first concept a company uses of a fallback list
//     (gaps filled from the later ones). Banks have no gross margin: null.
const axios = require('axios');

const TICKERS_URL = 'https://www.sec.gov/files/company_tickers.json';
const FACTS_URL = (cik) => `https://data.sec.gov/api/xbrl/companyfacts/CIK${cik}.json`;
const SUBMISSIONS_URL = (cik) => `https://data.sec.gov/submissions/CIK${cik}.json`;
const ARCHIVE_URL = (cik, accession) => `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${accession}/`;

const PLACEHOLDER = 'you@example.com';
const TICKERS_TTL_MS = 24 * 60 * 60 * 1000;
const RESULT_TTL_MS = 6 * 60 * 60 * 1000;
const ERROR_TTL_MS = 10 * 60 * 1000;
const MAX_CACHED = 200;
const REQUEST_GAP_MS = 150; // well under SEC's 10 requests a second
const TIMEOUT_MS = 20000;

const CONCEPTS = {
  revenue: [
    'RevenueFromContractWithCustomerExcludingAssessedTax',
    'Revenues',
    'RevenuesNetOfInterestExpense',
    'RevenueFromContractWithCustomerIncludingAssessedTax',
    'SalesRevenueNet',
    'SalesRevenueGoodsNet',
    'SalesRevenueServicesNet'
  ],
  costOfRevenue: ['CostOfGoodsAndServicesSold', 'CostOfRevenue', 'CostOfGoodsSold'],
  grossProfit: ['GrossProfit'],
  operatingIncome: ['OperatingIncomeLoss'],
  netIncome: ['NetIncomeLoss', 'ProfitLoss', 'NetIncomeLossAvailableToCommonStockholdersBasic'],
  epsDiluted: ['EarningsPerShareDiluted', 'EarningsPerShareBasicAndDiluted']
};

const REPORT_FORMS = ['10-Q', '10-K', '20-F', '40-F'];

class EarningsError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code; // 'NOT_FOUND' | 'NO_DATA' | 'UPSTREAM' | 'NOT_CONFIGURED'
  }
}

// ---------------------------------------------------------------- helpers

const DAY_MS = 86400000;
const dayNum = (iso) => Math.round(Date.parse(`${iso}T00:00:00Z`) / DAY_MS);
const isoFromDay = (n) => new Date(n * DAY_MS).toISOString().slice(0, 10);
const daysBetween = (a, b) => dayNum(b) - dayNum(a);

// Python's round(x, n) for the values we print (ties are vanishingly rare in
// these ratios); symmetric around zero, unlike Math.round.
function round(x, digits = 1) {
  const f = 10 ** digits;
  return (Math.sign(x) * Math.round(Math.abs(x) * f)) / f;
}

function pct(a, b) {
  if (a === null || a === undefined || b === null || b === undefined || b === 0) return null;
  return round((100 * (a - b)) / Math.abs(b), 1);
}

function margin(part, whole) {
  if (part === null || part === undefined || !whole) return null;
  return round((100 * part) / whole, 1);
}

function userAgentFromEnv(env = process.env) {
  const ua = String(env.SEC_USER_AGENT || '').trim();
  if (!ua || !ua.includes('@') || ua.includes(PLACEHOLDER)) return null;
  return ua;
}

// ---------------------------------------------------------------- facts

// Raw facts for one us-gaap concept (USD, or USD/shares for EPS).
function factsFor(companyfacts, concept, unitHint) {
  const node = companyfacts && companyfacts.facts && companyfacts.facts['us-gaap'] && companyfacts.facts['us-gaap'][concept];
  if (!node) return [];
  const units = node.units || {};
  const unit = unitHint && units[unitHint] ? unitHint : Object.keys(units)[0];
  return unit ? units[unit] || [] : [];
}

const stampOf = (f) => [f.filed || '', f.accn || ''];
const stampGt = (a, b) => (a[0] !== b[0] ? a[0] > b[0] : a[1] > b[1]);
const stampLt = (a, b) => (a[0] !== b[0] ? a[0] < b[0] : a[1] < b[1]);

// { "start|end": fact } for duration facts from 10-Q / 10-K. Value from the
// latest filing, fiscal label from the first one.
function periods(facts) {
  const latest = new Map();
  const first = new Map();
  for (const f of facts || []) {
    if (!f || !f.start || !REPORT_FORMS.includes(String(f.form || '').split('/')[0])) continue;
    const key = `${f.start}|${f.end}`;
    const stamp = stampOf(f);
    if (!latest.has(key) || stampGt(stamp, stampOf(latest.get(key)))) latest.set(key, f);
    if (!first.has(key) || stampLt(stamp, stampOf(first.get(key)))) first.set(key, f);
  }
  const out = new Map();
  for (const [key, f] of latest) {
    const firstFact = first.get(key);
    out.set(key, Object.assign({}, f, { fy: firstFact.fy, fp: firstFact.fp, firstFiled: firstFact.filed }));
  }
  return out;
}

// { end: { value, start, end, derived, fy, fp, form, filed } } three-month values.
function quarterly(facts, deriveQ4 = true) {
  const q = {};
  const years = [];
  for (const f of periods(facts).values()) {
    const days = daysBetween(f.start, f.end);
    if (days >= 80 && days <= 100) {
      q[f.end] = { value: f.val, start: f.start, end: f.end, derived: false, fy: f.fy, fp: f.fp, form: f.form, filed: f.filed };
    } else if (days >= 350 && days <= 380) {
      years.push(f);
    }
  }
  if (deriveQ4) {
    for (const f of years) {
      if (q[f.end]) continue;
      const inside = Object.values(q)
        .filter((v) => v.start >= f.start && v.end < f.end)
        .sort((a, b) => (a.end < b.end ? -1 : a.end > b.end ? 1 : 0));
      if (inside.length !== 3) continue;
      q[f.end] = {
        value: f.val - inside.reduce((s, v) => s + v.value, 0),
        start: isoFromDay(dayNum(inside[2].end) + 1),
        end: f.end,
        derived: true,
        fy: f.fy,
        fp: 'Q4',
        form: f.form,
        filed: f.filed
      };
    }
  }
  return q;
}

// Quarterly series for a metric: its concepts in order, later ones filling gaps.
function series(companyfacts, key, deriveQ4 = true) {
  const unit = key === 'epsDiluted' ? 'USD/shares' : 'USD';
  const merged = {};
  const used = [];
  for (const concept of CONCEPTS[key]) {
    const q = quarterly(factsFor(companyfacts, concept, unit), deriveQ4);
    let added = false;
    for (const [end, v] of Object.entries(q)) {
      if (!merged[end]) {
        merged[end] = Object.assign({}, v, { concept });
        added = true;
      }
    }
    if (added) used.push(concept);
  }
  return { series: merged, concepts: used };
}

// The quarter about a year before `end` (within 10 days), or null.
function yoyMatch(seriesObj, end, days = 365, slack = 10) {
  const target = dayNum(end) - days;
  let best = null;
  for (const e of Object.keys(seriesObj)) {
    const gap = Math.abs(dayNum(e) - target);
    if (gap <= slack && (best === null || gap < best[0])) best = [gap, e];
  }
  return best ? seriesObj[best[1]] : null;
}

const valueAt = (s, end) => (s[end] ? s[end].value : null);

function grossProfitAt(s, end) {
  const gp = valueAt(s.grossProfit, end);
  if (gp !== null) return gp;
  const r = valueAt(s.revenue, end);
  const cost = valueAt(s.costOfRevenue, end);
  return r !== null && cost !== null ? r - cost : null;
}

const pointChange = (cur, prior) => (cur === null || prior === null ? null : round(cur - prior, 1));

// Every number for the page, as plain data.
function analyse(companyfacts, { quarters = 8, name = null } = {}) {
  const s = {};
  const concepts = {};
  for (const key of Object.keys(CONCEPTS)) {
    const r = series(companyfacts, key, true);
    s[key] = r.series;
    concepts[key] = r.concepts;
  }
  const rev = s.revenue;
  if (!Object.keys(rev).length && !Object.keys(s.netIncome).length) {
    throw new EarningsError('no quarterly revenue or net income in the XBRL facts', 'NO_DATA');
  }
  const ends = Array.from(new Set(Object.keys(rev).concat(Object.keys(s.netIncome))))
    .sort()
    .reverse()
    .slice(0, quarters);

  const rows = ends.map((end) => {
    const r = valueAt(rev, end);
    const gp = grossProfitAt(s, end);
    const oi = valueAt(s.operatingIncome, end);
    const ni = valueAt(s.netIncome, end);
    const eps = valueAt(s.epsDiluted, end);
    const prior = {
      revenue: yoyMatch(rev, end),
      netIncome: yoyMatch(s.netIncome, end),
      epsDiluted: yoyMatch(s.epsDiluted, end)
    };
    const base = rev[end] || s.netIncome[end] || {};
    const grossMargin = margin(gp, r);
    const operatingMargin = margin(oi, r);
    const netMargin = margin(ni, r);
    // Margins a year earlier, read at the matched revenue quarter.
    const pe = prior.revenue ? prior.revenue.end : null;
    const priorRev = pe ? valueAt(rev, pe) : null;
    const priorMargin = (v) => (pe ? margin(v, priorRev) : null);
    return {
      end,
      start: base.start || null,
      fiscal: `${base.fp || ''} ${base.fy || ''}`,
      derived: Boolean((rev[end] && rev[end].derived) || (s.netIncome[end] && s.netIncome[end].derived)),
      revenue: r,
      grossProfit: gp,
      operatingIncome: oi,
      netIncome: ni,
      epsDiluted: eps !== null ? round(eps, 2) : null,
      grossMargin,
      operatingMargin,
      netMargin,
      revenueYoy: pct(r, prior.revenue ? prior.revenue.value : null),
      netIncomeYoy: pct(ni, prior.netIncome ? prior.netIncome.value : null),
      epsYoy: pct(eps, prior.epsDiluted ? prior.epsDiluted.value : null),
      grossMarginYoyPt: pe ? pointChange(grossMargin, priorMargin(grossProfitAt(s, pe))) : null,
      operatingMarginYoyPt: pe ? pointChange(operatingMargin, priorMargin(valueAt(s.operatingIncome, pe))) : null,
      netMarginYoyPt: pe ? pointChange(netMargin, priorMargin(valueAt(s.netIncome, pe))) : null,
      filed: base.filed || null,
      form: base.form || null
    };
  });

  const ttm = {};
  for (const key of ['revenue', 'netIncome', 'epsDiluted']) {
    const last4 = Object.keys(s[key]).sort().slice(-4);
    if (last4.length === 4 && daysBetween(last4[0], last4[3]) < 300) {
      ttm[key] = last4.reduce((sum, e) => sum + s[key][e].value, 0);
    }
  }
  if (ttm.epsDiluted !== undefined) ttm.epsDiluted = round(ttm.epsDiluted, 2);
  if (ttm.revenue !== undefined) {
    ttm.periodEnd = Object.keys(s.revenue).sort().slice(-1)[0];
    if (ttm.netIncome !== undefined) ttm.netMargin = margin(ttm.netIncome, ttm.revenue);
  }

  return {
    entity: name || companyfacts.entityName || null,
    cik: String(companyfacts.cik === undefined ? '' : companyfacts.cik).padStart(10, '0'),
    rows,
    ttm,
    concepts
  };
}

// When SEC's facts lag a report that is already filed: the facts end, and
// the filing to read instead. Null when the facts are current.
function staleNote(result, filings) {
  const rep = filings && filings.report;
  if (!rep || !result.rows.length || !rep.period) return null;
  const latest = result.rows[0].end;
  if (rep.period > latest && daysBetween(latest, rep.period) > 20) {
    return { factsEnd: latest, form: rep.form, period: rep.period, filed: rep.filed, url: rep.url };
  }
  return null;
}

// ---------------------------------------------------------------- filings

const EXHIBIT_RANK = [/ex(?:hibit)?[-_]?99[-_.]?0?1(?!\d)/i, /ex(?:hibit)?[-_]?99/i, /earnings|release|press/i, /ex(?:hibit)?[-_]?\d/i];

// The press release among a filing's files (EX-99.1 by its usual names).
function exhibitName(names, primary = null) {
  const docs = (names || []).filter(
    (n) => /\.(htm|html|txt|pdf)$/i.test(n) && n !== primary && !/^(R\d+\.htm|\d{10}-\d{2}-\d{6})/.test(n)
  );
  for (const rx of EXHIBIT_RANK) {
    const hits = docs.filter((n) => rx.test(n)).sort();
    if (hits.length) return hits[0];
  }
  return null;
}

// Newest 10-Q / 10-K and newest earnings 8-K (item 2.02). `fetchIndex(url)`,
// when given, reads the 8-K folder's index.json to find the EX-99 exhibit.
async function latestFilings(submissions, cik, fetchIndex = null) {
  const rec = (submissions && submissions.filings && submissions.filings.recent) || {};
  const out = { report: null, earnings8k: null };
  const forms = rec.form || [];
  for (let i = 0; i < forms.length; i += 1) {
    const form = forms[i];
    const acc = rec.accessionNumber[i];
    const folder = ARCHIVE_URL(cik, acc.replace(/-/g, ''));
    if (!out.report && REPORT_FORMS.includes(form)) {
      out.report = { form, filed: rec.filingDate[i], period: rec.reportDate[i], accession: acc, url: folder + rec.primaryDocument[i] };
    }
    const items = (rec.items && rec.items[i]) || '';
    if (!out.earnings8k && form === '8-K' && items.includes('2.02')) {
      const e = { form, filed: rec.filingDate[i], accession: acc, url: folder + rec.primaryDocument[i], exhibit: null, index: `${folder}${acc}-index.htm` };
      if (fetchIndex) {
        try {
          const idx = await fetchIndex(`${folder}index.json`);
          const names = ((idx && idx.directory && idx.directory.item) || []).map((it) => it.name);
          const pick = exhibitName(names, rec.primaryDocument[i]);
          if (pick) e.exhibit = folder + pick;
        } catch {
          // no exhibit link; the filing index still is
        }
      }
      out.earnings8k = e;
    }
    if (out.report && out.earnings8k) break;
  }
  return out;
}

// ---------------------------------------------------------------- tickers

const cleanTitle = (title) => String(title || '').replace(/\s*\/[A-Z]{2,5}\/?\s*$/, '').trim() || null;
const tickerKey = (t) => String(t || '').toUpperCase().replace(/-/g, '.');

// ticker -> { cik (10 digits), name } from company_tickers.json.
function tickerMap(data) {
  const out = new Map();
  for (const v of Object.values(data || {})) {
    if (!v || !v.ticker) continue;
    const k = tickerKey(v.ticker);
    if (!out.has(k)) out.set(k, { cik: String(v.cik_str).padStart(10, '0'), name: cleanTitle(v.title) });
  }
  return out;
}

// ---------------------------------------------------------------- service

function defaultFetchJson(userAgent) {
  let chain = Promise.resolve();
  let last = 0;
  return (url) => {
    const run = chain.then(async () => {
      const wait = REQUEST_GAP_MS - (Date.now() - last);
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      last = Date.now();
      try {
        const res = await axios.get(url, {
          timeout: TIMEOUT_MS,
          headers: { 'User-Agent': userAgent, 'Accept-Encoding': 'gzip, deflate', Accept: 'application/json' },
          maxContentLength: 80 * 1024 * 1024
        });
        return res.data;
      } catch (err) {
        const status = err.response && err.response.status;
        if (status === 404) throw new EarningsError(`SEC has no data at ${url}`, 'NOT_FOUND');
        throw new EarningsError(`SEC request failed (${status || err.code || err.message})`, 'UPSTREAM');
      }
    });
    chain = run.catch(() => {});
    return run;
  };
}

// createEarningsService({ userAgent, fetchJson, now }) -> { configured, getEarnings(symbol) }
// fetchJson(url) -> parsed JSON (injected in tests). Results are cached per
// CIK for 6 hours (failures for 10 minutes), the ticker list for a day.
function createEarningsService({ userAgent = userAgentFromEnv(), fetchJson = null, now = () => Date.now(), quarters = 8 } = {}) {
  const configured = Boolean(userAgent) || Boolean(fetchJson);
  const get = fetchJson || (userAgent ? defaultFetchJson(userAgent) : null);
  let tickers = null; // { map, at }
  let tickersInflight = null;
  const cache = new Map(); // cik -> { at, ttl, value | error }
  const inflight = new Map();

  async function loadTickers() {
    if (tickers && now() - tickers.at < TICKERS_TTL_MS) return tickers.map;
    if (!tickersInflight) {
      tickersInflight = get(TICKERS_URL)
        .then((data) => {
          tickers = { map: tickerMap(data), at: now() };
          return tickers.map;
        })
        .finally(() => {
          tickersInflight = null;
        });
    }
    return tickersInflight;
  }

  async function build(cik, name) {
    const facts = await get(FACTS_URL(cik));
    const result = analyse(facts, { quarters, name });
    let filings = { report: null, earnings8k: null };
    try {
      const sub = await get(SUBMISSIONS_URL(cik));
      filings = await latestFilings(sub, cik, get);
    } catch {
      // the numbers stand without the filing links
    }
    return Object.assign(result, { filings, staleNote: staleNote(result, filings) });
  }

  async function getEarnings(symbol) {
    if (!configured) throw new EarningsError('SEC_USER_AGENT is not set', 'NOT_CONFIGURED');
    const map = await loadTickers();
    const hit = map.get(tickerKey(symbol));
    if (!hit) throw new EarningsError(`no SEC CIK for ${symbol}`, 'NOT_FOUND');
    const { cik, name } = hit;
    const cached = cache.get(cik);
    if (cached && now() - cached.at < cached.ttl) {
      if (cached.error) throw cached.error;
      return cached.value;
    }
    if (!inflight.has(cik)) {
      const p = build(cik, name)
        .then((value) => {
          cache.set(cik, { at: now(), ttl: RESULT_TTL_MS, value });
          return value;
        })
        .catch((error) => {
          if (error instanceof EarningsError && error.code !== 'UPSTREAM') cache.set(cik, { at: now(), ttl: ERROR_TTL_MS, error });
          throw error;
        })
        .finally(() => {
          inflight.delete(cik);
          if (cache.size > MAX_CACHED) cache.delete(cache.keys().next().value);
        });
      inflight.set(cik, p);
    }
    return inflight.get(cik);
  }

  return { configured, getEarnings };
}

module.exports = {
  CONCEPTS,
  EarningsError,
  userAgentFromEnv,
  factsFor,
  periods,
  quarterly,
  series,
  yoyMatch,
  pct,
  margin,
  analyse,
  staleNote,
  exhibitName,
  latestFilings,
  cleanTitle,
  tickerMap,
  createEarningsService,
  TICKERS_URL,
  FACTS_URL,
  SUBMISSIONS_URL
};
