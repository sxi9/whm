import { ShieldAlert } from 'lucide-react';
import { api } from '../../api/client.js';
import { useApi } from '../../hooks/useApi.js';
import { useAuth } from '../../auth/AuthContext.jsx';
import { Card, StatusPill } from '../../components/Common.jsx';
import { Button, ErrorBanner } from '../../components/Form.jsx';
import { useConfirm } from '../../components/Modal.jsx';
import { useJobRunner, JobPanel } from '../software/Shared.jsx';

const SEVERITY = {
  critical: ['failed', 'Critical'],
  security: ['warning', 'Security'],
  update: ['info', 'Update'],
};

export function SeverityPill({ severity }) {
  const [status, text] = SEVERITY[severity] || SEVERITY.update;
  return <StatusPill status={status}>{text}</StatusPill>;
}

// What an item's Update button sends: [path, body] from the server's own action.
export function updateRequest(item) {
  const action = item?.action;
  if (!action || action.method !== 'POST' || typeof action.path !== 'string') return null;
  return [action.path, action.body ?? {}];
}

// What the confirm names, from the item alone (the job is what the server runs).
export function updateSummary(item) {
  if (item.kind === 'php') return item.layout === 'keel' ? `Rebuilds PHP ${item.id} from the official php.net ${item.candidate} source over /opt/keel/php/${item.id} (about 15 minutes) and restarts keel-php${item.id}-fpm.` : `Upgrades ${item.packages?.length ? item.packages.join(', ') : `the php${item.id} packages`} to ${item.candidate} and reloads ${item.unit || 'PHP-FPM'}.`;
  if (item.kind === 'runtime' && String(item.id).startsWith('nodejs:')) return `Installs the latest Node.js ${item.candidate} build over /opt/keel/node/${String(item.id).split(':')[1]}; sites keep the same node${String(item.id).split(':')[1]} path.`;
  return `Upgrades ${item.packages?.length ? item.packages.join(', ') : item.label} to ${item.candidate} through the package manager (no dist-upgrade).`;
}

export function UpdateRow({ item, busy, onUpdate }) {
  const request = updateRequest(item);
  return (
    <tr>
      <td style={{ width: 90 }}><SeverityPill severity={item.severity} /></td>
      <td>
        <div><strong>{item.label}</strong> {item.current && <span className="muted">{item.current}</span>}{item.candidate && <span className="muted"> → {item.candidate}</span>}</div>
        {Array.isArray(item.reasons) && item.reasons.length > 0 && <small className="muted" style={{ whiteSpace: 'pre-line' }}>{item.reasons.join('\n')}</small>}
      </td>
      <td className="actions-col">
        {request ? <Button size="sm" variant={item.severity === 'critical' ? 'danger' : 'primary'} loading={busy} onClick={() => onUpdate(item)}>Update{item.candidate ? ` to ${item.candidate}` : ''}</Button> : <span className="muted small">no fix available yet</span>}
      </td>
    </tr>
  );
}

// The server's critical-update list (GET /software/updates/critical, contract
// §63) with one Update button per item; renders nothing while the list is
// empty. `kinds` narrows it for a category page.
export function UpdatesBanner({ kinds = null, title = 'Updates that need attention', subtitle = 'PHP advisories, security updates of the web stack and newer runtime builds. Each Update runs as a job you can follow here.' }) {
  const { user } = useAuth();
  const confirm = useConfirm();
  const isRoot = user?.role === 'root';
  const list = useApi('/software/updates/critical', { enabled: isRoot });
  const runner = useJobRunner({ onFinished: () => list.refetch() });
  const items = (list.data?.items || []).filter((i) => !kinds || kinds.includes(i.kind));
  if (!isRoot || (!items.length && !runner.jobId)) return null;
  const update = async (item) => {
    const request = updateRequest(item);
    if (!request) return;
    if (!(await confirm({ title: `Update ${item.label}${item.candidate ? ` to ${item.candidate}` : ''}?`, message: updateSummary(item), confirmLabel: 'Update', danger: item.severity === 'critical' }))) return;
    runner.start(() => api.post(request[0], request[1]), `Update ${item.label}`);
  };
  return (
    <>
      {items.length > 0 && (
        <Card className="updates-banner" title={<><ShieldAlert size={16} style={{ verticalAlign: '-3px', marginRight: 6 }} />{title}</>} subtitle={subtitle} actions={<Button onClick={() => api.post('/software/updates/critical/refresh').then(() => list.refetch())}>Check again</Button>} padded={false}>
          <div className="table-wrap">
            <table>
              <tbody>
                {items.map((item) => <UpdateRow key={`${item.kind}:${item.id}`} item={item} busy={runner.busy} onUpdate={update} />)}
              </tbody>
            </table>
          </div>
          <div style={{ padding: '0 16px 12px' }}>
            <ErrorBanner error={runner.error} />
            {list.data?.packagesCheckedAt && <p className="muted small">Package updates as of the last check ({new Date(list.data.packagesCheckedAt).toLocaleString()}); System Update › Check now refreshes them.</p>}
          </div>
        </Card>
      )}
      <JobPanel runner={runner} title="Update progress" />
    </>
  );
}
