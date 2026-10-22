import React, { useState } from 'react';

// The phone's form of a holdings table: one card per holding.
//
// The header of each card carries what is checked every day - name and
// security number, quantity, value, profit and the day's change. A tap
// opens the rest of the row's columns, under the same names as the
// desktop's headers; "נתונים מורחבים" adds the extended columns, to the
// holding and to each purchase; a holding bought in several lots lists
// every purchase with its own profit, and a tap on one opens all of its
// columns - the desktop's expanded row. Nothing on the desktop table is
// left out: every column has a place here.
//
// `items` is built by the table that owns the data (IsraeliStocksTable,
// AmericanStocksTable), so the cards and the desktop table are two views
// of one set of figures:
//   { key, name, idLine, lotsCount, value, valueSub, pl, daily, yesterday,
//     details: [{ label, value }], ext: [...], actions,
//     lots: [{ key, title, pl, details, ext, actions }] }
// value/pl/daily/yesterday and every entry's value are ready-made nodes.

function FieldList({ fields }) {
  if (!fields || fields.length === 0) return null;
  return (
    <dl className="hc-fields">
      {fields.map((f) => (
        <div className="hc-field" key={f.label}>
          <dt>{f.label}</dt>
          <dd>{f.value}</dd>
        </div>
      ))}
    </dl>
  );
}

function ExtBlock({ fields }) {
  if (!fields || fields.length === 0) return null;
  return (
    <div className="hc-ext">
      <span className="hc-ext-title">נתונים מורחבים</span>
      <FieldList fields={fields} />
    </div>
  );
}

function HoldingCards({ items, showExtended = false, label }) {
  const [openCards, setOpenCards] = useState(() => new Set());
  const [openLots, setOpenLots] = useState(() => new Set());
  const toggle = (setter, key) =>
    setter((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  return (
    <ul className="hc-list" aria-label={label}>
      {items.map((item) => {
        const open = openCards.has(item.key);
        const detailsId = `hc-${item.key}`;
        return (
          <li key={item.key} className={`hc-card ${open ? 'is-open' : ''}`}>
            <button type="button" className="hc-head" aria-expanded={open} aria-controls={detailsId} onClick={() => toggle(setOpenCards, item.key)}>
              <span className="hc-id">
                <span className="hc-name">
                  <bdi>{item.name}</bdi>
                  {item.lotsCount > 1 && <span className="hc-badge">{item.lotsCount} קניות</span>}
                </span>
                {item.idLine && <span className="hc-idline">{item.idLine}</span>}
              </span>
              <span className="hc-figures">
                <span className="hc-value">{item.value}</span>
                {item.valueSub && <span className="hc-valuesub">{item.valueSub}</span>}
                <span className="hc-line">{item.pl}</span>
              </span>
              <span className="hc-daily">
                <span>היום</span>
                <span className="hc-line">{item.daily}</span>
              </span>
              {item.yesterday ? (
                <span className="hc-daily hc-yesterday">
                  <span>אתמול</span>
                  <span className="hc-line">{item.yesterday}</span>
                </span>
              ) : null}
            </button>
            {open && (
              <div className="hc-body" id={detailsId}>
                <FieldList fields={item.details} />
                {showExtended && <ExtBlock fields={item.ext} />}
                {item.lots && item.lots.length > 1 && (
                  <div className="hc-lots">
                    <span className="hc-lots-title">{item.lots.length} קניות</span>
                    {item.lots.map((lot) => {
                      const lotOpen = openLots.has(lot.key);
                      return (
                        <div key={lot.key} className={`hc-lot ${lotOpen ? 'is-open' : ''}`}>
                          <button type="button" className="hc-lot-head" aria-expanded={lotOpen} onClick={() => toggle(setOpenLots, lot.key)}>
                            <span className="hc-lot-title">{lot.title}</span>
                            <span className="hc-line">{lot.pl}</span>
                            <span className="hc-lot-more">{lotOpen ? 'סגירת פרטי הקנייה' : 'כל נתוני הקנייה'}</span>
                          </button>
                          {lotOpen && (
                            <div className="hc-lot-body">
                              <FieldList fields={lot.details} />
                              {showExtended && <ExtBlock fields={lot.ext} />}
                              {lot.actions && <div className="hc-actions">{lot.actions}</div>}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
                {item.actions && <div className="hc-actions">{item.actions}</div>}
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

export default HoldingCards;
