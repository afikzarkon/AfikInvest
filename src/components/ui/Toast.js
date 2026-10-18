import React, { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';

// Short success/error messages after a save, in the corner of the screen.
//
//   const toast = useToast();
//   toast.success('הפרופיל נשמר'); toast.error('השמירה נכשלה');
//
// Announced to screen readers (status for success, alert for errors), and
// closable by button; each disappears on its own after a few seconds.
const ToastContext = createContext(null);
const DURATION_MS = 4500;

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  const nextId = useRef(1);

  const dismiss = useCallback((id) => setToasts((list) => list.filter((t) => t.id !== id)), []);

  const show = useCallback(
    (kind, message) => {
      const id = nextId.current++;
      setToasts((list) => [...list.slice(-3), { id, kind, message }]);
      setTimeout(() => dismiss(id), DURATION_MS);
    },
    [dismiss]
  );

  const api = useMemo(
    () => ({
      success: (message) => show('success', message),
      error: (message) => show('error', message),
      info: (message) => show('info', message)
    }),
    [show]
  );

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="toast-stack" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast toast-${t.kind}`} role={t.kind === 'error' ? 'alert' : 'status'}>
            <span className="toast-message">{t.message}</span>
            <button type="button" className="toast-close" onClick={() => dismiss(t.id)} aria-label="סגירת ההודעה">
              ×
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

// Outside a provider (a component rendered on its own in a test) the calls
// do nothing rather than throw.
const NOOP = { success() {}, error() {}, info() {} };
export function useToast() {
  return useContext(ToastContext) || NOOP;
}
