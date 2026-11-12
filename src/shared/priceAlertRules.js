// Ported from day-trader-skill (MIT, Jake Schincariol) - trader-alerts/alerts.py
//
// User price alerts: the rule shape, its validation (Hebrew errors, used by
// the API and by the form) and the trigger test. Pure functions; the job in
// server/priceAlerts.js fetches the quotes and stores the results.
//
// Rule types (alerts.py's above / below / pct_move with a direction):
//   above     the price is at or above `value`
//   below     the price is at or below `value`
//   pct_up    the price is up `value` percent or more from the previous close
//   pct_down  the price is down `value` percent or more from the previous close
//
// Each rule rings ONCE: the job moves it from 'active' to 'triggered' with
// the price and time, and it stays quiet until the user re-arms it.
//
// Prices are in the security's own trading currency: dollars for US
// securities, shekels (not agorot) for TASE ones.
//
// CommonJS without spread/class syntax - see transactionLedger.js for why.

var MAX_PRICE_ALERTS_PER_USER = 50;
var RULE_TYPES = ['above', 'below', 'pct_up', 'pct_down'];
var MARKETS = ['US', 'TASE'];
var NOTE_MAX = 200;
var NAME_MAX = 100;

var RULE_LABELS_HE = {
  above: 'מחיר מעל',
  below: 'מחיר מתחת',
  pct_up: 'עלייה של % מסגירה קודמת',
  pct_down: 'ירידה של % מסגירה קודמת'
};

var STATUS_LABELS_HE = { active: 'פעילה', triggered: 'הופעלה' };

var US_SYMBOL_RE = /^[A-Z][A-Z0-9.-]{0,14}$/;
var TASE_ID_RE = /^\d{3,9}$/;

function isPctType(type) {
  return type === 'pct_up' || type === 'pct_down';
}

function currencySymbol(market) {
  return market === 'TASE' ? '₪' : '$';
}

function formatNumber(n) {
  var x = Number(n);
  if (!isFinite(x)) return '';
  return Math.abs(x) >= 1000 ? x.toLocaleString('en-US', { maximumFractionDigits: 2 }) : String(Math.round(x * 100) / 100);
}

function formatPrice(n, market) {
  return formatNumber(n) + ' ' + currencySymbol(market);
}

function normalizeSymbol(raw, market) {
  var s = String(raw === undefined || raw === null ? '' : raw).trim();
  return market === 'US' ? s.toUpperCase() : s;
}

// Validates a new rule (or, with `base`, an update merged over an existing
// rule). Returns the clean rule fields; throws an Error with a Hebrew
// message on bad input.
function validatePriceAlertInput(input, base) {
  var src = input && typeof input === 'object' ? input : {};
  var prev = base || {};
  var market = src.market !== undefined ? String(src.market).toUpperCase() : prev.market;
  if (MARKETS.indexOf(market) === -1) throw new Error('יש לבחור שוק: ארה"ב או תל אביב');

  var symbol = src.symbol !== undefined ? normalizeSymbol(src.symbol, market) : prev.symbol;
  if (!symbol) throw new Error('יש להזין סימול');
  if (market === 'US' && !US_SYMBOL_RE.test(symbol)) throw new Error('סימול לא תקין (למשל AAPL)');
  if (market === 'TASE' && !TASE_ID_RE.test(symbol)) throw new Error('בבורסה בתל אביב יש להזין מספר נייר ערך (ספרות בלבד)');

  var ruleType = src.ruleType !== undefined ? String(src.ruleType) : prev.ruleType;
  if (RULE_TYPES.indexOf(ruleType) === -1) throw new Error('סוג התראה לא תקין');

  var rawValue = src.value !== undefined ? src.value : prev.value;
  var value = typeof rawValue === 'string' && rawValue.trim() === '' ? NaN : Number(rawValue);
  if (isPctType(ruleType)) {
    if (!isFinite(value) || value < 0.1 || value > 100) throw new Error('אחוז השינוי צריך להיות בין 0.1 ל-100');
  } else if (!isFinite(value) || value <= 0 || value > 10000000) {
    throw new Error('יש להזין מחיר חיובי');
  }

  var note = src.note !== undefined ? String(src.note === null ? '' : src.note).trim() : prev.note || '';
  if (note.length > NOTE_MAX) throw new Error('ההערה ארוכה מדי (עד ' + NOTE_MAX + ' תווים)');

  var name = src.name !== undefined ? String(src.name === null ? '' : src.name).trim().slice(0, NAME_MAX) : prev.name || '';

  return {
    market: market,
    symbol: symbol,
    ruleType: ruleType,
    value: Math.round(value * 1e6) / 1e6,
    note: note,
    name: name,
    currency: market === 'TASE' ? 'ILS' : 'USD'
  };
}

// The percent move of `price` from `prevClose`, or null when there is no
// usable previous close.
function movePct(price, prevClose) {
  var p = Number(price);
  var ref = Number(prevClose);
  if (!isFinite(p) || !isFinite(ref) || ref <= 0) return null;
  return (p / ref - 1) * 100;
}

// Does the quote meet the rule? Level rules compare the price with the
// level ("at or above" / "at or below", as alerts.py does); percent rules
// compare the move from the previous close. A rule that is not active never
// hits - that is what makes it ring once.
//   quote: { price, prevClose }
// Returns { hit, move } (move is the percent move, null when unknown).
function evaluatePriceAlert(rule, quote) {
  var none = { hit: false, move: null };
  if (!rule || rule.status !== 'active' || !quote) return none;
  var price = Number(quote.price);
  if (!isFinite(price) || price <= 0) return none;
  var move = movePct(price, quote.prevClose);
  var v = Number(rule.value);
  var hit = false;
  if (rule.ruleType === 'above') hit = price >= v;
  else if (rule.ruleType === 'below') hit = price <= v;
  else if (rule.ruleType === 'pct_up') hit = move !== null && move >= v;
  else if (rule.ruleType === 'pct_down') hit = move !== null && move <= -v;
  return { hit: hit, move: move };
}

// A short Hebrew description of the condition: "מחיר מעל 200 $".
function describeRule(rule) {
  if (isPctType(rule.ruleType)) {
    return (rule.ruleType === 'pct_up' ? 'עלייה של ' : 'ירידה של ') + formatNumber(rule.value) + '% מהסגירה הקודמת';
  }
  return (rule.ruleType === 'above' ? 'מחיר מעל ' : 'מחיר מתחת ל-') + formatPrice(rule.value, rule.market);
}

// The alert stored when a rule rings, in the shape features.insertAlert
// takes. `armedAt` (when the rule was created or last re-armed) makes the
// dedup key unique per ring, so a re-armed rule can ring again but a retried
// job run cannot ring the same arming twice.
function buildPriceAlert(rule, quote, opts) {
  var o = opts || {};
  var now = o.now || new Date();
  var price = Number(quote.price);
  var move = movePct(price, quote.prevClose);
  var label = rule.name ? rule.name + ' (' + rule.symbol + ')' : rule.symbol;
  var priceText = formatPrice(price, rule.market);
  var title;
  var message;
  if (rule.ruleType === 'above') {
    title = label + ' הגיעה ל-' + priceText + ' - מעל ' + formatPrice(rule.value, rule.market);
    message = label + ' נסחרה ב-' + priceText + ', ברף ההתראה שהגדרת (' + formatPrice(rule.value, rule.market) + ') או מעליו.';
  } else if (rule.ruleType === 'below') {
    title = label + ' ירדה ל-' + priceText + ' - מתחת ל-' + formatPrice(rule.value, rule.market);
    message = label + ' נסחרה ב-' + priceText + ', ברף ההתראה שהגדרת (' + formatPrice(rule.value, rule.market) + ') או מתחתיו.';
  } else {
    var moveText = (move >= 0 ? '+' : '') + (Math.round(move * 100) / 100).toFixed(2) + '%';
    title = label + ' ' + (rule.ruleType === 'pct_up' ? 'עלתה' : 'ירדה') + ' ' + moveText + ' מהסגירה הקודמת';
    message =
      label + ' נסחרה ב-' + priceText + ', שינוי של ' + moveText + ' מהסגירה הקודמת (' + formatPrice(quote.prevClose, rule.market) +
      '). רף ההתראה: ' + formatNumber(rule.value) + '%.';
  }
  if (rule.note) message += ' הערה: ' + rule.note;
  message += ' המחיר מושהה ואינו בזמן אמת; ההתראה לא תופעל שוב עד שתפעילו אותה מחדש.';
  return {
    userId: rule.userId,
    type: 'PRICE_TARGET',
    severity: 'warning',
    sessionDate: quote.tradeDate || now.toISOString().slice(0, 10),
    instrument: { symbol: rule.symbol, market: rule.market, name: rule.name || '', currency: rule.currency || (rule.market === 'TASE' ? 'ILS' : 'USD') },
    title: title,
    message: message,
    priceAlertId: rule.id,
    ruleType: rule.ruleType,
    value: rule.value,
    price: price,
    prevClose: quote.prevClose === undefined ? null : quote.prevClose,
    movePct: move === null ? null : Math.round(move * 100) / 100,
    note: rule.note || '',
    dedupKey: 'price-alert:' + rule.id + ':' + (rule.armedAt || rule.createdAt || '')
  };
}

exports.MAX_PRICE_ALERTS_PER_USER = MAX_PRICE_ALERTS_PER_USER;
exports.RULE_TYPES = RULE_TYPES;
exports.RULE_LABELS_HE = RULE_LABELS_HE;
exports.STATUS_LABELS_HE = STATUS_LABELS_HE;
exports.isPctType = isPctType;
exports.currencySymbol = currencySymbol;
exports.formatPrice = formatPrice;
exports.validatePriceAlertInput = validatePriceAlertInput;
exports.movePct = movePct;
exports.evaluatePriceAlert = evaluatePriceAlert;
exports.describeRule = describeRule;
exports.buildPriceAlert = buildPriceAlert;
