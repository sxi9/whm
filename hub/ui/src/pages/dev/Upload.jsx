import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { PageHeader, Card, StatusPill } from '../../components/Common.jsx';
import { Field, TextInput, Textarea, Select, Button, ErrorBanner } from '../../components/Form.jsx';
import { api, queryString } from '../../api/client.js';
import { useApi } from '../../hooks/useApi.js';
import { useAction } from '../../hooks/useAction.js';

const MAX_BYTES = 20 * 1024 * 1024;

export function encodeHeader(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (typeof Buffer !== 'undefined') return Buffer.from(text, 'utf8').toString('base64');
  return btoa(unescape(encodeURIComponent(text)));
}

// Parses "scope: justification" lines into the X-WHM-Justifications object.
export function parseJustifications(text) {
  const out = {};
  for (const line of String(text || '').split('\n')) {
    const m = line.match(/^\s*([a-z:*._-]{3,80})\s*[:=]\s*(.+)$/i);
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
}

// Both segments come from the URL or a select; a '/', '?' or '#' in them
// must stay inside this route, never pick another one.
export function uploadPath(pluginId, channel) {
  return `/dev/plugins/${encodeURIComponent(pluginId)}/versions${queryString({ channel })}`;
}

export default function Upload() {
  const { id: routeId } = useParams();
  const navigate = useNavigate();
  const plugins = useApi(routeId ? null : '/dev/plugins?pageSize=100');
  const [pluginId, setPluginId] = useState(routeId || '');
  const [channel, setChannel] = useState('stable');
  const [file, setFile] = useState(null);
  const [changelog, setChangelog] = useState('');
  const [justifications, setJustifications] = useState('');
  const { run, busy, error } = useAction();
  const [result, setResult] = useState(null);
  const tooBig = file && file.size > MAX_BYTES;
  const submit = () => run(async () => {
    const bytes = await file.arrayBuffer();
    const headers = {};
    if (changelog.trim()) headers['X-WHM-Changelog'] = encodeHeader(changelog);
    const just = parseJustifications(justifications);
    if (Object.keys(just).length) headers['X-WHM-Justifications'] = encodeHeader(just);
    const { data } = await api.postRaw(uploadPath(pluginId, channel), bytes, 'application/gzip', headers);
    return data;
  }, { success: (v) => `Version ${v.version} uploaded; scanning`, then: (v) => setResult(v) });
  return (
    <>
      <PageHeader title="Upload a version" description="A .whmplugin built with scripts/build-plugin.js --sign --dev <key> (DEV-SIGNATURE.json from one of your active keys; no SIGNATURE.json). Max 20 MiB." home="/dev" crumbs={[{ to: '/dev/plugins', label: 'Plugins' }]} />
      <ErrorBanner error={error} />
      {result && <Card title="Uploaded"><p><StatusPill status={result.status} /> {result.plugin_id} {result.version} on {result.channel}. <Link to={`/dev/plugins/${result.plugin_id}/versions/${result.version}`}>Follow the scan and review</Link>.</p></Card>}
      <Card>
        {routeId ? <p>Plugin: <code>{routeId}</code></p> : <Field label="Plugin"><Select value={pluginId} onChange={setPluginId} options={(plugins.data || []).map((p) => ({ value: p.id, label: `${p.name} (${p.id})` }))} placeholder="pick a listing" /></Field>}
        <Field label="Channel" help="A panel on beta sees both channels."><Select value={channel} onChange={setChannel} options={['stable', 'beta']} /></Field>
        <Field label="Package (.whmplugin)" error={tooBig ? 'Larger than 20 MiB' : null}><input type="file" accept=".whmplugin,application/gzip" onChange={(e) => setFile(e.target.files?.[0] || null)} /></Field>
        <Field label="Changelog (Markdown)"><Textarea value={changelog} onChange={setChangelog} rows={4} mono /></Field>
        <Field label="Permission justifications" help="One per line: scope: why it is needed (≥ 20 characters). accounts:write, backups:restore, agent:op:* and net:outbound:* mark the version high-risk."><Textarea value={justifications} onChange={setJustifications} rows={4} mono placeholder={'store:own: keeps per-user notes in the plugin store\nnet:outbound:api.example.com: fetches exchange rates'} /></Field>
        <div className="inline-list">
          <Button variant="primary" loading={busy} disabled={!pluginId || !file || tooBig} onClick={submit}>Upload</Button>
          <Button variant="ghost" onClick={() => navigate(pluginId ? `/dev/plugins/${pluginId}/versions` : '/dev/plugins')}>Cancel</Button>
        </div>
        <p className="muted" style={{ marginTop: 10 }}>What the scanner refuses: child_process/fs/net requires, eval, new Function, computed constructor access, Reflect, process, globalThis, import(), WebAssembly, unicode escapes in identifiers, .sh/.node/.so/.wasm/.mjs entries, secrets, typosquats. Undeclared fetch hosts and agent ops are flagged for the reviewer.</p>
      </Card>
    </>
  );
}
