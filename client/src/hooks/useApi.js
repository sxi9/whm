import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api/client.js';

// Small data-fetching hook: refetches when `path` changes, exposes a manual
// refetch, and ignores responses from superseded requests.
export function useApi(path, { enabled = true, refreshMs = 0 } = {}) {
  const [state, setState] = useState({ data: null, meta: null, error: null, loading: Boolean(enabled && path) });
  const seq = useRef(0);

  const run = useCallback(async (silent = false) => {
    if (!enabled || !path) return;
    const id = ++seq.current;
    if (!silent) setState((s) => ({ ...s, loading: true, error: null }));
    try {
      const res = await api.get(path);
      if (id === seq.current) setState({ data: res.data ?? null, meta: res.meta ?? null, error: null, loading: false });
    } catch (error) {
      if (id === seq.current) setState((s) => ({ ...s, error, loading: false }));
    }
  }, [path, enabled]);

  useEffect(() => { run(); }, [run]);
  useEffect(() => {
    if (!refreshMs || !enabled) return undefined;
    const t = setInterval(() => run(true), refreshMs);
    return () => clearInterval(t);
  }, [refreshMs, run, enabled]);

  return { ...state, refetch: run, setData: (updater) => setState((s) => ({ ...s, data: typeof updater === 'function' ? updater(s.data) : updater })) };
}

// Wraps a mutation so components get loading/error state and field errors.
export function useMutation(fn) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const mutate = useCallback(async (...args) => {
    setLoading(true);
    setError(null);
    try {
      return await fn(...args);
    } catch (err) {
      setError(err);
      throw err;
    } finally {
      setLoading(false);
    }
  }, [fn]);
  return { mutate, loading, error, fieldErrors: error?.fields || null, reset: () => setError(null) };
}
