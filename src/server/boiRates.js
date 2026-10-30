// The Bank of Israel's representative rates (שער יציג) - the first source
// for the shekel's exchange-rate history, ahead of Yahoo and the ECB.
//
// WHY. It is the rate Israeli tax and brokers use, published once a
// working day, and the one a person checks on boi.org.il. Yahoo's USDILS=X
// history was found carrying a rate from days earlier under a newer date:
// it had 28.10.2026 at ~3.02 where the Bank of Israel published 3.1280,
// and so "yesterday" showed the dollar adding ~8,000 shekels on a day it
// fell 0.45%.
//
// The API is the Bank's public SDMX service: no key, CSV out. A series is
// RER_<CUR>_ILS; each row carries TIME_PERIOD (YYYY-MM-DD) and OBS_VALUE.
// The columns are found by name, not position.
const axios = require('axios');

const BASE_URL = 'https://edge.boi.gov.il/FusionEdgeServer/sdmx/v2/data/dataflow/BOI.STATISTICS/EXR/1.0';
const REQUEST_TIMEOUT_MS = 10000;

// Yahoo's FX symbols this app uses -> the Bank's series, for the pairs
// against the shekel it publishes.
function boiSeries(symbol) {
  const m = /^(USD|EUR|GBP)ILS=X$/.exec(String(symbol || ''));
  return m ? `RER_${m[1]}_ILS` : null;
}

function isBoiSymbol(symbol) {
  return Boolean(boiSeries(symbol));
}

const unquote = (s) => String(s).trim().replace(/^"(.*)"$/, '$1');

// CSV text -> [{ date, close }] ascending, one per date.
function parseBoiCsv(text) {
  const lines = String(text || '').split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return [];
  const header = lines[0].split(',').map(unquote);
  const dateCol = header.indexOf('TIME_PERIOD');
  const valueCol = header.indexOf('OBS_VALUE');
  if (dateCol < 0 || valueCol < 0) return [];
  const byDate = new Map();
  lines.slice(1).forEach((line) => {
    const cells = line.split(',').map(unquote);
    const date = cells[dateCol];
    const close = Number(cells[valueCol]);
    if (/^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(close) && close > 0) byDate.set(date, close);
  });
  return [...byDate.entries()].map(([date, close]) => ({ date, close })).sort((a, b) => (a.date < b.date ? -1 : 1));
}

// Daily representative rates from a date to today -
// fetchYahooHistoricalCloses's [{ date, close }] ascending. Throws when
// there are none, so the caller falls back.
async function fetchBoiHistory(symbol, fromDateStr, { get = axios.get } = {}) {
  const series = boiSeries(symbol);
  if (!series) throw new Error(`not a Bank of Israel series: ${symbol}`);
  const from = fromDateStr || new Date(Date.now() - 400 * 86400000).toISOString().slice(0, 10);
  const response = await get(`${BASE_URL}/${series}`, {
    params: { startperiod: from, format: 'csv' },
    timeout: REQUEST_TIMEOUT_MS,
    responseType: 'text'
  });
  const points = parseBoiCsv(response && response.data);
  if (!points.length) throw new Error(`bank of israel has no ${series} rates`);
  return points;
}

module.exports = { isBoiSymbol, fetchBoiHistory, parseBoiCsv };
