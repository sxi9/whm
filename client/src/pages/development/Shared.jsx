import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Copy, Check, Download } from 'lucide-react';
import { api } from '../../api/client.js';
import { useApi } from '../../hooks/useApi.js';
import { Card, StatusPill, Loading, KeyValue, formatDate } from '../../components/Common.jsx';
import { Button, ErrorBanner } from '../../components/Form.jsx';
import { useToast } from '../../components/Toast.jsx';

export { RequestError, Tabs, isCapabilityError } from '../security/Shared.jsx';

export function downloadBytes(filename, bytes, type = 'application/octet-stream') {
  const blob = new Blob([bytes], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function downloadText(filename, text, type = 'text/plain') { downloadBytes(filename, text, `${type};charset=utf-8`); }

export function downloadBase64(filename, base64, type) {
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  downloadBytes(filename, bytes, type);
}

export function CopyButton({ text, label = 'Copy', size = 'sm' }) {
  const [done, setDone] = useState(false);
  const copy = async () => {
    try { await navigator.clipboard.writeText(text); setDone(true); setTimeout(() => setDone(false), 1500); } catch { /* clipboard blocked */ }
  };
  return <Button size={size} icon={done ? Check : Copy} onClick={copy}>{done ? 'Copied' : label}</Button>;
}

const METHOD_TONE = { GET: 'ok', POST: 'info', PUT: 'warning', PATCH: 'warning', DELETE: 'failed' };
export function MethodPill({ method }) { return <StatusPill status={METHOD_TONE[method] || 'unknown'}>{method}</StatusPill>; }

export function RolePill({ role }) {
  const map = { root: ['failed', 'root only'], reseller: ['warning', 'root + reseller'], any: ['ok', 'any principal'] };
  const [tone, text] = map[role] || ['unknown', role];
  return <StatusPill status={tone}>{text}</StatusPill>;
}

export function ScopePills({ scopes }) {
  if (!scopes?.length) return <span className="muted">inherits user role</span>;
  return <>{scopes.map((s) => <code key={s} style={{ marginRight: 4 }}>{s}</code>)}</>;
}

export function Stat({ label, value, hint }) {
  return <div className="stat"><div className="label">{label}</div><div className="value">{value ?? '—'}</div>{hint && <div className="small muted">{hint}</div>}</div>;
}

// Tiny markdown renderer (headings, paragraphs, lists, fences, quotes, tables,
// inline code/bold/links) so BLUEPRINT sections read well without a dependency.
export function Markdown({ text, baseSlugs = true }) {
  const blocks = useMemo(() => parseMarkdown(text || ''), [text]);
  return <div className="markdown">{blocks.map((b, i) => <Block key={i} block={b} baseSlugs={baseSlugs} />)}</div>;
}

function slugify(s) { return s.toLowerCase().replace(/[*`]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''); }

export function parseMarkdown(text) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (/^```/.test(line)) {
      const lang = line.slice(3).trim();
      const body = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) body.push(lines[i++]);
      i++;
      blocks.push({ type: 'code', lang, text: body.join('\n') });
      continue;
    }
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) { blocks.push({ type: 'heading', level: h[1].length, text: h[2].trim() }); i++; continue; }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { blocks.push({ type: 'hr' }); i++; continue; }
    if (/^\|/.test(line)) {
      const rows = [];
      while (i < lines.length && /^\|/.test(lines[i])) rows.push(lines[i++]);
      const cells = rows.filter((r) => !/^\|\s*:?-{2,}/.test(r)).map((r) => r.replace(/^\||\|$/g, '').split('|').map((c) => c.trim()));
      blocks.push({ type: 'table', head: cells[0] || [], rows: cells.slice(1) });
      continue;
    }
    if (/^>\s?/.test(line)) {
      const body = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) body.push(lines[i++].replace(/^>\s?/, ''));
      blocks.push({ type: 'quote', text: body.join(' ') });
      continue;
    }
    if (/^\s*([-*+]|\d+\.)\s+/.test(line)) {
      const items = [];
      const ordered = /^\s*\d+\./.test(line);
      while (i < lines.length && (/^\s*([-*+]|\d+\.)\s+/.test(lines[i]) || (/^\s{2,}\S/.test(lines[i]) && items.length))) {
        if (/^\s*([-*+]|\d+\.)\s+/.test(lines[i])) items.push(lines[i].replace(/^\s*([-*+]|\d+\.)\s+/, ''));
        else items[items.length - 1] += ' ' + lines[i].trim();
        i++;
      }
      blocks.push({ type: 'list', ordered, items });
      continue;
    }
    if (!line.trim()) { i++; continue; }
    const para = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,6}\s|```|\||>|\s*([-*+]|\d+\.)\s)/.test(lines[i])) para.push(lines[i++].trim());
    blocks.push({ type: 'p', text: para.join(' ') });
  }
  return blocks;
}

function Inline({ text }) {
  const parts = [];
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\[[^\]]+\]\([^)]+\))/g;
  let last = 0; let m; let k = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    if (m[1]) parts.push(<code key={k++}>{m[1].slice(1, -1)}</code>);
    else if (m[2]) parts.push(<strong key={k++}>{m[2].slice(2, -2)}</strong>);
    else if (m[3]) {
      const lm = m[3].match(/^\[([^\]]+)\]\(([^)]+)\)$/);
      const href = lm[2];
      parts.push(/^https?:/.test(href) ? <a key={k++} href={href} target="_blank" rel="noreferrer">{lm[1]}</a> : <span key={k++}>{lm[1]} <code>{href}</code></span>);
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return <>{parts}</>;
}

function Block({ block, baseSlugs }) {
  switch (block.type) {
    case 'heading': { const Tag = `h${Math.min(6, block.level + 1)}`; return <Tag id={baseSlugs ? slugify(block.text) : undefined} style={{ marginTop: block.level <= 2 ? 22 : 14 }}><Inline text={block.text} /></Tag>; }
    case 'code': return <pre className="log" style={{ maxHeight: 'none' }}>{block.text}</pre>;
    case 'quote': return <blockquote className="muted" style={{ borderLeft: '3px solid var(--border)', margin: '10px 0', paddingLeft: 12 }}><Inline text={block.text} /></blockquote>;
    case 'hr': return <hr style={{ border: 0, borderTop: '1px solid var(--border)', margin: '18px 0' }} />;
    case 'list': { const Tag = block.ordered ? 'ol' : 'ul'; return <Tag>{block.items.map((it, i) => <li key={i}><Inline text={it} /></li>)}</Tag>; }
    case 'table': return (
      <div className="table-wrap" style={{ margin: '10px 0' }}>
        <table>
          <thead><tr>{block.head.map((c, i) => <th key={i}><Inline text={c} /></th>)}</tr></thead>
          <tbody>{block.rows.map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j}><Inline text={c} /></td>)}</tr>)}</tbody>
        </table>
      </div>
    );
    default: return <p><Inline text={block.text} /></p>;
  }
}

export function curlFor(endpoint) {
  const path = endpoint.path.replace(/:([A-Za-z0-9_]+)/g, '<$1>');
  const auth = endpoint.auth ? ' \\\n  -H "Authorization: Bearer $WHM_TOKEN"' : '';
  const body = ['POST', 'PUT', 'PATCH'].includes(endpoint.method) ? ' \\\n  -H "Content-Type: application/json" -d \'{}\'' : '';
  return `curl -s -X ${endpoint.method} "https://$HOST:2087${path}"${auth}${body}`;
}

// Endpoint browser shared by the WHM and cPanel OpenAPI pages.
export function ApiReference({ scope, note }) {
  const toast = useToast();
  const { data, loading, error, refetch } = useApi(`/development/openapi/endpoints?scope=${scope}`);
  const [q, setQ] = useState('');
  const [method, setMethod] = useState('');
  const [role, setRole] = useState('');
  const [open, setOpen] = useState(null);
  const [selected, setSelected] = useState(null);
  const [downloading, setDownloading] = useState(false);

  const groups = useMemo(() => (data?.groups || []).map((g) => ({
    ...g,
    endpoints: g.endpoints.filter((e) => (!q || `${e.method} ${e.path}`.toLowerCase().includes(q.toLowerCase())) && (!method || e.method === method) && (!role || e.role === role)),
  })).filter((g) => g.endpoints.length), [data, q, method, role]);
  const shown = groups.reduce((n, g) => n + g.endpoints.length, 0);

  const downloadSpec = async () => {
    setDownloading(true);
    try { const res = await api.get(`/development/openapi.json?scope=${scope}`); downloadText(`whm-openapi-${scope}.json`, JSON.stringify(res.data, null, 2), 'application/json'); } catch (err) { toast.error(err); } finally { setDownloading(false); }
  };

  return (
    <>
      {note}
      <ErrorBanner error={error} onRetry={refetch} />
      {loading && !data && <Loading text="Walking the router…" />}
      {data && (
        <>
          <div className="stat-grid" style={{ marginBottom: 14 }}>
            <Stat label="Endpoints" value={data.total} hint={`${shown} shown`} />
            {Object.entries(data.byMethod).map(([m, n]) => <Stat key={m} label={m} value={n} />)}
            <Stat label="Groups" value={data.groups.length} />
          </div>
          <Card title="Endpoints" subtitle="Generated live from the mounted Express routers: every path, method and the role it requires. Pick one for a curl example." padded={false}
            actions={<><Button size="sm" icon={Download} loading={downloading} onClick={downloadSpec}>openapi.json</Button><Button size="sm" onClick={() => refetch()}>Refresh</Button></>}>
            <div className="datatable-toolbar" style={{ padding: 12 }}>
              <input className="input" placeholder="Filter by path…" value={q} onChange={(e) => setQ(e.target.value)} style={{ maxWidth: 320 }} />
              <select className="input select" value={method} onChange={(e) => setMethod(e.target.value)} style={{ maxWidth: 140 }}><option value="">All methods</option>{['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map((m) => <option key={m}>{m}</option>)}</select>
              <select className="input select" value={role} onChange={(e) => setRole(e.target.value)} style={{ maxWidth: 180 }}><option value="">All roles</option><option value="root">root only</option><option value="reseller">root + reseller</option><option value="any">any principal</option></select>
            </div>
            {groups.length === 0 && <p className="muted" style={{ padding: 14 }}>No endpoints match.</p>}
            {groups.map((g) => (
              <div key={g.prefix} style={{ borderTop: '1px solid var(--border)' }}>
                <button className="link-button" style={{ display: 'flex', width: '100%', justifyContent: 'space-between', padding: '10px 14px', textAlign: 'left' }} onClick={() => setOpen(open === g.prefix ? null : g.prefix)}>
                  <strong><code>/api{g.prefix}</code></strong>
                  <span className="small muted">{g.endpoints.length} endpoint{g.endpoints.length === 1 ? '' : 's'} · {g.roles.root} root · {g.roles.reseller} reseller · {g.roles.any} public</span>
                </button>
                {(open === g.prefix || q || method || role) && (
                  <div className="table-wrap">
                    <table>
                      <tbody>
                        {g.endpoints.map((e) => (
                          <tr key={`${e.method} ${e.path}`} className={selected === e ? 'is-selected' : ''} onClick={() => setSelected(selected === e ? null : e)} style={{ cursor: 'pointer' }}>
                            <td style={{ width: 90 }}><MethodPill method={e.method} /></td>
                            <td><code>{e.path}</code></td>
                            <td style={{ width: 160 }}><RolePill role={e.role} /></td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            ))}
          </Card>
          {selected && (
            <Card title={<><MethodPill method={selected.method} /> <code>{selected.path}</code></>} actions={<CopyButton text={curlFor(selected)} label="Copy curl" />}>
              <KeyValue items={[['Access', <RolePill key="r" role={selected.role} />], ['Authentication', selected.auth ? 'Session cookie + X-CSRF-Token, or Authorization: Bearer <api token>' : 'None (public)'], ['Path parameters', selected.path.match(/:([A-Za-z0-9_]+)/g)?.map((p) => p.slice(1)).join(', ') || 'none'], ['Envelope', '{ data, meta } on success · { error: { code, message, fields? } } on failure']]} />
              <pre className="log" style={{ marginTop: 10 }}>{curlFor(selected)}</pre>
              <p className="small muted" style={{ marginTop: 8 }}>Create a token under <Link to="/development/manage-api-tokens">Manage API Tokens</Link>. Long operations answer <code>202</code> with a job id you can follow in the Task Queue Monitor.</p>
            </Card>
          )}
        </>
      )}
    </>
  );
}

export function DocLinks({ docs }) {
  if (!docs?.length) return <p className="muted">No documents are shipped with this install.</p>;
  return (
    <div className="tool-grid">
      {docs.map((d) => (
        <div key={d.slug} className="tool-card">
          <Link to={`/development/developer-documentation?doc=${d.slug}`} className="tool-link">
            <strong>{d.title}</strong>
            <small>{d.summary}{d.available ? ` · ${d.sections ? `${d.sections} sections` : d.type}` : ' · not shipped with this install'}</small>
          </Link>
        </div>
      ))}
    </div>
  );
}

export function RelativeTime({ value }) { return <span title={value || ''}>{formatDate(value)}</span>; }
