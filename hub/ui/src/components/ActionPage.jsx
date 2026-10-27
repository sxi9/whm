import { useState } from 'react';
import { PageHeader, Card, StatusPill, CapabilityNotice } from './Common.jsx';
import { Button, ErrorBanner } from './Form.jsx';
import { useToast } from './Toast.jsx';
import { useConfirm } from './Modal.jsx';

// A described action with one button and a result panel. Used for restarts,
// rebuilds, reboots and other "do the thing" functions.
export function ActionPage({ fn, title, description, buttonLabel = 'Run', danger = false, confirmMessage, typeToConfirm, run, renderResult, children, status, crumbs, home }) {
  const toast = useToast();
  const confirm = useConfirm();
  const [state, setState] = useState({ loading: false, result: null, error: null });

  const go = async () => {
    if (confirmMessage) {
      const ok = await confirm({ title: title || fn?.label, message: confirmMessage, danger, confirmLabel: buttonLabel, typeToConfirm });
      if (!ok) return;
    }
    setState({ loading: true, result: null, error: null });
    try {
      const result = await run();
      setState({ loading: false, result, error: null });
      toast.success(`${title || fn?.label}: completed`);
    } catch (error) {
      setState({ loading: false, result: null, error });
      toast.error(error);
    }
  };

  return (
    <>
      <PageHeader fn={fn} title={title} description={description} crumbs={crumbs} home={home} />
      <Card>
        {status && <div className="action-status">{status}</div>}
        {children}
        <div className="action-row">
          <Button variant={danger ? 'danger' : 'primary'} loading={state.loading} onClick={go}>{buttonLabel}</Button>
        </div>
        <CapabilityNotice error={state.error} />
        {state.error && state.error.code !== 'capability_missing' && <ErrorBanner error={state.error} />}
        {state.result && (
          <div className="action-result">
            {renderResult ? renderResult(state.result) : (
              <>
                <StatusPill status="ok">Done</StatusPill>
                <pre className="log">{typeof state.result === 'string' ? state.result : JSON.stringify(state.result, null, 2)}</pre>
              </>
            )}
          </div>
        )}
      </Card>
    </>
  );
}
