import { useCallback, useState } from 'react';
import { api } from '../../../api/client.js';
import { useApi } from '../../../hooks/useApi.js';
import { PageHeader, Card, Loading, StatusPill, formatDate } from '../../../components/Common.jsx';
import { Button } from '../../../components/Form.jsx';
import { useToast } from '../../../components/Toast.jsx';
import { useConfirm } from '../../../components/Modal.jsx';
import { RequestError } from '../../server-configuration/Shared.jsx';
import { TerminalView } from '../../server-configuration/TerminalView.jsx';

export default function Terminal({ fn }) {
  const toast = useToast();
  const confirm = useConfirm();
  const { data, loading, error, refetch } = useApi('/server-config/terminal');
  const [active, setActive] = useState(null);
  const [openError, setOpenError] = useState(null);
  const [busy, setBusy] = useState(false);

  const open = async () => {
    setBusy(true); setOpenError(null);
    try { const { data: s } = await api.post('/server-config/terminal', { shell: '/bin/bash' }); setActive(s); refetch(); } catch (err) { if (err.status === 501) setOpenError(err); else toast.error(err); } finally { setBusy(false); }
  };
  const close = async (s) => {
    if (!(await confirm({ title: 'Close this terminal session?', message: 'The shell and anything running in the foreground receive SIGHUP.', confirmLabel: 'Close session', danger: true }))) return;
    try { await api.delete(`/server-config/terminal/${s.id}`); if (active?.id === s.id) setActive(null); refetch(); } catch (err) { if (err.status !== 404) toast.error(err); else { setActive(null); refetch(); } }
  };
  const onExit = useCallback(() => refetch(), [refetch]);
  const onClosed = useCallback(() => { setActive(null); refetch(); }, [refetch]);

  return (
    <>
      <PageHeader fn={fn} description="A root shell on this server inside the browser. Sessions are audited when opened and closed, belong to the administrator who opened them and expire after a period of inactivity." actions={<Button variant="primary" loading={busy} onClick={open} disabled={data && data.installed === false}>New session</Button>} />
      <RequestError error={error} onRetry={refetch} />
      <RequestError error={openError} onRetry={() => { setOpenError(null); refetch(); }} />
      {loading && !data && <Loading />}
      {data && data.installed === false && !openError && <RequestError error={{ status: 501, code: 'capability_missing', message: 'The "script" utility (util-linux) is required for the in-browser terminal and was not found on this server.' }} onRetry={refetch} />}
      {active && (
        <Card title="Terminal" actions={<Button size="sm" variant="danger" onClick={() => close(active)}>Close session</Button>}>
          <TerminalView session={active} onExit={onExit} onClosed={onClosed} />
        </Card>
      )}
      {data && (
        <Card title="Your sessions" subtitle={`Up to ${data.maxSessions} at once; a session ends after ${data.idleMinutes} minutes without input or output, even while a tab is attached. Full-screen programs get the window size requested when the session opened.`} padded={false}>
          <div className="table-wrap"><table>
            <thead><tr><th>Session</th><th>Shell</th><th>Started</th><th>Last activity</th><th>Viewers</th><th /></tr></thead>
            <tbody>
              {data.sessions.length === 0 && <tr><td colSpan={6} className="table-state">No open sessions.</td></tr>}
              {data.sessions.map((s) => (
                <tr key={s.id}>
                  <td><code>{s.id.slice(0, 12)}</code> {active?.id === s.id && <StatusPill status="active">attached</StatusPill>}<br /><small className="muted">PID {s.pid}</small></td>
                  <td>{s.shell}</td>
                  <td>{formatDate(s.startedAt)}</td>
                  <td>{formatDate(s.lastActivity)}</td>
                  <td>{s.viewers}</td>
                  <td className="actions-col"><div className="row-actions">{active?.id !== s.id && <Button size="sm" onClick={() => setActive(s)}>Attach</Button>}<Button size="sm" variant="danger" onClick={() => close(s)}>Close</Button></div></td>
                </tr>
              ))}
            </tbody>
          </table></div>
        </Card>
      )}
    </>
  );
}
