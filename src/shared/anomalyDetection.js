// Price / volume anomaly detection and the alert built from it.
//
// Pure functions over an array of daily bars, so they run the same in the
// nightly server scan and in tests. See docs/ARCHITECTURE_SPEC_ADVANCED_FEATURES.md
// section 1 for the design.
//
// Detectors (each compares TODAY against a baseline that EXCLUDES today, so a
// shock cannot inflate the very dispersion it is measured against):
//   PRICE_ZSCORE   - today's log return vs the mean/σ of the prior 20 daily
//                    log returns (sample σ). |z| >= 2 warning, >= 3 critical.
//   PRICE_PCT_MOVE - plain single-day % move >= X% (user setting, default 5);
//                    >= 2X is critical.
//   PRICE_VS_SMA   - distance of the close from the 20-day SMA in units of
//                    the price's own σ (Bollinger distance) >= 3.
//   VOLUME_SPIKE   - today's volume vs the 30-day average daily volume
//                    (zero-volume days are data gaps and are dropped).
//                    >= 2x warning, >= 3x critical.
//
// CommonJS without spread/class syntax - see transactionLedger.js for why.

const SEVERITIES = ['info', 'warning', 'critical'];
const PRICE_KINDS = ['PRICE_ZSCORE', 'PRICE_PCT_MOVE', 'PRICE_VS_SMA'];

const DEFAULT_ANOMALY_CONFIG = {
  lookback: 20,
  zWarn: 2,
  zCritical: 3,
  pctMove: 5,
  advWindow: 30,
  volWarn: 2,
  volCritical: 3,
  minHistory: 20,
  // Portfolio weighting of the alert's severity (percent of the portfolio).
  minorWeightPct: 1,
  majorWeightPct: 15
};

const mean = (xs) => xs.reduce((s, x) => s + x, 0) / xs.length;
const stdev = (xs) => {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) * (x - m), 0) / (xs.length - 1));
};

const withDefaults = (cfg) => Object.assign({}, DEFAULT_ANOMALY_CONFIG, cfg || {});

// bars: [{ date, close, volume }] ascending; the last bar is the session
// being evaluated. Returns { signals, metrics } - metrics are reported even
// when nothing fired, for the message text and for debugging.
function analyzeBars(bars, config) {
  const cfg = withDefaults(config);
  const signals = [];
  const clean = (bars || []).filter((b) => b && Number(b.close) > 0).map((b) => ({
    date: b.date,
    close: Number(b.close),
    volume: Number(b.volume) || 0
  }));
  if (clean.length < cfg.minHistory + 1) {
    return { signals, metrics: null };
  }

  const today = clean[clean.length - 1];
  const prev = clean[clean.length - 2];
  const hist = clean.slice(-(cfg.lookback + 2), -1);
  const metrics = {
    sessionDate: today.date,
    close: today.close,
    prevClose: prev.close,
    changePct: (today.close / prev.close - 1) * 100,
    zScore: null,
    smaDistance: null,
    volumeRatio: null,
    averageVolume: null
  };

  // 1) Return z-score
  const logReturns = hist.slice(1).map((b, i) => Math.log(b.close / hist[i].close));
  const sigma = stdev(logReturns);
  if (sigma > 0) {
    const z = (Math.log(today.close / prev.close) - mean(logReturns)) / sigma;
    metrics.zScore = z;
    const abs = Math.abs(z);
    const sev = abs >= cfg.zCritical ? 'critical' : abs >= cfg.zWarn ? 'warning' : null;
    if (sev) signals.push({ kind: 'PRICE_ZSCORE', severity: sev, value: z, threshold: cfg.zWarn, direction: z > 0 ? 'up' : 'down' });
  }

  // 2) Single-day % move
  const pct = metrics.changePct;
  if (Math.abs(pct) >= cfg.pctMove) {
    signals.push({
      kind: 'PRICE_PCT_MOVE',
      severity: Math.abs(pct) >= 2 * cfg.pctMove ? 'critical' : 'warning',
      value: pct,
      threshold: cfg.pctMove,
      direction: pct > 0 ? 'up' : 'down'
    });
  }

  // 3) Distance from the SMA in σ-of-price units
  const closes = hist.slice(-cfg.lookback).map((b) => b.close);
  const sma = mean(closes);
  const sdPrice = stdev(closes);
  if (sdPrice > 0) {
    const k = (today.close - sma) / sdPrice;
    metrics.smaDistance = k;
    if (Math.abs(k) >= cfg.zCritical) {
      signals.push({ kind: 'PRICE_VS_SMA', severity: 'warning', value: k, threshold: cfg.zCritical, direction: k > 0 ? 'up' : 'down' });
    }
  }

  // 4) Volume vs ADV
  const vols = clean.slice(-(cfg.advWindow + 1), -1).map((b) => b.volume).filter((v) => v > 0);
  if (vols.length >= Math.min(cfg.advWindow, cfg.minHistory) && today.volume > 0) {
    const adv = mean(vols);
    const ratio = today.volume / adv;
    metrics.volumeRatio = ratio;
    metrics.averageVolume = adv;
    const sev = ratio >= cfg.volCritical ? 'critical' : ratio >= cfg.volWarn ? 'warning' : null;
    if (sev) signals.push({ kind: 'VOLUME_SPIKE', severity: sev, value: ratio, threshold: cfg.volWarn, direction: null });
  }

  return { signals, metrics };
}

function detectAnomalies(bars, config) {
  return analyzeBars(bars, config).signals;
}

// A daily move that looks like an unadjusted split (exactly 1/2, 1/3, 1/4,
// 2x, 3x, ...) rather than a market move. Such a day is reported as a data
// check, never as a crash.
function looksLikeSplit(metrics) {
  if (!metrics || !(metrics.prevClose > 0)) return false;
  const ratio = metrics.close / metrics.prevClose;
  const candidates = [2, 3, 4, 5, 10, 1 / 2, 1 / 3, 1 / 4, 1 / 5, 1 / 10, 1.5, 2 / 3];
  const volumeNormal = metrics.volumeRatio === null || metrics.volumeRatio < 2;
  return volumeNormal && candidates.some((c) => Math.abs(ratio / c - 1) < 0.005);
}

const rank = (severity) => Math.max(0, SEVERITIES.indexOf(severity));
const clampSeverity = (r) => SEVERITIES[Math.min(Math.max(r, 0), SEVERITIES.length - 1)];

// Merges one symbol's same-day signals into a single alert's type and
// severity: the highest signal severity, one step up when price and volume
// agree, then weighted by the position's share of the portfolio.
function consolidateSignals(signals, { weightPct = null } = {}, config) {
  const cfg = withDefaults(config);
  if (!signals || !signals.length) return null;
  const hasPrice = signals.some((s) => PRICE_KINDS.indexOf(s.kind) !== -1);
  const hasVolume = signals.some((s) => s.kind === 'VOLUME_SPIKE');
  const type = hasPrice && hasVolume ? 'COMBINED_ANOMALY' : hasPrice ? 'PRICE_ANOMALY' : 'VOLUME_ANOMALY';
  let r = Math.max.apply(null, signals.map((s) => rank(s.severity)));
  // Agreement can lift a warning to critical, but nothing goes past
  // critical - capped BEFORE the weighting, so a tiny position still steps
  // down from it.
  if (hasPrice && hasVolume) r = Math.min(r + 1, SEVERITIES.length - 1);
  if (weightPct !== null && weightPct !== undefined) {
    if (weightPct < cfg.minorWeightPct) r -= 1;
    else if (weightPct > cfg.majorWeightPct) r += 1;
  }
  const priceSignal = signals.find((s) => s.direction);
  return { type, severity: clampSeverity(r), direction: priceSignal ? priceSignal.direction : null };
}

const fmtPct = (v) => `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`;
const fmtIls = (v) => `₪${Math.round(Math.abs(v)).toLocaleString('en-US')}`;

// The recommendation attached to an anomaly alert. Rule-based and
// deliberately conservative: an alert is a prompt to look, not an order.
function recommendAction({ type, direction, weightPct, targetWeightPct }, config) {
  const cfg = withDefaults(config);
  const cap = targetWeightPct || cfg.majorWeightPct;
  if (type === 'VOLUME_ANOMALY') {
    return {
      action: 'CHECK_NEWS',
      text: 'מחזור מסחר חריג בלי תנועת מחיר חריגה - לרוב סימן לחדשות או לאירוע מתקרב. כדאי לבדוק דיווחים לפני כל פעולה.'
    };
  }
  if (weightPct !== null && weightPct !== undefined && weightPct < cfg.minorWeightPct) {
    return { action: 'NO_ACTION', text: 'הפוזיציה קטנה מאוד ביחס לתיק - התנועה כמעט אינה משפיעה עליו.' };
  }
  if (direction === 'up' && weightPct > cap) {
    return {
      action: 'CONSIDER_REBALANCE',
      text: `אחרי העלייה הפוזיציה מהווה ${weightPct.toFixed(1)}% מהתיק, מעל ${cap}%. אם התזה לא השתנתה, שקלו מימוש חלקי חזרה ליעד במקום יציאה מלאה.`
    };
  }
  if (direction === 'down') {
    return {
      action: 'REVIEW',
      text: 'בדקו אם יש חדשות שמשנות את התזה לפני פעולה. אם הפוזיציה בהפסד ריאלי, ייתכן שיש כאן הזדמנות לקיזוז מס (עמוד "הזדמנות לקיזוז מס").'
    };
  }
  return { action: 'CHECK_NEWS', text: 'תנועה חריגה - כדאי לבדוק את החדשות על החברה.' };
}

// Builds the alert payload (the agreed JSON format) for one user and one
// symbol, or null when nothing fired. `position` describes the user's
// holding; `metrics` comes from analyzeBars.
function buildAnomalyAlert({ userId, instrument, signals, metrics, position, targetWeightPct = null, config }) {
  if (!signals || !signals.length || !metrics) return null;
  const pos = position || {};

  if (looksLikeSplit(metrics)) {
    return {
      userId,
      type: 'DATA_CHECK',
      severity: 'info',
      sessionDate: metrics.sessionDate,
      instrument,
      position: pos,
      signals,
      title: `${instrument.symbol}: שינוי מחיר שנראה כמו פיצול מניה`,
      message: `המחיר השתנה פי ${(metrics.close / metrics.prevClose).toFixed(3)} במחזור רגיל - סביר שמדובר בפיצול/איחוד מניות ולא בתנועת שוק. בדקו שהכמות בתיק עודכנה בהתאם.`,
      recommendation: { action: 'NO_ACTION', text: 'אין צורך בפעולת השקעה; ודאו שנתוני הכמות נכונים.' },
      dedupKey: `${userId}:${instrument.symbol}:DATA_CHECK:${metrics.sessionDate}`
    };
  }

  const merged = consolidateSignals(signals, { weightPct: pos.weightPct }, config);
  const pctText = fmtPct(metrics.changePct);
  // With a verb ("fell"/"rose") the size reads without a sign.
  const sizeText = `${Math.abs(metrics.changePct).toFixed(1)}%`;
  const volText = metrics.volumeRatio ? ` במחזור פי ${metrics.volumeRatio.toFixed(1)} מהממוצע` : '';
  const verb = metrics.changePct >= 0 ? 'עלתה' : 'ירדה';

  let title;
  let message;
  if (merged.type === 'VOLUME_ANOMALY') {
    title = `${instrument.symbol}: מחזור מסחר פי ${metrics.volumeRatio.toFixed(1)} מהממוצע`;
    message = `${instrument.name || instrument.symbol} נסחרה היום במחזור פי ${metrics.volumeRatio.toFixed(1)} מהממוצע היומי של 30 הימים האחרונים, עם שינוי מחיר של ${pctText}.`;
  } else {
    title = `${instrument.symbol} ${verb} ${sizeText}${volText}`;
    const zText = metrics.zScore !== null ? `, כ-${Math.abs(metrics.zScore).toFixed(1)} סטיות תקן מהתנודה היומית הרגילה שלה` : '';
    message = `${instrument.name || instrument.symbol} ${verb} היום ${sizeText}${zText}${volText}.`;
  }
  if (pos.dayPnlILS !== undefined && pos.dayPnlILS !== null && pos.weightPct !== undefined && pos.weightPct !== null) {
    message += ` הפוזיציה שלך ${pos.dayPnlILS >= 0 ? 'הרוויחה' : 'הפסידה'} ${fmtIls(pos.dayPnlILS)} היום ומהווה ${pos.weightPct.toFixed(1)}% מהתיק.`;
  }

  return {
    userId,
    type: merged.type,
    severity: merged.severity,
    sessionDate: metrics.sessionDate,
    instrument,
    position: pos,
    signals,
    title,
    message,
    recommendation: recommendAction(
      { type: merged.type, direction: merged.direction, weightPct: pos.weightPct, targetWeightPct },
      config
    ),
    dedupKey: `${userId}:${instrument.symbol}:${merged.type}:${metrics.sessionDate}`
  };
}

// The 24-hour cooldown per (user, symbol, alert type): a new alert is kept
// only when no alert of the same type was raised for the symbol within the
// window - unless the new one is MORE severe (an escalation is news).
function passesCooldown(alert, recentAlerts, { now = new Date(), cooldownHours = 24 } = {}) {
  const since = now.getTime() - cooldownHours * 3600 * 1000;
  const blocking = (recentAlerts || []).filter(
    (prev) =>
      prev.type === alert.type &&
      Date.parse(prev.createdAt) >= since &&
      rank(alert.severity) <= rank(prev.severity)
  );
  return blocking.length === 0;
}

exports.SEVERITIES = SEVERITIES;
exports.DEFAULT_ANOMALY_CONFIG = DEFAULT_ANOMALY_CONFIG;
exports.analyzeBars = analyzeBars;
exports.detectAnomalies = detectAnomalies;
exports.looksLikeSplit = looksLikeSplit;
exports.consolidateSignals = consolidateSignals;
exports.recommendAction = recommendAction;
exports.buildAnomalyAlert = buildAnomalyAlert;
exports.passesCooldown = passesCooldown;
