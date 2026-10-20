import React, { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';

// A panel that slides up from the bottom of a phone screen, for controls
// that would otherwise fill the page above what they control (the analysis
// page's market, currency and date filters).
//
// Styled as the bottom bar's "עוד" sheet (.nav-sheet in App.css), so both
// read as the same kind of surface. Rendered on <body> for the same reason
// that sheet is: an ancestor with a backdrop-filter becomes the containing
// block of anything fixed inside it.
//
// Closes on the backdrop, on Escape and on the close button; `footer` is a
// row pinned under the content, typically the button that applies and
// closes.
function BottomSheet({ title, onClose, children, footer = null }) {
  const sheetRef = useRef(null);
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    if (sheetRef.current) sheetRef.current.focus();
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return createPortal(
    // eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions
    <div className="nav-sheet-backdrop" onClick={onClose}>
      {/* eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-noninteractive-element-interactions */}
      <div
        className="nav-sheet bottom-sheet"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        ref={sheetRef}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="nav-sheet-head">
          <span className="nav-sheet-title">{title}</span>
          <button type="button" className="nav-sheet-close" onClick={onClose} aria-label="סגירה">
            ×
          </button>
        </div>
        <div className="bottom-sheet-body">{children}</div>
        {footer && <div className="bottom-sheet-footer">{footer}</div>}
      </div>
    </div>,
    document.body
  );
}

export default BottomSheet;
