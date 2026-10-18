// Plain-language readings of the valuation numbers, for the simple view of
// the valuation page: is a multiple cheap or expensive against the company's
// own past and against its peers, and is it meaningful at all.
//
// Tones: 'cheap' | 'expensive' | 'normal' | 'mixed' | 'na'.

// Within this much of the reference, a multiple counts as "as usual".
export const NORMAL_BAND_PCT = 15;

// A P/E over this, or a 5-year range wider than this many times, comes from
// earnings that are tiny or swing with one-off items - the number then
// moves by hundreds on small changes and says little about the price.
const PE_MEANINGLESS_ABOVE = 100;
const PE_MEANINGLESS_RANGE = 8;

export function toneOfPct(pct) {
  if (pct === null || pct === undefined || !Number.isFinite(pct)) return 'na';
  if (pct < -NORMAL_BAND_PCT) return 'cheap';
  if (pct > NORMAL_BAND_PCT) return 'expensive';
  return 'normal';
}

// One row of the multiples table, read: whether it is meaningful, and how
// it compares with the 5-year average and the peer median.
export function readMultiple(row) {
  const current = row.current;
  if (!Number.isFinite(current) || current <= 0) {
    return { meaningful: false, reason: 'missing', history: 'na', peers: 'na' };
  }
  if (row.metric === 'PE') {
    const wideRange = row.min5y > 0 && row.max5y / row.min5y > PE_MEANINGLESS_RANGE;
    if (current > PE_MEANINGLESS_ABOVE || wideRange) {
      return { meaningful: false, reason: 'unstable-earnings', history: 'na', peers: 'na' };
    }
  }
  return {
    meaningful: true,
    reason: null,
    history: toneOfPct(row.vsHistoryPct),
    peers: row.peerCount >= 2 ? toneOfPct(row.vsSectorPct) : 'na'
  };
}

// Several readings to one: the side most meaningful multiples fall on.
export function combineTones(tones) {
  const known = tones.filter((t) => t !== 'na');
  if (!known.length) return 'na';
  const count = (t) => known.filter((x) => x === t).length;
  const cheap = count('cheap');
  const expensive = count('expensive');
  if (cheap > known.length / 2) return 'cheap';
  if (expensive > known.length / 2) return 'expensive';
  if (cheap && expensive) return 'mixed';
  if (cheap > expensive) return 'cheap';
  if (expensive > cheap) return 'expensive';
  return 'normal';
}

export function multiplesSummary(rows) {
  const readings = (rows || []).map(readMultiple);
  return {
    history: combineTones(readings.map((r) => r.history)),
    peers: combineTones(readings.map((r) => r.peers))
  };
}

// "cheaper by 57%" / "3.2 times as expensive" - a percentage up to doubling,
// a multiple beyond it, since "+394%" means little to most readers.
export function describeGap(pct) {
  if (pct === null || pct === undefined || !Number.isFinite(pct)) return '';
  if (pct >= 100) return `יקר פי ${(1 + pct / 100).toFixed(1)}`;
  if (pct > 0) return `יקר ב-${Math.round(pct)}%`;
  if (pct < 0) return `זול ב-${Math.round(-pct)}%`;
  return 'זהה';
}

export const DCF_VERDICT_TONE = { UNDERVALUED: 'cheap', OVERVALUED: 'expensive', FAIRLY_VALUED: 'normal', 'N/A': 'na' };
