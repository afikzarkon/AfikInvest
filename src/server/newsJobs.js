// Ported from day-trader-skill (MIT, Jake Schincariol)
//
// 'news.scan': for every US security anyone holds, read the company's
// recent 8-K filings on SEC EDGAR and alert each holder once per material
// filing (earnings 2.02, officer change 5.02, M&A 1.01/2.01, bankruptcy
// 1.03, restatement 4.02, delisting 3.01, ...). One SEC request per
// company, shared by all its holders; the dedup key (user + accession
// number) makes a filing alert once however often the scan runs.
const { buildHoldingsIndex, loadPortfolios } = require('./holdingsIndex');
const { dateInTimeZone } = require('./marketCalendar');
const { createNewsService, filingSeverity } = require('./newsService');

function buildFilingAlert({ userId, instrument, filing, severity }) {
  const labels = (filing.itemLabels || []).join(', ') || 'דיווח שוטף';
  const date = filing.time ? dateInTimeZone(new Date(filing.time), 'America/New_York') : null;
  const who = instrument.name || filing.company || instrument.symbol;
  return {
    userId,
    type: 'NEWS_FILING',
    severity,
    sessionDate: date,
    instrument,
    title: `${instrument.symbol}: דיווח ${filing.form} ל-SEC - ${labels}`,
    message: `${who} הגישה ל-SEC דיווח ${filing.form}${date ? ` בתאריך ${date}` : ''} (${labels}). כדאי לקרוא את הדיווח המקורי לפני כל החלטה.`,
    recommendation: { action: 'CHECK_NEWS', text: 'קראו את הדיווח המלא באתר ה-SEC. זהו מידע בלבד ולא ייעוץ השקעות.' },
    link: filing.link,
    filing: { form: filing.form, accession: filing.accession, items: filing.items, filedAt: filing.time },
    dedupKey: `${userId}:NEWS_FILING:${filing.accession}`
  };
}

async function runNewsScan({ store, features, newsService, now = new Date(), userIds = null, lookbackHours = 26 }) {
  const summary = { securities: 0, scanned: 0, filings: 0, alertsCreated: 0, skipped: null, failures: [] };
  if (!newsService.isSecConfigured()) {
    summary.skipped = 'SEC_USER_AGENT not set';
    return summary;
  }
  const portfolios = await loadPortfolios(store, userIds);
  const securities = buildHoldingsIndex(portfolios).securities.filter((s) => s.market === 'US');
  summary.securities = securities.length;
  const cutoff = now.getTime() - lookbackHours * 3600 * 1000;
  const ahead = now.getTime() + 10 * 60 * 1000;

  for (const sec of securities) {
    let filings;
    try {
      filings = await newsService.getFilings(sec.symbol);
    } catch (err) {
      summary.failures.push({ symbol: sec.symbol, error: String(err && err.message) });
      continue;
    }
    summary.scanned += 1;
    const fresh = filings.filter((f) => {
      const t = f.time ? Date.parse(f.time) : NaN;
      return f.accession && t >= cutoff && t <= ahead && filingSeverity(f);
    });
    summary.filings += fresh.length;
    for (const filing of fresh) {
      const severity = filingSeverity(filing);
      const instrument = { symbol: sec.symbol, market: sec.market, name: sec.name, currency: sec.currency };
      for (const holder of sec.holders) {
        const alert = buildFilingAlert({ userId: holder.userId, instrument, filing, severity });
        if (await features.insertAlert(Object.assign({}, alert, { createdAt: now.toISOString() }))) summary.alertsCreated += 1;
      }
    }
  }
  return summary;
}

// -> { 'news.scan': async (payload) => summary }. payload: { userIds?, hours? }.
function createNewsJobHandlers({ store, features, fetchers = null, newsService = null, now = () => new Date() }) {
  const service = newsService || createNewsService({ fetchers });
  return {
    'news.scan': (payload = {}) =>
      runNewsScan({
        store,
        features,
        newsService: service,
        now: now(),
        userIds: Array.isArray(payload.userIds) ? payload.userIds : null,
        lookbackHours: Number(payload.hours) > 0 ? Math.min(Number(payload.hours), 24 * 14) : 26
      })
  };
}

module.exports = { createNewsJobHandlers, runNewsScan, buildFilingAlert };
