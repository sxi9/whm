import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../api/client.js';

// Minimal terminal renderer: strips ANSI escape sequences (honouring only
// erase-in-line and clear-screen) and handles CR, LF, tab and backspace so
// prompts and progress output read correctly. Resize is not forwarded; the
// shell is started with fixed COLUMNS/LINES.
const ESCAPES = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-?]*[ -/]*[@-~]|\x1b[()][AB012]|\x1b[=>78]|\x1b\[\?[0-9;]*[hl]/g;
// An escape sequence the chunk boundary cut in two is held until the rest arrives.
const PARTIAL_ESCAPE = /\x1b(?:\[[0-?]*[ -/]*|\][^\x07\x1b]{0,255}|[()])?$/;
const ERASE = /^\x1b\[(\d*)([KJ])$/;
const MAX_LINES = 2000;
const MAX_COLS = 4096;
const INPUT_BATCH_MS = 16;
const OUTPUT_QUEUE_LIMIT = 256 * 1024;

// The screen buffer is mutated in place and painted by paintScreen, which only
// rewrites the lines from dirtyFrom onwards; `dropped` counts lines trimmed off
// the top since the last paint and `cleared` marks a full reset.
export function createScreen(maxLines = MAX_LINES) {
  return { lines: [''], col: 0, dirtyFrom: 0, dropped: 0, cleared: false, held: '', maxLines };
}

function putChars(screen, text) {
  const { lines } = screen;
  let i = lines.length - 1;
  let line = lines[i];
  let { col } = screen;
  screen.dirtyFrom = Math.min(screen.dirtyFrom, i);
  const newline = () => { lines[i] = line; lines.push(''); i++; line = ''; col = 0; };
  for (const ch of text) {
    if (ch === '\n') newline();
    else if (ch === '\r') col = 0;
    else if (ch === '\b') col = Math.max(0, col - 1);
    else if (ch === '\x07' || ch === '\x0f' || ch === '\x0e') { /* bell / shift */ } else if (ch === '\t') {
      const next = (col + 8) & ~7;
      line = line.padEnd(next, ' ');
      col = next;
    } else {
      if (col >= MAX_COLS) newline();
      if (col === line.length) line += ch;
      else line = line.padEnd(col, ' ').slice(0, col) + ch + line.slice(col + 1);
      col++;
    }
  }
  lines[i] = line;
  screen.col = col;
}

function control(screen, seq) {
  const m = ERASE.exec(seq);
  if (!m) return;
  const { lines } = screen;
  const i = lines.length - 1;
  if (m[2] === 'K') {
    const mode = m[1] || '0';
    const line = lines[i];
    if (mode === '0') lines[i] = line.slice(0, screen.col);
    else if (mode === '1') lines[i] = ' '.repeat(Math.min(screen.col + 1, line.length)) + line.slice(screen.col + 1);
    else if (mode === '2') lines[i] = '';
    screen.dirtyFrom = Math.min(screen.dirtyFrom, i);
  } else if (m[1] === '2' || m[1] === '3') {
    lines.length = 0;
    lines.push('');
    screen.col = 0;
    screen.dirtyFrom = 0;
    screen.dropped = 0;
    screen.cleared = true;
  }
}

export function feedScreen(screen, chunk) {
  let text = screen.held + chunk;
  screen.held = '';
  const cut = PARTIAL_ESCAPE.exec(text);
  if (cut) { screen.held = cut[0]; text = text.slice(0, -cut[0].length); }
  if (!text) return screen;
  ESCAPES.lastIndex = 0;
  let pos = 0;
  let m;
  while ((m = ESCAPES.exec(text))) {
    if (m.index > pos) putChars(screen, text.slice(pos, m.index));
    control(screen, m[0]);
    pos = m.index + m[0].length;
  }
  if (pos < text.length) putChars(screen, text.slice(pos));
  const { lines } = screen;
  if (lines.length > screen.maxLines) {
    const n = lines.length - screen.maxLines;
    lines.splice(0, n);
    screen.dropped += n;
    screen.dirtyFrom = Math.max(0, screen.dirtyFrom - n);
  }
  return screen;
}

// One text node per line; only nodes from dirtyFrom on are touched.
export function paintScreen(screen, el) {
  const { lines } = screen;
  const nodes = el.childNodes;
  if (screen.cleared) { el.textContent = ''; screen.cleared = false; }
  while (screen.dropped > 0 && nodes.length) { el.removeChild(el.firstChild); screen.dropped--; }
  screen.dropped = 0;
  while (nodes.length > lines.length) el.removeChild(el.lastChild);
  const last = lines.length - 1;
  for (let i = Math.min(screen.dirtyFrom, nodes.length); i <= last; i++) {
    const data = i < last ? `${lines[i]}\n` : lines[i];
    const node = nodes[i];
    if (!node) el.appendChild(document.createTextNode(data));
    else if (node.data !== data) node.data = data;
  }
  screen.dirtyFrom = last;
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

// Anything but a single printable character (Enter, arrows, control keys,
// escape sequences, pasted text) is sent without waiting for the input batch.
export function isUrgent(input) {
  return input.length !== 1 || input.charCodeAt(0) < 0x20 || input === '\x7f';
}

const schedule = (fn) => (typeof requestAnimationFrame === 'function' ? requestAnimationFrame(fn) : setTimeout(fn, 16));
const unschedule = (handle) => (typeof cancelAnimationFrame === 'function' ? cancelAnimationFrame(handle) : clearTimeout(handle));

export function TerminalView({ session, onExit, onClosed }) {
  const [status, setStatus] = useState('connecting');
  const [notice, setNotice] = useState(null);
  const screen = useRef(createScreen());
  const queued = useRef('');
  const frame = useRef(null);
  const stick = useRef(true);
  const pending = useRef('');
  const inflight = useRef(false);
  const timer = useRef(null);
  const boxRef = useRef(null);
  const outRef = useRef(null);
  const id = session.id;

  const paint = useCallback(() => {
    frame.current = null;
    const text = queued.current;
    queued.current = '';
    if (text) feedScreen(screen.current, text);
    const el = outRef.current;
    const box = boxRef.current;
    if (!el || !box) return;
    const follow = stick.current || box.scrollHeight - box.scrollTop - box.clientHeight < 40;
    paintScreen(screen.current, el);
    if (follow) { box.scrollTop = box.scrollHeight; stick.current = false; }
  }, []);

  // Output is parsed as it arrives but painted once per animation frame.
  const write = useCallback((text) => {
    queued.current += text;
    if (queued.current.length > OUTPUT_QUEUE_LIMIT) { feedScreen(screen.current, queued.current); queued.current = ''; }
    if (frame.current == null) frame.current = schedule(paint);
  }, [paint]);

  useEffect(() => {
    screen.current = createScreen();
    queued.current = '';
    stick.current = true;
    if (outRef.current) outRef.current.textContent = '';
    const close = api.stream(`/server-config/terminal/${id}/stream`, (event) => {
      if (event.type === 'open') setStatus('connected');
      else if (event.type === 'output') write(event.data);
      else if (event.type === 'notice') setNotice(event.message);
      else if (event.type === 'exit') { setStatus('exited'); write(`\r\n[session ended${event.code != null ? ` with status ${event.code}` : event.message ? `: ${event.message}` : event.reason ? ` (${event.reason.replace(/_/g, ' ')})` : ''}]\r\n`); onExit?.(event); }
      else if (event.type === 'error') { setStatus('error'); setNotice(event.message); }
    }, () => setStatus((s) => (s === 'exited' ? s : 'disconnected')));
    return () => { close(); if (frame.current != null) { unschedule(frame.current); frame.current = null; } };
  }, [id, onExit, write]);

  const flush = useCallback(async () => {
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    if (inflight.current || !pending.current) return;
    const data = pending.current;
    pending.current = '';
    inflight.current = true;
    try { await api.post(`/server-config/terminal/${id}/input`, { data }); } catch (err) { setNotice(err.message); if (err.status === 404) { setStatus('exited'); onClosed?.(); } } finally { inflight.current = false; if (pending.current) flush(); }
  }, [id, onClosed]);

  // Printable characters typed in quick succession travel together (at most
  // one request per 16 ms); Enter, arrows and control keys go out at once.
  const send = useCallback((text) => {
    if (!text || status === 'exited') return;
    pending.current += text;
    stick.current = true;
    if (isUrgent(text)) flush();
    else if (!timer.current) timer.current = setTimeout(flush, INPUT_BATCH_MS);
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
        <span ref={outRef} /><span style={{ background: '#d7e2ec', color: '#0b1117' }}>{status === 'exited' ? '' : ' '}</span>
      </pre>
    </div>
  );
}
