import { layoutSliceCallouts, sliceMidAngles, wrapLabel } from './pieCalloutLayout';

const opts = { cy: 180, outerRadius: 90, paddingAngle: 1, top: 34, bottom: 318 };

test('mid-angles run counter-clockwise from 3 o\'clock like Recharts', () => {
  const [a, b] = sliceMidAngles([1, 1], 0);
  expect(a.midAngle).toBeCloseTo(90);
  expect(b.midAngle).toBeCloseTo(270);
  expect(a.percent).toBeCloseTo(0.5);
});

test('leaves slices under the threshold unlabelled', () => {
  const layout = layoutSliceCallouts([100, 1], opts);
  expect(layout[0]).not.toBeNull();
  expect(layout[1]).toBeNull();
});

test('spreads neighbouring small slices on the same side at least `gap` apart', () => {
  // Several small slices clustered together - their natural heights are
  // only a few pixels apart.
  const values = [55, 4, 5, 4, 30, 8];
  const layout = layoutSliceCallouts(values, { ...opts, gap: 38 });
  [true, false].forEach((isRight) => {
    const ys = layout
      .filter((l) => l && l.isRight === isRight)
      .map((l) => l.labelY)
      .sort((a, b) => a - b);
    for (let i = 1; i < ys.length; i += 1) {
      expect(ys[i] - ys[i - 1]).toBeGreaterThanOrEqual(38 - 1e-9);
    }
  });
});

test('keeps every label inside the chart', () => {
  const layout = layoutSliceCallouts([10, 10, 10, 10, 10, 10, 10], opts);
  layout.forEach((l) => {
    expect(l.labelY).toBeGreaterThanOrEqual(opts.top);
    expect(l.labelY).toBeLessThanOrEqual(opts.bottom);
  });
});

test('leaves a lone label at its natural height', () => {
  const [only] = layoutSliceCallouts([1], opts);
  // A single full ring: mid-angle 180, so it sits on the left at centre height.
  expect(only.isRight).toBe(false);
  expect(only.labelY).toBeCloseTo(opts.cy);
});

test('wraps a label at spaces to fit the width', () => {
  const measure = (s) => s.length * 10;
  expect(wrapLabel('קופת חיסכון בבנק', 110, measure)).toEqual(['קופת חיסכון', 'בבנק']);
  expect(wrapLabel('עו"ש', 110, measure)).toEqual(['עו"ש']);
  // A word longer than the limit keeps a line of its own.
  expect(wrapLabel('אבגדהוזחטיכל קצר', 50, measure)).toEqual(['אבגדהוזחטיכל', 'קצר']);
});
