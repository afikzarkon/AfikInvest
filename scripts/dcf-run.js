// End-to-end DCF run on live data, outside the browser:
//
//   node scripts/dcf-run.js NOW AVGO [--out <folder>] [--date YYYY-MM-DD]
//
// First the manual presets against their expected numbers (AVGO: DCF_METHOD.md's
// 117 / 234 / 326; NOW: 60.1 / 127.4 / 166.5). Then, for each ticker: fetch the
// dated snapshot (server/dcfSnapshot.js), derive the inputs by the auto rules
// and run the engine (shared/dcfRules.js), write the input card as JSON, and
// reproduce the card offline - from its inputs and from its raw data -
// failing if any number differs.
const fs = require('fs');
const path = require('path');
const { fetchDcfSnapshot } = require('../src/server/dcfSnapshot');
const { evaluateDcf, buildInputCard, reproduceFromCard, PRESETS } = require('../src/shared/dcfRules');

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i > -1 ? args[i + 1] : null;
};
const tickers = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--')));
const out = path.resolve(flag('--out') || path.join(require('os').tmpdir(), 'afikinvest-dcf-cards'));
const date = flag('--date') || new Date().toISOString().slice(0, 10);
fs.mkdirSync(out, { recursive: true });

const pct = (v, d = 2) => (Number.isFinite(v) ? `${(v * 100).toFixed(d)}%` : 'n/a');
const b = (v) => (Number.isFinite(v) ? `${(v / 1e9).toFixed(3)}B` : 'n/a');
const usd = (v) => (Number.isFinite(v) ? v.toFixed(2) : 'n/a');
let failures = 0;

// What each preset must give back (per share by scenario, and the WACC).
const EXPECTED = {
  AVGO: { values: { conservative: 117, base: 234, management: 326 }, wacc: 0.1125 },
  NOW: { values: { bear: 60.1, base: 127.4, bull: 166.5 }, wacc: 0.0933 }
};

function checkReproduction(card) {
  const { fromInputs, fromRaw } = reproduceFromCard(JSON.parse(JSON.stringify(card)));
  const diffs = [];
  Object.keys(card.results.scenarios || {}).forEach((k) => {
    if (fromInputs.results[k].perShare !== card.results.scenarios[k].perShare) diffs.push(`${k} from inputs`);
    if (fromRaw && fromRaw.results[k].perShare !== card.results.scenarios[k].perShare) diffs.push(`${k} from raw`);
  });
  if (fromInputs.main.wacc !== card.results.wacc) diffs.push('wacc');
  if (fromInputs.irr !== card.results.irr) diffs.push('irr');
  return diffs;
}

function report(label, e, card, file) {
  console.log(`\n=== ${label} (${card.mode}) - ${file}`);
  if (e.unsuitable) return console.log(`  not suited to DCF: ${e.unsuitable}`);
  if (!e.model) return console.log(`  missing: ${e.missing.join(', ')}`);
  const m = e.model.base;
  const d = e.derived;
  if (d) {
    console.log(`  raw   revenue TTM ${b(d.revenueTtm.value)} | FCF TTM ${b(d.fcfTtm.value)} (${d.fcfBasis}, margin ${pct(d.fcfMarginTtm.value)}) | SBC TTM ${b(d.sbcTtm.value)} (${pct(d.sbcPctTtm.value)})`);
    console.log(`        rev0 ${b(d.rev0.value)} [${d.rev0.basis}] | growth1 ${pct(d.growth1.value)} [${d.growth1.basis}]`);
    const parts = d.cash.parts || {};
    console.log(`  cash  ${b(d.cash.value)} = cash ${b(parts.cash)} + short-term ${b(parts.shortTermInvestments)} + long-term marketable ${b(parts.longTermMarketable)}`);
  }
  console.log(`  rate  rf ${pct(m.rf)} | beta_raw ${m.betaRaw ?? 'n/a'} -> beta ${Number(m.beta).toFixed(4)} | erp ${pct(m.erp)} kd ${pct(m.kd)} tax ${pct(m.tax)} gT ${pct(m.gT)}`);
  console.log(`  firm  price ${usd(m.price)} | basic ${(m.basicShares / 1e6).toFixed(1)}M diluted ${(m.dilutedShares / 1e6).toFixed(1)}M | debt ${b(m.debt)} cash ${b(m.cash)}`);
  e.model.scenarios.forEach((s) => {
    console.log(`  ${s.label.padEnd(10)} growth ${s.growth.map((x) => pct(x, 1)).join(' ')} | margin ${s.fcfMargin.map((x) => pct(x, 1)).join(' ')} | sbc ${s.sbcPct.map((x) => pct(x, 1)).join(' ')}`);
  });
  if (e.schedules) {
    console.log(`  source growth: ${e.schedules.growthSources.map((x) => x.kind).join(' / ')} | margin: ${e.schedules.marginSources.map((x) => x.kind).join(' / ')}`);
  }
  if (!e.main.ok) return console.log(`  error: ${e.main.errors.join('; ')}`);
  console.log(`  ==> WACC ${pct(e.main.wacc)} | per share ${e.model.scenarios.map((s) => `${s.label} ${usd(e.results[s.key].perShare)}`).join(' / ')} | weighted ${usd(e.weighted)}`);
  console.log(`      IRR ${e.model.scenarios.map((s) => pct(e.irrByScenario[s.key])).join(' / ')} | implied growth ${pct(e.impliedGrowth)} | TV share ${pct(e.main.tvShare, 1)} | implied exit ${Number(e.main.impliedExit).toFixed(1)}x`);
  e.flags.forEach((f) => console.log(`  flag: ${f}`));
  e.warnings.forEach((w) => console.log(`  warning: ${w}`));
  const diffs = checkReproduction(card);
  if (diffs.length) {
    failures += 1;
    console.log(`  REPRODUCTION FAILED: ${diffs.join(', ')}`);
  } else {
    console.log('  reproduction from the card alone (inputs and raw data): identical');
  }
}

(async () => {
  // The manual presets first - the method's own sanity checks.
  for (const [ticker, preset] of Object.entries(PRESETS)) {
    const e = evaluateDcf({ mode: 'manual', manual: preset, valuationDate: preset.asOf });
    const card = buildInputCard(e, null, ticker);
    const file = path.join(out, `${ticker}-manual-preset.json`);
    fs.writeFileSync(file, JSON.stringify(card, null, 2));
    report(`${ticker} preset`, e, card, file);
    const want = EXPECTED[ticker];
    const off = Object.entries(want.values).filter(([k, v]) => Math.abs(e.results[k].perShare - v) > 1);
    if (off.length || Math.abs(e.main.wacc - want.wacc) > 0.00005) {
      failures += 1;
      console.log(`  PRESET MISMATCH: ${off.map(([k]) => `${k} ${usd(e.results[k].perShare)}`).join(', ')} WACC ${pct(e.main.wacc)}`);
    } else {
      console.log(`  matches the expected ${Object.values(want.values).join(' / ')} at WACC ${pct(want.wacc)}`);
    }
  }

  for (const raw of tickers) {
    const ticker = raw.toUpperCase();
    const snapshot = await fetchDcfSnapshot(ticker);
    const e = evaluateDcf({ mode: 'auto', snapshot, valuationDate: date });
    const card = buildInputCard(e, snapshot, ticker);
    const file = path.join(out, `${ticker}-auto-${date}.json`);
    fs.writeFileSync(file, JSON.stringify(card, null, 2));
    console.log(`\n  sources: ${JSON.stringify(snapshot.diagnostics)}`);
    report(ticker, e, card, file);
  }
  console.log(`\ncards: ${out}`);
  process.exitCode = failures ? 1 : 0;
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
