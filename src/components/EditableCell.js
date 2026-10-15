import React from 'react';

// A single click-to-edit table cell used in both stock tables.
// Renders the display value normally; when this exact field is being
// edited (editingField === `${id}-${field}`), it swaps to an <input>.
//
// This is the same pattern that used to be copy-pasted ~20 times across
// IsraeliStocksTable.js and AmericanStocksTable.js — behavior is unchanged,
// only the location moved.
function EditableCell({
  id,
  field,
  exchange,
  value,
  editingField,
  isEditMode,
  handleCellClick,
  handleInlineEdit,
  finishInlineEdit,
  handleKeyDown,
  displayValue,
  type = 'text',
  step,
  min,
  parse,
  style,
  className,
  // The cell's column header. On mobile the table becomes one card per
  // row and every value needs its own label, since the header row is no
  // longer above it (see App.css's max-width: 720px block, which renders
  // this through content: attr(data-label)).
  label,
  // The input's accessible name, for a cell whose column header does not
  // say enough on its own - a movement row's "סכום" column, say, where the
  // sign carries the direction. Defaults to the column label.
  ariaLabel
}) {
  const isEditing = editingField === `${id}-${field}`;
  const cellClassName = [isEditMode ? 'editable-cell' : '', className].filter(Boolean).join(' ');
  const handleChange = (e) => {
    const raw = e.target.value;
    const parsed = parse ? parse(raw) : raw;
    handleInlineEdit(id, field, parsed, exchange);
  };

  return (
    <td
      onClick={() => handleCellClick(id, field, exchange)}
      className={cellClassName}
      style={style}
      data-label={label}
    >
      {isEditing ? (
        <input
          type={type}
          aria-label={ariaLabel || label}
          value={value}
          onChange={handleChange}
          onBlur={finishInlineEdit}
          onKeyDown={(e) => handleKeyDown(e, id, field, exchange)}
          autoFocus
          step={step}
          min={min}
        />
      ) : (
        displayValue
      )}
    </td>
  );
}

export default EditableCell;
