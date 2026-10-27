import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { PageHeader, Card, StatusPill, Loading, formatBytes, formatDate } from '../../components/Common.jsx';
import { Button, ErrorBanner, Field, TextInput, Textarea, Select, Toggle } from '../../components/Form.jsx';
import { Modal } from '../../components/Modal.jsx';
import { api } from '../../api/client.js';
import { useApi } from '../../hooks/useApi.js';
import { useAction } from '../../hooks/useAction.js';
import { KV, Tabs } from '../../widgets/index.jsx';
import { decideReview, REVIEW_REASON_CODES } from './queues.js';

const CHECKLIST = [
  ['manifest_ok', 'Manifest and id match the listing'],
  ['permissions_justified', 'Every permission is justified and proportionate'],
  ['no_dangerous_code', 'No eval/Function/child_process/escape patterns (scan clean or flags explained)'],
  ['network_declared', 'Every outbound host is declared with a net:outbound scope'],
  ['diff_reviewed', 'Diff since the last published version reviewed'],
  ['identity_ok', 'Name/slug do not impersonate another plugin or brand'],
];

export function ScanReport({ report }) {
  if (!report) return <p className="muted">No scan report yet.</p>;
  return (
    <>
      <KV items={[['Result', <StatusPill status={report.ok ? 'passed' : 'failed'}>{report.ok ? 'passed' : 'rejected'}</StatusPill>], ['Risk', report.risk], ['Rejects', (report.rejects || []).length], ['Flags', (report.flags || []).length], ['Scanned', formatDate(report.at || report.scanned_at)]]} />
      {(report.rejects || []).length > 0 && <><h3 style={{ marginTop: 10 }}>Rejects</h3><ul className="timeline">{report.rejects.map((r, i) => <li key={i}><time>{r.file}{r.line ? `:${r.line}` : ''}</time><span><code>{r.rule}</code> {r.detail}</span></li>)}</ul></>}
      {(report.flags || []).length > 0 && <><h3 style={{ marginTop: 10 }}>Flags (need a human look)</h3><ul className="timeline">{report.flags.map((r, i) => <li key={i}><time>{r.file}{r.line ? `:${r.line}` : ''}</time><span><code>{r.rule}</code> {r.detail}</span></li>)}</ul></>}
    </>
  );
}

export function DiffView({ diff }) {
  if (!diff) return <p className="muted">First version: nothing to diff against.</p>;
  const files = diff.files || diff.changes || [];
  return (
    <>
      {diff.base_version && <p className="muted">Compared with {diff.base_version}</p>}
      {files.length === 0 && <p className="muted">No file changes.</p>}
      {files.map((f) => (
        <details key={f.path} open={f.status !== 'unchanged'}>
          <summary><StatusPill status={f.status === 'added' ? 'ok' : f.status === 'removed' ? 'bad' : f.status === 'modified' ? 'warn' : 'muted'}>{f.status}</StatusPill> <code>{f.path}</code> {f.bytes != null && <span className="muted">{formatBytes(f.bytes)}</span>}</summary>
          {f.diff && <div className="diff">{String(f.diff).split('\n').map((line, i) => <div key={i} className={`line ${line.startsWith('+') ? 'add' : line.startsWith('-') ? 'del' : line.startsWith('@@') ? 'hunk' : ''}`}>{line}</div>)}</div>}
        </details>
      ))}
    </>
  );
}

function ReasonsEditor({ reasons, onChange }) {
  const set = (i, patch) => onChange(reasons.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <>
      {reasons.map((r, i) => (
        <div key={i} className="form-grid">
          <Field label="Code"><Select value={r.code} onChange={(v) => set(i, { code: v })} options={REVIEW_REASON_CODES} placeholder="pick" /></Field>
          <Field label="Path (optional)"><TextInput value={r.path || ''} onChange={(v) => set(i, { path: v })} placeholder="main.js:88" /></Field>
          <Field label="Text"><TextInput value={r.text} onChange={(v) => set(i, { text: v })} /></Field>
        </div>
      ))}
      <Button size="sm" onClick={() => onChange([...reasons, { code: '', path: '', text: '' }])}>Add reason</Button>
    </>
  );
}

export default function ReviewDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { data, loading, error, refetch } = useApi(`/admin/market/reviews/${id}`);
  const { run, busy, error: actionError } = useAction();
  const [tab, setTab] = useState('scan');
  const [checklist, setChecklist] = useState({});
  const [notes, setNotes] = useState('');
  const [decision, setDecision] = useState(null);
  const [reasons, setReasons] = useState([{ code: '', path: '', text: '' }]);
  if (loading && !data) return <Loading />;
  if (error) return <ErrorBanner error={error} onRetry={refetch} />;
  if (!data) return null;
  const { review, version: v, plugin, developer, permissions, diff, assets, requires_two_reviewers } = data;
  const decide = (kind) => run(() => decideReview(api, id, kind, { notes: notes || undefined, checklist, reasons }), {
    success: (r) => (kind === 'approve' ? (r?.pending_second_reviewer ? 'First approval recorded; a second reviewer must approve' : 'Approved and signed with the active plugin key') : kind === 'request-changes' ? 'Changes requested' : 'Rejected'),
    then: () => { setDecision(null); refetch(); },
  });
  const manifest = v.manifest || {};
  return (
    <>
      <PageHeader title={`${plugin.name} ${v.version}`} description={`${plugin.id} · ${v.channel} · submitted ${formatDate(v.created_at)}`} home="/admin" crumbs={[{ to: '/admin/market/reviews', label: 'Review queue' }]}
        actions={<><StatusPill status={v.risk === 'high' ? 'high' : 'normal'}>{v.risk} risk</StatusPill><StatusPill status={v.status} /></>} />
      {requires_two_reviewers && <div className="banner banner-warning"><div><strong>Two reviewers required.</strong> This high-risk version needs a second, different reviewer before the hub signs it. Approvals so far: {(review.approvals || []).map((a) => a.by).join(', ') || 'none'}.</div></div>}
      {developer.status !== 'verified' && <div className="banner banner-warning"><div><strong>Developer is {developer.status}.</strong> Approval signs the package, but publishing requires a verified developer.</div></div>}
      <div className="two-col">
        <Card title="Version">
          <KV items={[['Developer', <Link to={`/admin/market/developers/${developer.id}`}>{developer.display_name}</Link>], ['Developer status', <StatusPill status={developer.status} />], ['Rejections (90 d)', developer.rejections_90d], ['Engines', v.engines_whm], ['Package', `${formatBytes(v.package_bytes)} packed · ${formatBytes(v.extracted_bytes)} extracted`], ['Upload sha256', <code className="small">{v.upload_sha256}</code>], ['Digest', <code className="small">{v.package_digest}</code>], ['Developer key', v.dev_kid], ['Hub key', v.mkt_kid || 'not signed yet'], ['Pricing', JSON.stringify(plugin.pricing)]]} />
        </Card>
        <Card title="Permissions" subtitle="New scopes since the last published version are highlighted">
          <ul className="scope-list">
            {(permissions || []).map((p) => <li key={p.scope} className={p.added ? 'added' : ''}><code>{p.scope}{p.added && ' (new)'}</code><span>{p.description && <>{p.description}<br /></>}<em className={p.justification ? '' : 'muted'}>{p.justification || 'no justification given'}</em></span></li>)}
            {!(permissions || []).length && <li><span className="muted">No permissions requested.</span></li>}
          </ul>
        </Card>
      </div>
      <Card padded={false}>
        <div style={{ padding: '12px 18px 0' }}><Tabs value={tab} onChange={setTab} tabs={[{ value: 'scan', label: 'Scan report' }, { value: 'diff', label: 'Diff' }, { value: 'manifest', label: 'Manifest' }, { value: 'files', label: 'Files' }, { value: 'changelog', label: 'Changelog & assets' }, { value: 'history', label: 'Review history' }]} /></div>
        <div className="card-body">
          {tab === 'scan' && <ScanReport report={v.scan_report} />}
          {tab === 'diff' && <DiffView diff={diff} />}
          {tab === 'manifest' && <pre className="code-block">{JSON.stringify(manifest, null, 2)}</pre>}
          {tab === 'files' && <div className="table-wrap"><table><thead><tr><th>Path</th><th>Bytes</th><th>sha256</th></tr></thead><tbody>{(v.files || []).map((f) => <tr key={f.path}><td><code>{f.path}</code></td><td>{formatBytes(f.bytes)}</td><td><code className="small">{f.sha256}</code></td></tr>)}</tbody></table></div>}
          {tab === 'changelog' && <><pre className="code-block">{v.changelog_md || 'No changelog.'}</pre><div className="inline-list">{(assets || []).map((a) => <a key={a.id} href={a.url} target="_blank" rel="noreferrer noopener" className="pill pill-muted">{a.kind} #{a.position}</a>)}</div></>}
          {tab === 'history' && <KV items={[['State', review.state], ['Reviewer', review.reviewer_id], ['Approvals', (review.approvals || []).map((a) => `${a.by} @ ${formatDate(a.at)}`).join(', ') || '—'], ['Reasons', (review.reasons || []).map((r) => `${r.code}${r.path ? ` (${r.path})` : ''}: ${r.text}`).join('; ') || '—'], ['Notes', review.notes_md], ['Decided', formatDate(review.decided_at)]]} />}
        </div>
      </Card>
      <Card title="Decision" subtitle="Every decision needs a fresh two-factor confirmation and is audited with your reviewer id.">
        <ErrorBanner error={actionError} />
        {CHECKLIST.map(([k, label]) => <Field key={k} inline><Toggle checked={Boolean(checklist[k])} onChange={(val) => setChecklist((c) => ({ ...c, [k]: val }))} label={label} /></Field>)}
        <Field label="Reviewer notes"><Textarea value={notes} onChange={setNotes} rows={3} /></Field>
        <div className="inline-list">
          <Button variant="primary" loading={busy} disabled={review.state !== 'open'} onClick={() => decide('approve')}>Approve & sign</Button>
          <Button disabled={busy || review.state !== 'open'} onClick={() => setDecision('request-changes')}>Request changes</Button>
          <Button variant="danger" disabled={busy || review.state !== 'open'} onClick={() => setDecision('reject')}>Reject</Button>
          <Button variant="ghost" onClick={() => navigate('/admin/market/reviews')}>Back to queue</Button>
        </div>
      </Card>
      <Modal open={Boolean(decision)} title={decision === 'reject' ? 'Reject this version' : 'Request changes'} onClose={() => setDecision(null)} size="lg"
        footer={<><Button onClick={() => setDecision(null)}>Cancel</Button><Button variant={decision === 'reject' ? 'danger' : 'primary'} loading={busy} onClick={() => decide(decision)}>{decision === 'reject' ? 'Reject' : 'Request changes'}</Button></>}>
        <p className="muted">Structured reasons are sent to the developer; uploaded bytes are immutable, so they resubmit as a new version.</p>
        <ReasonsEditor reasons={reasons} onChange={setReasons} />
      </Modal>
    </>
  );
}
