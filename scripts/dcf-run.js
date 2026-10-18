// End-to-end DCF run on live data, outside the browser:
//
//   node scripts/dcf-run.js AVGO KO NVDA [--out <folder>] [--date YYYY-MM-DD]
//
// For each ticker: fetch the dated snapshot (server/dcfSnapshot.js), derive
// the inputs by the auto rules and run the engine (shared/dcfRules.js), write
// the input card as JSON, then reproduce the card offline - from its inputs
// and from its raw data - and fail if any number differs. Also runs the
// manual AVGO preset against DCF_METHOD.md's 117 / 234 / 326.
const fs = require('fs');
const path = require('path');
const { fetchDcfSnapshot } = require('../src/server/dcfSnapshot');
const { evaluateDcf, buildInputCard, reproduceFromCard, AVGO_PRESET } = require('../src/shared/dcfRules');

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

function report(ticker, e, card, file) {
  console.log(`\n=== ${ticker} (${card.mode}) - ${file}`);
  if (e.unsuitable) return console.log(`  not suited to DCF: ${e.unsuitable}`);
  if (!e.model) return console.log(`  missing: ${e.missing.join(', ')}`);
  const m = e.model.base;
  const d = e.derived;
  if (d) {
    console.log(`  raw   revenue TTM ${b(d.revenueTtm.value)} | FCF TTM ${b(d.fcfTtm.value)} (margin ${pct(d.fcfMarginTtm.value)}) | SBC TTM ${b(d.sbcTtm.value)} (${pct(d.sbcPctTtm.value)})`);
    console.log(`        rev0 ${b(d.rev0.value)} [${d.rev0.basis}] | growth1 ${pct(d.growth1.value)} [${d.growth1.basis}]`);
  }
  console.log(`  rate  rf ${pct(m.rf)} | beta_raw ${m.betaRaw ?? 'n/a'} -> beta ${Number(m.beta).toFixed(4)} | erp ${pct(m.erp)} kd ${pct(m.kd)} tax ${pct(m.tax)} gT ${pct(m.gT)}`);
  console.log(`  firm  price ${usd(m.price)} | basic ${(m.basicShares / 1e6).toFixed(1)}M diluted ${(m.dilutedShares / 1e6).toFixed(1)}M | debt ${b(m.debt)} cash ${b(m.cash)}`);
  e.model.scenarios.forEach((s) => {
    console.log(`  ${s.label.padEnd(10)} growth ${s.growth.map((x) => pct(x, 1)).join(' ')} | margin ${s.fcfMargin.map((x) => pct(x, 1)).join(' ')} | sbc ${s.sbcPct.map((x) => pct(x, 1)).join(' ')}`);
  });
  if (!e.main.ok) return console.log(`  error: ${e.main.errors.join('; ')}`);
  console.log(`  ==> WACC ${pct(e.main.wacc)} | per share ${e.model.scenarios.map((s) => `${s.label} ${usd(e.results[s.key].perShare)}`).join(' / ')} | weighted ${usd(e.weighted)}`);
  console.log(`      upside ${pct(e.main.upside, 1)} | TV share ${pct(e.main.tvShare, 1)} | implied exit ${Number(e.main.impliedExit).toFixed(1)}x | IRR ${pct(e.irr)}`);
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
  // The manual preset first - the method's own sanity check.
  const preset = evaluateDcf({ mode: 'manual', manual: AVGO_PRESET, valuationDate: AVGO_PRESET.asOf });
  const presetCard = buildInputCard(preset, null, 'AVGO');
  const presetFile = path.join(out, 'AVGO-manual-preset.json');
  fs.writeFileSync(presetFile, JSON.stringify(presetCard, null, 2));
  report('AVGO preset', preset, presetCard, presetFile);
  const got = ['conservative', 'base', 'management'].map((k) => Math.round(preset.results[k].perShare));
  if (got.join('/') !== '117/234/326' || Math.abs(preset.main.wacc - 0.1125) > 0.00005) {
    failures += 1;
    console.log(`  PRESET MISMATCH: ${got.join('/')} at ${pct(preset.main.wacc)}`);
  } else {
    console.log('  matches DCF_METHOD.md: 117 / 234 / 326 at WACC 11.25%');
  }

  for (const ticker of tickers) {
    const snapshot = await fetchDcfSnapshot(ticker.toUpperCase());
    const e = evaluateDcf({ mode: 'auto', snapshot, valuationDate: date });
    const card = buildInputCard(e, snapshot, ticker.toUpperCase());
    const file = path.join(out, `${ticker.toUpperCase()}-auto-${date}.json`);
    fs.writeFileSync(file, JSON.stringify(card, null, 2));
    console.log(`\n  sources: ${JSON.stringify(snapshot.diagnostics)}`);
    report(ticker.toUpperCase(), e, card, file);
  }
  console.log(`\ncards: ${out}`);
  process.exitCode = failures ? 1 : 0;
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
