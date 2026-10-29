import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { MessageSquare, Send, Lock, Unlock, Search } from 'lucide-react';
import { api, queryString } from '../../api/client.js';
import { useApi } from '../../hooks/useApi.js';
import { useAuth } from '../../auth/AuthContext.jsx';
import { Card, EmptyState, Loading, StatusPill, formatDate } from '../../components/Common.jsx';
import { Textarea, Button, ErrorBanner } from '../../components/Form.jsx';
import { useToast } from '../../components/Toast.jsx';

export const MESSAGE_MAX_CHARS = 4000;
export const LIST_PAGE_SIZE = 200;

export const listPath = (q) => `/support/chat${queryString({ q, pageSize: LIST_PAGE_SIZE })}`;
export const conversationPath = (username) => `/support/account-conversations?account=${encodeURIComponent(username)}`;
export const conversationLabel = (row) => row.conversation?.subject || `Support for ${row.account.domain}`;

const dayOf = (value) => (value ? String(value).replace(' ', 'T').slice(0, 10) : '');

// Messages grouped by calendar day for the date separators.
export function groupByDay(messages) {
  const groups = [];
  for (const m of messages || []) {
    const day = dayOf(m.createdAt);
    const last = groups[groups.length - 1];
    if (last && last.day === day) last.messages.push(m);
    else groups.push({ day, messages: [m] });
  }
  return groups;
}

export function describeParty(side, viewerSide) {
  if (side === viewerSide) return 'you';
  return side === 'manager' ? 'your account manager' : 'the account';
}

function ManagerLine({ account }) {
  if (!account?.manager) return <span className="muted">No manager assigned yet</span>;
  const { username, role, email } = account.manager;
  return <span>Account manager: <strong>{username}</strong> <span className="muted">({role}{email ? ` · ${email}` : ''})</span></span>;
}

export function ConversationList({ rows, selected, onSelect, q, onSearch, loading, error, viewerSide }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      {viewerSide === 'manager' && (
        <div style={{ position: 'relative', padding: '10px 12px', borderBottom: '1px solid var(--border)' }}>
          <Search size={14} style={{ position: 'absolute', left: 22, top: 20, color: 'var(--text-muted)' }} />
          <input className="input" value={q} onChange={(e) => onSearch(e.target.value)} placeholder="Filter by user, domain, owner or subject" aria-label="Filter conversations" style={{ paddingLeft: 30 }} />
        </div>
      )}
      {error && <div style={{ padding: 12 }}><ErrorBanner error={error} /></div>}
      {loading && !rows.length && <Loading />}
      {!loading && !rows.length && <div style={{ padding: 16 }}><EmptyState title="No accounts to talk to" icon={MessageSquare}>{viewerSide === 'manager' ? 'Accounts you own or manage appear here.' : 'No hosting account is linked to this login.'}</EmptyState></div>}
      <ul role="listbox" aria-label="Conversations" style={{ listStyle: 'none', margin: 0, padding: 0, overflowY: 'auto', flex: 1 }}>
        {rows.map((row) => {
          const active = row.account.username === selected;
          const unread = row.conversation?.unread || 0;
          return (
            <li key={row.account.username} role="option" aria-selected={active}>
              <button type="button" onClick={() => onSelect(row.account.username)} className="link-button" style={{ display: 'block', width: '100%', textAlign: 'left', padding: '10px 12px', borderBottom: '1px solid var(--border)', background: active ? 'var(--primary-soft)' : 'transparent', borderLeft: active ? '3px solid var(--primary)' : '3px solid transparent', textDecoration: 'none', color: 'inherit', cursor: 'pointer' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'baseline' }}>
                  <strong style={{ fontWeight: unread ? 700 : 500 }}>{row.account.domain}</strong>
                  {unread > 0 && <span className="pill pill-info" title={`${unread} unread`}>{unread}</span>}
                  {!unread && row.conversation?.status === 'closed' && <StatusPill status="disabled">closed</StatusPill>}
                </div>
                <div className="muted" style={{ fontSize: 12, display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                  <span><code>{row.account.username}</code>{viewerSide === 'manager' && row.account.manager ? ` · manager ${row.account.manager.username}` : ''}</span>
                  <span>{row.conversation?.lastMessageAt ? formatDate(row.conversation.lastMessageAt) : 'no messages'}</span>
                </div>
                {row.conversation?.lastPreview && <div className="muted" style={{ fontSize: 12, marginTop: 2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{row.conversation.lastAuthor}: {row.conversation.lastPreview}</div>}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export function MessageList({ messages, viewerSide, endRef }) {
  if (!messages?.length) return <div style={{ padding: 24 }}><EmptyState title="No messages yet" icon={MessageSquare}>Write the first message below to start this conversation.</EmptyState></div>;
  return (
    <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 10 }}>
      {groupByDay(messages).map((g) => (
        <div key={g.day}>
          <div className="muted" style={{ textAlign: 'center', fontSize: 12, margin: '6px 0 10px' }}>{g.day}</div>
          {g.messages.map((m) => {
            const mine = m.side === viewerSide;
            return (
              <div key={m.id} style={{ display: 'flex', justifyContent: mine ? 'flex-end' : 'flex-start', marginBottom: 8 }}>
                <div style={{ maxWidth: '78%', background: mine ? 'var(--primary-soft)' : 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', padding: '8px 12px' }} title={formatDate(m.createdAt)}>
                  <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>
                    <strong style={{ color: 'var(--text)' }}>{m.author}</strong> · {m.authorRole === 'user' ? 'account' : m.authorRole} · {formatDate(m.createdAt)}
                  </div>
                  <div style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{m.body}</div>
                </div>
              </div>
            );
          })}
        </div>
      ))}
      {endRef && <div ref={endRef} />}
    </div>
  );
}

export function Composer({ onSend, disabled, status }) {
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState(null);
  const left = MESSAGE_MAX_CHARS - draft.length;
  const send = async () => {
    const body = draft.trim();
    if (!body || sending) return;
    setSending(true);
    setError(null);
    try { await onSend(body); setDraft(''); } catch (err) { setError(err); } finally { setSending(false); }
  };
  return (
    <div style={{ borderTop: '1px solid var(--border)', padding: 12 }}>
      <ErrorBanner error={error} />
      <Textarea value={draft} onChange={setDraft} rows={3} maxLength={MESSAGE_MAX_CHARS} disabled={disabled} aria-label="Message" placeholder={status === 'closed' ? 'This conversation is closed; sending a message reopens it.' : 'Write a message… (Ctrl+Enter to send)'}
        onKeyDown={(e) => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); send(); } }} />
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 8, gap: 8 }}>
        <span className={`muted ${left < 0 ? 'field-error' : ''}`} style={{ fontSize: 12 }}>{left.toLocaleString()} characters left</span>
        <Button variant="primary" icon={Send} loading={sending} disabled={disabled || !draft.trim()} onClick={send}>Send</Button>
      </div>
    </div>
  );
}

// One account's thread: snapshot + live updates over the SSE stream, the
// composer, and close/reopen for the manager side.
export function ChatThread({ username, onActivity }) {
  const toast = useToast();
  const [thread, setThread] = useState(null);
  const [error, setError] = useState(null);
  const endRef = useRef(null);
  const sideRef = useRef(null);
  const activityRef = useRef(onActivity);
  activityRef.current = onActivity;
  const markRead = useCallback(() => api.post(`/support/chat/${encodeURIComponent(username)}/read`).then(() => activityRef.current?.()).catch(() => {}), [username]);

  useEffect(() => {
    setThread(null);
    setError(null);
    sideRef.current = null;
    let open = true;
    const applySnapshot = (data) => {
      sideRef.current = data.viewerSide;
      setThread((t) => t || { account: data.account, conversation: data.conversation, messages: data.messages, viewerSide: data.viewerSide, canModerate: data.canModerate, hasMore: data.hasMore });
      if (data.conversation?.unread > 0) markRead();
    };
    const close = api.stream(`/support/chat/${encodeURIComponent(username)}/stream`, (event) => {
      if (!open) return;
      if (event.type === 'snapshot') {
        applySnapshot(event);
      } else if (event.type === 'message') {
        setThread((t) => (t ? { ...t, conversation: { ...(t.conversation || {}), ...event.conversation }, messages: t.messages.some((m) => m.id === event.message.id) ? t.messages : [...t.messages, event.message] } : t));
        if (sideRef.current && event.message.side !== sideRef.current) markRead();
        activityRef.current?.();
      } else if (event.type === 'status') {
        setThread((t) => (t ? { ...t, conversation: { ...(t.conversation || {}), status: event.status, subject: event.subject } } : t));
        activityRef.current?.();
      }
    });
    // The stream carries the snapshot; a plain fetch covers hosts whose proxy buffers SSE.
    api.get(`/support/chat/${encodeURIComponent(username)}?limit=100`).then(({ data }) => { if (open) applySnapshot(data); }).catch((err) => { if (open) setError(err); });
    return () => { open = false; close(); };
  }, [username, markRead]);

  useEffect(() => { endRef.current?.scrollIntoView({ block: 'end' }); }, [thread?.messages?.length]);

  const send = async (body) => {
    const { data } = await api.post(`/support/chat/${encodeURIComponent(username)}/messages`, { body });
    setThread((t) => (t ? { ...t, conversation: data.conversation, messages: t.messages.some((m) => m.id === data.message.id) ? t.messages : [...t.messages, data.message] } : t));
    onActivity?.();
  };

  const setStatus = async (status) => {
    try {
      const { data } = await api.patch(`/support/chat/${encodeURIComponent(username)}`, { status });
      setThread((t) => (t ? { ...t, conversation: data } : t));
      toast.success(status === 'closed' ? 'Conversation closed' : 'Conversation reopened');
      onActivity?.();
    } catch (err) { toast.error(err); }
  };

  const loadOlder = async () => {
    const first = thread?.messages?.[0];
    if (!first) return;
    try {
      const { data } = await api.get(`/support/chat/${encodeURIComponent(username)}?limit=100&before=${first.id}`);
      setThread((t) => (t ? { ...t, messages: [...data.messages, ...t.messages], hasMore: data.hasMore } : t));
    } catch (err) { toast.error(err); }
  };

  if (error) return <div style={{ padding: 16 }}><ErrorBanner error={error} /></div>;
  if (!thread) return <Loading text="Opening conversation…" />;
  const { account, conversation } = thread;
  const closed = conversation?.status === 'closed';
  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0, height: '100%' }}>
      <header style={{ padding: '12px 16px', borderBottom: '1px solid var(--border)', display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        <div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <strong>{conversation?.subject || `Support for ${account.domain}`}</strong>
            <StatusPill status={closed ? 'disabled' : 'active'}>{closed ? 'closed' : 'open'}</StatusPill>
            {account.suspended && <StatusPill status="suspended">account suspended</StatusPill>}
          </div>
          <div className="muted" style={{ fontSize: 12 }}>
            <code>{account.username}</code> · {account.domain} · owner {account.owner} · <ManagerLine account={account} />
          </div>
        </div>
        {thread.canModerate && (
          <div className="row-actions">
            {closed
              ? <Button size="sm" icon={Unlock} onClick={() => setStatus('open')}>Reopen</Button>
              : <Button size="sm" icon={Lock} onClick={() => setStatus('closed')}>Close</Button>}
          </div>
        )}
      </header>
      <div style={{ flex: 1, overflowY: 'auto', minHeight: 240, maxHeight: '55vh' }}>
        {thread.hasMore && <div style={{ textAlign: 'center', padding: 8 }}><Button size="sm" onClick={loadOlder}>Load earlier messages</Button></div>}
        <MessageList messages={thread.messages} viewerSide={thread.viewerSide} endRef={endRef} />
      </div>
      <Composer onSend={send} status={conversation?.status} />
    </div>
  );
}

// List on the left, thread on the right; ?account= deep-links a thread.
export function ChatWorkspace() {
  const { user } = useAuth();
  const [params, setParams] = useSearchParams();
  const selected = params.get('account') || '';
  const [q, setQ] = useState('');
  const { data, meta, loading, error, refetch } = useApi(listPath(q), { refreshMs: 60_000 });
  const rows = useMemo(() => data || [], [data]);
  const viewerSide = meta?.viewerSide || (user?.role === 'user' ? 'account' : 'manager');
  const refetchRef = useRef(refetch);
  refetchRef.current = refetch;
  const onActivity = useCallback(() => refetchRef.current(true), []);
  const select = useCallback((username) => setParams(username ? { account: username } : {}), [setParams]);

  useEffect(() => {
    if (!selected && viewerSide === 'account' && rows.length === 1) select(rows[0].account.username);
  }, [selected, viewerSide, rows, select]);

  const current = rows.find((r) => r.account.username === selected);
  return (
    <>
      {viewerSide === 'account' && rows[0] && (
        <Card>
          <p style={{ margin: 0 }}><ManagerLine account={rows[0].account} /> — write here for anything about <strong>{rows[0].account.domain}</strong>; the manager is notified and answers in this thread.</p>
        </Card>
      )}
      <Card padded={false}>
        <div style={{ display: 'flex', flexWrap: 'wrap', minHeight: 420 }}>
          <aside style={{ flex: '0 0 320px', maxWidth: '100%', borderRight: '1px solid var(--border)' }} aria-label="Conversation list">
            <ConversationList rows={rows} selected={selected} onSelect={select} q={q} onSearch={setQ} loading={loading} error={error} viewerSide={viewerSide} />
          </aside>
          <section style={{ flex: '1 1 420px', minWidth: 0 }}>
            {selected
              ? <ChatThread key={selected} username={selected} onActivity={onActivity} />
              : (
                <div style={{ padding: 24 }}>
                  <EmptyState title="Select a conversation" icon={MessageSquare}>
                    {viewerSide === 'manager' ? <span>Each hosting account has one thread shared by root, its owner and its manager. Assign managers under <Link to="/account-functions/modify-an-account">Modify an Account</Link>.</span> : 'Your conversation opens automatically once your account is linked.'}
                  </EmptyState>
                </div>
              )}
          </section>
        </div>
      </Card>
      {current && viewerSide === 'manager' && current.account.manager?.username !== user?.username && user?.role !== 'root' && (
        <p className="muted" style={{ fontSize: 12 }}>You see this thread as the account's owner; its manager is {current.account.manager?.username || 'not assigned'}.</p>
      )}
    </>
  );
}
