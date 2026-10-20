import { render, screen } from '@testing-library/react';
import { Futures, placeScaleLabels } from './ValuationSimple';

const futures = {
  rows: [
    { key: 'bear', label: 'אם הדברים ילכו פחות טוב', value: 118.85, text: '$118.85', vsPrice: 'below' },
    { key: 'base', label: 'אם הדברים ילכו כצפוי', value: 156.09, text: '$156.09', vsPrice: 'below' },
    { key: 'bull', label: 'אם הדברים ילכו מצוין', value: 174.85, text: '$174.85', vsPrice: 'below' }
  ],
  price: 342.94,
  priceText: '$342.94',
  summary: 'גם אם הכל ילך מצוין, השווי שחישבנו נמוך מהמחיר של היום.'
};

describe('the three futures on one line', () => {
  // Each price twice: once in the list, once on the line beside its dot.
  test('writes every scenario price and today\'s price on the line itself', () => {
    const { container } = render(<Futures futures={futures} />);
    const scale = container.querySelector('.vs-scale');
    ['$118.85', '$156.09', '$174.85'].forEach((text) => {
      expect(screen.getAllByText(text)).toHaveLength(2);
      expect(scale).toHaveTextContent(text);
    });
    expect(scale.querySelector('.vs-scale-today')).toHaveTextContent('מחיר היום $342.94');
  });

  test('neighbours too close for one level are split over two', () => {
    const placed = placeScaleLabels([
      { key: 'bear', at: 4 },
      { key: 'base', at: 15 },
      { key: 'bull', at: 21 }
    ]);
    expect(placed.map((p) => p.lane)).toEqual([0, 1, 0]);
  });

  test('labels far apart stay on one level', () => {
    const placed = placeScaleLabels([
      { key: 'bear', at: 10 },
      { key: 'base', at: 50 },
      { key: 'bull', at: 90 }
    ]);
    expect(placed.every((p) => p.lane === 0)).toBe(true);
  });
});
