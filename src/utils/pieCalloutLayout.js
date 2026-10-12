// Vertical placement of a donut's outside callout labels, so that no two
// labels on the same side of the ring print over each other.
//
// Recharts calls a Pie's label renderer once per slice and hands it only
// that slice's geometry, so a renderer on its own cannot see its
// neighbours. When several small slices sit next to each other their
// labels all want nearly the same height on the rail and land on top of
// one another. This computes every slice's angle the way Recharts does
// (recharts/lib/polar/Pie.js: the default 0 -> 360 sweep, paddingAngle
// between non-zero slices, no minAngle), then spreads each side's labels
// apart to at least `gap` pixels while keeping them inside the chart.
//
// Returns one entry per value, in order: null for a slice that gets no
// label (below `minPercent`), otherwise { isRight, labelY }.

export function sliceMidAngles(values, paddingAngle = 0) {
  const nums = values.map((v) => (Number.isFinite(v) && v > 0 ? v : 0));
  const sum = nums.reduce((a, b) => a + b, 0);
  const notZero = nums.filter((v) => v !== 0).length;
  const padding = nums.length <= 1 ? 0 : paddingAngle;
  const realTotalAngle = 360 - notZero * padding;

  let prevEnd = 0;
  return nums.map((val, i) => {
    const percent = sum > 0 ? val / sum : 0;
    const start = i > 0 ? prevEnd + (val !== 0 ? padding : 0) : 0;
    const end = start + percent * realTotalAngle;
    prevEnd = end;
    return { midAngle: (start + end) / 2, percent };
  });
}

// Pushes sorted positions apart to `gap`, inside [min, max]. Downward first,
// then back up from the bottom if that ran past `max`; if there is simply
// not room for all of them, they are spaced evenly across the range.
function spread(ys, gap, min, max) {
  if (ys.length === 0) return ys;
  if ((ys.length - 1) * gap > max - min) {
    const step = ys.length > 1 ? (max - min) / (ys.length - 1) : 0;
    return ys.map((_, i) => (ys.length > 1 ? min + i * step : (min + max) / 2));
  }
  const out = ys.map((y) => Math.min(Math.max(y, min), max));
  for (let i = 1; i < out.length; i += 1) out[i] = Math.max(out[i], out[i - 1] + gap);
  if (out[out.length - 1] > max) {
    out[out.length - 1] = max;
    for (let i = out.length - 2; i >= 0; i -= 1) out[i] = Math.min(out[i], out[i + 1] - gap);
  }
  return out;
}

export function layoutSliceCallouts(
  values,
  { cy, outerRadius, paddingAngle = 0, minPercent = 0.03, elbowGap = 12, gap = 38, top, bottom }
) {
  const slices = sliceMidAngles(values, paddingAngle).map(({ midAngle, percent }, index) => {
    if (!percent || percent < minPercent) return null;
    const angle = (-midAngle * Math.PI) / 180;
    return {
      index,
      isRight: Math.cos(angle) >= 0,
      desiredY: cy + (outerRadius + elbowGap) * Math.sin(angle)
    };
  });

  const result = values.map(() => null);
  [true, false].forEach((isRight) => {
    const side = slices
      .filter((s) => s && s.isRight === isRight)
      .sort((a, b) => a.desiredY - b.desiredY);
    const ys = spread(
      side.map((s) => s.desiredY),
      gap,
      top,
      bottom
    );
    side.forEach((s, i) => {
      result[s.index] = { isRight, labelY: ys[i] };
    });
  });
  return result;
}

// Breaks a label into lines no wider than `maxWidth`, at spaces. `measure`
// returns a string's rendered width in px. A single word wider than the
// limit keeps a line of its own rather than being split mid-word.
export function wrapLabel(text, maxWidth, measure) {
  const words = String(text || '').split(/\s+/).filter(Boolean);
  const lines = [];
  words.forEach((word) => {
    const last = lines[lines.length - 1];
    if (last !== undefined && measure(`${last} ${word}`) <= maxWidth) {
      lines[lines.length - 1] = `${last} ${word}`;
    } else {
      lines.push(word);
    }
  });
  return lines.length ? lines : [''];
}

// A text-width measurer for SVG labels, backed by a canvas. Falls back to a
// rough per-character estimate where canvas is unavailable (jsdom).
let measureCanvas;
export function makeTextMeasurer(fontSize, fontWeight = 400) {
  let ctx = null;
  try {
    // jsdom has no canvas and logs an error for every attempt to get one.
    const isJsdom = typeof navigator !== 'undefined' && /jsdom/i.test(navigator.userAgent || '');
    if (typeof document !== 'undefined' && !isJsdom) {
      measureCanvas = measureCanvas || document.createElement('canvas');
      ctx = measureCanvas.getContext ? measureCanvas.getContext('2d') : null;
    }
  } catch {
    ctx = null;
  }
  if (!ctx) return (s) => String(s).length * fontSize * 0.55;
  const family =
    (typeof window !== 'undefined' && window.getComputedStyle && window.getComputedStyle(document.body).fontFamily) ||
    'sans-serif';
  const font = `${fontWeight} ${fontSize}px ${family}`;
  return (s) => {
    ctx.font = font;
    return ctx.measureText(String(s)).width;
  };
}
