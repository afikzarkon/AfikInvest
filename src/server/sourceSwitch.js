// An admin's off switch for each outside data provider.
//
// If a provider asks us to stop (or blocks us), one click in the admin
// panel stops every request to it at once, without a deploy. What it was
// supplying then comes from the next source in its chain, or from the last
// known value the callers already keep - the same path as when the
// provider is simply down.
//
// It works at one place for every provider: an axios request interceptor
// that matches the request's host. Every market source goes through
// axios, so no module needs its own check - except the Puppeteer page
// read, which is not axios and asks isProviderDisabled() itself
// (quotesRoutes.js's TASE chain).
//
// A refused request throws code SOURCE_DISABLED before anything is sent.
// It is not counted against the source's health (sourceHealth.js) and the
// fallback chain moves on as for a spent budget (fallbackChain.js).
//
// The off list is a system setting ('disabled_sources'), so it survives
// restarts, is shared with the worker process (re-read every minute) and
// every change lands in admin_audit_log.

const SETTING_KEY = 'disabled_sources';
const REFRESH_MS = 60 * 1000;

// Each provider: its Hebrew label, the hosts it is reached at, and the
// sourceHealth.js rows that belong to it.
const PROVIDERS = {
  yahoo: { label: 'Yahoo Finance', hosts: ['yahoo.com'], sources: ['yahoo-chart', 'yahoo-summary'] },
  tase: { label: 'הבורסה לניירות ערך - API', hosts: ['api.tase.co.il'], sources: ['tase-api', 'tase-eod', 'tase-index'] },
  'tase-page': { label: 'הבורסה לניירות ערך - קריאת דף (Puppeteer)', hosts: ['market.tase.co.il'], sources: ['puppeteer'] },
  bizportal: { label: 'ביזפורטל', hosts: ['bizportal.co.il'], sources: ['bizportal'] },
  finnhub: { label: 'Finnhub', hosts: ['finnhub.io'], sources: ['finnhub'] },
  fmp: { label: 'Financial Modeling Prep', hosts: ['financialmodelingprep.com'], sources: ['fmp'] },
  tiingo: { label: 'Tiingo', hosts: ['tiingo.com'], sources: ['tiingo'] },
  frankfurter: { label: 'Frankfurter (ECB)', hosts: ['frankfurter.dev'], sources: ['frankfurter'] },
  cbs: { label: 'הלמ"ס', hosts: ['cbs.gov.il'], sources: ['cbs'] }
};

// A host belongs to a provider when it is one of its hosts or a subdomain
// of one (query1.finance.yahoo.com -> yahoo).
function providerOfHost(hostname) {
  const host = String(hostname || '').toLowerCase();
  if (!host) return null;
  for (const [name, p] of Object.entries(PROVIDERS)) {
    if (p.hosts.some((h) => host === h || host.endsWith(`.${h}`))) return name;
  }
  return null;
}

function providerOfUrl(url, baseURL) {
  try {
    return providerOfHost(new URL(url, baseURL).hostname);
  } catch {
    return null;
  }
}

function providerOfSource(sourceName) {
  for (const [name, p] of Object.entries(PROVIDERS)) {
    if (p.sources.includes(sourceName)) return name;
  }
  return null;
}

function disabledError(provider) {
  const err = new Error(`${provider} is switched off by an admin`);
  err.code = 'SOURCE_DISABLED';
  return err;
}

function cleanList(list) {
  return [...new Set((Array.isArray(list) ? list : []).filter((name) => Object.prototype.hasOwnProperty.call(PROVIDERS, name)))];
}

function createSourceSwitch({ logger = console } = {}) {
  let disabled = new Set();
  let admin = null;
  let timer = null;

  const apply = (list) => {
    disabled = new Set(cleanList(list));
  };

  async function refresh() {
    if (!admin) return;
    try {
      const value = await admin.getSetting(SETTING_KEY);
      apply(value && value.disabled);
    } catch (err) {
      // Keeps the list it has: a database hiccup must not switch a
      // provider back on.
      logger.warn('[source-switch] could not read the off list:', err && err.message);
    }
  }

  return {
    isProviderDisabled: (provider) => disabled.has(provider),
    isSourceDisabled: (sourceName) => disabled.has(providerOfSource(sourceName)),
    disabledList: () => [...disabled],

    // The admin panel's list: every provider, whether it is off.
    list: () => Object.entries(PROVIDERS).map(([name, p]) => ({ name, label: p.label, hosts: p.hosts, disabled: disabled.has(name) })),

    // Throws SOURCE_DISABLED for a request to a provider that is off.
    assertAllowed(url, baseURL) {
      const provider = providerOfUrl(url, baseURL);
      if (provider && disabled.has(provider)) throw disabledError(provider);
    },

    async attach(adminStore) {
      admin = adminStore;
      await refresh();
      if (!timer) {
        timer = setInterval(refresh, REFRESH_MS);
        if (timer.unref) timer.unref();
      }
    },

    // Saves the off list (audited by adminStore.setSetting) and applies it
    // in this process at once. `store` defaults to the attached admin store.
    async save(list, actor, store = admin) {
      const value = await store.setSetting(SETTING_KEY, { disabled: cleanList(list) }, actor);
      apply(value.disabled);
      return this.list();
    },

    apply
  };
}

// The one the app uses; tests build their own.
const sourceSwitch = createSourceSwitch();

// Installs the check on an axios instance (the shared default one, which
// every market source module uses). Safe to call more than once.
const installed = new WeakSet();
function installSourceSwitch(axiosInstance = require('axios'), sw = sourceSwitch) {
  if (installed.has(axiosInstance)) return;
  installed.add(axiosInstance);
  axiosInstance.interceptors.request.use((config) => {
    sw.assertAllowed(config.url, config.baseURL);
    return config;
  });
}

module.exports = { sourceSwitch, createSourceSwitch, installSourceSwitch, providerOfHost, providerOfSource, PROVIDERS, SETTING_KEY };
