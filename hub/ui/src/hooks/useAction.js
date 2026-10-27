import { useCallback, useState } from 'react';
import { useToast } from '../components/Toast.jsx';

// run(fn, { success, then }) wraps a mutating call: busy flag, toast on
// success, error toast + state on failure. Returns the result or null.
export function useAction() {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const run = useCallback(async (fn, { success = null, then = null, silent = false } = {}) => {
    setBusy(true);
    setError(null);
    try {
      const result = await fn();
      if (success) toast.success(typeof success === 'function' ? success(result) : success);
      await then?.(result);
      return result;
    } catch (err) {
      setError(err);
      if (!silent) toast.error(err);
      return null;
    } finally {
      setBusy(false);
    }
  }, [toast]);
  return { run, busy, error, clearError: () => setError(null) };
}
