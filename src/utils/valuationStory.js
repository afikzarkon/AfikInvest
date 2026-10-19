// The valuation page told in plain words, for someone who has never heard of
// a multiple or a DCF: one answer, then each of the three checks as a short
// story with its real numbers, what the price assumes about the future, and
// how the picture changes if things go badly or well.
//
// Pure: the page's market data and the automatic DCF in, sentences out.
// Numbers inside a sentence are wrapped in Unicode isolates, so a sign or a
// currency symbol never jumps to the wrong side inside Hebrew text.
import { readMultiple, multiplesSummary, DCF_VERDICT_TONE } from './valuationInsights';

const LRI = '⁦';
const PDI = '⁩';
const iso = (s) => `${LRI}${s}${PDI}`;
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

const SYMBOLS = { USD: '$', EUR: '€', GBP: '£', ILS: '₪' };
export function money(v, currency) {
  if (!isNum(v)) return '—';
  const sym = SYMBOLS[currency];
  // A round dollar reads as one ("$1"), every other figure with cents.
  const n = v === Math.round(v) && Math.abs(v) < 10 ? String(v) : v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return iso(sym ? `${sym}${n}` : `${n} ${currency || ''}`.trim());
}
const pct = (v, digits = 0) => iso(`${(v * 100).toFixed(digits)}%`);
const times = (v) => iso(v.toFixed(1));

// "by 40%" up to doubling, "2.2 times" beyond - "+120%" means little to most.
function howMuchMore(bigger, smaller) {
  const ratio = bigger / smaller;
  return ratio >= 2 ? `פי ${times(ratio)}` : `ב-${pct(ratio - 1)}`;
}

// What a multiple measures, in words: "every $1 of <reward> a year".
const REWARD = {
  PE: { word: 'רווח', long: 'רווח שהחברה מרוויחה בשנה' },
  PFCF: { word: 'כסף פנוי', long: 'כסף פנוי שנשאר לחברה בשנה אחרי כל ההוצאות' },
  PS: { word: 'מכירות', long: 'מכירות של החברה בשנה' }
};

// The one multiple the stories use: profit first (the most familiar), then
// free cash, then sales - the first that is meaningful for this company.
export function pickMultiple(rows) {
  for (const metric of ['PE', 'PFCF', 'PS']) {
    const row = (rows || []).find((r) => r.metric === metric);
    if (row && readMultiple(row).meaningful) return row;
  }
  return null;
}

const TONE_SCORE = { cheap: -1, normal: 0, expensive: 1 };

// The three checks to one answer, and where it sits on a cheap-to-expensive
// scale (-1 .. 1) for the page's gauge.
export function combineVerdict(tones) {
  const known = tones.filter((t) => t in TONE_SCORE);
  if (!known.length) return { tone: 'na', score: 0, agree: 0, total: 0 };
  const count = (t) => known.filter((x) => x === t).length;
  const score = known.reduce((s, t) => s + TONE_SCORE[t], 0) / known.length;
  let tone;
  if (count('expensive') > known.length / 2) tone = 'expensive';
  else if (count('cheap') > known.length / 2) tone = 'cheap';
  else if (count('expensive') && count('cheap')) tone = 'mixed';
  else if (count('normal') >= known.length / 2) tone = 'normal';
  else tone = score > 0 ? 'expensive' : score < 0 ? 'cheap' : 'normal';
  return { tone, score, agree: tone in TONE_SCORE ? count(tone) : 0, total: known.length };
}

const HEADLINES = {
  expensive: 'המניה נראית יקרה כרגע',
  cheap: 'המניה נראית זולה כרגע',
  normal: 'המחיר של המניה נראה הוגן',
  mixed: 'התמונה מעורבת',
  na: 'אין מספיק נתונים כדי לענות'
};

function verdictLine(verdict) {
  const { tone, agree, total } = verdict;
  if (tone === 'na') return 'לא הצלחנו לטעון מספיק נתונים על החברה הזאת. אפשר לנסות שוב מאוחר יותר.';
  if (tone === 'mixed') return 'חלק מהבדיקות אומרות שהמניה זולה וחלק שהיא יקרה. כשהבדיקות לא מסכימות, כדאי להיזהר במיוחד.';
  const what = { expensive: 'משלמים עליה יותר מהרגיל או יותר ממה שהיא שווה', cheap: 'משלמים עליה פחות מהרגיל או פחות ממה שהיא שווה', normal: 'המחיר שלה קרוב למה שהיא שווה' }[tone];
  return `${agree === total ? `כל ${total} הבדיקות` : `${agree} מתוך ${total} הבדיקות`} מראות ש${what}.`;
}

// Check 1: the price against the company's own last five years.
function historyCheck(row, tone, name) {
  const base = { key: 'history', icon: '📅', title: 'לעומת העבר של החברה', tone };
  if (!row || tone === 'na' || !isNum(row.avg5y)) {
    return { ...base, tone: 'na', story: ['אין מספיק היסטוריה של מחירים ורווחים כדי להשוות לעבר.'], takeaway: '' };
  }
  const r = REWARD[row.metric];
  const story = [
    `היום משלמים על מניה של ${name} בערך ${money(row.current, 'USD')} על כל ${money(1, 'USD')} של ${r.long}.`,
    `ב-5 השנים האחרונות שילמו על אותו ${money(1, 'USD')} בממוצע ${money(row.avg5y, 'USD')}.`
  ];
  const gap = row.current / row.avg5y;
  const takeaway =
    tone === 'expensive'
      ? `כלומר היום משלמים ${howMuchMore(row.current, row.avg5y)} יותר מהרגיל - כמו לקנות משהו במחיר גבוה מזה שבדרך כלל משלמים עליו.`
      : tone === 'cheap'
        ? `כלומר היום משלמים ${howMuchMore(row.avg5y, row.current)} פחות מהרגיל - כמו לקנות משהו במבצע.`
        : `כלומר היום משלמים בערך כמו תמיד${Math.abs(gap - 1) >= 0.01 ? ` (הפרש של ${pct(Math.abs(gap - 1))})` : ''}.`;
  return { ...base, story, takeaway };
}

// Check 2: the price against similar companies.
function peersCheck(row, tone, name, peers) {
  const base = { key: 'peers', icon: '👥', title: 'לעומת חברות דומות', tone };
  if (!row || tone === 'na' || !isNum(row.sectorMedian)) {
    return { ...base, tone: 'na', story: ['לא מצאנו מספיק חברות דומות כדי להשוות.'], takeaway: '' };
  }
  const r = REWARD[row.metric];
  const names = (peers || [])
    .map((p) => p && p.symbol)
    .filter(Boolean)
    .slice(0, 5)
    .join(', ');
  const story = [
    `חברות דומות${names ? ` (${iso(names)})` : ''} נמכרות בדרך כלל ב-${money(row.sectorMedian, 'USD')} על כל ${money(1, 'USD')} של ${r.word}.`,
    `${name} נמכרת ב-${money(row.current, 'USD')}.`
  ];
  const takeaway =
    tone === 'expensive'
      ? `כלומר היא יקרה ${howMuchMore(row.current, row.sectorMedian)} מהחברות הדומות לה.`
      : tone === 'cheap'
        ? `כלומר היא זולה ${howMuchMore(row.sectorMedian, row.current)} מהחברות הדומות לה.`
        : 'כלומר המחיר שלה דומה לחברות דומות.';
  return { ...base, story, takeaway };
}

// Check 3: the automatic DCF's base case, told as "what the future money is
// worth today".
function futureCheck(evaluation, price, currency, name) {
  const base = { key: 'future', icon: '💰', title: 'לפי הכסף שהיא צפויה להרוויח' };
  if (!evaluation) return { ...base, tone: 'na', story: ['עוד לא הצלחנו לטעון את הנתונים לחישוב הזה.'], takeaway: '' };
  if (evaluation.unsuitable) {
    return { ...base, tone: 'na', story: [`את החישוב הזה אי אפשר לעשות לחברה הזאת: ${evaluation.unsuitable}`], takeaway: '' };
  }
  const main = evaluation.main;
  if (!main || !main.ok || !isNum(main.perShare)) {
    return { ...base, tone: 'na', story: ['חסרים נתונים כדי לחשב את השווי לפי הכסף העתידי.'], takeaway: '' };
  }
  const label = evaluation.labels ? evaluation.labels[evaluation.baseKey] : 'N/A';
  const tone = DCF_VERDICT_TONE[label] || 'na';
  const value = main.perShare;
  const story = [
    `ניסינו לחשב כמה כסף ${name} תרוויח בשנים הבאות, וכמה כל הכסף הזה שווה היום (כסף שמגיע בעתיד שווה קצת פחות מכסף שיש ביד היום).`,
    value > 0
      ? `יצא שמניה אחת שווה בערך ${money(value, currency)}. היום היא עולה ${money(price, currency)}.`
      : 'יצא שלפי ההנחות האלה למניה אין שווי חיובי - החובות של החברה גדולים ממה שהפעילות שלה שווה.'
  ];
  const takeaway =
    !(value > 0)
      ? ''
      : tone === 'expensive'
        ? `כלומר המחיר של היום גבוה ${howMuchMore(price, value)} ממה שחישבנו שהמניה שווה.`
        : tone === 'cheap'
          ? `כלומר לפי החישוב המניה שווה ${howMuchMore(value, price)} יותר ממה שהיא עולה.`
          : 'כלומר המחיר של היום קרוב למה שחישבנו שהמניה שווה.';
  return { ...base, tone, story, takeaway, value };
}

// Average yearly revenue growth over the fiscal years on file.
export function pastRevenueGrowth(fiscalYears) {
  const rows = (fiscalYears || []).filter((y) => y && isNum(y.revenue) && y.revenue > 0).sort((a, b) => String(a.periodEnd).localeCompare(String(b.periodEnd)));
  if (rows.length < 2) return null;
  const years = rows.length - 1;
  return { rate: Math.pow(rows[rows.length - 1].revenue / rows[0].revenue, 1 / years) - 1, years };
}

// What the price assumes: the constant growth that makes it fair, against
// how fast the company has actually grown.
function assumption(evaluation, fiscalYears) {
  if (!evaluation || !isNum(evaluation.impliedGrowth)) return null;
  const g = evaluation.impliedGrowth;
  const past = pastRevenueGrowth(fiscalYears);
  const lines = [`כדי שהמחיר של היום יהיה הוגן, המכירות של החברה צריכות לגדול בכ-${pct(g, 1)} בכל שנה, 5 שנים ברצף.`];
  let tone = 'normal';
  if (past) {
    lines.push(`ב-${past.years} השנים האחרונות הן גדלו בממוצע בכ-${pct(past.rate, 1)} בשנה.`);
    if (g > past.rate + 0.05 && g > past.rate * 1.5) {
      tone = 'expensive';
      lines.push('זה הרבה יותר ממה שהחברה הצליחה עד היום - המחיר מניח שהעתיד יהיה הרבה יותר טוב מהעבר.');
    } else if (g < past.rate - 0.02) {
      tone = 'cheap';
      lines.push('זה פחות ממה שהחברה עשתה עד עכשיו - המחיר לא דורש ממנה להשתפר.');
    } else {
      lines.push('זה בערך כמו קצב הצמיחה שלה עד היום.');
    }
  }
  return { lines, tone };
}

// Three futures - bad, as expected, very good - against today's price.
function futures(evaluation, price, currency) {
  if (!evaluation || !evaluation.results) return null;
  const pick = (key) => {
    const r = evaluation.results[key];
    return r && r.ok && isNum(r.perShare) ? r.perShare : null;
  };
  const bear = pick('bear');
  const base = pick('base');
  const bull = pick('bull');
  if (![bear, base, bull].every(isNum)) return null;
  const rows = [
    { key: 'bear', label: 'אם הדברים ילכו פחות טוב', value: bear },
    { key: 'base', label: 'אם הדברים ילכו כצפוי', value: base },
    { key: 'bull', label: 'אם הדברים ילכו מצוין', value: bull }
  ].map((r) => ({ ...r, text: money(r.value, currency), vsPrice: r.value > price ? 'above' : 'below' }));
  const summary =
    bull < price
      ? 'גם אם הכל ילך מצוין, השווי שחישבנו נמוך מהמחיר של היום.'
      : bear > price
        ? 'גם אם הדברים ילכו פחות טוב, השווי שחישבנו גבוה מהמחיר של היום.'
        : 'המחיר של היום נמצא באמצע - הכל תלוי באיך יילכו הדברים.';
  return { rows, summary, price, priceText: money(price, currency) };
}

export function buildValuationStory(data, evaluation) {
  const name = data.name ? data.name.replace(/,?\s+(Inc\.?|Corporation|Corp\.?|Ltd\.?|plc|N\.V\.)$/i, '') : data.symbol;
  const currency = data.currency || 'USD';
  const row = pickMultiple(data.multiples);
  const tones = multiplesSummary(row ? [row] : []);
  const checks = [
    historyCheck(row, tones.history, name),
    peersCheck(row, tones.peers, name, data.peers),
    futureCheck(evaluation, data.price, currency, name)
  ];
  const verdict = combineVerdict(checks.map((c) => c.tone));
  // Without a usable profit figure the comparisons fall back to free cash or
  // sales - a weaker yardstick, and "cheap" on sales says nothing about a
  // company that loses money. The answer says so.
  const note =
    row && row.metric !== 'PE' && verdict.tone !== 'na'
      ? `שימו לב: לחברה הזאת אין כרגע רווח יציב, אז השווינו לפי ה${REWARD[row.metric].word} שלה ולא לפי הרווח. זו מדידה פחות מדויקת, וחברה שמפסידה כסף יכולה להיראות "זולה" ועדיין להיות מסוכנת.`
      : '';
  return {
    name,
    priceText: money(data.price, currency),
    verdict: { ...verdict, headline: HEADLINES[verdict.tone], line: verdictLine(verdict), note },
    checks,
    assumption: assumption(evaluation, data.fiscalYears),
    futures: futures(evaluation, data.price, currency)
  };
}
