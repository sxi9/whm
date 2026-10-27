import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { PageHeader, Card, StatusPill, formatBytes, formatDate } from '../../components/Common.jsx';
import { Button, ErrorBanner } from '../../components/Form.jsx';
import { useConfirm } from '../../components/Modal.jsx';
import { api } from '../../api/client.js';
import { useApi } from '../../hooks/useApi.js';
import { useAction } from '../../hooks/useAction.js';
import { ReasonModal } from '../../widgets/index.jsx';

export const VERSION_STATUS_HELP = {
  uploaded: 'Received; the scanner picks it up shortly.', scanning: 'Automated checks are running.', scan_failed: 'Automated checks rejected it; fix and upload a new version.',
  in_review: 'Waiting for a human reviewer.', changes_requested: 'The reviewer asked for changes; upload a new version.', approved: 'Signed by the hub; publish it to a channel.',
  published: 'Live on its channel.', rejected: 'Rejected by the reviewer.', yanked: 'Hidden, no new installs.', revoked: 'Revoked by the vendor; panels disable it.',
};

// Publish/yank controls reused by VersionDetail.
export function VersionActions({ pluginId, version, onChanged }) {
  const { run, busy } = useAction();
  const confirm = useConfirm();
  const [yank, setYank] = useState(false);
  return (
    <>
      {version.status === 'approved' && <Button size="sm" variant="primary" loading={busy} onClick={async () => { if (await confirm({ title: `Publish ${version.version} to ${version.channel}`, message: 'Requires a fresh two-factor code and a verified developer status. Panels on this channel see it in their next update check.' })) run(() => api.post(`/dev/plugins/${pluginId}/versions/${version.version}/publish`, { channel: version.channel }), { success: 'Published', then: onChanged }); }}>Publish</Button>}
      {version.status === 'published' && <Button size="sm" loading={busy} onClick={() => setYank(true)}>Yank</Button>}
      <ReasonModal open={yank} title={`Yank ${version.version}`} help="Hidden from the catalog and no new installs; panels that already installed it may re-download." required={false} confirmLabel="Yank" onClose={() => setYank(false)}
        onConfirm={({ reason }) => run(() => api.post(`/dev/plugins/${pluginId}/versions/${version.version}/yank`, reason ? { reason } : {}), { success: 'Version yanked', then: onChanged })} />
    </>
  );
}

export default function Versions() {
  const { id } = useParams();
  const { data, loading, error, refetch } = useApi(`/dev/plugins/${id}/versions`);
  const rows = data || [];
  return (
    <>
      <PageHeader title="Versions" description={`${id} · one channel per version; semver must grow on its channel`} home="/dev" crumbs={[{ to: '/dev/plugins', label: 'Plugins' }, { to: `/dev/plugins/${id}`, label: id }]}
        actions={<Link className="btn btn-primary" to={`/dev/plugins/${id}/upload`}>Upload version</Link>} />
      <ErrorBanner error={error} onRetry={refetch} />
      <Card padded={false}>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Version</th><th>Channel</th><th>Status</th><th>Risk</th><th>Scan</th><th>Package</th><th>Hub key</th><th>Uploaded</th><th>Published</th><th /></tr></thead>
            <tbody>
              {loading && !data && <tr><td colSpan={10} className="muted">Loading…</td></tr>}
              {rows.map((v) => (
                <tr key={v.id}>
                  <td><Link to={`/dev/plugins/${id}/versions/${v.version}`}><strong>{v.version}</strong></Link></td><td>{v.channel}</td>
                  <td><StatusPill status={v.status} /><br /><span className="muted">{VERSION_STATUS_HELP[v.status]}</span></td><td>{v.risk}</td>
                  <td>{v.scan_report ? <>{v.scan_report.rejects?.length || 0} rejects · {v.scan_report.flags?.length || 0} flags</> : '—'}</td>
                  <td>{formatBytes(v.package_bytes)}</td><td>{v.mkt_kid || '—'}</td><td>{formatDate(v.created_at)}</td><td>{formatDate(v.published_at)}</td>
                  <td className="inline-list"><VersionActions pluginId={id} version={v} onChanged={refetch} /></td>
                </tr>
              ))}
              {!loading && !rows.length && <tr><td colSpan={10} className="muted">No versions uploaded yet.</td></tr>}
            </tbody>
          </table>
        </div>
      </Card>
    </>
  );
}
