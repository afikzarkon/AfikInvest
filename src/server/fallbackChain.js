// The one way every piece of market data with more than one source is
// fetched: try each source in order, return the first answer, and say so
// whenever the answer did not come from the first choice.
//
//   runFallbackChain('sector:NVDA', [
//     { source: 'yahoo-summary', fn: () => ... },
//     { source: 'finnhub', enabled: isFinnhubEnabled(), fn: () => ... },
//     { source: 'fmp', enabled: isFmpEnabled(), fn: () => ... }
//   ])  ->  { value, source }
//
// - A source whose key is not configured (enabled: false) is skipped
//   silently - not having a Tiingo key is a setup choice, not a failure.
// - Each attempt is recorded in sourceHealth (the admin panel's list),
//   except a refusal that made no request: a spent free-plan budget or
//   Yahoo's own cooldown says nothing about the source's health.
// - When a fallback answers, one warning line names the data, the source
//   that answered and why the ones before it did not.
// - `accept(value)` can reject an answer that arrived but is no use (an
//   empty list, a profile with no sector) so the next source is asked.
// - When every source fails, the error lists each one's reason. The
//   callers already keep a last known value for that case (symbolCache,
//   getYahooPayload's last good quote, the valuation cache), which is the
//   final link of the chain.
const { sourceHealth } = require('./sourceHealth');

// Refusals that made no request: a spent free-plan budget, Yahoo's
// cooldown, an FMP endpoint already known to be outside the key's plan.
const NO_REQUEST_CODES = new Set(['FINNHUB_BUDGET', 'FMP_BUDGET', 'FMP_PLAN', 'TIINGO_BUDGET', 'YAHOO_COOLDOWN']);

function reasonOf(err) {
  if (!err) return 'unknown error';
  const status = err.response && err.response.status;
  return status ? `HTTP ${status}` : err.message || String(err);
}

async function runFallbackChain(label, steps, { logger = console, accept = () => true } = {}) {
  const failures = [];
  for (const step of steps) {
    if (step.enabled === false) continue;
    try {
      const value = await step.fn();
      if (!accept(value)) {
        failures.push(`${step.source}: no usable data`);
        continue;
      }
      if (step.track !== false) sourceHealth.success(step.source);
      if (failures.length) {
        logger.warn(`[market-data] ${label}: using fallback ${step.source} (${failures.join('; ')})`);
      }
      return { value, source: step.source };
    } catch (err) {
      if (step.track !== false && !NO_REQUEST_CODES.has(err && err.code)) sourceHealth.failure(step.source, err);
      failures.push(`${step.source}: ${reasonOf(err)}`);
    }
  }
  const err = new Error(`${label}: every source failed (${failures.join('; ') || 'none configured'})`);
  err.failures = failures;
  throw err;
}

module.exports = { runFallbackChain };
