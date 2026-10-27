import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client.js';

// GET `path` and expose { data, meta, loading, error, refetch }. A null path
// (or enabled: false) renders nothing and fetches nothing.
export function useApi(path, { enabled = true } = {}) {
  const active = Boolean(path) && enabled;
  const [state, setState] = useState({ data: null, meta: null, loading: active, error: null });
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!active) return undefined;
    let alive = true;
    setState((s) => ({ ...s, loading: true, error: null }));
    api.get(path).then(
      (res) => { if (alive) setState({ data: res?.data ?? null, meta: res?.meta ?? null, loading: false, error: null }); },
      (error) => { if (alive) setState({ data: null, meta: null, loading: false, error }); },
    );
    return () => { alive = false; };
  }, [path, active, tick]);

  const refetch = useCallback(() => setTick((t) => t + 1), []);
  return { ...state, refetch };
}
