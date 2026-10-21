// The review in words. Every sentence is a template filled from the
// numbers the scoring produced - nothing here decides a score, and nothing
// is said that a figure does not back.
//
// Tone: a mentor who has read the numbers. Direct, specific, encouraging;
// "worth checking" rather than "you should", never "buy" or "sell".
//
// Replaceable as a whole: a future AI phrasing layer would take the same
// review object and return the same shape.
import { formatMonthLabel } from './portfolioDates';
import { areAmountsHidden, AMOUNT_MASK } from './formatters';
import { THRESHOLDS, TAX_CONFIG } from './portfolioReviewConfig';

// ---------------------------------------------------------------------------
// Number formatting for prose: whole shekels, the site's "N ₪" order, and
// the privacy mask when amounts are hidden.

export const ils = (v) => {
  if (areAmountsHidden()) return `${AMOUNT_MASK} ₪`;
  if (!Number.isFinite(v)) return '—';
  return `${Math.round(Math.abs(v)).toLocaleString('he-IL')} ₪`;
};

export const pct = (v, digits = 0) => (Number.isFinite(v) ? `${Math.abs(v).toFixed(digits)}%` : '—');

export const signedPct = (v, digits = 1) => (Number.isFinite(v) ? `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(digits)}%` : '—');

const dateHe = (iso) => (iso ? iso.split('-').reverse().join('/') : '');

const monthsText = (n) => (n === 1 ? 'חודש אחד' : `${n} חודשים`);

// "זוהו 3 קניות" / "זוהתה קנייה אחת".
const casesText = (n, one, many) => (n === 1 ? one : `${n} ${many}`);

const listCases = (cases, max = 3) =>
  cases
    .slice(0, max)
    .map((c) => `${c.label} (${dateHe(c.date)})`)
    .join(', ') + (cases.length > max ? ` ועוד ${cases.length - max}` : '');

// ---------------------------------------------------------------------------
// Notes: { tone: 'good' | 'attention' | 'thought', priority, text, focus? }
// `focus` is the wording used when the note is chosen as the one thing to
// work on this month.

function collectNotes(review) {
  const notes = [];
  const add = (tone, priority, text, focus = null, category = null) => notes.push({ tone, priority, text, focus, category });
  const cat = Object.fromEntries(review.categories.map((c) => [c.key, c]));
  const f = review.facts;

  // 1. Volume
  const vol = cat.volume.metrics;
  if (f.invested > 0) {
    const dest = biggestDestination(vol.destinations);
    const destText = dest ? `, ו-${pct(dest.share * 100)} מהסכום הלך ל${dest.label}` : '';
    if (Number.isFinite(vol.vsAvg3Pct) && vol.avg3 > 0) {
      const versus =
        Math.abs(vol.vsAvg3Pct) < 2
          ? `בדומה לממוצע שלך ב-3 החודשים האחרונים (${ils(vol.avg3)})`
          : `${pct(vol.vsAvg3Pct)} ${vol.vsAvg3Pct >= 0 ? 'יותר' : 'פחות'} מהממוצע שלך ב-3 החודשים האחרונים (${ils(vol.avg3)})`;
      const text = `השקעת ${f.isPartial ? 'עד כה ' : ''}החודש ${ils(f.invested)}, ${versus}${destText}.`;
      add(vol.drop ? 'attention' : vol.vsAvg3Pct >= -10 ? 'good' : 'thought', vol.drop ? 60 : 40, text, null, 'volume');
    } else {
      add('good', 35, `השקעת ${f.isPartial ? 'עד כה ' : ''}החודש ${ils(f.invested)}${destText}.`, null, 'volume');
    }
  } else if (!f.isPartial && vol.avg3 > 0) {
    add('attention', 72, `החודש לא הושקע כסף, לעומת ממוצע של ${ils(vol.avg3)} בחודש ב-3 החודשים שלפניו.`, `לחזור לקצב ההשקעה הרגיל שלך (כ-${ils(vol.avg3)} בחודש), או להחליט במודע על הפסקה.`, 'volume');
  }
  if (vol.spike && Number.isFinite(vol.vsAvg3Pct)) {
    add('thought', 45, `החודש הושקע פי ${(1 + vol.vsAvg3Pct / 100).toFixed(1)} מהממוצע שלך. שווה לשאול אם זו החלטה מתוכננת או תגובה לתנועה בשוק.`, null, 'volume');
  }
  if (vol.topStock && vol.topStock.shareOfMonth >= 0.6 && f.invested > 0) {
    add('attention', 55, `${pct(vol.topStock.shareOfMonth * 100)} מכספי החודש הלכו למניה בודדת אחת (${vol.topStock.label}).`, `לפזר את ההשקעה הבאה על יותר מנייר אחד, כדי שהכסף החדש לא יגדיל ריכוז במניה אחת.`, 'volume');
  }
  if (vol.pattern === 'regular') add('good', 30, 'סכומי ההשקעה החודשיים שלך יציבים יחסית - זה הרגל שעובד לטובתך לאורך זמן.', null, 'volume');
  if (vol.pattern === 'lumpy') add('thought', 35, 'סכומי ההשקעה משתנים מאוד מחודש לחודש. הוראת קבע קבועה, גם אם קטנה, מורידה את התלות בתזמון.', null, 'volume');

  // 2/3. Month result
  const succ = cat.success.metrics;
  if (succ.best) {
    add('good', 38, `ההשקעה הבולטת החודש: ${succ.best.label}, רווח של ${ils(succ.best.pnl)}${Number.isFinite(succ.best.contributionPct) ? ` (תרומה של ${signedPct(succ.best.contributionPct, 2)} לתשואת התיק)` : ''}.`, null, 'success');
  }
  if (succ.worst && Number.isFinite(succ.worst.contributionPct) && succ.worst.contributionPct <= -0.5) {
    add('attention', 42, `החלשה החודש: ${succ.worst.label}, הפסד של ${ils(succ.worst.pnl)} (${signedPct(succ.worst.contributionPct, 2)} מתשואת התיק).`, null, 'success');
  }
  if (succ.winners + succ.losers >= 2) {
    const rate = (succ.winners / (succ.winners + succ.losers)) * 100;
    add(rate >= 50 ? 'good' : 'thought', 25, `${succ.winners} מתוך ${succ.winners + succ.losers} ההחזקות (${pct(rate)}) סיימו את החודש${f.isPartial ? ' עד כה' : ''} בפלוס.`, null, 'success');
  }
  const cmp = cat.comparison.metrics.rows || [];
  const retRow = cmp.find((r) => r.key === 'returnPct');
  if (retRow && retRow.current !== null && retRow.previous !== null) {
    add('thought', 20, `תשואת התיק החודש ${signedPct(retRow.current)} לעומת ${signedPct(retRow.previous)} בחודש הקודם. חודש בודד הוא בעיקר רעש שוק - המגמה חשובה יותר.`, null, 'comparison');
  }
  if (review.trend && review.trend.direction === 'improving') add('good', 50, 'הציון הכללי שלך במגמת שיפור בחודשים האחרונים.', null, 'comparison');
  if (review.trend && review.trend.direction === 'eroding') add('attention', 50, 'הציון הכללי שלך במגמת ירידה בחודשים האחרונים - בגרף המגמה אפשר לראות מתי זה התחיל.', null, 'comparison');

  // 4. Diversification
  const div = cat.diversification;
  div.alerts.forEach((a) => {
    if (a.key === 'largestPosition') {
      add('attention', 85, `${a.label} מהווה ${pct(a.pct)} מהתיק המושקע - מעל הסף של ${THRESHOLDS.diversification.largestPositionAlertPct}%. ירידה חדה בה לבדה תורגש בכל התיק.`, `לבחון את משקל ${a.label} בתיק (${pct(a.pct)}). למשל, להפנות הפקדות הבאות לנכסים אחרים עד שהמשקל יורד.`, 'diversification');
    }
    if (a.key === 'topSector') {
      add('attention', 70, `${pct(a.pct)} מניירות הערך שלך בסקטור ${a.label}.`, `לבחון את החשיפה לסקטור ${a.label} (${pct(a.pct)} מניירות הערך) ואיך היא משתלבת עם שאר התיק.`, 'diversification');
    }
    if (a.key === 'currency') add('thought', 40, `${pct(a.pct)} מהתיק חשוף ל${a.label}. כדאי שזו תהיה בחירה מודעת, בהתאם למטבע שבו תצטרך את הכסף.`, null, 'diversification');
    if (a.key === 'homeBias') add('thought', 45, `${pct(a.pct)} מניירות הערך שלך בישראל. השוק הישראלי הוא חלק קטן מהשוק העולמי, כך שהתיק תלוי מאוד בכלכלה אחת.`, null, 'diversification');
  });
  if (div.metrics.sectorCount >= 5 && !div.alerts.some((a) => a.key === 'topSector')) {
    add('good', 45, `ניירות הערך שלך מפוזרים על ${div.metrics.sectorCount} סקטורים, בלי סקטור אחד שמשתלט.`, null, 'diversification');
  }
  if (Number.isFinite(div.metrics.diversifiedShare) && div.metrics.diversifiedShare >= 0.6) {
    add('good', 40, `${pct(div.metrics.diversifiedShare * 100)} מהתיק המושקע בקרנות, קופות ומכשירים מפוזרים מטבעם.`, null, 'diversification');
  }

  // 5. Discipline
  const disc = cat.discipline.metrics;
  if (disc.streak >= 3) add('good', 55, `השקעת ${monthsText(disc.streak)} ברציפות.`, null, 'discipline');
  if (cat.discipline.status === 'scored' && disc.windowMonths >= 6 && disc.activeMonths / disc.windowMonths < 0.5) {
    add('attention', 58, disc.activeMonths ? `השקעת רק ב-${disc.activeMonths} מתוך ${disc.windowMonths} החודשים האחרונים.` : `לא נרשמו השקעות ב-${disc.windowMonths} החודשים האחרונים.`, 'לקבוע סכום חודשי קבוע, גם קטן, ולהשקיע אותו בכל חודש.', 'discipline');
  }

  // 6. Risk
  const risk = cat.riskAdjusted.metrics;
  if (cat.riskAdjusted.status === 'scored') {
    if (risk.maxDrawdownPct >= 15) {
      const rec = risk.recovered && risk.recoveryDays !== null ? `, והתיק התאושש תוך ${risk.recoveryDays} ימים` : risk.recovered ? '' : ', והתיק עדיין לא חזר לשיא';
      add('thought', 48, `הירידה המקסימלית בתקופה הנבדקת הייתה ${pct(risk.maxDrawdownPct, 1)} (${dateHe(risk.peakDate)} עד ${dateHe(risk.troughDate)})${rec}. שווה לשאול אם ירידה כזו מתאימה לך.`, null, 'riskAdjusted');
    }
    if (Number.isFinite(risk.sharpe) && risk.sharpe >= 1) add('good', 45, `על כל יחידת סיכון התיק הניב תשואה טובה (Sharpe של ${risk.sharpe.toFixed(2)}).`, null, 'riskAdjusted');
    if (Number.isFinite(risk.sharpe) && risk.sharpe <= 0) add('thought', 44, `בתקופה הנבדקת התשואה לא עלתה על הריבית חסרת הסיכון (${pct(risk.riskFreePct, 1)}), כך שהסיכון לא תוגמל.`, null, 'riskAdjusted');
  }

  // 7. Decisions
  const dec = cat.decisions.metrics;
  if (dec.stats) {
    const basis = dec.stats.basis === 'closed' ? 'מהעסקאות הסגורות' : 'מהפוזיציות הפתוחות';
    if (dec.stats.winRate >= 50 && Number.isFinite(dec.stats.payoff) && dec.stats.payoff < 0.7) {
      add('attention', 66, `${pct(dec.stats.winRate)} ${basis} ברווח, אבל ההפסד הממוצע (${ils(dec.stats.avgLoss)}) גדול בהרבה מהרווח הממוצע (${ils(dec.stats.avgWin)}). אחוז הצלחה גבוה לא מספיק כשההפסדים גדולים יותר.`, 'לבדוק מה משותף להפסדים הגדולים, ואם יש כלל יציאה שהיה עוצר אותם מוקדם יותר.', 'decisions');
    } else if (dec.stats.profitFactor >= 2) {
      add('good', 44, `סך הרווחים ${basis} גדול פי ${Number.isFinite(dec.stats.profitFactor) ? dec.stats.profitFactor.toFixed(1) : 'הרבה'} מסך ההפסדים.`, null, 'decisions');
    }
  }
  if (dec.biases) {
    const b = dec.biases;
    if (b.chasing.length) add('attention', 64, `${casesText(b.chasing.length, 'זוהתה קנייה אחת', 'קניות זוהו')} אחרי זינוק של ${THRESHOLDS.decisions.chasingRisePct}% ומעלה בחודש שלפניהן: ${listCases(b.chasing)}.`, 'לפני הקנייה הבאה של נייר שזינק לאחרונה, לכתוב לעצמך למה קונים אותו ולא רק "כי הוא עולה".', 'decisions');
    if (b.panic.length) add('attention', 68, `${casesText(b.panic.length, 'זוהתה מכירה אחת', 'מכירות זוהו')} בהפסד אחרי ירידה של ${THRESHOLDS.decisions.panicDropPct}% ומעלה בחודש שלפניהן: ${listCases(b.panic)}.`, 'לקבוע מראש מתי מוכרים, כדי שההחלטה לא תתקבל בזמן ירידה.', 'decisions');
    if (b.disposition.length) add('attention', 62, `${casesText(b.disposition.length, 'זוהה מקרה אחד שבו', 'מקרים זוהו שבהם')} נמכרה מנצחת תוך פחות מ-${THRESHOLDS.decisions.dispositionWinnerMaxDays} יום בזמן שמפסידה ותיקה נשארה בתיק: ${listCases(b.disposition)}.`, 'לבחון את ההחזקות המפסידות באותה קפדנות שבה בוחנים את המרוויחות.', 'decisions');
    if (dec.biasesCheckable && !dec.biasCases && b.checkable.chasing + b.checkable.sells >= 3) {
      add('good', 42, 'בשנה האחרונה לא זוהו קניות אחרי זינוק חד או מכירות בבהלה.', null, 'decisions');
    }
  }

  // 8. Activity
  const act = cat.activity.metrics;
  if (Number.isFinite(act.turnoverPct) && act.turnoverPct >= 100) {
    add('attention', 56, `מחזור המסחר השנתי שלך ${pct(act.turnoverPct)} מהתיק. מסחר תכוף מוסיף עמלות ומס, ולא תמיד תשואה.`, 'לצמצם עסקאות לא מתוכננות - למשל לחכות שבוע לפני כל מכירה.', 'activity');
  }
  if (Number.isFinite(act.avgHoldingDays) && act.avgHoldingDays >= 365) {
    add('good', 36, `זמן ההחזקה הממוצע שלך כ-${monthsText(Math.round(act.avgHoldingDays / 30))} - סבלנות היא יתרון.`, null, 'activity');
  }

  // 9. Costs
  const cost = cat.costs;
  if (cost.status === 'scored' && Number.isFinite(cost.metrics.feesPct)) {
    if (cost.metrics.feesPct < THRESHOLDS.costs.lowFeeBadgePct) add('good', 34, `העמלות השנתיות שלך ${pct(cost.metrics.feesPct, 2)} מהתיק (${ils(cost.metrics.feesILS)} בתקופה).`, null, 'costs');
    else add('attention', 60, `העמלות השנתיות שלך ${pct(cost.metrics.feesPct, 2)} מהתיק (${ils(cost.metrics.feesILS)}). זה מקטין את התשואה בכל שנה מחדש.`, 'להשוות את מסלול העמלות שלך מול מסלולים אחרים אצל הברוקר.', 'costs');
  }

  // 10. Tax
  const tax = cat.tax.metrics;
  if (cat.tax.status === 'scored') {
    if (tax.avoidableTax > 0) {
      add('attention', 90, `השנה מימשת רווח ריאלי נטו של ${ils(tax.netGain)} (מס משוער ${ils(tax.taxDue)}), ובתיק יש הפסדים פתוחים של ${ils(tax.harvestableLoss)} שיכלו לקזז עד ${ils(tax.avoidableTax)} מהמס.`, `לבדוק עם איש מקצוע אם מימוש הפסדים לפני סוף השנה מתאים לך - הוא יכול לקזז עד ${ils(tax.avoidableTax)} מהמס.`, 'tax');
    } else if (tax.realLosses < 0 && tax.realGains > 0) {
      add('good', 40, `הפסדים שמומשו השנה (${ils(tax.realLosses)}) כבר מקזזים חלק מהרווחים (${ils(tax.realGains)}).`, null, 'tax');
    }
    add('thought', 15, TAX_CONFIG.holdingPeriodNoteHe, null, 'tax');
  }

  // 11. Benchmark
  const bm = cat.benchmark;
  if (bm.status === 'scored') {
    const m = bm.metrics;
    const tail = `אילו כל הקניות והמכירות שלך נעשו ב-${m.benchmark.label} באותם תאריכים, השווי היה ${ils(m.benchmarkValue)}. התיק שלך שווה ${ils(m.actualValue)}`;
    if (m.excessPct >= 0) add('good', 52, `${tail}, ${ils(m.differenceILS)} (${pct(m.excessPct, 1)}) יותר.`, null, 'benchmark');
    else add('attention', 54, `${tail}, ${ils(m.differenceILS)} (${pct(m.excessPct, 1)}) פחות.`, `לשאול מה הבחירה האקטיבית מוסיפה, כשאותו כסף ב-${m.benchmark.label} היה שווה ${ils(-m.differenceILS)} יותר.`, 'benchmark');
  }

  // 12. Cash
  const cash = cat.cash;
  cash.alerts.forEach((a) => {
    const since = a.months > 1 ? `, כבר ${monthsText(a.months)} ברציפות` : '';
    add('attention', 78, `${pct(a.pct)} מהתיק (${ils(cash.metrics.cash)}) יושב בעו"ש ובקרנות כספיות${since}.`, `להחליט כמה מזומן אתה צריך ככרית ביטחון, ומה לעשות ביתרה (${ils(cash.metrics.cash)} כרגע).`, 'cash');
  });

  // 13. Goal
  const goal = cat.goal;
  if (goal.status === 'noGoal') {
    add('thought', 30, 'עדיין לא הגדרת יעד. יעד עם סכום ותאריך מאפשר לבדוק כל חודש אם אתה בקצב.', null, 'goal');
  } else if (goal.status === 'scored') {
    const g = goal.metrics;
    if (g.achieved) add('good', 80, `הגעת ליעד של ${ils(g.target)}.`, null, 'goal');
    else if (g.deadlinePassed) add('attention', 75, `תאריך היעד עבר, והתיק הגיע ל-${pct(g.progressPct)} מהיעד (${ils(g.target)}).`, 'לעדכן את היעד: תאריך חדש או סכום חדש.', 'goal');
    else if (g.onTrack) add('good', 70, `בקצב ההפקדות הנוכחי (${ils(g.avgMonthlyNet)} בחודש) אתה בדרך ליעד של ${ils(g.target)} עד ${dateHe(g.targetDate)}, גם בלי להניח תשואה.`, null, 'goal');
    else {
      add('attention', 100, `כדי להגיע ל-${ils(g.target)} עד ${dateHe(g.targetDate)} נדרשות הפקדות של כ-${ils(g.requiredMonthly)} בחודש (בלי להניח תשואה). הממוצע שלך ב-6 החודשים האחרונים ${ils(g.avgMonthlyNet)}.`, `להעלות את ההפקדה החודשית לכיוון ${ils(g.requiredMonthly)}, או לעדכן את היעד כך שיתאים לקצב שלך.`, 'goal');
    }
  }

  // 14. Dividends
  const dv = cat.dividends.metrics;
  if (dv && dv.net12m > 0) add('thought', 18, `ב-12 החודשים האחרונים נכנסו ${ils(dv.net12m)} דיבידנדים נטו (כ-${ils(dv.monthlyAvg)} בחודש).`, null, 'dividends');

  return notes;
}

// The destination the month's money went to most, by the most telling
// split: a sector when sectors are known, else the instrument type.
function biggestDestination(destinations) {
  if (!destinations) return null;
  const sector = (destinations.bySector || []).find((s) => s.key !== '__unclassified__');
  if (sector && sector.share >= 0.5 && sector.key !== 'ETF') return { label: `סקטור ה${sector.label}`, share: sector.share };
  const inst = (destinations.byInstrument || [])[0];
  return inst ? { label: inst.label, share: inst.share } : null;
}

// ---------------------------------------------------------------------------
// Investor profile: from behaviour, not a questionnaire.

export function investorProfile(review) {
  const cat = Object.fromEntries(review.categories.map((c) => [c.key, c]));
  const act = cat.activity.metrics;
  const disc = cat.discipline.metrics;
  const cash = cat.cash.metrics;
  const dec = cat.decisions.metrics;
  const vol = cat.volume.metrics;
  const months = review.monthsOfHistory;

  if (months < 3) {
    return { key: 'beginner', label: 'משקיע בתחילת הדרך', reason: `יש במערכת ${monthsText(months)} של היסטוריה. הפרופיל יתבהר אחרי כמה חודשים של פעילות.` };
  }
  if ((Number.isFinite(act.tradesPerMonth) && act.tradesPerMonth >= 4) || (Number.isFinite(act.turnoverPct) && act.turnoverPct >= 100) || (Number.isFinite(act.avgHoldingDays) && act.avgHoldingDays < 120)) {
    return { key: 'active', label: 'סוחר פעיל', reason: `כ-${(act.tradesPerMonth || 0).toFixed(1)} עסקאות בחודש${Number.isFinite(act.turnoverPct) ? `, מחזור שנתי של ${pct(act.turnoverPct)}` : ''}${Number.isFinite(act.avgHoldingDays) ? ` וזמן החזקה ממוצע של ${Math.round(act.avgHoldingDays)} ימים` : ''}.` };
  }
  if ((dec.biases && dec.biases.chasing.length >= 2) || (vol.pattern === 'lumpy' && vol.topStock && vol.topStock.shareOfMonth >= 0.6)) {
    return { key: 'opportunist', label: 'צייד הזדמנויות', reason: 'ההשקעות מגיעות בקפיצות ולעיתים קרובות לנייר בודד, אחרי תנועה חדה במחיר.' };
  }
  if (Number.isFinite(cash.sharePct) && cash.sharePct >= 40) {
    return { key: 'cautious', label: 'חוסך זהיר', reason: `${pct(cash.sharePct)} מהתיק במזומן ובקרנות כספיות.` };
  }
  if (disc.streak >= 6 && Number.isFinite(disc.cv) && disc.cv <= 0.5) {
    return { key: 'steady', label: 'משקיע מתמיד', reason: `השקעת ${monthsText(disc.streak)} ברציפות, בסכומים דומים מחודש לחודש.` };
  }
  if (Number.isFinite(act.avgHoldingDays) && act.avgHoldingDays >= 365 && (!Number.isFinite(act.turnoverPct) || act.turnoverPct < 30)) {
    return { key: 'longTerm', label: 'בונה ארוך טווח', reason: `זמן החזקה ממוצע של כ-${monthsText(Math.round(act.avgHoldingDays / 30))} ומעט מכירות.` };
  }
  return { key: 'balanced', label: 'משקיע מאוזן', reason: 'אין דפוס קיצוני אחד: ההשקעות, הפעילות והמזומן בטווחים בינוניים.' };
}

// ---------------------------------------------------------------------------
// Badges - each one only when its own figure backs it.

export function earnedBadges(review) {
  const cat = Object.fromEntries(review.categories.map((c) => [c.key, c]));
  const out = [];
  const streak = cat.discipline.metrics.streak || 0;
  if (streak >= 3) out.push({ key: 'streak', icon: '🔥', label: `${streak} חודשים רצופים של השקעה` });
  const div = cat.diversification.metrics;
  if (div && div.sectorCount >= 5) out.push({ key: 'sectors', icon: '🧩', label: `תיק מפוזר ל-${div.sectorCount} סקטורים` });
  if (div && div.largest && div.largest.pct > 0 && div.largest.pct < 10) out.push({ key: 'noGiant', icon: '⚖️', label: 'אין מניה בודדת מעל 10%' });
  if (div && Number.isFinite(div.israelPct) && div.israelPct >= 10 && div.israelPct <= 50) out.push({ key: 'global', icon: '🌍', label: 'פיזור גאוגרפי מאוזן' });
  if (cat.costs.status === 'scored' && cat.costs.metrics.feesPct < THRESHOLDS.costs.lowFeeBadgePct) out.push({ key: 'lowFees', icon: '💸', label: `עמלות מתחת ל-${THRESHOLDS.costs.lowFeeBadgePct}%` });
  if (cat.benchmark.status === 'scored' && cat.benchmark.metrics.excessPct > 0) out.push({ key: 'beatIndex', icon: '🏁', label: `מקדים את ${cat.benchmark.metrics.benchmark.label}` });
  const b = cat.decisions.metrics.biases;
  if (b && cat.decisions.metrics.biasesCheckable && !cat.decisions.metrics.biasCases && b.checkable.chasing + b.checkable.sells >= 3) out.push({ key: 'calm', icon: '🧘', label: 'ללא קניות אחרי זינוק או מכירות בבהלה' });
  if (cat.goal.status === 'scored' && cat.goal.metrics.achieved) out.push({ key: 'goal', icon: '🎯', label: 'היעד הושג' });
  if (cat.goal.status === 'scored' && cat.goal.metrics.onTrack) out.push({ key: 'onTrack', icon: '📈', label: 'בקצב ליעד' });
  return out;
}

// ---------------------------------------------------------------------------
// One line per category for its card.

export function categorySummary(category, review) {
  const m = category.metrics || {};
  if (category.status === 'noData' || category.status === 'noGoal') return category.reason;
  switch (category.key) {
    case 'volume':
      return `${ils(review.facts.invested)} הושקעו${review.facts.isPartial ? ' עד כה' : ''}${m.avg3 !== null && m.avg3 !== undefined ? ` · ממוצע 3 חודשים ${ils(m.avg3)} · ממוצע 6 חודשים ${ils(m.avg6)}` : ''}`;
    case 'comparison': {
      const r = (m.rows || []).find((x) => x.key === 'invested');
      return r && r.previous !== null ? `מול ${formatMonthLabel(m.previousMonth)}: ${ils(r.current)} לעומת ${ils(r.previous)}` : 'השוואה לחודש הקודם ולממוצע';
    }
    case 'success':
      return `${Number.isFinite(m.returnPct) ? `תשואה ${signedPct(m.returnPct)} · ` : ''}${m.winners} בפלוס, ${m.losers} במינוס`;
    case 'diversification':
      return [m.largest && m.largest.label ? `גדולה: ${m.largest.label} ${pct(m.largest.pct)}` : null, m.topSector && m.topSector.label ? `סקטור מוביל: ${m.topSector.label} ${pct(m.topSector.pct)}` : null, Number.isFinite(m.israelPct) ? `ישראל ${pct(m.israelPct)}` : null].filter(Boolean).join(' · ');
    case 'discipline':
      return `רצף של ${monthsText(m.streak)} · השקעה ב-${m.activeMonths} מתוך ${m.windowMonths} חודשים`;
    case 'riskAdjusted':
      return `תנודתיות ${pct(m.volatilityPct, 1)} · ירידה מקסימלית ${pct(m.maxDrawdownPct, 1)}${Number.isFinite(m.sharpe) ? ` · Sharpe ${m.sharpe.toFixed(2)}` : ''}`;
    case 'decisions':
      return `${m.stats ? `${pct(m.stats.winRate)} רווחיות · Profit factor ${Number.isFinite(m.stats.profitFactor) ? m.stats.profitFactor.toFixed(2) : '∞'} · ` : ''}${m.biasesCheckable ? `${m.biasCases} מקרי הטיה` : 'הטיות: אין מה לבדוק'}`;
    case 'activity':
      return `${m.trades} עסקאות ב-${monthsText(m.months)}${Number.isFinite(m.turnoverPct) ? ` · מחזור ${pct(m.turnoverPct)}` : ''}${Number.isFinite(m.avgHoldingDays) ? ` · החזקה ממוצעת ${Math.round(m.avgHoldingDays)} ימים` : ''}`;
    case 'costs':
      return `${ils(m.feesILS)} עמלות · ${pct(m.feesPct, 2)} מהתיק בשנה`;
    case 'tax':
      return `${m.sales} מימושים ב-${m.year} · רווח ריאלי נטו ${ils(m.netGain)} · מס משוער ${ils(m.taxDue)}`;
    case 'benchmark':
      return `התיק ${ils(m.actualValue)} מול ${ils(m.benchmarkValue)} ב-${m.benchmark.label} (${signedPct(m.excessPct)})`;
    case 'cash':
      return `${ils(m.cash)} במזומן ובכספיות · ${pct(m.sharePct)} מהתיק`;
    case 'goal':
      return m.achieved ? 'היעד הושג' : `${pct(m.progressPct)} מהיעד · ${m.monthsLeft} חודשים נותרו${Number.isFinite(m.requiredMonthly) ? ` · נדרש ${ils(m.requiredMonthly)} בחודש` : ''}`;
    case 'dividends':
      return `${ils(m.net12m)} נטו ב-12 חודשים${Number.isFinite(m.yieldPct) ? ` · תשואת דיבידנד ${pct(m.yieldPct, 2)}` : ''}${Number.isFinite(m.projectedAnnualILS) ? ` · צפי שנתי ${ils(m.projectedAnnualILS)}` : ''}`;
    default:
      return '';
  }
}

// ---------------------------------------------------------------------------
// The whole text block.

export function buildReviewText(review) {
  const notes = collectNotes(review).sort((a, b) => b.priority - a.priority);
  const good = notes.filter((n) => n.tone === 'good').slice(0, 5);
  const attention = notes.filter((n) => n.tone === 'attention').slice(0, 5);
  const thoughts = notes.filter((n) => n.tone === 'thought').slice(0, 3);
  const top = notes.find((n) => n.tone === 'attention' && n.focus);
  const oneThing = top
    ? { text: top.focus, why: top.text, category: top.category }
    : review.score !== null
    ? { text: 'להמשיך באותו קצב - לא זוהתה נקודה אחת שבולטת לשיפור החודש.', why: null, category: null }
    : null;
  return {
    monthLabel: formatMonthLabel(review.selectedMonth),
    good,
    attention,
    thoughts,
    oneThing,
    profile: investorProfile(review),
    badges: earnedBadges(review),
    summaries: Object.fromEntries(review.categories.map((c) => [c.key, categorySummary(c, review)]))
  };
}
