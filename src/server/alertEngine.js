// The two scheduled scans behind Smart Alerts:
//
//   runAnomalyScan   - once per security held by anyone: fetch ~3 months of
//                      daily bars, then per holder apply that user's
//                      thresholds, consolidate the day's signals into ONE
//                      alert, apply the 24h cooldown and store it.
//   runCalendarRefresh - announced + projected earnings/dividend dates for
//                      every held security, then the T-7/T-1 (earnings) and
//                      T-2 (ex-dividend) reminders for each holder.
//
// Market data comes in through `marketData` (see createMarketData below) so
// tests run on fixtures and production on Yahoo/TASE.
const { analyzeBars, buildAnomalyAlert, passesCooldown, DEFAULT_ANOMALY_CONFIG } = require('../shared/anomalyDetection');
const { buildHoldingEvents, remindersDue, buildEventReminderAlert, addDays, daysBetween } = require('../shared/eventCalendar');
const { buildHoldingsIndex, loadPortfolios } = require('./holdingsIndex');

const DEFAULT_ALERT_SETTINGS = {
  enabled: true,
  pctMove: DEFAULT_ANOMALY_CONFIG.pctMove,
  zWarn: DEFAULT_ANOMALY_CONFIG.zWarn,
  zCritical: DEFAULT_ANOMALY_CONFIG.zCritical,
  volWarn: DEFAULT_ANOMALY_CONFIG.volWarn,
  volCritical: DEFAULT_ANOMALY_CONFIG.volCritical,
  majorWeightPct: DEFAULT_ANOMALY_CONFIG.majorWeightPct,
  eventReminders: true
};

const SETTING_RANGES = {
  pctMove: [1, 50],
  zWarn: [1, 6],
  zCritical: [1.5, 10],
  volWarn: [1.2, 10],
  volCritical: [1.5, 20],
  majorWeightPct: [1, 100]
};

// Validates a settings update; unknown keys are dropped, out-of-range
// numbers rejected.
function normalizeAlertSettings(input, base = DEFAULT_ALERT_SETTINGS) {
  const out = Object.assign({}, DEFAULT_ALERT_SETTINGS, base);
  const src = input && typeof input === 'object' ? input : {};
  ['enabled', 'eventReminders'].forEach((key) => {
    if (src[key] !== undefined) out[key] = Boolean(src[key]);
  });
  Object.keys(SETTING_RANGES).forEach((key) => {
    if (src[key] === undefined) return;
    const v = Number(src[key]);
    const [lo, hi] = SETTING_RANGES[key];
    if (!Number.isFinite(v) || v < lo || v > hi) throw new Error(`${key} must be between ${lo} and ${hi}`);
    out[key] = v;
  });
  if (out.zCritical <= out.zWarn) throw new Error('zCritical must be above zWarn');
  if (out.volCritical <= out.volWarn) throw new Error('volCritical must be above volWarn');
  return out;
}

function configFromSettings(settings) {
  return Object.assign({}, DEFAULT_ANOMALY_CONFIG, {
    pctMove: settings.pctMove,
    zWarn: settings.zWarn,
    zCritical: settings.zCritical,
    volWarn: settings.volWarn,
    volCritical: settings.volCritical,
    majorWeightPct: settings.majorWeightPct
  });
}

const todayOf = (now) => now.toISOString().slice(0, 10);

async function settingsFor(features, userId, cache) {
  if (cache.has(userId)) return cache.get(userId);
  const stored = await features.getAlertSettings(userId);
  const s = Object.assign({}, DEFAULT_ALERT_SETTINGS, stored || {});
  cache.set(userId, s);
  return s;
}

async function storeIfDue(features, alert, now) {
  const recent = await features.recentAlerts(alert.userId, alert.instrument.symbol, new Date(now.getTime() - 24 * 3600 * 1000).toISOString());
  if (!passesCooldown(alert, recent, { now })) return false;
  return features.insertAlert(Object.assign({}, alert, { createdAt: now.toISOString() }));
}

// maxStaleDays: bars whose last session is older than this are not
// evaluated (a halted security or a feed that stopped updating would
// otherwise re-alert on the same old move).
async function runAnomalyScan({ store, features, marketData, now = new Date(), userIds = null, maxStaleDays = 4 }) {
  const portfolios = await loadPortfolios(store, userIds);
  const { securities } = buildHoldingsIndex(portfolios);
  const settingsCache = new Map();
  const summary = { securities: securities.length, scanned: 0, alertsCreated: 0, stale: [], failures: [] };

  for (const sec of securities) {
    let bars;
    try {
      bars = await marketData.getBars(sec.market, sec.symbol);
    } catch (err) {
      summary.failures.push({ symbol: sec.symbol, market: sec.market, error: String(err && err.message) });
      continue;
    }
    if (!bars || !bars.length) continue;
    const last = bars[bars.length - 1].date;
    if (daysBetween(last, todayOf(now)) > maxStaleDays) {
      summary.stale.push(sec.symbol);
      continue;
    }
    summary.scanned += 1;

    for (const holder of sec.holders) {
      const settings = await settingsFor(features, holder.userId, settingsCache);
      if (!settings.enabled) continue;
      const cfg = configFromSettings(settings);
      const { signals, metrics } = analyzeBars(bars, cfg);
      if (!signals.length) continue;
      // TASE closes are in agorot; US closes in dollars at the user's rate.
      const toIls = sec.market === 'TASE' ? 0.01 : holder.usdRate || null;
      const dayPnlILS = metrics && toIls ? holder.units * (metrics.close - metrics.prevClose) * toIls : null;
      const alert = buildAnomalyAlert({
        userId: holder.userId,
        instrument: { symbol: sec.symbol, market: sec.market, name: sec.name, currency: sec.currency },
        signals,
        metrics,
        position: {
          quantity: holder.units,
          weightPct: holder.weightPct === null ? null : Math.round(holder.weightPct * 10) / 10,
          valueILS: Math.round(holder.valueILS * 100) / 100,
          dayPnlILS: dayPnlILS === null ? null : Math.round(dayPnlILS * 100) / 100
        },
        targetWeightPct: settings.majorWeightPct,
        config: cfg
      });
      if (alert && (await storeIfDue(features, alert, now))) summary.alertsCreated += 1;
    }
  }
  return summary;
}

async function runCalendarRefresh({ store, features, marketData, now = new Date(), userIds = null, horizonDays = 200 }) {
  const today = todayOf(now);
  const portfolios = await loadPortfolios(store, userIds);
  const { securities, byUser } = buildHoldingsIndex(portfolios);
  const summary = { securities: securities.length, refreshed: 0, unsupported: [], failures: [], remindersCreated: 0 };

  for (const sec of securities) {
    if (!marketData.supportsCalendar(sec.market)) {
      summary.unsupported.push(`${sec.market}:${sec.symbol}`);
      continue;
    }
    try {
      const [calendar, history] = await Promise.all([
        marketData.getCalendar(sec.market, sec.symbol).catch(() => null),
        marketData.getDividendHistory(sec.market, sec.symbol).catch(() => [])
      ]);
      const events = buildHoldingEvents({
        symbol: sec.symbol,
        market: sec.market,
        currency: sec.currency,
        calendar,
        history,
        today,
        horizonDays
      });
      // Keep a week of the past so "today's" and just-passed events still show.
      await features.replaceFutureMarketEvents(sec.symbol, sec.market, addDays(today, -7), events);
      summary.refreshed += 1;
    } catch (err) {
      summary.failures.push({ symbol: sec.symbol, error: String(err && err.message) });
    }
  }

  // Reminders, per holder.
  const settingsCache = new Map();
  for (const [userId, info] of byUser.entries()) {
    const settings = await settingsFor(features, userId, settingsCache);
    if (!settings.eventReminders) continue;
    const keys = info.positions.map((p) => ({ symbol: p.symbol, market: p.market }));
    const events = await features.listMarketEvents(keys, today, addDays(today, 8));
    for (const { event, daysBefore } of remindersDue(events, today)) {
      const position = info.positions.find((p) => p.symbol === event.symbol && p.market === event.market);
      const alert = buildEventReminderAlert({
        userId,
        instrument: { symbol: event.symbol, market: event.market, name: position ? position.name : '', currency: event.currency },
        event,
        daysBefore,
        units: position ? position.units : null,
        fxRate: event.currency === 'USD' ? info.usdRate : null
      });
      if (await features.insertAlert(Object.assign({}, alert, { createdAt: now.toISOString() }))) summary.remindersCreated += 1;
    }
  }
  return summary;
}

// The user's calendar: stored events for their holdings, with the expected
// gross dividend for the units they hold.
async function buildUserCalendar({ store, features, userId, from, to }) {
  const portfolios = await loadPortfolios(store, [userId]);
  const { byUser } = buildHoldingsIndex(portfolios);
  const info = byUser.get(userId);
  if (!info) return [];
  const events = await features.listMarketEvents(info.positions.map((p) => ({ symbol: p.symbol, market: p.market })), from, to);
  return events.map((e) => {
    const position = info.positions.find((p) => p.symbol === e.symbol && p.market === e.market);
    const units = position ? position.units : 0;
    const expectedGross =
      (e.eventType === 'EX_DIVIDEND' || e.eventType === 'DIVIDEND_PAYMENT') && e.amountPerShare ? e.amountPerShare * units : null;
    const rate = e.currency === 'USD' ? info.usdRate : 1;
    return Object.assign({}, e, {
      name: position ? position.name : '',
      units,
      expectedGross,
      expectedGrossILS: expectedGross !== null && rate ? expectedGross * rate : null
    });
  });
}

// Production market data: Yahoo for US securities, TASE's own API for
// Israeli ones. The calendar is US-only for now - TASE publishes dividend
// and report dates through Maya announcements, which have no public API.
function createMarketData() {
  const { fetchYahooDailyBars, fetchYahooCalendar, fetchYahooDividendHistory } = require('./yahooQuotes');
  const { fetchTaseDailyBars } = require('./taseHistoryApi');
  return {
    async getBars(market, symbol) {
      return market === 'US' ? fetchYahooDailyBars(symbol) : fetchTaseDailyBars(symbol);
    },
    supportsCalendar(market) {
      return market === 'US';
    },
    async getCalendar(market, symbol) {
      return fetchYahooCalendar(symbol);
    },
    async getDividendHistory(market, symbol) {
      const from = new Date(Date.now() - 3 * 365 * 86400000).toISOString().slice(0, 10);
      return fetchYahooDividendHistory(symbol, from);
    }
  };
}

module.exports = {
  DEFAULT_ALERT_SETTINGS,
  normalizeAlertSettings,
  runAnomalyScan,
  runCalendarRefresh,
  buildUserCalendar,
  createMarketData
};
