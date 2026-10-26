import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../api/client.js';

// Minimal terminal renderer: strips ANSI escape sequences and honours CR, LF
// and backspace so prompts and progress output read correctly. Resize is not
// forwarded; the shell is started with fixed COLUMNS/LINES.
const ESCAPES = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-?]*[ -/]*[@-~]|\x1b[()][AB012]|\x1b[=>78]|\x1b\[\?[0-9;]*[hl]/g;
const MAX_LINES = 2000;

export function feedLines(state, text) {
  const lines = state.lines.slice();
  let { col } = state;
  let line = lines.pop() ?? '';
  for (const ch of text.replace(ESCAPES, '')) {
    if (ch === '\n') { lines.push(line); line = ''; col = 0; } else if (ch === '\r') { col = 0; } else if (ch === '\b') { col = Math.max(0, col - 1); } else if (ch === '\x07' || ch === '\x0f' || ch === '\x0e') { /* bell / shift */ } else if (ch === '\t') {
      const next = (col + 8) & ~7;
      line = line.padEnd(next, ' ');
      col = next;
    } else {
      line = (line.padEnd(col, ' ').slice(0, col) + ch + line.slice(col + 1));
      col++;
    }
  }
  lines.push(line);
  return { lines: lines.length > MAX_LINES ? lines.slice(lines.length - MAX_LINES) : lines, col };
}

const KEYS = { Enter: '\r', Backspace: '\x7f', Tab: '\t', Escape: '\x1b', ArrowUp: '\x1b[A', ArrowDown: '\x1b[B', ArrowRight: '\x1b[C', ArrowLeft: '\x1b[D', Home: '\x1b[H', End: '\x1b[F', Delete: '\x1b[3~', PageUp: '\x1b[5~', PageDown: '\x1b[6~' };

export function keyToInput(e) {
  if (e.altKey || e.metaKey) return null;
  if (e.ctrlKey) {
    if (e.key.length === 1) {
      const code = e.key.toUpperCase().charCodeAt(0);
      if (code >= 64 && code <= 95) return String.fromCharCode(code - 64);
      if (e.key === ' ') return '\x00';
    }
    return KEYS[e.key] ?? null;
  }
  if (KEYS[e.key]) return KEYS[e.key];
  if (e.key.length === 1) return e.key;
  return null;
}

export function TerminalView({ session, onExit, onClosed }) {
  const [state, setState] = useState({ lines: [''], col: 0 });
  const [status, setStatus] = useState('connecting');
  const [notice, setNotice] = useState(null);
  const pending = useRef('');
  const inflight = useRef(false);
  const timer = useRef(null);
  const boxRef = useRef(null);
  const endRef = useRef(null);
  const id = session.id;

  useEffect(() => {
    setState({ lines: [''], col: 0 });
    const close = api.stream(`/server-config/terminal/${id}/stream`, (event) => {
      if (event.type === 'open') setStatus('connected');
      else if (event.type === 'output') setState((s) => feedLines(s, event.data));
      else if (event.type === 'notice') setNotice(event.message);
      else if (event.type === 'exit') { setStatus('exited'); setState((s) => feedLines(s, `\r\n[session ended${event.code != null ? ` with status ${event.code}` : event.message ? `: ${event.message}` : event.reason ? ` (${event.reason.replace(/_/g, ' ')})` : ''}]\r\n`)); onExit?.(event); }
      else if (event.type === 'error') { setStatus('error'); setNotice(event.message); }
    }, () => setStatus((s) => (s === 'exited' ? s : 'disconnected')));
    return close;
  }, [id, onExit]);

  useEffect(() => { endRef.current?.scrollIntoView({ block: 'end' }); }, [state]);

  const flush = useCallback(async () => {
    timer.current = null;
    if (inflight.current || !pending.current) return;
    const data = pending.current;
    pending.current = '';
    inflight.current = true;
    try { await api.post(`/server-config/terminal/${id}/input`, { data }); } catch (err) { setNotice(err.message); if (err.status === 404) { setStatus('exited'); onClosed?.(); } } finally { inflight.current = false; if (pending.current) flush(); }
  }, [id, onClosed]);

  // Keystrokes are coalesced for a few milliseconds so fast typing becomes a
  // handful of requests rather than one per key.
  const send = useCallback((text) => {
    if (!text || status === 'exited') return;
    pending.current += text;
    if (!timer.current) timer.current = setTimeout(flush, 40);
  }, [flush, status]);

  const onKeyDown = (e) => {
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'V' || e.key === 'v')) return;
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'C' || e.key === 'c')) return;
    const input = keyToInput(e);
    if (input == null) return;
    e.preventDefault();
    send(input);
  };
  const onPaste = (e) => { e.preventDefault(); send(e.clipboardData.getData('text')); };

  return (
    <div className="terminal-wrap">
      <div className="row-actions" style={{ justifyContent: 'space-between', marginBottom: 6 }}>
        <span className="muted">Session <code>{id.slice(0, 8)}</code> · PID {session.pid} · {status}{notice ? ` · ${notice}` : ''}</span>
        <span className="muted">Click the terminal and type. Ctrl+Shift+C / Ctrl+Shift+V copy and paste; Ctrl+C interrupts.</span>
      </div>
      <pre ref={boxRef} className="log terminal" tabIndex={0} role="textbox" aria-label="Terminal" aria-multiline="true" onKeyDown={onKeyDown} onPaste={onPaste} onClick={() => boxRef.current?.focus()}
        style={{ maxHeight: 'none', height: '60vh', minHeight: 320, outline: 'none', cursor: 'text', whiteSpace: 'pre', fontSize: 13, lineHeight: '18px' }}>
        {state.lines.join('\n')}<span style={{ background: '#d7e2ec', color: '#0b1117' }}>{status === 'exited' ? '' : ' '}</span>
        <div ref={endRef} />
      </pre>
    </div>
  );
}
