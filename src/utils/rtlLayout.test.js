import fs from 'fs';
import path from 'path';

// Comments are stripped up front. Without that, a rule documented as
// "not display:none" would read as containing display:none, and an
// assertion about the CSS would actually be testing the prose next to it.
const CSS = fs
  .readFileSync(path.join(__dirname, '..', 'App.css'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '');

// The app is RTL. A layout built with PHYSICAL edge properties (left,
// right, margin-left, padding-right, border-left...) is built for LTR and
// then needs a mirrored duplicate for RTL - two rules that drift apart the
// moment one is edited. The logical equivalents (inset-inline-start,
// margin-inline-end, ...) resolve against the document direction, so one
// rule is correct in both.
//
// This checks the components added or rebuilt in the layout
// re-architecture. It deliberately does NOT police the whole stylesheet:
// older sections predate this and are a separate cleanup.
const NEW_LAYOUT_SELECTORS = [
  '.app-shell',
  '.side-nav',
  '.side-nav-brand',
  '.side-nav-list',
  '.side-nav-link',
  '.side-nav-footer',
  '.side-nav-user',
  '.app-main',
  '.app-main-inner',
  '.page-toolbar',
  '.page-toolbar-main',
  '.page-toolbar-actions',
  '.page-toolbar-secondary',
  '.page-toolbar-primary',
  '.toolbar-btn',
  '.kpi-row',
  '.kpi-tile',
  '.kpi-tile-glow',
  '.kpi-tile-head'
];

// Physical edge properties that have a logical counterpart. `left`/`right`
// as offsets are included; `text-align: left/right` is not (it has its own
// start/end keywords, checked separately below).
const PHYSICAL_PROPS = [
  'margin-left',
  'margin-right',
  'padding-left',
  'padding-right',
  'border-left',
  'border-right',
  'left',
  'right'
];

// Plain string scanning rather than a regex: the selector list contains
// characters a regex would need escaping for, and a mis-escaped pattern
// silently matches nothing - which would make every assertion below pass
// while checking absolutely nothing.
function blocksFor(selector) {
  const out = [];
  let from = 0;
  for (;;) {
    const at = CSS.indexOf(selector, from);
    if (at === -1) break;
    from = at + selector.length;

    // Must be a whole selector token: preceded by a delimiter, and
    // followed only by whitespace before `{` or `,` - so `.side-nav` does
    // not also match `.side-nav-link`.
    const before = at === 0 ? '\n' : CSS[at - 1];
    if (!' \n\t,}'.includes(before)) continue;

    let i = from;
    while (i < CSS.length && ' \n\t'.includes(CSS[i])) i += 1;
    if (CSS[i] !== '{') continue;

    const close = CSS.indexOf('}', i);
    if (close === -1) continue;
    out.push(CSS.slice(i + 1, close));
  }
  return out;
}

// The declarations in a block, as [property, value] pairs.
function declarations(block) {
  return block
    .split(';')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const colon = line.indexOf(':');
      if (colon === -1) return null;
      return [line.slice(0, colon).trim(), line.slice(colon + 1).trim()];
    })
    .filter(Boolean);
}

describe('RTL correctness of the new layout', () => {
  test.each(NEW_LAYOUT_SELECTORS)('%s uses logical properties, not physical edges', (selector) => {
    const blocks = blocksFor(selector);
    expect(blocks.length).toBeGreaterThan(0); // the selector must actually exist
    blocks.forEach((block) => {
      const offenders = declarations(block)
        .filter(([prop]) => PHYSICAL_PROPS.includes(prop))
        .map(([prop]) => `${selector} -> ${prop}`);
      expect(offenders).toEqual([]);
    });
  });

  test('the sidebar is separated from the page with a logical border', () => {
    const block = blocksFor('.side-nav')[0];
    expect(block).toMatch(/border-inline-end/);
  });

  test('the active-page marker is anchored to the inline start, not to a fixed side', () => {
    expect(CSS).toMatch(/\.side-nav-link\.active::before[^}]*inset-inline-start/);
  });

  test('text alignment uses start/end rather than left/right', () => {
    NEW_LAYOUT_SELECTORS.forEach((selector) => {
      blocksFor(selector).forEach((block) => {
        declarations(block)
          .filter(([prop]) => prop === 'text-align')
          .forEach(([, value]) => {
            expect(['start', 'end', 'center', 'inherit']).toContain(value);
          });
      });
    });
  });
});

describe('responsiveness of the new layout', () => {
  test('the shell has a breakpoint that turns the sidebar into a bottom bar', () => {
    const mobile = CSS.slice(CSS.indexOf('@media (max-width: 960px)'));
    expect(mobile).toMatch(/\.side-nav\s*\{[^}]*bottom:\s*0/);
    // And the page gets bottom padding, so the last row isn't stuck under it.
    expect(mobile).toMatch(/\.app-shell\s*\{[^}]*padding-bottom/);
  });

  // A table stays a table at every width: the rows used to become one
  // card per holding on a phone, which reads well for a single position
  // and makes comparing two of them impossible.
  test('rows stay table rows rather than becoming cards on a phone', () => {
    const phone = CSS.slice(CSS.indexOf('@media (max-width: 720px)'));
    // The card layout turned rows and cells into blocks and printed the
    // column name from a data attribute. Neither may come back.
    expect(phone).not.toMatch(/content:\s*attr\(data-label\)/);
    expect(phone).not.toMatch(/\.stocks-table tr,[\s\S]{0,80}display:\s*block/);
  });

  // Pinning the identifier is what makes the sideways scroll legible:
  // without it a swipe leaves a grid of anonymous numbers.
  test('the identifying column is pinned while the metrics scroll', () => {
    const block = CSS.slice(CSS.lastIndexOf('.stocks-table th:first-child,'));
    const rule = block.slice(0, block.indexOf('}'));
    expect(rule).toMatch(/position:\s*sticky/);
    // The first column renders at the right edge of the RTL table, and
    // that is the edge it must stick to. It is a physical `right`
    // because the scroller around it is LTR (next test).
    expect(rule).toMatch(/right:\s*0/);
    expect(rule).toMatch(/z-index/);
  });

  // iOS WebKit mispositions a horizontally sticky cell inside an RTL
  // scroll container - the identifier column was drawn off-screen - so
  // the scroller is LTR and only the table inside it is RTL.
  test('the table scroller is LTR around an RTL table', () => {
    expect(CSS).toMatch(/\.table-container\s*\{\s*direction:\s*ltr;\s*\}/);
    expect(CSS).toMatch(/\.table-container > \.stocks-table\s*\{\s*direction:\s*rtl;\s*\}/);
  });

  // A translucent pinned cell shows the rows sliding underneath it,
  // which is worse than not pinning at all.
  test('the pinned column is painted on an opaque surface', () => {
    const block = CSS.slice(CSS.lastIndexOf('.stocks-table th:first-child,'));
    const rule = block.slice(0, block.indexOf('}'));
    expect(rule).toMatch(/background:\s*var\(--sw-surface-3\)/);
    // --sw-surface-3 is the token documented as opaque, and it has to be
    // opaque in BOTH themes or the pinned column leaks in one of them.
    const values = [...CSS.matchAll(/--sw-surface-3:\s*([^;]+);/g)].map((m) => m[1].trim());
    expect(values.length).toBeGreaterThanOrEqual(2);
    values.forEach((v) => expect(v).not.toMatch(/rgba|transparent/));
  });

  // A figure broken across two lines stops being one number, and one
  // wrapped cell sets the height of its whole row.
  test('data cells do not wrap', () => {
    // The nowrap rule pairs these two selectors; they appear together
    // nowhere else in the stylesheet.
    const at = CSS.search(/\.stocks-table td,\s*\.analysis-table td \{/);
    expect(at).toBeGreaterThan(-1);
    const block = CSS.slice(at);
    const rule = block.slice(0, block.indexOf('}'));
    expect(rule).toMatch(/white-space:\s*nowrap/);
  });

  test('the table scrolls inside its own container rather than widening the page', () => {
    const block = CSS.slice(CSS.indexOf('.table-container {'));
    const rule = block.slice(0, block.indexOf('}'));
    expect(rule).toMatch(/overflow-x:\s*auto/);
  });

  test('motion is disabled for users who ask for reduced motion', () => {
    expect(CSS).toMatch(/@media \(prefers-reduced-motion: reduce\)/);
    const block = CSS.slice(CSS.indexOf('@media (prefers-reduced-motion: reduce)'));
    expect(block).toMatch(/animation-duration:\s*0\.01ms\s*!important/);
  });
});
