import React, { useEffect, useRef, useState } from 'react';
import PrivacyToggle from './PrivacyToggle';

// The contextual action bar for whatever page is open: one sticky strip
// holding the page title, its actions, and its live status.
//
// Controls used to be scattered down the page - a save button in a bar at
// the very top, export and "add" in a header row below it, then edit-mode
// and column toggles buried in the middle between the summary and the
// tables, with three separate places reporting status. Finding an action
// meant remembering where on the page it lived.
//
// Three zones, in a deliberate order:
//   primary   - exactly one, the thing this page is FOR. Filled, accented.
//   secondary - view/filter/export. Outlined, visually quieter, so the
//               primary action is never competing with six others.
//   status    - passive feedback only, never a control.
//
// Sticky, so the actions stay reachable while scrolling a long table
// instead of requiring a trip back to the top.
//
// `sticky` is opt-out for the pages where that is the wrong trade. The
// dashboard is one: it has no long table to keep actions reachable over,
// and pinning its header means the figures below it are read through a
// permanently reserved strip. There the header is just the top of the
// page, and scrolls away like the rest of it.
function PageToolbar({
  title,
  subtitle,
  primaryAction,
  secondaryActions,
  status,
  children,
  sticky = true
}) {
  return (
    <div className={`page-toolbar ${sticky ? 'is-sticky' : 'is-static'}`}>
      <div className="page-toolbar-main">
        <div className="page-toolbar-heading">
          <div className="page-toolbar-title-row">
            <h1 className="page-toolbar-title">{title}</h1>
            {/* Privacy mode, reachable from the top of every page. */}
            <PrivacyToggle />
          </div>
          {subtitle && <p className="page-toolbar-subtitle">{subtitle}</p>}
        </div>

        <div className="page-toolbar-actions">
          {secondaryActions && <div className="page-toolbar-secondary">{secondaryActions}</div>}
          {primaryAction && <div className="page-toolbar-primary">{primaryAction}</div>}
        </div>
      </div>

      {status && <div className="page-toolbar-status">{status}</div>}
      {children}
    </div>
  );
}

// A secondary control in the toolbar. `pressed` drives both the visual
// state and aria-pressed, so a toggle that is ON is reported as on rather
// than only looking different.
export function ToolbarButton({ onClick, pressed, disabled, title, children }) {
  return (
    <button
      type="button"
      className={`toolbar-btn ${pressed ? 'is-pressed' : ''}`}
      onClick={onClick}
      disabled={disabled}
      aria-pressed={pressed === undefined ? undefined : Boolean(pressed)}
      title={title}
    >
      {children}
    </button>
  );
}

// The secondary actions folded behind one "⋯" button - the phone's form of
// the toolbar, where a row of five buttons wrapped into a 300px block above
// the page's own content. The same buttons, in a menu; choosing one closes
// it, as do a tap outside and Escape.
export function ToolbarMoreMenu({ label = 'פעולות נוספות', children }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const onPointer = (e) => {
      if (rootRef.current && !rootRef.current.contains(e.target)) setOpen(false);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className="toolbar-more" ref={rootRef}>
      <button
        type="button"
        className={`toolbar-btn toolbar-more-button ${open ? 'is-pressed' : ''}`}
        aria-haspopup="true"
        aria-expanded={open}
        aria-label={label}
        title={label}
        onClick={() => setOpen((o) => !o)}
      >
        ⋯
      </button>
      {open && (
        // A click on any button inside runs that button and then closes.
        // eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions
        <div className="toolbar-more-menu" onClick={(e) => e.target.closest('button') && setOpen(false)}>
          {children}
        </div>
      )}
    </div>
  );
}

// The page's single primary action.
export function ToolbarPrimaryButton({ onClick, disabled, children }) {
  return (
    <button type="button" className="toolbar-btn-primary" onClick={onClick} disabled={disabled}>
      {children}
    </button>
  );
}

// Passive status text. `tone` only affects color; it is never the sole
// carrier of meaning, since the text itself always says what happened.
export function ToolbarStatus({ tone = 'muted', children }) {
  return <span className={`toolbar-status toolbar-status-${tone}`}>{children}</span>;
}

export default PageToolbar;
