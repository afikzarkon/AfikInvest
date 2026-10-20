import React, { useMemo, useState } from 'react';
import { evaluateDcf, buildInputCard, PRESETS, DEFAULT_RULES, waccBandText } from '../../shared/dcfRules';
import { runDcf } from '../../shared/dcfEngine';
import { DCF_VERDICT_TONE } from '../../utils/valuationInsights';
import { Num, ToneBadge, fmtMoney, fmtRate } from './shared';

// The DCF calculator on the one engine (shared/dcfEngine.runDcf), in two
// modes:
//   auto   - every input derived by the visible rules (shared/dcfRules.js)
//            from the dated data snapshot. The rules' own numbers are shown,
//            not edited; what a person may ADD, each with its source, is a
//            consensus / guidance growth or margin for a year, the
//            company's normalized FCF, and the rate when it is missing.
//   manual - the same model, every number editable (or a preset). Editing
//            the auto model turns it into a manual, "custom" one.
// Three scenarios side by side, a weighted row, the per-year assumptions
// with each year's source, the discount rate built up from its parts,
// sensitivity, the sources, the rules, and an export of the input card
// that reproduces it all offline.

export const VALUE_WORDS = { UNDERVALUED: 'מתומחרת בחסר', FAIRLY_VALUED: 'מחיר הוגן', OVERVALUED: 'מתומחרת ביתר', 'N/A': 'לא ניתן לקבוע' };

const clone = (x) => JSON.parse(JSON.stringify(x));
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const today = () => new Date().toISOString().slice(0, 10);

function howMuch(bigger, smaller) {
  const ratio = bigger / smaller;
  return ratio >= 2 ? `פי ${ratio.toFixed(1)}` : `ב-${Math.round((ratio - 1) * 100)}%`;
}

export function verdictSentence(result, label, band) {
  if (!result || !result.ok) return '';
  const { perShare: value, price } = result;
  if (!(value > 0)) return 'לפי ההנחות האלה אין למניה שווי חיובי - החוב גדול מהשווי של הפעילות.';
  if (label === 'OVERVALUED') return `לפי תרחיש הבסיס המניה נראית יקרה: המחיר היום גבוה ${howMuch(price, value)} מהשווי שחושב.`;
  if (label === 'UNDERVALUED') return `לפי תרחיש הבסיס המניה נראית זולה: השווי שחושב גבוה ${howMuch(value, price)} מהמחיר היום.`;
  return `לפי תרחיש הבסיס המחיר היום קרוב לשווי (הפרש של פחות מ-${Math.round(band * 100)}%).`;
}

// "If you buy at today's price and the base case comes true, you earn about
// X% a year" - against the return the model requires (WACC) - and the
// constant growth the price implies.
export function irrSentence(evaluation) {
  const main = evaluation && evaluation.main;
  if (!main || !main.ok) return '';
  const implied = isNum(evaluation.impliedGrowth)
    ? ` כדי שהמחיר יהיה הוגן באותם שוליים, ההכנסות צריכות לגדול בכ-${(evaluation.impliedGrowth * 100).toFixed(1)}% בכל שנה, 5 שנים.`
    : '';
  if (!isNum(evaluation.irr)) {
    return (main.perShare < main.price
      ? 'גם בשיעור היוון נמוך מאוד השווי לפי תרחיש הבסיס נמוך מהמחיר - אין תשואה שנתית משתמעת.'
      : 'השווי לפי תרחיש הבסיס גבוה מהמחיר גם בשיעור היוון גבוה מאוד.') + implied;
  }
  const diff = evaluation.irr - main.wacc;
  const reading = diff > 0.01 ? 'יותר מהתשואה שהמודל דורש - לפי ההנחות המחיר אטרקטיבי.' : diff < -0.01 ? 'פחות מהתשואה שהמודל דורש - לפי ההנחות המחיר גבוה.' : 'בערך התשואה שהמודל דורש.';
  return `בקנייה במחיר של היום, אם תרחיש הבסיס יתממש, התשואה השנתית הצפויה היא כ-${(evaluation.irr * 100).toFixed(1)}%, מול תשואה נדרשת (WACC) של ${(main.wacc * 100).toFixed(2)}%. זה ${reading}${implied}`;
}

// A number field that shows percent / billions / millions and keeps what
// the user is typing until it parses. allowEmpty: clearing it reports null.
const UNITS = {
  pct: { toText: (v) => (v * 100).toFixed(2), fromText: (t) => Number(t) / 100, suffix: '%' },
  money: { toText: (v) => (v / 1e9).toFixed(3), fromText: (t) => Number(t) * 1e9, suffix: 'B' },
  shares: { toText: (v) => (v / 1e6).toFixed(1), fromText: (t) => Number(t) * 1e6, suffix: 'M' },
  plain: { toText: (v) => String(Math.round(v * 10000) / 10000), fromText: (t) => Number(t), suffix: '' }
};

function NumberField({ id, label, value, unit = 'plain', onChange, readOnly, note, allowEmpty, placeholder }) {
  const u = UNITS[unit];
  const [text, setText] = useState(null);
  const shown = text !== null ? text : isNum(value) ? u.toText(value) : '';
  return (
    <div className="dcf-field">
      <label htmlFor={id}>{label}</label>
      <span className="dcf-field-input">
        <input
          id={id}
          type="text"
          inputMode="decimal"
          dir="ltr"
          value={shown}
          placeholder={placeholder}
          readOnly={readOnly}
          onChange={(e) => {
            setText(e.target.value);
            if (allowEmpty && e.target.value.trim() === '') return onChange(null);
            const v = u.fromText(e.target.value);
            if (e.target.value.trim() !== '' && Number.isFinite(v)) onChange(v);
            return undefined;
          }}
          onBlur={() => setText(null)}
        />
        {u.suffix && <span className="dcf-field-suffix">{u.suffix}</span>}
      </span>
      {note && <span className="dcf-field-note">{note}</span>}
    </div>
  );
}

function TextField({ id, label, value, onChange, placeholder, type = 'text' }) {
  return (
    <div className="dcf-field">
      <label htmlFor={id}>{label}</label>
      <input id={id} className="dcf-text" type={type} value={value || ''} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}

function downloadJson(obj, filename) {
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function ScenarioCards({ evaluation, currency, priceCurrency, active, onSelect }) {
  const { model, results, labels, weighted } = evaluation;
  return (
    <div className="dcf-scenario-cards" role="group" aria-label="תרחישים">
      {model.scenarios.map((s) => {
        const r = results[s.key];
        const label = labels ? labels[s.key] : 'N/A';
        return (
          <button key={s.key} type="button" className={`dcf-scenario-card ${active === s.key ? 'is-active' : ''}`} aria-pressed={active === s.key} onClick={() => onSelect(s.key)}>
            <span className="dcf-scenario-name">{s.label}</span>
            {r.ok ? (
              <>
                <strong className="dcf-scenario-value" data-testid={`dcf-value-${s.key}`}>
                  <Num>{fmtMoney(r.perShare, currency)}</Num>
                </strong>
                <span className="dcf-scenario-upside">
                  <Num>{`${r.upside >= 0 ? '+' : ''}${(r.upside * 100).toFixed(1)}%`}</Num> מול המחיר
                  {evaluation.irrByScenario && isNum(evaluation.irrByScenario[s.key]) ? (
                    <>
                      {' '}
                      · IRR <Num>{fmtRate(evaluation.irrByScenario[s.key], 1)}</Num>
                    </>
                  ) : null}
                </span>
                <ToneBadge tone={DCF_VERDICT_TONE[label]}>{VALUE_WORDS[label]}</ToneBadge>
              </>
            ) : (
              <span className="dcf-scenario-error">{r.errors[0]}</span>
            )}
          </button>
        );
      })}
      <div className="dcf-scenario-card dcf-scenario-weighted">
        <span className="dcf-scenario-name">ממוצע משוקלל</span>
        <strong className="dcf-scenario-value" data-testid="dcf-value-weighted">
          <Num>{isNum(weighted) ? fmtMoney(weighted, currency) : '—'}</Num>
        </strong>
        <span className="dcf-scenario-upside">
          {Object.entries(model.weights || {})
            .map(([k, w]) => `${Math.round(w * 100)}% ${(model.scenarios.find((s) => s.key === k) || {}).label || k}`)
            .join(' · ')}
        </span>
        <span className="dcf-scenario-upside">
          מחיר: <Num>{fmtMoney(model.base.price, priceCurrency)}</Num>
        </span>
      </div>
    </div>
  );
}

const SOURCE_BADGES = { consensus: ['normal', 'קונצנזוס'], guidance: ['normal', 'הנחיה'], held: ['mixed', 'מוחזק'], rule: ['na', 'כלל'] };

function SourceCell({ source }) {
  if (!source) return null;
  const [tone, word] = SOURCE_BADGES[source.kind] || ['na', source.kind];
  return (
    <span title={source.text} className="dcf-source-cell">
      <ToneBadge tone={tone}>{word}</ToneBadge>
    </span>
  );
}

// The per-year table. In auto mode it also takes the figures a person may
// add - consensus / guidance growth and margins - and shows each year's
// source; in manual mode every assumption is editable.
function YearTable({ scenario, result, editable, onEdit, fyLabels, currency, schedules, overrides, onOverrides, isBase }) {
  const rows = [
    { key: 'growth', label: 'צמיחת הכנסות', sourceKey: 'growthSources' },
    { key: 'fcfMargin', label: 'שולי FCF (לפני SBC)', sourceKey: 'marginSources' },
    { key: 'sbcPct', label: 'SBC מההכנסות' }
  ];
  const yearName = (i) => (fyLabels ? fyLabels[i] : `שנה ${i + 1}`);
  const guidanceRow = (field, label) => (
    <tr className="dcf-guidance-row">
      <th scope="row">{label}</th>
      {scenario.growth.map((_, i) => {
        const entry = overrides && overrides[field] ? overrides[field][i] : null;
        return (
          <td key={`${field}-${i}`}>
            <NumberField
              id={`dcf-ov-${field}-${i}`}
              label={<span className="visually-hidden">{`${label}, ${yearName(i)}`}</span>}
              value={entry && isNum(entry.value) ? entry.value : null}
              unit="pct"
              allowEmpty
              placeholder="—"
              onChange={(v) => onOverrides(field, i, v)}
            />
          </td>
        );
      })}
    </tr>
  );
  return (
    <div className="stocks-table-container">
      <table className="analysis-table dcf-years" aria-label="הנחות לכל שנה">
        <thead>
          <tr>
            <th scope="col">שנה</th>
            {scenario.growth.map((_, i) => (
              <th key={i} scope="col">
                {yearName(i)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <React.Fragment key={row.key}>
              <tr>
                <th scope="row">{row.label}</th>
                {scenario[row.key].map((v, i) => (
                  <td key={`${scenario.key}-${i}`}>
                    {editable ? (
                      <NumberField
                        id={`dcf-${scenario.key}-${row.key}-${i}`}
                        label={<span className="visually-hidden">{`${row.label}, ${yearName(i)}`}</span>}
                        value={v}
                        unit="pct"
                        onChange={(nv) => onEdit(row.key, i, nv)}
                      />
                    ) : (
                      <Num>{fmtRate(v)}</Num>
                    )}
                  </td>
                ))}
              </tr>
              {!editable && isBase && schedules && row.sourceKey && (
                <tr className="dcf-source-row">
                  <th scope="row">מקור</th>
                  {schedules[row.sourceKey].map((src, i) => (
                    <td key={i}>
                      <SourceCell source={src} />
                    </td>
                  ))}
                </tr>
              )}
            </React.Fragment>
          ))}
          {!editable && onOverrides && guidanceRow('growth', 'צמיחה מקונצנזוס / הנחיה')}
          {!editable && onOverrides && guidanceRow('fcfMargin', 'שולי FCF מהנחיה / קונצנזוס')}
          {result && result.ok && (
            <>
              <tr>
                <th scope="row">הכנסות</th>
                {result.years.map((y) => (
                  <td key={y.t}>
                    <Num>{fmtMoney(y.rev)}</Num>
                  </td>
                ))}
              </tr>
              <tr>
                <th scope="row">FCF אחרי SBC</th>
                {result.years.map((y) => (
                  <td key={y.t}>
                    <Num>{fmtMoney(y.adj)}</Num>
                  </td>
                ))}
              </tr>
              <tr>
                <th scope="row">ערך נוכחי</th>
                {result.years.map((y) => (
                  <td key={y.t}>
                    <Num>{fmtMoney(y.pv)}</Num>
                  </td>
                ))}
              </tr>
            </>
          )}
        </tbody>
      </table>
      {result && result.ok && (
        <p className="muted-note">
          סכום הערכים הנוכחיים <Num>{fmtMoney(result.sumPv, currency)}</Num> · ערך סופי <Num>{fmtMoney(result.tv, currency)}</Num> (ערכו היום <Num>{fmtMoney(result.pvTv, currency)}</Num>,{' '}
          <Num>{fmtRate(result.tvShare)}</Num> מהשווי) · שווי פעילות <Num>{fmtMoney(result.ev, currency)}</Num> · שווי הון <Num>{fmtMoney(result.equity, currency)}</Num>
        </p>
      )}
    </div>
  );
}

// Where the added growth / margin figures come from, one source per row.
function GuidanceSources({ overrides, onSource }) {
  const first = (field) => (overrides[field] || []).find((e) => e && isNum(e.value)) || {};
  return (
    <div className="dcf-fields">
      <TextField id="dcf-ov-growth-source" label="מקור הצמיחה שהוזנה" value={first('growth').source} placeholder="למשל: קונצנזוס, Visible Alpha" onChange={(v) => onSource('growth', 'source', v)} />
      <TextField id="dcf-ov-growth-date" label="תאריך" type="date" value={first('growth').asOf} onChange={(v) => onSource('growth', 'asOf', v)} />
      <TextField id="dcf-ov-margin-source" label="מקור השוליים שהוזנו" value={first('fcfMargin').source} placeholder="למשל: הנחיית החברה, שיחת רווחים" onChange={(v) => onSource('fcfMargin', 'source', v)} />
      <TextField id="dcf-ov-margin-date" label="תאריך" type="date" value={first('fcfMargin').asOf} onChange={(v) => onSource('fcfMargin', 'asOf', v)} />
    </div>
  );
}

// The two FCF bases, and which one the model uses.
function FcfBasis({ evaluation, overrides, onOverride, currency }) {
  const d = evaluation.derived;
  const rev = d.revenueTtm.value;
  const margin = (v) => (isNum(v) && rev > 0 ? fmtRate(v / rev, 1) : '—');
  const normalized = overrides.normalizedFcfTtm || {};
  const choose = (basis) => onOverride('fcfBasis', basis);
  return (
    <div className="dcf-basis" role="radiogroup" aria-label="בסיס ה-FCF">
      <label className="dcf-basis-option">
        <input type="radio" name="dcf-basis" checked={d.fcfBasis === 'reported'} onChange={() => choose('reported')} />
        <span>
          תזרים תפעולי פחות Capex: <Num>{fmtMoney(d.fcfTtmReported.value, currency)}</Num> (<Num>{margin(d.fcfTtmReported.value)}</Num>) - ברירת המחדל
        </span>
      </label>
      <label className="dcf-basis-option">
        <input type="radio" name="dcf-basis" checked={d.fcfBasis === 'normalized'} onChange={() => choose('normalized')} disabled={!isNum(normalized.value)} />
        <span>
          FCF מנורמל של החברה (מוסיף חזרה עלויות רכישה חד-פעמיות):{' '}
          {isNum(normalized.value) ? (
            <>
              <Num>{fmtMoney(normalized.value, currency)}</Num> (<Num>{margin(normalized.value)}</Num>)
            </>
          ) : (
            'לא הוזן'
          )}
        </span>
      </label>
      <div className="dcf-fields">
        <NumberField
          id="dcf-ov-normalized"
          label="FCF מנורמל, 12 חודשים"
          value={isNum(normalized.value) ? normalized.value : null}
          unit="money"
          allowEmpty
          placeholder="—"
          onChange={(v) => onOverride('normalizedFcfTtm', v === null ? null : Object.assign({ source: '', asOf: today() }, normalized, { value: v }))}
        />
        <TextField
          id="dcf-ov-normalized-source"
          label="מקור"
          value={normalized.source}
          placeholder="למשל: דוח רבעון 2, עמ' 12"
          onChange={(v) => isNum(normalized.value) && onOverride('normalizedFcfTtm', Object.assign({}, normalized, { source: v }))}
        />
        <TextField
          id="dcf-ov-normalized-date"
          label="תאריך"
          type="date"
          value={normalized.asOf}
          onChange={(v) => isNum(normalized.value) && onOverride('normalizedFcfTtm', Object.assign({}, normalized, { asOf: v }))}
        />
      </div>
    </div>
  );
}

function WaccPanel({ evaluation, editable, onBase, sourcesByField }) {
  const b = evaluation.model.base;
  const main = evaluation.main;
  const f = (key, label, unit, note, alwaysReadOnly) => (
    <NumberField
      key={`${key}-${editable}`}
      id={`dcf-base-${key}`}
      label={label}
      value={b[key]}
      unit={unit}
      readOnly={!editable || alwaysReadOnly}
      onChange={(v) => onBase(key, v)}
      note={note || (sourcesByField && sourcesByField[key])}
    />
  );
  return (
    <div className="dcf-wacc">
      <div className="dcf-fields">
        {f('rf', 'ריבית חסרת סיכון (rf)', 'pct')}
        {isNum(b.betaRaw) && f('betaRaw', 'בטא גולמית (מידע)', 'plain', 'Yahoo, 5 שנים חודשית; המודל משתמש בבטא המתואמת', true)}
        {f(
          'beta',
          'בטא מתואמת',
          'plain',
          evaluation.derived && evaluation.derived.beta && evaluation.derived.beta.capped
            ? evaluation.derived.beta.basis
            : isNum(b.betaRaw)
              ? `${DEFAULT_RULES.betaWeight} × ${b.betaRaw.toFixed(3)} + ${DEFAULT_RULES.betaConst}`
              : null
        )}
        {f('erp', 'פרמיית סיכון שוק', 'pct')}
        {f('kd', 'עלות חוב לפני מס', 'pct')}
        {f('tax', 'שיעור מס', 'pct')}
        {f('gT', 'צמיחה סופית (gT)', 'pct')}
        {editable && <NumberField id="dcf-base-waccOverride" label="WACC ידני (ריק = מחושב)" value={isNum(b.waccOverride) ? b.waccOverride : null} unit="pct" allowEmpty onChange={(v) => onBase('waccOverride', v)} />}
      </div>
      {main && main.ok && (
        <p className="muted-note">
          {main.waccOverridden && evaluation.waccBand ? (
            <>
              WACC מחושב <Num>{fmtRate(evaluation.waccBand.computed, 2)}</Num> ({waccBandText(evaluation.waccBand.min, evaluation.waccBand.max)}), ולכן{' '}
              <strong>
                WACC <Num>{fmtRate(main.wacc, 2)}</Num>
              </strong>
            </>
          ) : main.waccOverridden ? (
            <>
              WACC הוזן ידנית: <Num>{fmtRate(main.wacc, 2)}</Num>
            </>
          ) : (
            <>
              עלות הון עצמי <Num>{fmtRate(main.ke, 2)}</Num> (rf + בטא × פרמיה) · משקל הון <Num>{fmtRate(main.wE, 2)}</Num> (שווי שוק <Num>{fmtMoney(main.marketCap)}</Num> מול חוב{' '}
              <Num>{fmtMoney(b.debt)}</Num>) · עלות חוב אחרי מס <Num>{fmtRate(main.kdAfterTax, 2)}</Num> → <strong>WACC <Num>{fmtRate(main.wacc, 2)}</Num></strong>
            </>
          )}
        </p>
      )}
    </div>
  );
}

function CompanyFields({ evaluation, editable, onBase, sourcesByField }) {
  const b = evaluation.model.base;
  const f = (key, label, unit) => (
    <NumberField key={`${key}-${editable}`} id={`dcf-base-${key}`} label={label} value={b[key]} unit={unit} readOnly={!editable} onChange={(v) => onBase(key, v)} note={sourcesByField && sourcesByField[key]} />
  );
  return (
    <div className="dcf-fields">
      {f('price', 'מחיר', 'plain')}
      {f('rev0', 'הכנסות בסיס (שנה נוכחית)', 'money')}
      {f('cash', 'מזומן והשקעות סחירות', 'money')}
      {f('debt', 'חוב (קצר + ארוך, ללא חכירות)', 'money')}
      {f('basicShares', 'מניות בסיסי (לשווי שוק)', 'shares')}
      {f('dilutedShares', 'מניות מדולל (לשווי למניה)', 'shares')}
    </div>
  );
}

function Sensitivity({ grid, currency, main }) {
  if (!grid) return null;
  // Rows are the terminal growth under Gordon, the multiple under the exit
  // method (dcfEngine.sensitivity).
  const byExit = grid.rowKind === 'exitMultiple';
  const rowText = (v) => (byExit ? `${v}x` : fmtRate(v, 1));
  return (
    <div className="stocks-table-container">
      <table className="analysis-table dcf-grid" aria-label="רגישות">
        <thead>
          <tr>
            <th>{byExit ? 'מכפיל' : 'gT'} \ WACC</th>
            {grid.waccs.map((w) => (
              <th key={w}>
                <Num>{fmtRate(w, 2)}</Num>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {grid.values.map((row, i) => (
            <tr key={grid.rows[i]}>
              <th>
                <Num>{rowText(grid.rows[i])}</Num>
              </th>
              {row.map((v, j) => {
                const tone = v === null ? '' : v >= main.price ? 'cell-under' : 'cell-over';
                return (
                  <td key={j} className={`${tone} ${i === 2 && j === 2 ? 'cell-current' : ''}`}>
                    {v === null ? '—' : v.toFixed(2)}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="muted-note">
        שווי למניה ({currency}) לפי WACC (עמודות) ו{byExit ? 'מכפיל יציאה' : 'צמיחה סופית'} (שורות). ירוק = מעל המחיר, אדום = מתחתיו. המסגרת = התוצאה הראשית.
      </p>
    </div>
  );
}

// The terminal value by the other method, for comparison: the exit
// multiples under Gordon (25x / 30x for a technology / growth company,
// otherwise 15x / 20x / 25x), Gordon under an exit multiple.
function ExitMethod({ inputs, currency, multiples }) {
  if (inputs.terminalMethod === 'exit') {
    const gordon = runDcf(Object.assign({}, inputs, { terminalMethod: 'gordon' }));
    return (
      <p className="muted-note">
        שיטה חלופית - ערך סופי לפי Gordon עם צמיחה סופית של <Num>{fmtRate(inputs.gT)}</Num>:{' '}
        <Num>{gordon.ok ? fmtMoney(gordon.perShare, currency) : '—'}</Num>
      </p>
    );
  }
  const values = (Array.isArray(multiples) && multiples.length ? multiples : [15, 20, 25]).map((m) => ({ m, out: runDcf(Object.assign({}, inputs, { terminalMethod: 'exit', exitMultiple: m })) }));
  return (
    <p className="muted-note">
      שיטה חלופית - ערך סופי לפי מכפיל יציאה על ה-FCF (אחרי SBC) של השנה החמישית:{' '}
      {values.map(({ m, out }, i) => (
        <span key={m}>
          {i ? ' · ' : ''}
          <Num>{`${m}x: ${out.ok ? fmtMoney(out.perShare, currency) : '—'}`}</Num>
        </span>
      ))}
    </p>
  );
}

const DERIVED_LABELS = {
  revenueTtm: 'הכנסות 12 חודשים',
  fcfTtmReported: 'FCF 12 חודשים: תזרים תפעולי פחות Capex',
  fcfTtmNormalized: 'FCF 12 חודשים: מנורמל של החברה',
  fcfTtm: 'FCF בשימוש',
  sbcTtm: 'SBC 12 חודשים',
  netIncomeTtm: 'רווח נקי 12 חודשים',
  fcfMarginTtm: 'שולי FCF 12 חודשים',
  sbcPctTtm: 'SBC מההכנסות, 12 חודשים',
  rev0: 'הכנסות בסיס',
  growth1: 'צמיחת השנה הראשונה',
  betaRaw: 'בטא גולמית',
  beta: 'בטא מתואמת',
  rf: 'ריבית חסרת סיכון',
  basicShares: 'מניות בסיסי',
  dilutedShares: 'מניות מדולל',
  debt: 'חוב',
  cash: 'מזומן והשקעות סחירות'
};
const CASH_PART_LABELS = { cash: 'מזומן ושווי מזומן', shortTermInvestments: 'השקעות לטווח קצר', longTermMarketable: 'ניירות ערך סחירים לטווח ארוך' };
const PCT_FIELDS = new Set(['fcfMarginTtm', 'sbcPctTtm', 'growth1', 'rf']);
const PLAIN_FIELDS = new Set(['betaRaw', 'beta']);
const SHARE_FIELDS = new Set(['basicShares', 'dilutedShares']);

function fmtDerived(key, v, currency) {
  if (!isNum(v)) return 'חסר';
  if (PCT_FIELDS.has(key)) return fmtRate(v, 2);
  if (PLAIN_FIELDS.has(key)) return v.toFixed(3);
  if (SHARE_FIELDS.has(key)) return `${(v / 1e6).toFixed(1)}M`;
  return fmtMoney(v, currency);
}

function SourcesPanel({ evaluation, snapshot, currency }) {
  const d = evaluation.derived;
  return (
    <div>
      {d && (
        <div className="stocks-table-container">
          <table className="analysis-table dcf-sources" aria-label="נתוני מקור">
            <thead>
              <tr>
                <th>נתון</th>
                <th>ערך</th>
                <th>מקור ובסיס</th>
              </tr>
            </thead>
            <tbody>
              {Object.keys(DERIVED_LABELS)
                .filter((k) => d[k])
                .map((k) => (
                  <React.Fragment key={k}>
                    <tr>
                      <td>{DERIVED_LABELS[k]}</td>
                      <td>
                        <Num>{fmtDerived(k, d[k].value, currency)}</Num>
                      </td>
                      <td>
                        {d[k].basis} {d[k].fallback && <ToneBadge tone="mixed">חלופה</ToneBadge>}
                      </td>
                    </tr>
                    {k === 'cash' &&
                      d.cash.parts &&
                      Object.keys(CASH_PART_LABELS).map((part) => (
                        <tr key={part} className="dcf-sub-row">
                          <td>↳ {CASH_PART_LABELS[part]}</td>
                          <td>
                            <Num>{isNum(d.cash.parts[part]) ? fmtMoney(d.cash.parts[part], currency) : 'לא דווח'}</Num>
                          </td>
                          <td>{d.cash.partSources ? d.cash.partSources[part] : ''}</td>
                        </tr>
                      ))}
                  </React.Fragment>
                ))}
            </tbody>
          </table>
        </div>
      )}
      {snapshot && (
        <ul className="muted-note dcf-source-list">
          {snapshot.price && (
            <li>
              מחיר: {snapshot.price.source}, <Num>{snapshot.price.asOf}</Num>
            </li>
          )}
          {snapshot.rf && (
            <li>
              ריבית: {snapshot.rf.source}, <Num>{snapshot.rf.asOf}</Num>
            </li>
          )}
          {!snapshot.rf && snapshot.rfLastSaved && (
            <li>
              ריבית: הערך האחרון שנשמר, <Num>{snapshot.rfLastSaved.asOf}</Num>
            </li>
          )}
          {snapshot.betaRaw && (
            <li>
              בטא: {snapshot.betaRaw.source}, נשלף <Num>{snapshot.betaRaw.asOf}</Num>
            </li>
          )}
          {snapshot.consensus && (
            <li>
              קונצנזוס: {snapshot.consensus.source}, נשלף <Num>{snapshot.consensus.asOf}</Num>
            </li>
          )}
          {snapshot.sources && (
            <li>
              דוחות: {snapshot.sources.quarters}; {snapshot.sources.annual}
            </li>
          )}
          <li>
            נשלף: <Num>{String(snapshot.retrievedAt || '').slice(0, 16).replace('T', ' ')}</Num> UTC
          </li>
        </ul>
      )}
    </div>
  );
}

// Who the technology / growth rules apply to, in words.
function techGrowthText(R) {
  const tg = R.techGrowth;
  if (!tg) return null;
  return (
    <>
      חברת טכנולוגיה (סקטור <Num>{tg.sectors.join(', ')}</Num>) או חברה שצומחת <Num>{fmtRate(tg.growthAbove)}</Num> ומעלה בשנה הראשונה
    </>
  );
}

const sizeLabel = (v) => (v >= 1e12 ? `$${v / 1e12}T` : `$${v / 1e9}B`);

function RulesPanel({ rules: R, onRules }) {
  const caps = Array.isArray(R.betaCaps) ? R.betaCaps : [];
  const capAt = (above) => caps.find((t) => t.above === above);
  const sbcShare = isNum(R.sbcShareTechGrowth) ? R.sbcShareTechGrowth : 1;
  return (
    <div>
      <ul className="val-steps">
        <li>הכנסות בסיס: קונצנזוס אנליסטים לשנה הנוכחית (חסר: הכנסות 12 החודשים האחרונים).</li>
        <li>צמיחת שנה 1: קונצנזוס שנה הבאה מול הבסיס (חסר: 12 חודשים מול 12 חודשים קודמים, ואז שנת כספים מול קודמתה).</li>
        <li>
          צמיחה בשנים הבאות: ערך מקונצנזוס / הנחיה כשהוזן; אחרי השנה האחרונה שיש לה ערך - דעיכה לצמיחה הסופית:{' '}
          <Num>{`g[t] = ${fmtRate(R.gT)} + (g[t-1] - ${fmtRate(R.gT)}) × k`}</Num>.
        </li>
        <li>
          שולי FCF: הנחיה / קונצנזוס כשהוזנו, והשיעור האחרון מוחזק אחריהם בלי דעיכה. בלי הנחיה:{' '}
          {R.flatMargin && R.techGrowth ? <>ל{techGrowthText(R)} - שולי 12 החודשים נשארים קבועים; לכל השאר - </> : null}
          כלל גנרי: שולי 12 החודשים × (1 - {R.marginStep} × שנה).
        </li>
        <li>
          FCF = תזרים תפעולי פחות Capex (ברירת מחדל), או ה-FCF המנורמל של החברה כשהוזן ונבחר. SBC: אחוז 12 החודשים × (1 - <Num>{R.sbcStep}</Num> × שנה), מופחת
          מהתזרים במלואו
          {sbcShare < 1 && R.techGrowth ? (
            <>
              ; ב{techGrowthText(R)} רק <Num>{`${Math.round(sbcShare * 100)}%`}</Num> ממנו, כי שאר הדילול כבר נספר במספר המניות המדולל
            </>
          ) : null}
          .
        </li>
        <li>מזומן = מזומן ושווי מזומן + השקעות לטווח קצר + ניירות ערך סחירים לטווח ארוך; בלי השקעות אסטרטגיות. חוב = קצר + ארוך, בלי חכירות.</li>
        <li>
          בטא: <Num>{`${R.betaWeight} × raw + ${R.betaConst}`}</Num>
          {caps.map((t) => (
            <span key={t.above}>
              ; מעל <Num>{sizeLabel(t.above)}</Num> שווי שוק - לכל היותר <Num>{t.betaCap}</Num>
            </span>
          ))}
          . פרמיית סיכון <Num>{fmtRate(R.erp)}</Num>, עלות חוב <Num>{fmtRate(R.kd)}</Num>, מס <Num>{fmtRate(R.tax)}</Num>.
          ריבית: אג&quot;ח ארה&quot;ב ל-10 שנים; חסרה - הערך האחרון שנשמר, ואם אין - צריך להזין אותה.
          {R.waccBand && (isNum(R.waccBand.min) || isNum(R.waccBand.max)) ? (
            <>
              {' '}
              WACC, {waccBandText(R.waccBand.min, R.waccBand.max)}: חישוב שחורג ממנה מוחזק עליה, והמחושב מוצג לידו.
            </>
          ) : null}
        </li>
        <li>
          תרחישים: שמרני - צמיחה × <Num>{R.scenarios.bear.growthMult}</Num> ושוליים <Num>{fmtRate(R.scenarios.bear.marginShift)}</Num>; אופטימי - צמיחה ×{' '}
          <Num>{R.scenarios.bull.growthMult}</Num> ושוליים <Num>{`+${fmtRate(R.scenarios.bull.marginShift)}`}</Num>. משקלות{' '}
          <Num>{`${R.weights.bear * 100}/${R.weights.base * 100}/${R.weights.bull * 100}`}</Num>.
        </li>
        <li>
          ערך סופי:{' '}
          {R.terminalMethod === 'exit' ? (
            <>
              מכפיל יציאה של <Num>{`${R.exitMultiple}x`}</Num> על ה-FCF (אחרי SBC) של השנה החמישית
            </>
          ) : (
            <>Gordon עם הצמיחה הסופית</>
          )}
          {R.techGrowth && Array.isArray(R.exitMultiplesTechGrowth) ? (
            <>
              ; ל{techGrowthText(R)} מוצג לצידו גם השווי לפי מכפיל יציאה של <Num>{R.exitMultiplesTechGrowth.map((m) => `${m}x`).join(' / ')}</Num>
            </>
          ) : null}
          . אין תקרות, רצפות או התאמות מעבר לכללים שכאן.
        </li>
        <li>
          <strong>לא כלול, בשני המצבים:</strong> ה-FCF של החלק שנותר מהשנה הנוכחית. שנה 1 היא שנת הכספים המלאה הבאה, מהוונת שנה שלמה. לחברה עם תזרים גדול זה יכול להיות כמה
          דולרים למניה (ב-NOW כ-2 דולר למניה אחרי SBC).
        </li>
      </ul>
      {onRules && (
        <div className="dcf-fields">
          <NumberField id="dcf-rule-k" label={`k - קצב הדעיכה של הצמיחה (ברירת מחדל ${DEFAULT_RULES.fadeK})`} value={R.fadeK} unit="plain" onChange={(v) => onRules({ fadeK: v })} />
          {DEFAULT_RULES.betaCaps.map((t) => {
            const current = capAt(t.above);
            return (
              <NumberField
                key={t.above}
                id={`dcf-rule-beta-cap-${t.above}`}
                label={`תקרת בטא מעל ${sizeLabel(t.above)} (ריק = בלי, ברירת מחדל ${t.betaCap})`}
                value={current ? current.betaCap : null}
                unit="plain"
                allowEmpty
                onChange={(v) => onRules({ betaCaps: { [t.above]: v === null ? 'off' : v } })}
              />
            );
          })}
          <NumberField
            id="dcf-rule-wacc-min"
            label="רצפת WACC (ריק = בלי רצפה, ברירת המחדל)"
            value={R.waccBand && isNum(R.waccBand.min) ? R.waccBand.min : null}
            unit="pct"
            allowEmpty
            onChange={(v) => onRules({ waccBand: { min: v } })}
          />
          <NumberField
            id="dcf-rule-wacc-max"
            label={`תקרת WACC (ריק = בלי תקרה, ברירת מחדל ${fmtRate(DEFAULT_RULES.waccBand.max)})`}
            value={R.waccBand && isNum(R.waccBand.max) ? R.waccBand.max : null}
            unit="pct"
            allowEmpty
            onChange={(v) => onRules({ waccBand: { max: v } })}
          />
          <NumberField
            id="dcf-rule-sbc-share"
            label={`חלק ה-SBC שמופחת בטכנולוגיה וצמיחה (0-1, ברירת מחדל ${DEFAULT_RULES.sbcShareTechGrowth})`}
            value={sbcShare}
            unit="plain"
            onChange={(v) => onRules({ sbcShareTechGrowth: v })}
          />
          <label className="dcf-check">
            <input type="checkbox" checked={!!R.flatMargin} onChange={(e) => onRules({ flatMargin: e.target.checked })} /> שוליים קבועים לטכנולוגיה וצמיחה (במקום דעיכה של{' '}
            {R.marginStep * 100}% בשנה)
          </label>
          <div className="dcf-field">
            <label htmlFor="dcf-rule-terminal">שיטת הערך הסופי</label>
            <select id="dcf-rule-terminal" value={R.terminalMethod} onChange={(e) => onRules({ terminalMethod: e.target.value })}>
              <option value="gordon">Gordon - צמיחה סופית</option>
              <option value="exit">מכפיל יציאה על ה-FCF</option>
            </select>
          </div>
          {R.terminalMethod === 'exit' && (
            <NumberField id="dcf-rule-exit" label="מכפיל יציאה (על ה-FCF של שנה 5)" value={R.exitMultiple} unit="plain" onChange={(v) => onRules({ exitMultiple: v })} />
          )}
        </div>
      )}
    </div>
  );
}

// "FY27".."FY31" from the consensus year, when known.
function fiscalLabels(snapshot, preset) {
  if (preset) return ['FY27', 'FY28', 'FY29', 'FY30', 'FY31'];
  const end = snapshot && snapshot.consensus && snapshot.consensus.rev0y && snapshot.consensus.rev0y.periodEnd;
  const year = end ? Number(String(end).slice(0, 4)) : NaN;
  return Number.isFinite(year) ? [1, 2, 3, 4, 5].map((i) => `FY${String(year + i).slice(2)}`) : null;
}

// The rate, asked for when it is missing and none was saved.
function MissingRate({ onOverride }) {
  return (
    <div className="dcf-fields">
      <NumberField
        id="dcf-ov-rf"
        label="ריבית חסרת סיכון (אג&quot;ח ארה&quot;ב ל-10 שנים)"
        value={null}
        unit="pct"
        allowEmpty
        placeholder="למשל 5.10"
        onChange={(v) => onOverride('rf', v === null ? null : { value: v, source: 'הוזן ידנית', asOf: today() })}
      />
    </div>
  );
}

export default function DcfCalculator({ ticker, snapshot, autoEvaluation, overrides, onOverrides, onRules }) {
  const [mode, setMode] = useState('auto');
  const [manual, setManual] = useState(null);
  const [preset, setPreset] = useState(null);
  const [active, setActive] = useState('base');

  const manualEvaluation = useMemo(() => (manual ? evaluateDcf({ mode: 'manual', manual, valuationDate: today() }) : null), [manual]);
  const evaluation = mode === 'manual' && manualEvaluation ? manualEvaluation : autoEvaluation;
  const presetActive = Boolean(preset) && mode === 'manual';
  const currency = presetActive ? 'USD' : (snapshot && (snapshot.financialCurrency || snapshot.currency)) || '';
  const priceCurrency = presetActive ? 'USD' : (snapshot && snapshot.currency) || currency;

  const scenarioKeys = evaluation && evaluation.model ? evaluation.model.scenarios.map((s) => s.key) : [];
  const activeKey = scenarioKeys.includes(active) ? active : evaluation && evaluation.baseKey;

  const editFromAuto = () => {
    if (autoEvaluation && autoEvaluation.model) {
      setManual(clone(autoEvaluation.model));
      setPreset(null);
      setMode('manual');
    }
  };
  const loadPreset = (p) => {
    setManual(clone({ base: p.base, scenarios: p.scenarios, weights: p.weights }));
    setPreset(p);
    setActive('base');
    setMode('manual');
  };
  const onBase = (key, value) =>
    setManual((m) => {
      const next = clone(m);
      if (value === null) delete next.base[key];
      else next.base[key] = value;
      return next;
    });
  const onEdit = (field, i, value) =>
    setManual((m) => {
      const next = clone(m);
      const s = next.scenarios.find((x) => x.key === activeKey);
      s[field][i] = value;
      return next;
    });

  // The figures added to the auto model.
  const ov = overrides || { growth: [], fcfMargin: [] };
  const setOverride = (key, value) => onOverrides && onOverrides(Object.assign({}, ov, { [key]: value }));
  const setYear = (field, i, value) => {
    const list = (ov[field] || []).slice();
    while (list.length < 5) list.push(null);
    const prev = list.find((e) => e && isNum(e.value)) || {};
    list[i] = value === null ? null : { value, source: prev.source || '', asOf: prev.asOf || today() };
    setOverride(field, list);
  };
  const setRowSource = (field, key, text) => {
    const list = (ov[field] || []).map((e) => (e && isNum(e.value) ? Object.assign({}, e, { [key]: text }) : e));
    setOverride(field, list);
  };

  const editable = mode === 'manual';
  const d = evaluation && evaluation.derived;
  const sourcesByField =
    d && mode === 'auto'
      ? { rf: d.rf.basis, cash: d.cash.basis, debt: d.debt.basis, basicShares: d.basicShares.basis, dilutedShares: d.dilutedShares.basis, rev0: d.rev0.basis }
      : null;

  const exportCard = () => {
    const card = buildInputCard(evaluation, presetActive ? null : snapshot, presetActive ? preset.ticker : ticker);
    downloadJson(card, `dcf-card-${card.ticker || 'stock'}-${card.mode}${presetActive ? '-preset' : ''}-${card.valuationDate}.json`);
  };
  const tickerPreset = PRESETS[ticker];

  const header = (
    <div className="dcf-toolbar">
      <div className="dcf-mode" role="group" aria-label="מצב">
        <button type="button" className={`dcf-scenario ${mode === 'auto' ? 'is-active' : ''}`} aria-pressed={mode === 'auto'} onClick={() => setMode('auto')}>
          אוטומטי (לפי כללים)
        </button>
        <button
          type="button"
          className={`dcf-scenario ${mode === 'manual' ? 'is-active' : ''}`}
          aria-pressed={mode === 'manual'}
          onClick={() => (manual ? setMode('manual') : editFromAuto())}
          disabled={!manual && !(autoEvaluation && autoEvaluation.model)}
        >
          ידני{manual ? (preset ? ` - פריסט ${preset.ticker}` : ' - מותאם אישית') : ''}
        </button>
      </div>
      {tickerPreset && (
        <button type="button" className="benchmark-toggle-button" onClick={() => loadPreset(tickerPreset)}>
          {`פריסט ${tickerPreset.ticker} (${tickerPreset.source})`}
        </button>
      )}
      {mode === 'manual' && autoEvaluation && autoEvaluation.model && (
        <button type="button" className="auth-link" onClick={editFromAuto}>
          התחלה מחדש מהערכים האוטומטיים
        </button>
      )}
      {evaluation && evaluation.model && (
        <button type="button" className="benchmark-toggle-button" onClick={exportCard}>
          ייצוא כרטיס קלטים
        </button>
      )}
    </div>
  );

  if (!evaluation) return header;
  if (evaluation.unsuitable) {
    return (
      <>
        {header}
        <div className="dcf-unsuitable" role="status">
          <strong>לא מתאים ל-DCF.</strong> {evaluation.unsuitable}
        </div>
      </>
    );
  }
  if (!evaluation.model) {
    const rateMissing = evaluation.missing.some((m) => /ריבית חסרת סיכון/.test(m));
    return (
      <>
        {header}
        <div className="dcf-unsuitable" role="alert">
          <strong>אין מספיק נתונים לחישוב.</strong> חסר: {evaluation.missing.join(', ')}.
          {rateMissing && onOverrides && <MissingRate onOverride={setOverride} />}
        </div>
      </>
    );
  }

  const main = evaluation.main;
  const scenario = evaluation.model.scenarios.find((s) => s.key === activeKey);
  const result = evaluation.results[activeKey];
  const scenarioInputs = Object.assign({}, evaluation.model.base, { growth: scenario.growth, fcfMargin: scenario.fcfMargin, sbcPct: scenario.sbcPct });
  const notes = evaluation.warnings.concat(evaluation.flags);
  const autoMode = mode === 'auto';

  return (
    <div className="dcf-calc">
      {header}
      {mode === 'manual' && (
        <p className="muted-note">
          {preset ? `פריסט ${preset.ticker}: ${preset.source} (${preset.asOf}). ` : 'מצב ידני (מותאם אישית): הערכים האוטומטיים הועתקו, וכל מספר ניתן לעריכה. '}
          התוצאה מתעדכנת מיד.
        </p>
      )}

      <ScenarioCards evaluation={evaluation} currency={currency} priceCurrency={priceCurrency} active={activeKey} onSelect={setActive} />

      {main && main.ok ? (
        <div className="val-result" aria-live="polite">
          <dl className="dcf-kpis">
            <div>
              <dt>WACC</dt>
              <dd>
                <Num>{fmtRate(main.wacc, 2)}</Num>
              </dd>
            </div>
            <div>
              <dt>תשואה משתמעת (IRR)</dt>
              <dd>
                <Num>{isNum(evaluation.irr) ? fmtRate(evaluation.irr, 1) : 'אין'}</Num>
              </dd>
            </div>
            <div>
              <dt>צמיחה משתמעת (5 שנים)</dt>
              <dd data-testid="dcf-implied-growth">
                <Num>{isNum(evaluation.impliedGrowth) ? fmtRate(evaluation.impliedGrowth, 1) : 'אין'}</Num>
              </dd>
            </div>
            <div>
              <dt>חלק הערך הסופי</dt>
              <dd>
                <Num>{fmtRate(main.tvShare, 0)}</Num>
              </dd>
            </div>
            <div>
              <dt>מכפיל יציאה משתמע</dt>
              <dd>
                <Num>{isNum(main.impliedExit) ? `${main.impliedExit.toFixed(1)}x` : '—'}</Num>
              </dd>
            </div>
            <div>
              <dt>מרווח ביטחון</dt>
              <dd>
                <Num>{isNum(main.marginOfSafety) ? fmtRate(main.marginOfSafety, 1) : '—'}</Num>
              </dd>
            </div>
          </dl>
          <p className="val-result-sentence" data-testid="dcf-verdict">
            {verdictSentence(main, evaluation.labels[evaluation.baseKey], evaluation.rules.labelBand)}
          </p>
          <p className="val-result-implied">{irrSentence(evaluation)}</p>
        </div>
      ) : (
        <ul className="dcf-errors" role="alert">
          {(main ? main.errors : []).map((e) => (
            <li key={e}>{e}</li>
          ))}
        </ul>
      )}

      {notes.length > 0 && (
        <ul className="dcf-warnings" aria-label="אזהרות">
          {notes.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      )}

      <details className="val-details" open>
        <summary>ההנחות לכל שנה - תרחיש {scenario.label}</summary>
        <YearTable
          scenario={scenario}
          result={result}
          editable={editable}
          onEdit={onEdit}
          fyLabels={fiscalLabels(snapshot, presetActive)}
          currency={currency}
          schedules={autoMode ? evaluation.schedules : null}
          overrides={ov}
          onOverrides={autoMode ? setYear : null}
          isBase={activeKey === evaluation.baseKey}
        />
        {autoMode && (
          <>
            <p className="muted-note">
              אפשר להוסיף צמיחה מקונצנזוס או מהנחיית החברה (Yahoo נותן רק את השנה הנוכחית והבאה) ושולי FCF מהנחיה - עם המקור והתאריך. שנה עם ערך משתמשת בו; הצמיחה דועכת רק
              אחרי השנה האחרונה שיש לה ערך, והשוליים נשארים קבועים אחריה. התרחישים השמרני והאופטימי מוחלים על הערכים האלה.
            </p>
            <GuidanceSources overrides={ov} onSource={setRowSource} />
          </>
        )}
        {mode === 'manual' ? null : <p className="muted-note">כדי לשנות הנחה שהכללים גוזרים, עברו ל"ידני": הערכים יועתקו ויסומנו כמותאמים אישית.</p>}
      </details>

      {autoMode && evaluation.derived && (
        <details className="val-details">
          <summary>בסיס ה-FCF</summary>
          <FcfBasis evaluation={evaluation} overrides={ov} onOverride={setOverride} currency={currency} />
        </details>
      )}

      <details className="val-details">
        <summary>שיעור ההיוון (WACC) ונתוני החברה</summary>
        <WaccPanel evaluation={evaluation} editable={editable} onBase={onBase} sourcesByField={sourcesByField} />
        <CompanyFields evaluation={evaluation} editable={editable} onBase={onBase} sourcesByField={sourcesByField} />
      </details>

      {main && main.ok && (
        <details className="val-details">
          <summary>מה יוצא בהנחות אחרות?</summary>
          <Sensitivity grid={evaluation.sensitivity} currency={currency} main={main} />
          <ExitMethod
            inputs={scenarioInputs}
            currency={currency}
            multiples={autoMode && evaluation.derived && evaluation.derived.techGrowth && evaluation.derived.techGrowth.value ? evaluation.rules.exitMultiplesTechGrowth : null}
          />
        </details>
      )}

      {autoMode && (
        <details className="val-details">
          <summary>נתוני המקור</summary>
          <SourcesPanel evaluation={evaluation} snapshot={snapshot} currency={currency} />
        </details>
      )}
      <details className="val-details">
        <summary>הכללים</summary>
        <RulesPanel rules={autoMode ? evaluation.rules : DEFAULT_RULES} onRules={autoMode ? onRules : null} />
      </details>
    </div>
  );
}
