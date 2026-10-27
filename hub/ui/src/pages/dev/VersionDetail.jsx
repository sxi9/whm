import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { PageHeader, Card, StatusPill, Loading, formatBytes, formatDate } from '../../components/Common.jsx';
import { Field, TextInput, Textarea, Button, ErrorBanner } from '../../components/Form.jsx';
import { api } from '../../api/client.js';
import { useApi } from '../../hooks/useApi.js';
import { useAction } from '../../hooks/useAction.js';
import { KV } from '../../widgets/index.jsx';
import { ScanReport } from '../admin/ReviewDetail.jsx';
import { VersionActions, VERSION_STATUS_HELP } from './Versions.jsx';

const EDITABLE = ['uploaded', 'scanning', 'scan_failed', 'in_review', 'changes_requested'];

export default function VersionDetail() {
  const { id, v: version } = useParams();
  const { data, loading, error, refetch } = useApi(`/dev/plugins/${id}/versions/${version}`);
  const { run, busy, error: saveError } = useAction();
  const [changelog, setChangelog] = useState(data?.changelog_md || '');
  const [just, setJust] = useState(data?.permission_justifications || {});
  useEffect(() => { if (data) { setChangelog(data.changelog_md || ''); setJust(data.permission_justifications || {}); } }, [data]);
  if (loading && !data) return <Loading />;
  if (error) return <ErrorBanner error={error} onRetry={refetch} />;
  if (!data) return null;
  const v = data;
  const review = v.review || null;
  const editable = EDITABLE.includes(v.status);
  const scopes = v.permissions || [];
  return (
    <>
      <PageHeader title={`${id} ${v.version}`} description={VERSION_STATUS_HELP[v.status]} home="/dev" crumbs={[{ to: '/dev/plugins', label: 'Plugins' }, { to: `/dev/plugins/${id}/versions`, label: 'Versions' }]}
        actions={<><StatusPill status={v.status} /><VersionActions pluginId={id} version={v} onChanged={refetch} /></>} />
      {review && review.reasons?.length > 0 && (
        <div className={`banner ${review.state === 'rejected' ? 'banner-error' : 'banner-warning'}`}><div>
          <strong>{review.state === 'rejected' ? 'Rejected' : 'Changes requested'} — uploaded bytes are immutable, resubmit as a new version.</strong>
          <ul>{review.reasons.map((r, i) => <li key={i}><code>{r.code}</code>{r.path && <> at <code>{r.path}</code></>}: {r.text}</li>)}</ul>
          {review.notes_md && <p className="muted">{review.notes_md}</p>}
        </div></div>
      )}
      <div className="two-col">
        <Card title="Package">
          <KV items={[['Channel', v.channel], ['Risk', v.risk], ['Engines', v.engines_whm], ['Packed', formatBytes(v.package_bytes)], ['Extracted', formatBytes(v.extracted_bytes)], ['Upload sha256', <code className="small">{v.upload_sha256}</code>], ['Served sha256', v.package_sha256 ? <code className="small">{v.package_sha256}</code> : 'not signed yet'], ['Your key', v.dev_kid], ['Hub key', v.mkt_kid || '—'], ['Signed', formatDate(v.signed_at)], ['Uploaded', formatDate(v.created_at)], ['Published', formatDate(v.published_at)], v.yanked_at && ['Yanked', `${formatDate(v.yanked_at)} · ${v.yanked_reason || ''}`]]} />
        </Card>
        <Card title="Scan report"><ScanReport report={v.scan_report} /></Card>
      </div>
      <Card title="Permission justifications" subtitle="Every scope needs ≥ 20 characters explaining why. Saving re-runs the scan on scan_failed / in_review / changes_requested versions.">
        <ErrorBanner error={saveError} />
        {scopes.map((s) => <Field key={s} label={<code>{s}</code>} error={(just[s] || '').length < 20 ? 'At least 20 characters' : null}><TextInput value={just[s] || ''} onChange={(val) => setJust((j) => ({ ...j, [s]: val }))} disabled={!editable} /></Field>)}
        {!scopes.length && <p className="muted">This version requests no permissions.</p>}
        <Field label="Changelog (Markdown)"><Textarea value={changelog} onChange={setChangelog} rows={6} mono disabled={!editable} /></Field>
        <Button variant="primary" loading={busy} disabled={!editable} onClick={() => run(() => api.patch(`/dev/plugins/${id}/versions/${version}`, { changelog_md: changelog, permission_justifications: just }), { success: 'Saved', then: refetch })}>Save</Button>
        {!editable && <span className="muted" style={{ marginLeft: 10 }}>A {v.status} version is frozen.</span>}
      </Card>
      {v.manifest && <Card title="Manifest"><pre className="code-block">{JSON.stringify(v.manifest, null, 2)}</pre></Card>}
    </>
  );
}
