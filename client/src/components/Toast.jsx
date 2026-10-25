import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';
import { CheckCircle2, AlertTriangle, Info, XCircle, X } from 'lucide-react';

const ToastContext = createContext(null);
const ICONS = { success: CheckCircle2, error: XCircle, warning: AlertTriangle, info: Info };

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  const counter = useRef(0);

  const dismiss = useCallback((id) => setToasts((t) => t.filter((x) => x.id !== id)), []);
  const push = useCallback((kind, message, { title, timeout = kind === 'error' ? 8000 : 4500 } = {}) => {
    const id = ++counter.current;
    setToasts((t) => [...t, { id, kind, message, title }]);
    if (timeout) setTimeout(() => dismiss(id), timeout);
    return id;
  }, [dismiss]);

  const value = useMemo(() => ({
    success: (m, o) => push('success', m, o),
    error: (m, o) => push('error', typeof m === 'string' ? m : m?.message || 'Something went wrong', o),
    warning: (m, o) => push('warning', m, o),
    info: (m, o) => push('info', m, o),
    dismiss,
  }), [push, dismiss]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="toast-stack" role="status" aria-live="polite">
        {toasts.map((t) => {
          const Icon = ICONS[t.kind];
          return (
            <div key={t.id} className={`toast toast-${t.kind}`}>
              <Icon size={18} />
              <div className="toast-body">
                {t.title && <strong>{t.title}</strong>}
                <span>{t.message}</span>
              </div>
              <button className="icon-button" onClick={() => dismiss(t.id)} aria-label="Dismiss"><X size={14} /></button>
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used inside ToastProvider');
  return ctx;
}
