// מקור נתונים למדד המחירים לצרכן: ה-API הציבורי של הלמ"ס (הלשכה המרכזית
// לסטטיסטיקה). המדד מתפרסם רק פעם בחודש (ב-15 לחודש, עבור החודש הקודם),
// ולכן אין טעם למשוך אותו בכל טעינה - שומרים אותו בקאש בזיכרון ומרעננים
// רק פעם ביום (למקרה שהתפרסם מדד חדש) או לפי בקשה מפורשת.
//
// ✅ נבדק מול השרת החי (26.8.2026): endpoint, פרמטרים (כולל פורמט
// startPeriod/endPeriod כ-mm-yyyy), ומבנה התגובה בפונקציה parseCbsResponse
// כולם מאומתים מול תגובה אמיתית מ-api.cbs.gov.il.
const axios = require('axios');
const { sourceHealth } = require('./sourceHealth');

const CBS_BASE_URL = 'https://api.cbs.gov.il/index/data/price';
// קוד הסדרה של "מדד המחירים לצרכן - כללי" (יש לוודא מול תיעוד הלמ"ס)
const CPI_SERIES_ID = '120010';
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // רענון פעם ביום למדד "הידוע"

// קאש בזיכרון: מדדי עבר קבועים לכל תקופת ריצת השרת (מדד שכבר פורסם
// לא משתנה), ולכן שומרים אותם ללא תפוגה. "המדד הידוע" מתרענן אחת ליום.
// שים לב: הקאש הוא per-mount (בתוך mountCpiRoutes), לא global-module, כדי
// שיהיה אפשר להריץ מספר עותקים מבודדים (כמו בטסטים) בלי לדלוף מצב ביניהם.
function createCpiCache() {
  const monthIndexCache = new Map(); // "YYYY-MM" -> number
  let latestIndexCache = null; // { month: 'YYYY-MM', value: number, fetchedAt: number }
  return {
    monthIndexCache,
    getLatest: () => latestIndexCache,
    setLatest: (v) => { latestIndexCache = v; }
  };
}

// מבנה התגובה האמיתי (נבדק מול השרת החי):
// {
//   "month": [
//     {
//       "code": 120010,
//       "name": "Consumer Price Index - General",
//       "date": [
//         { "year": 2026, "month": 7, "currBase": { "baseDesc": "...", "value": 105.1 }, ... }
//       ]
//     }
//   ]
// }
// כלומר: מערך סדרות תחת data.month, ולכל סדרה מערך נקודות תחת date[],
// עם year/month נפרדים (לא מחרוזת תאריך) וה-value בתוך currBase (לא מערך).
function parseCbsResponse(data) {
  const series = (data && Array.isArray(data.month)) ? data.month : [];
  const rows = [];
  series.forEach((s) => {
    (Array.isArray(s.date) ? s.date : []).forEach((d) => {
      const value = d.currBase && d.currBase.value;
      if (d.year == null || d.month == null || value == null) return;
      const monthKey = `${d.year}-${String(d.month).padStart(2, '0')}`;
      rows.push({ month: monthKey, value: Number(value) });
    });
  });
  return rows;
}

async function fetchCbsSeries({ startPeriod, endPeriod, last } = {}) {
  const params = {
    id: CPI_SERIES_ID,
    format: 'json',
    lang: 'en', // תגובה עם תאריכים לטיניים, עקבי יותר לפרסור
    download: 'false'
  };
  if (startPeriod) params.startPeriod = startPeriod;
  if (endPeriod) params.endPeriod = endPeriod;
  if (last) params.last = last;

  const response = await sourceHealth.track('cbs', () =>
    axios.get(CBS_BASE_URL, {
      params,
      headers: { 'User-Agent': 'afikinvest-app/1.0' }, // חובה ע"פ תיעוד הלמ"ס
      timeout: 10000
    })
  );
  const rows = parseCbsResponse(response.data);
  if (rows.length === 0) {
    // עוזר לאבחון: אם החזרנו 0 שורות, זה כמעט תמיד או שמבנה התגובה שונה
    // ממה שהונח ב-parseCbsResponse, או שה-id/lang/פורמט לא תקינים.
    console.warn('[cpi] CBS response parsed to 0 rows. Raw response snippet:',
      JSON.stringify(response.data).slice(0, 500));
  }
  return rows;
}

// "YYYY-MM" -> "mm-yyyy", the period format the CBS API expects (e.g.
// '2023-01' -> '01-2023'). Sending yyyymm was the cause of the 500s seen
// during development.
function toCbsPeriod(monthKey) {
  const [year, month] = monthKey.split('-');
  return `${month}-${year}`;
}

// מחזיר את ערך המדד לחודש נתון ("YYYY-MM"), עם קאש קבוע (מדדי עבר לא משתנים).
async function getIndexForMonth(cache, monthKey) {
  if (cache.monthIndexCache.has(monthKey)) return cache.monthIndexCache.get(monthKey);

  const period = toCbsPeriod(monthKey);
  const rows = await fetchCbsSeries({ startPeriod: period, endPeriod: period });
  const match = rows.find((r) => r.month === monthKey);
  if (match) {
    cache.monthIndexCache.set(monthKey, match.value);
    return match.value;
  }
  return null;
}

// Resolves MANY months in ONE upstream call, by asking CBS for the single
// contiguous range that spans them (earliest..latest) instead of issuing
// one request per month.
//
// This is the single biggest cause of the app's slow first paint that this
// route was responsible for: a portfolio with N distinct purchase/deposit
// months made POST /api/cpi/months issue N *sequential* CBS requests, each
// with a 10s timeout - so ~20 months could hold the CPI response (and with
// it every index-linked tax figure on screen) for the better part of a
// minute. A 20-month span is one request either way; the range response is
// only a few dozen rows, and every row it returns is cached, so adjacent
// months asked for later cost nothing at all.
//
// Only months genuinely missing from the cache trigger a fetch, and a
// failure degrades to "whatever is already cached" rather than throwing -
// the caller renders a fallback for months it has no index for.
async function getIndexesForMonths(cache, monthKeys) {
  const unique = [...new Set(monthKeys)].sort();
  const missing = unique.filter((m) => !cache.monthIndexCache.has(m));

  if (missing.length > 0) {
    const startPeriod = toCbsPeriod(missing[0]);
    const endPeriod = toCbsPeriod(missing[missing.length - 1]);
    const rows = await fetchCbsSeries({ startPeriod, endPeriod });
    // Cache every row in the window, not just the requested months - the
    // range came back in one response either way, and the neighbouring
    // months are very likely to be asked for next (a portfolio's purchase
    // dates cluster).
    rows.forEach((r) => cache.monthIndexCache.set(r.month, r.value));
  }

  const result = {};
  unique.forEach((m) => {
    const value = cache.monthIndexCache.get(m);
    if (value != null) result[m] = value;
  });
  return result;
}

// מחזיר את "המדד הידוע" האחרון שפורסם, עם רענון פעם ביום.
async function getLatestIndex(cache) {
  const cached = cache.getLatest();
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached;
  }
  const rows = await fetchCbsSeries({ last: 1 });
  const sorted = [...rows].sort((a, b) => (a.month < b.month ? 1 : -1));
  const latest = sorted[0];
  if (latest) {
    const entry = { month: latest.month, value: latest.value, fetchedAt: Date.now() };
    cache.setLatest(entry);
    cache.monthIndexCache.set(latest.month, latest.value);
    return entry;
  }
  throw new Error('CBS API returned no CPI data');
}

function mountCpiRoutes(app) {
  const cache = createCpiCache();

  // GET /api/cpi/latest -> { month: 'YYYY-MM', value: number }
  app.get('/api/cpi/latest', async (req, res) => {
    try {
      const latest = await getLatestIndex(cache);
      return res.json({ month: latest.month, value: latest.value });
    } catch (err) {
      console.error('[cpi] failed to fetch latest index', err.response ? `status ${err.response.status}: ${JSON.stringify(err.response.data).slice(0, 300)}` : err.message);
      // fail-safe: אם יש קאש ישן, עדיף להגיש אותו מאשר לשבור את החישוב
      const stale = cache.getLatest();
      if (stale) {
        return res.json({ month: stale.month, value: stale.value, stale: true });
      }
      return res.status(502).json({ error: 'לא ניתן היה למשוך את מדד המחירים לצרכן' });
    }
  });

  // GET /api/cpi/month/:yyyymm -> { month, value }
  app.get('/api/cpi/month/:yyyymm', async (req, res) => {
    const monthKey = req.params.yyyymm;
    if (!/^\d{4}-\d{2}$/.test(monthKey)) {
      return res.status(400).json({ error: 'פורמט חודש לא תקין, נדרש YYYY-MM' });
    }
    try {
      const value = await getIndexForMonth(cache, monthKey);
      if (value == null) {
        return res.status(404).json({ error: `אין נתון מדד לחודש ${monthKey}` });
      }
      return res.json({ month: monthKey, value });
    } catch (err) {
      console.error('[cpi] failed to fetch index for month', monthKey, err.response ? `status ${err.response.status}: ${JSON.stringify(err.response.data).slice(0, 300)}` : err.message);
      return res.status(502).json({ error: 'לא ניתן היה למשוך את מדד המחירים לצרכן' });
    }
  });

  // POST /api/cpi/months  { months: ['2020-01', '2023-06', ...] } -> { '2020-01': value, ... }
  // נוח למשיכה מרוכזת של כל התאריכים הרלוונטיים לתיק בבקשה אחת.
  app.post('/api/cpi/months', async (req, res) => {
    const months = Array.isArray(req.body && req.body.months) ? req.body.months : [];
    const valid = months.filter((m) => typeof m === 'string' && /^\d{4}-\d{2}$/.test(m));
    if (valid.length === 0) return res.json({});
    try {
      return res.json(await getIndexesForMonths(cache, valid));
    } catch (err) {
      console.error('[cpi] failed to fetch indexes for months', valid, err.response ? `status ${err.response.status}: ${JSON.stringify(err.response.data).slice(0, 300)}` : err.message);
      // Partial data beats none: serve whatever is already cached instead
      // of failing the whole batch over one unreachable upstream call.
      const cached = {};
      valid.forEach((m) => {
        const v = cache.monthIndexCache.get(m);
        if (v != null) cached[m] = v;
      });
      return res.json(cached);
    }
  });
}

module.exports = { mountCpiRoutes };
