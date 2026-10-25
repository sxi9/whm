import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { X } from 'lucide-react';

export function Modal({ open, title, onClose, children, footer, size = 'md' }) {
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') onClose?.(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose?.(); }}>
      <div className={`modal modal-${size}`} role="dialog" aria-modal="true" aria-label={title}>
        <header className="modal-header">
          <h2>{title}</h2>
          <button className="icon-button" onClick={onClose} aria-label="Close"><X size={18} /></button>
        </header>
        <div className="modal-body">{children}</div>
        {footer && <footer className="modal-footer">{footer}</footer>}
      </div>
    </div>
  );
}

const ConfirmContext = createContext(null);

// useConfirm() returns an async function: const ok = await confirm({ title, message, danger })
export function ConfirmProvider({ children }) {
  const [state, setState] = useState(null);
  const resolver = useRef(null);
  const [typed, setTyped] = useState('');

  const confirm = useCallback((opts) => new Promise((resolve) => {
    resolver.current = resolve;
    setTyped('');
    setState({ title: 'Are you sure?', confirmLabel: 'Confirm', cancelLabel: 'Cancel', danger: false, ...opts });
  }), []);

  const finish = (result) => { resolver.current?.(result); resolver.current = null; setState(null); };
  const needsTyping = state?.typeToConfirm;
  const canConfirm = !needsTyping || typed === state.typeToConfirm;

  const value = useMemo(() => confirm, [confirm]);
  return (
    <ConfirmContext.Provider value={value}>
      {children}
      <Modal open={Boolean(state)} title={state?.title} onClose={() => finish(false)} size="sm"
        footer={(
          <>
            <button className="btn" onClick={() => finish(false)}>{state?.cancelLabel}</button>
            <button className={`btn ${state?.danger ? 'btn-danger' : 'btn-primary'}`} disabled={!canConfirm} onClick={() => finish(true)}>{state?.confirmLabel}</button>
          </>
        )}>
        <p>{state?.message}</p>
        {needsTyping && (
          <label className="field">
            <span className="field-label">Type <code>{state.typeToConfirm}</code> to confirm</span>
            <input className="input" value={typed} onChange={(e) => setTyped(e.target.value)} autoFocus />
          </label>
        )}
      </Modal>
    </ConfirmContext.Provider>
  );
}

export function useConfirm() {
  const ctx = useContext(ConfirmContext);
  if (!ctx) throw new Error('useConfirm must be used inside ConfirmProvider');
  return ctx;
}
