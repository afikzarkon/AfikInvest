// A quick estimate of how hard a password is to guess, for the strength
// meter under the password field. Guidance only - the server enforces the
// real rules (at least 8 characters, not in a known breach).
//
// Scores 0-4 from length and variety, with penalties for the patterns
// guessing tools try first: one repeated character, a run like "1234" or
// "abcd", a keyboard row, and words found in breach lists.
const COMMON = ['password', 'passw0rd', 'qwerty', '123456', '12345678', 'iloveyou', 'admin', 'welcome', 'letmein', 'monkey', 'dragon', 'football', 'sunshine', 'princess', 'shalom', 'israel', 'afikinvest'];
const SEQUENCES = ['0123456789', 'abcdefghijklmnopqrstuvwxyz', 'qwertyuiop', 'asdfghjkl', 'zxcvbnm'];

const LABELS = ['חלשה מאוד', 'חלשה', 'בינונית', 'טובה', 'חזקה'];

function hasSequence(lower) {
  for (const seq of SEQUENCES) {
    for (let i = 0; i + 4 <= seq.length; i += 1) {
      const run = seq.slice(i, i + 4);
      if (lower.includes(run) || lower.includes([...run].reverse().join(''))) return true;
    }
  }
  return false;
}

export function passwordStrength(password) {
  const p = String(password || '');
  if (!p) return { score: 0, label: '', hints: [] };
  const lower = p.toLowerCase();
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((re) => re.test(p)).length;
  const hints = [];

  let score = 0;
  if (p.length >= 8) score += 1;
  if (p.length >= 12) score += 1;
  if (p.length >= 16) score += 1;
  if (classes >= 2) score += 1;
  if (classes >= 3 && p.length >= 10) score += 1;

  if (p.length < 8) hints.push('לפחות 8 תווים');
  if (p.length < 12) hints.push('12 תווים ומעלה עדיף');
  if (classes < 2) hints.push('שלבו אותיות, ספרות או סימנים');
  if (/^(.)\1+$/.test(p)) {
    score = 0;
    hints.push('בלי תו אחד שחוזר על עצמו');
  }
  if (hasSequence(lower)) {
    score -= 1;
    hints.push('בלי רצפים כמו 1234 או qwerty');
  }
  if (COMMON.some((w) => lower.includes(w))) {
    score -= 2;
    hints.push('בלי מילים נפוצות כמו password');
  }
  score = Math.max(0, Math.min(4, score));
  if (p.length < 8) score = Math.min(score, 1);
  return { score, label: LABELS[score], hints: hints.slice(0, 2) };
}
