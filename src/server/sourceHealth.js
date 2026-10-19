// How each third-party data source is doing right now, for the admin
// panel's health tab: when it last answered, when it last failed and why,
// and how many times in a row it has failed.
//
// Every source already logs its own failures, but one at a time and per
// symbol - a Yahoo block shows up as forty separate warnings that say
// nothing about whether it is still going on. This keeps one line per
// source instead, and the moment a source crosses FAILURE_ALERT_THRESHOLD
// consecutive failures it is reported once through console.error, which
// errorLog.js also stores for the admin panel. It reports again when the
// source recovers, so the panel's error list shows when an outage began
// and ended rather than every request in between.
//
// In memory only: a restart starts every source as "no data yet", which is
// accurate - nothing has been asked of it since.

const FAILURE_ALERT_THRESHOLD = 5;

// Known sources, in the order the panel lists them, with a Hebrew label.
const SOURCES = {
  finnhub: 'Finnhub - מחירי מניות ארה"ב, מכפילים ועמיתים (ראשי), סקטורים ואנליסטים (גיבוי)',
  'yahoo-chart': 'Yahoo - מחירי מניות ארה"ב (גיבוי) ושערי מט"ח',
  'yahoo-summary': 'Yahoo - סקטורים, אנליסטים, דיבידנדים, הערכת שווי',
  'tase-api': 'הבורסה - מחיר חי (API)',
  'tase-eod': 'הבורסה - מחיר סוף יום (API)',
  puppeteer: 'הבורסה - קריאת דף (Puppeteer)',
  'tase-index': 'הבורסה - היסטוריית מדדים',
  bizportal: 'ביזפורטל - חיפוש ניירות לפי שם',
  cbs: 'הלמ"ס - מדד המחירים לצרכן',
  frankfurter: 'Frankfurter (ECB) - שערי מט"ח (גיבוי)',
  fmp: 'Financial Modeling Prep - סקטורים ומכפילים (גיבוי)',
  tiingo: 'Tiingo - דיבידנדים ומחירים חודשיים (גיבוי)'
};

function errorText(err) {
  if (!err) return 'unknown error';
  const status = err.response && err.response.status;
  const message = err.message || String(err);
  return status && !message.includes(String(status)) ? `HTTP ${status}: ${message}` : message;
}

function createSourceHealth({ logger = console, now = () => Date.now() } = {}) {
  const state = new Map();

  const entry = (name) => {
    if (!state.has(name)) {
      state.set(name, {
        lastSuccessAt: null,
        lastFailureAt: null,
        lastError: null,
        consecutiveFailures: 0,
        successes: 0,
        failures: 0,
        alerting: false
      });
    }
    return state.get(name);
  };

  return {
    success(name) {
      const e = entry(name);
      e.lastSuccessAt = now();
      e.successes += 1;
      e.consecutiveFailures = 0;
      if (e.alerting) {
        e.alerting = false;
        logger.warn(`[source-health] ${name} recovered`);
      }
    },

    failure(name, err) {
      const e = entry(name);
      e.lastFailureAt = now();
      e.lastError = errorText(err);
      e.failures += 1;
      e.consecutiveFailures += 1;
      if (!e.alerting && e.consecutiveFailures >= FAILURE_ALERT_THRESHOLD) {
        e.alerting = true;
        logger.error(`[source-health] ${name} is failing: ${e.consecutiveFailures} failures in a row - last: ${e.lastError}`);
      }
    },

    // Wraps a promise-returning call so it is recorded either way.
    async track(name, fn) {
      try {
        const result = await fn();
        this.success(name);
        return result;
      } catch (err) {
        this.failure(name, err);
        throw err;
      }
    },

    // One row per known source (plus any others that have reported), for
    // the admin panel. `extra` adds live state a module keeps itself, such
    // as Yahoo's cooldown.
    snapshot(extra = {}) {
      const names = [...new Set([...Object.keys(SOURCES), ...state.keys()])];
      return names.map((name) => {
        const e = state.get(name);
        const iso = (t) => (t ? new Date(t).toISOString() : null);
        let status = 'unknown';
        if (e) {
          if (e.consecutiveFailures >= FAILURE_ALERT_THRESHOLD) status = 'down';
          else if (e.consecutiveFailures > 0) status = 'degraded';
          else if (e.lastSuccessAt) status = 'ok';
        }
        return {
          name,
          label: SOURCES[name] || name,
          status,
          lastSuccessAt: iso(e && e.lastSuccessAt),
          lastFailureAt: iso(e && e.lastFailureAt),
          lastError: e ? e.lastError : null,
          consecutiveFailures: e ? e.consecutiveFailures : 0,
          successes: e ? e.successes : 0,
          failures: e ? e.failures : 0,
          ...(extra[name] || {})
        };
      });
    }
  };
}

// The one the app uses; tests build their own.
const sourceHealth = createSourceHealth();

module.exports = { sourceHealth, createSourceHealth, FAILURE_ALERT_THRESHOLD, SOURCES };
