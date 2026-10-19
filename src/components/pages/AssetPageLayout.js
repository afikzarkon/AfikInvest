import React from 'react';
import PortfolioActionsToolbar from '../PortfolioActionsToolbar';
import BetaBanner from '../BetaBanner';
import { useCompactLayout } from '../../hooks/useMediaQuery';

// The frame every asset page shares: the portfolio action toolbar, an
// optional summary card for that asset class, and then the page's table.
//
// The five asset pages differ only in which card and which table they
// render, so the wrapper markup, the toolbar wiring and the empty state all
// live here once. `.welcome-container`/`.welcome-content` are the same
// wrappers the dashboard uses - they carry the page's width and rhythm, and
// are not specific to the home page.
function AssetPageLayout({
  title,
  subtitle,
  summaryCard,
  isEmpty,
  emptyMessage,
  children,
  ...toolbarProps
}) {
  // On a phone the subtitle only repeats the page's name in more words;
  // the edit-mode hint, which says how to use the page, stays.
  const compact = useCompactLayout();
  return (
    <div className="App">
      <div className="welcome-container">
        <div className="welcome-content">
          <PortfolioActionsToolbar
            {...toolbarProps}
            title={title}
            subtitle={
              toolbarProps.isEditMode
                ? 'מצב עריכה פעיל - לחצו על תא בטבלה כדי לערוך אותו'
                : compact
                ? null
                : subtitle
            }
          />

          {/* Every asset page holds an editable table, so the "do not
              type real figures" half of the warning is the one that
              applies here. */}
          <BetaBanner tone="data" />

          {/* No card when the page has nothing in it: a card of zeroes
              reads as a real position worth nothing, rather than as an
              empty account. */}
          {!isEmpty && summaryCard && (
            <div className="portfolio-summary">
              <div className="summary-grid-custom">
                <div className="summary-row summary-row-single">{summaryCard}</div>
              </div>
            </div>
          )}

          {isEmpty ? (
            <div className="no-data-message">
              <p>{emptyMessage}</p>
              <p>לחצו על "+ הוספת מידע" כדי להוסיף</p>
            </div>
          ) : (
            children
          )}
        </div>
      </div>
    </div>
  );
}

export default AssetPageLayout;
