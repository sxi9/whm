import { useCallback, useEffect, useRef, useState } from 'react';
import { RefreshCw, Power } from 'lucide-react';
import '@xterm/xterm/css/xterm.css';
import { Card, StatusPill } from '../../../components/Common.jsx';
import { Button } from '../../../components/Form.jsx';
import { useT } from '../../../i18n/useT.js';
import { fill, untranslated } from '../../../i18n/fill.js';
import { PanelPage, PanelCapabilityState } from '../../../panel/PanelPage.jsx';
import { usePanelMe, panelApi } from '../../../panel/hooks/usePanel.js';
import { ApiError } from '../../../api/client.js';

// Terminal (contract §68): a login shell of the account, opened by
// POST /api/panel/terminal/sessions and attached over the WebSocket at
// /api/panel/terminal/ws?token= (single-use token, same session cookie). The
// bridge serves one client per session, so "Reconnect" always opens a new shell.
export const WS_PATH = '/api/panel/terminal/ws';
export const CLOSE_CODES = { unauthorized: 4401, forbidden: 4403, notFound: 4404, busy: 4409, ended: 4410, loggedOut: 4440 };
const TERM_HEIGHT = 480;

export const wsUrl = (loc, token) => `${loc.protocol === 'https:' ? 'wss' : 'ws'}://${loc.host}${WS_PATH}?token=${encodeURIComponent(token)}`;

// The plan says it before the API has to: has_shell false is the "not in your plan" state.
export const shellDisabledError = (me, t = untranslated) => (me?.account?.plan && me.account.plan.has_shell === false
  ? new ApiError(501, { error: { code: 'shell_disabled', message: t('panel.terminal.no_shell', 'Shell access is not included in your plan, so the terminal cannot be opened.') } })
  : null);

export function closeReason(code, t = untranslated) {
  if (code === CLOSE_CODES.loggedOut) return t('panel.terminal.closed_logout', 'Your panel session ended, so the terminal was closed.');
  if (code === CLOSE_CODES.busy) return t('panel.terminal.closed_busy', 'This terminal is already open in another tab.');
  if (code === CLOSE_CODES.ended || code === 1000 || code === 1005) return t('panel.terminal.closed_ended', 'The shell has ended.');
  if (code === CLOSE_CODES.unauthorized || code === CLOSE_CODES.forbidden || code === CLOSE_CODES.notFound) return t('panel.terminal.closed_refused', 'The connection was refused; open a new terminal.');
  return fill(t('panel.terminal.closed_other', 'The connection was lost (code {code}).'), { code });
}

export const statusTone = (status) => ({ connected: 'ok', connecting: 'warn', closed: 'unknown', error: 'error' }[status] || 'unknown');

export default function TerminalPage({ fn }) {
  const { t } = useT();
  const { me } = usePanelMe();
  const planError = shellDisabledError(me, t);
  const host = useRef(null);
  const term = useRef(null);
  const fit = useRef(null);
  const ws = useRef(null);
  const [status, setStatus] = useState('closed');
  const [error, setError] = useState(null);
  const [note, setNote] = useState(null);
  const [session, setSession] = useState(null);
  const [copied, setCopied] = useState(false);

  const disconnect = useCallback(async (closeSession = true) => {
    const sock = ws.current;
    ws.current = null;
    try { sock?.close(1000, 'bye'); } catch { /* closed */ }
    if (closeSession && session?.id) { try { await panelApi.delete(`/terminal/sessions/${session.id}`); } catch { /* ended already */ } }
    setSession(null);
    setStatus('closed');
  }, [session]);

  const connect = useCallback(async () => {
    if (planError || !host.current) return;
    await disconnect(true);
    setError(null);
    setNote(null);
    setStatus('connecting');
    try {
      if (!term.current) {
        const [{ Terminal }, { FitAddon }] = await Promise.all([import('@xterm/xterm'), import('@xterm/addon-fit')]);
        const tm = new Terminal({ cursorBlink: true, fontSize: 14, scrollback: 5000, allowProposedApi: false });
        const fa = new FitAddon();
        tm.loadAddon(fa);
        tm.open(host.current);
        tm.onData((data) => { if (ws.current?.readyState === 1) ws.current.send(JSON.stringify({ type: 'input', data })); });
        tm.onResize(({ cols, rows }) => { if (ws.current?.readyState === 1) ws.current.send(JSON.stringify({ type: 'resize', cols, rows })); });
        term.current = tm;
        fit.current = fa;
      }
      fit.current.fit();
      term.current.reset();
      term.current.focus();
      const res = await panelApi.post('/terminal/sessions', { cols: term.current.cols, rows: term.current.rows });
      const s = res.data;
      setSession(s);
      const sock = new WebSocket(wsUrl(window.location, s.wsToken));
      sock.binaryType = 'arraybuffer';
      ws.current = sock;
      sock.onmessage = (ev) => {
        if (typeof ev.data === 'string') {
          let msg = null;
          try { msg = JSON.parse(ev.data); } catch { msg = null; }
          if (msg?.type === 'ready') { setStatus('connected'); term.current?.focus(); }
          return;
        }
        term.current?.write(new Uint8Array(ev.data));
      };
      sock.onclose = (ev) => {
        if (ws.current === sock) ws.current = null;
        setStatus('closed');
        setNote(closeReason(ev.code, t));
        term.current?.write(`\r\n\x1b[2m[${closeReason(ev.code, t)}]\x1b[0m\r\n`);
      };
      sock.onerror = () => { setStatus('error'); };
    } catch (err) {
      setStatus('error');
      setError(err);
    }
  }, [planError, disconnect, t]);

  useEffect(() => {
    if (planError) return undefined;
    connect();
    const onResize = () => { try { fit.current?.fit(); } catch { /* not mounted */ } };
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      const sock = ws.current;
      ws.current = null;
      try { sock?.close(1000, 'bye'); } catch { /* closed */ }
      try { term.current?.dispose(); } catch { /* already disposed */ }
      term.current = null;
    };
    // The page opens one shell when it mounts; later shells come from the Reconnect button.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [Boolean(planError)]);

  const copySelection = async () => {
    const text = term.current?.getSelection?.() || '';
    if (!text) return;
    try { await navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* clipboard blocked */ }
  };

  const shown = planError || error;
  const actions = !planError && (
    <>
      <Button icon={RefreshCw} onClick={connect} loading={status === 'connecting'}>{t('panel.terminal.reconnect', 'Reconnect')}</Button>
      <Button icon={Power} onClick={() => disconnect(true)} disabled={status === 'closed'}>{t('panel.terminal.disconnect', 'Disconnect')}</Button>
    </>
  );

  return (
    <PanelPage fn={fn} actions={actions}>
      {shown && <PanelCapabilityState error={shown} onRetry={error ? connect : undefined} card />}
      {!planError && (
        <Card
          title={t('panel.terminal.title', 'Shell')}
          subtitle={session ? fill(t('panel.terminal.session', 'Session {id} as {user}'), { id: String(session.id).slice(0, 8), user: me?.account?.username || '' }) : t('panel.terminal.no_session', 'No shell is open.')}
          actions={<StatusPill status={statusTone(status)}>{t(`panel.terminal.status_${status}`, { connected: 'Connected', connecting: 'Connecting', closed: 'Disconnected', error: 'Failed' }[status])}</StatusPill>}
          padded={false}
        >
          <div ref={host} className="terminal-host" style={{ height: TERM_HEIGHT, padding: 8 }} aria-label={t('panel.terminal.aria', 'Terminal')} />
          <div className="card-body">
            {note && <p className="muted">{note}</p>}
            <p className="muted">
              {t('panel.terminal.paste_hint', 'Copy: select text, then press Ctrl+Shift+C (Cmd+C on a Mac) or use the button. Paste: Ctrl+Shift+V (Cmd+V on a Mac) or right-click.')}
              {' '}
              <button type="button" className="btn btn-sm" onClick={copySelection}>{copied ? t('panel.terminal.copied', 'Copied') : t('panel.terminal.copy', 'Copy selection')}</button>
            </p>
            <p className="muted">{t('panel.terminal.limits', 'A shell closes after 15 minutes without activity and after 4 hours at most. Every open and close is recorded; what you type is not.')}</p>
          </div>
        </Card>
      )}
    </PanelPage>
  );
}
