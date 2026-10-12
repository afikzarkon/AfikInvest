// The personalized event calendar: earnings, ex-dividend and dividend
// payment dates for the securities the user actually holds, including
// projected dates for dividends that have not been announced yet.
//
// Pure functions; the server job (server/alertEngine.js) feeds them the raw
// data and stores the result in market_events.
//
// PROJECTION
// A company that has paid on a regular rhythm will usually keep to it. From
// the last (up to) 8 ex-dates the median interval is taken and snapped to
// the nearest standard cadence (monthly 30, quarterly 91, semi-annual 182,
// annual 365 days) when it is within 25% of it. Successive ex-dates are then
// projected forward, and each payment date keeps the ex -> pay lag last
// observed (or 14 days when it never was). Every projected row says so
// (status 'projected') and carries a confidence from 0 to 1 based on how
// regular the history is. An announced date always replaces a projected one
// within +/-10 days of it.
//
// CommonJS without spread/class syntax - see transactionLedger.js for why.

const DAY_MS = 86400000;
const CADENCES = [30, 91, 182, 365];
const DEFAULT_PAY_LAG_DAYS = 14;
const SUPERSEDE_WINDOW_DAYS = 10;

const toTime = (date) => Date.parse(`${date}T00:00:00Z`);
const toDate = (time) => new Date(time).toISOString().slice(0, 10);
const addDays = (date, days) => toDate(toTime(date) + days * DAY_MS);
const daysBetween = (a, b) => Math.round((toTime(b) - toTime(a)) / DAY_MS);

const median = (xs) => {
  const s = xs.slice().sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

// history: [{ date (ex-date), amountPerShare }] in any order. Returns
// { intervalDays, cadence, confidence } or null when there is no rhythm to
// follow (fewer than 2 payments, or a gap longer than 13 months since the
// last one - a suspended dividend must not be projected forward).
function dividendRhythm(history, { today } = {}) {
  const dates = (history || [])
    .filter((d) => d && d.date && Number(d.amountPerShare) > 0)
    .map((d) => d.date)
    .sort();
  if (dates.length < 2) return null;
  const recent = dates.slice(-9);
  const intervals = [];
  for (let i = 1; i < recent.length; i += 1) intervals.push(daysBetween(recent[i - 1], recent[i]));
  const raw = median(intervals);
  if (!(raw > 0)) return null;
  const snapped = CADENCES.find((c) => Math.abs(raw - c) / c <= 0.25);
  const intervalDays = snapped || Math.round(raw);

  const last = dates[dates.length - 1];
  if (today && daysBetween(last, today) > Math.max(400, intervalDays * 2)) return null;

  const m = intervals.reduce((s, x) => s + x, 0) / intervals.length;
  const sd =
    intervals.length > 1 ? Math.sqrt(intervals.reduce((s, x) => s + (x - m) * (x - m), 0) / (intervals.length - 1)) : m * 0.25;
  const cv = m > 0 ? sd / m : 1;
  // Few observations are less trustworthy however regular they look.
  const sampleFactor = Math.min(1, intervals.length / 4);
  const confidence = Math.max(0.1, Math.min(0.95, (1 - 2 * cv) * sampleFactor));
  return { intervalDays, cadence: snapped || null, confidence: Math.round(confidence * 100) / 100, lastExDate: last };
}

// Projects future ex-dates (and their payment dates) from the rhythm, up to
// `horizonDays` after today. Amount = the last paid amount.
function projectDividendEvents({ symbol, market, currency, history, today, horizonDays = 200, payLagDays = null }) {
  const rhythm = dividendRhythm(history, { today });
  if (!rhythm) return [];
  const sorted = (history || []).filter((d) => d && d.date).slice().sort((a, b) => (a.date < b.date ? -1 : 1));
  const lastAmount = Number(sorted[sorted.length - 1].amountPerShare) || null;
  const lag = payLagDays !== null && payLagDays !== undefined ? payLagDays : DEFAULT_PAY_LAG_DAYS;
  const horizon = addDays(today, horizonDays);
  const out = [];
  let next = addDays(rhythm.lastExDate, rhythm.intervalDays);
  // Skip forward past dates already behind us (a payment that the history
  // simply has not caught up with yet is not "upcoming").
  let guard = 0;
  while (next < today && guard < 100) {
    next = addDays(next, rhythm.intervalDays);
    guard += 1;
  }
  while (next <= horizon && out.length < 24) {
    const base = { symbol, market, amountPerShare: lastAmount, currency, status: 'projected', confidence: rhythm.confidence, source: 'projection' };
    out.push(Object.assign({}, base, { eventType: 'EX_DIVIDEND', eventDate: next }));
    out.push(Object.assign({}, base, { eventType: 'DIVIDEND_PAYMENT', eventDate: addDays(next, lag) }));
    next = addDays(next, rhythm.intervalDays);
  }
  return out;
}

// Drops projected events that an announced (confirmed/estimated) event of the
// same type within +/-10 days supersedes.
function mergeEvents(announced, projected) {
  const kept = (projected || []).filter(
    (p) =>
      !(announced || []).some(
        (a) => a.eventType === p.eventType && Math.abs(daysBetween(a.eventDate, p.eventDate)) <= SUPERSEDE_WINDOW_DAYS
      )
  );
  return (announced || []).concat(kept).sort((a, b) => (a.eventDate < b.eventDate ? -1 : a.eventDate > b.eventDate ? 1 : 0));
}

const epochToDate = (epoch) => {
  const n = Number(epoch);
  if (!Number.isFinite(n) || n <= 0) return null;
  return toDate(n * 1000);
};

// Turns Yahoo's quoteSummary calendarEvents (+ summaryDetail) into announced
// events. Yahoo gives the earnings date as a 1-2 element range, and marks it
// an estimate until the company confirms it.
function eventsFromYahooCalendar({ symbol, market = 'US', currency = 'USD', calendarEvents, summaryDetail }) {
  const ce = calendarEvents || {};
  const sd = summaryDetail || {};
  const unwrap = (v) => (v && typeof v === 'object' && 'raw' in v ? v.raw : v);
  const events = [];

  const earnings = ce.earnings || {};
  const range = (Array.isArray(earnings.earningsDate) ? earnings.earningsDate : []).map(unwrap).map(epochToDate).filter(Boolean).sort();
  if (range.length) {
    events.push({
      symbol,
      market,
      eventType: 'EARNINGS',
      eventDate: range[0],
      eventDateEnd: range.length > 1 && range[range.length - 1] !== range[0] ? range[range.length - 1] : null,
      timeOfDay: 'UNKNOWN',
      amountPerShare: null,
      currency,
      status: unwrap(earnings.isEarningsDateEstimate) ? 'estimated' : 'confirmed',
      confidence: null,
      source: 'yahoo'
    });
  }

  const rate = Number(unwrap(sd.dividendRate));
  const perPayment = null;
  const exDate = epochToDate(unwrap(ce.exDividendDate) || unwrap(sd.exDividendDate));
  const payDate = epochToDate(unwrap(ce.dividendDate));
  if (exDate) {
    events.push({ symbol, market, eventType: 'EX_DIVIDEND', eventDate: exDate, amountPerShare: perPayment, currency, status: 'confirmed', confidence: null, source: 'yahoo', annualRate: Number.isFinite(rate) ? rate : null });
  }
  if (payDate) {
    events.push({ symbol, market, eventType: 'DIVIDEND_PAYMENT', eventDate: payDate, amountPerShare: perPayment, currency, status: 'confirmed', confidence: null, source: 'yahoo' });
  }
  return events;
}

// All events for one holding: announced from Yahoo + projected from the
// dividend history. The payment lag for projections comes from the
// announced ex/pay pair when both exist. An announced dividend without an
// amount takes the last paid amount.
function buildHoldingEvents({ symbol, market, currency, calendar, history, today, horizonDays }) {
  const announced = calendar ? eventsFromYahooCalendar({ symbol, market, currency, calendarEvents: calendar.calendarEvents, summaryDetail: calendar.summaryDetail }) : [];
  const exA = announced.find((e) => e.eventType === 'EX_DIVIDEND');
  const payA = announced.find((e) => e.eventType === 'DIVIDEND_PAYMENT');
  let lag = null;
  if (exA && payA) {
    const d = daysBetween(exA.eventDate, payA.eventDate);
    if (d >= 0 && d <= 90) lag = d;
  }
  const sortedHistory = (history || []).slice().sort((a, b) => (a.date < b.date ? -1 : 1));
  const lastAmount = sortedHistory.length ? Number(sortedHistory[sortedHistory.length - 1].amountPerShare) || null : null;
  announced.forEach((e) => {
    if ((e.eventType === 'EX_DIVIDEND' || e.eventType === 'DIVIDEND_PAYMENT') && e.amountPerShare === null) e.amountPerShare = lastAmount;
  });
  const projected = projectDividendEvents({ symbol, market, currency, history, today, horizonDays, payLagDays: lag });
  return mergeEvents(announced, projected).map((e) => {
    const copy = Object.assign({}, e);
    delete copy.annualRate;
    return copy;
  });
}

// Reminder schedule: earnings at T-7 and T-1, ex-dividend at T-2 (the last
// comfortable day to still buy and receive the dividend). Returns
// [{ event, daysBefore }] due on `today`.
const REMINDER_DAYS = { EARNINGS: [7, 1], EX_DIVIDEND: [2] };

function remindersDue(events, today) {
  const out = [];
  (events || []).forEach((event) => {
    const days = REMINDER_DAYS[event.eventType];
    if (!days) return;
    const until = daysBetween(today, event.eventDate);
    if (days.indexOf(until) !== -1) out.push({ event, daysBefore: until });
  });
  return out;
}

const EVENT_LABELS_HE = {
  EARNINGS: 'דוחות רבעוניים',
  EX_DIVIDEND: 'יום אקס דיבידנד',
  DIVIDEND_PAYMENT: 'תשלום דיבידנד'
};

function buildEventReminderAlert({ userId, instrument, event, daysBefore, units = null, fxRate = null }) {
  const when = daysBefore === 1 ? 'מחר' : `בעוד ${daysBefore} ימים`;
  const label = EVENT_LABELS_HE[event.eventType] || event.eventType;
  let message = `${label} של ${instrument.name || instrument.symbol} ${when} (${event.eventDate}${event.eventDateEnd ? `–${event.eventDateEnd}` : ''}).`;
  let recommendationText = 'אין צורך בפעולה - תזכורת בלבד.';
  if (event.eventType === 'EARNINGS') {
    recommendationText = 'סביב פרסום דוחות התנודתיות גבוהה מהרגיל. אם הפוזיציה גדולה ממשקל היעד, זה זמן טוב לבדוק את האיזון לפני הפרסום.';
  }
  if (event.eventType === 'EX_DIVIDEND' && event.amountPerShare && units) {
    const gross = event.amountPerShare * units;
    const ils = fxRate ? ` (כ-₪${Math.round(gross * fxRate).toLocaleString('en-US')})` : '';
    message += ` צפי לדיבידנד ברוטו של ${gross.toFixed(2)} ${event.currency || ''}${ils} על ${units} יחידות.`;
    recommendationText = 'כדי לקבל את הדיבידנד יש להחזיק את המניה לפני יום האקס.';
  }
  if (event.status === 'projected') message += ' (תאריך משוער לפי קצב התשלומים הקודם)';
  return {
    userId,
    type: 'EVENT_UPCOMING',
    severity: 'info',
    sessionDate: event.eventDate,
    instrument,
    event,
    title: `${instrument.symbol}: ${label} ${when}`,
    message,
    recommendation: { action: 'NO_ACTION', text: recommendationText },
    dedupKey: `${userId}:${instrument.symbol}:EVENT_UPCOMING:${event.eventType}:${event.eventDate}:T-${daysBefore}`
  };
}

exports.CADENCES = CADENCES;
exports.EVENT_LABELS_HE = EVENT_LABELS_HE;
exports.addDays = addDays;
exports.daysBetween = daysBetween;
exports.dividendRhythm = dividendRhythm;
exports.projectDividendEvents = projectDividendEvents;
exports.mergeEvents = mergeEvents;
exports.eventsFromYahooCalendar = eventsFromYahooCalendar;
exports.buildHoldingEvents = buildHoldingEvents;
exports.remindersDue = remindersDue;
exports.buildEventReminderAlert = buildEventReminderAlert;
