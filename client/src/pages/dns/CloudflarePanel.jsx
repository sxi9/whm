import { useEffect, useState } from 'react';
import { Cloud } from 'lucide-react';
import { api } from '../../api/client.js';
import { useApi } from '../../hooks/useApi.js';
import { useAuth } from '../../auth/AuthContext.jsx';
import { Card, StatusPill, KeyValue, Loading, formatDate } from '../../components/Common.jsx';
import { DataTable } from '../../components/DataTable.jsx';
import { Field, TextInput, Button, FormActions, ErrorBanner } from '../../components/Form.jsx';
import { ProgressLog } from '../../components/ProgressLog.jsx';
import { useToast } from '../../components/Toast.jsx';
import { useConfirm } from '../../components/Modal.jsx';

const SYNC_LABEL = { linked: 'Linked, not synced', pending: 'Push queued', ok: 'In sync', failed: 'Push failed' };

// Zone rows carry provider / cloudflare_status from GET /dns/zones.
export function ProviderBadge({ zone }) {
  const provider = zone?.provider || 'bind';
  if (provider !== 'cloudflare') return <StatusPill status="info">BIND</StatusPill>;
  const status = zone.cloudflare_status || zone.status || 'linked';
  return <StatusPill status={status === 'ok' ? 'ok' : status === 'failed' ? 'failed' : status === 'pending' ? 'pending' : 'info'}>Cloudflare · {SYNC_LABEL[status] || status}</StatusPill>;
}

function TokenForm({ onSaved }) {
  const toast = useToast();
  const [token, setToken] = useState('');
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);
  const submit = async (e) => {
    e.preventDefault();
    setSaving(true); setError(null);
    try {
      await api.put('/dns/cloudflare/token', { apiToken: token });
      setToken('');
      toast.success('Cloudflare token verified and saved');
      onSaved?.();
    } catch (err) { setError(err); } finally { setSaving(false); }
  };
  return (
    <form onSubmit={submit}>
      <ErrorBanner error={error && !error.fields ? error : null} />
      <Field label="API token" required error={error?.fields?.apiToken} help="Create a token at dash.cloudflare.com › My Profile › API Tokens with the permissions Zone:Read and DNS:Edit (not the Global API Key). It is verified against Cloudflare, stored encrypted and never shown again.">
        <TextInput type="password" value={token} onChange={setToken} autoComplete="off" placeholder="Cloudflare API token" />
      </Field>
      <FormActions><Button type="submit" variant="primary" loading={saving} disabled={token.trim().length < 20}>Verify and save</Button></FormActions>
    </form>
  );
}

function RemoteZones() {
  const [open, setOpen] = useState(false);
  const { data, loading, error, refetch } = useApi(open ? '/dns/cloudflare/zones' : null, { enabled: open });
  if (!open) return <FormActions><Button size="sm" onClick={() => setOpen(true)}>Show zones in the Cloudflare account</Button></FormActions>;
  return (
    <>
      <ErrorBanner error={error} onRetry={refetch} />
      <DataTable
        columns={[
          { key: 'name', label: 'Cloudflare zone', render: (z) => <code>{z.name}</code> },
          { key: 'status', label: 'Status', width: 110, render: (z) => <StatusPill status={z.status === 'active' ? 'ok' : 'pending'}>{z.status}{z.paused ? ' (paused)' : ''}</StatusPill> },
          { key: 'nameServers', label: 'Nameservers', render: (z) => <span className="muted" style={{ fontSize: 12 }}>{(z.nameServers || []).join(', ')}</span> },
          { key: 'linkedDomain', label: 'Panel zone', render: (z) => (z.linkedDomain ? <StatusPill status="ok">linked · {z.linkedDomain}</StatusPill> : z.localZone ? <StatusPill status="info">exists here, not linked</StatusPill> : <span className="muted">not on this server</span>) },
        ]}
        rows={data || []} loading={loading} rowKey={(z) => z.id} dense emptyText="The token can see no zones; add the site at Cloudflare first."
        toolbar={<Button size="sm" onClick={() => api.get('/dns/cloudflare/zones?refresh=true').then(() => refetch())}>Refresh</Button>}
      />
    </>
  );
}

// Root: token setup + account overview. Resellers only learn whether the
// integration is available for their zones.
export function CloudflareSetupCard() {
  const { user } = useAuth();
  const toast = useToast();
  const confirm = useConfirm();
  const { data, loading, error, refetch } = useApi('/dns/cloudflare/status');
  const [editing, setEditing] = useState(false);
  const isRoot = user?.role === 'root';
  const remove = async () => {
    if (!(await confirm({ title: 'Remove the Cloudflare API token?', message: 'Linked zones stay linked but no changes are pushed to Cloudflare until a new token is saved.', confirmLabel: 'Remove', danger: true }))) return;
    try { await api.delete('/dns/cloudflare/token'); toast.success('Cloudflare token removed'); refetch(); } catch (err) { toast.error(err); }
  };
  if (loading && !data) return <Card title="Cloudflare DNS"><Loading /></Card>;
  if (error) return <Card title="Cloudflare DNS"><ErrorBanner error={error} onRetry={refetch} /></Card>;
  if (!data) return null;
  const linked = data.linked || [];
  return (
    <Card title={<><Cloud size={16} style={{ verticalAlign: '-3px', marginRight: 6 }} />Cloudflare DNS</>}
      subtitle="Mirror zones to Cloudflare: every record change in the panel is pushed to the matching Cloudflare zone; BIND keeps serving the zone locally."
      actions={<StatusPill status={data.configured ? 'ok' : 'muted'}>{data.configured ? 'Token configured' : 'Not configured'}</StatusPill>}>
      {!isRoot && (data.configured
        ? <p className="muted">The root administrator has connected a Cloudflare account. Zones root has linked for your accounts can be imported and pushed from the zone card above; ask root to link a zone.</p>
        : <p className="muted">Cloudflare is not connected on this server. Ask the root administrator to add an API token.</p>)}
      {isRoot && data.configured && !editing && (
        <>
          <KeyValue items={[
            ['Account', data.accountName ? `${data.accountName} (${data.accountId})` : data.accountId || 'unknown until a zone exists'],
            ['Token', <code key="t">{data.tokenId || 'verified'}</code>],
            ['Verified', formatDate(data.verifiedAt)],
            ['Linked zones', `${linked.length}${data.failed ? ` · ${data.failed} failing` : ''}`],
          ]} />
          <FormActions>
            <Button size="sm" onClick={() => setEditing(true)}>Replace token</Button>
            <Button size="sm" variant="danger" onClick={remove}>Remove token</Button>
          </FormActions>
          <RemoteZones />
        </>
      )}
      {isRoot && (!data.configured || editing) && (
        <>
          {!data.configured && <p className="muted">Connect a Cloudflare account to manage DNS from here. Zones are linked one by one from the zone card below.</p>}
          <TokenForm onSaved={() => { setEditing(false); refetch(); }} />
          {editing && <FormActions><Button size="sm" onClick={() => setEditing(false)}>Cancel</Button></FormActions>}
        </>
      )}
      {linked.length > 0 && (
        <DataTable
          columns={[
            { key: 'domain', label: 'Zone', render: (z) => <code>{z.domain}</code> },
            { key: 'account', label: 'Account', render: (z) => z.account || <span className="muted">—</span> },
            { key: 'status', label: 'Sync', width: 180, render: (z) => <ProviderBadge zone={{ provider: 'cloudflare', cloudflare_status: z.status }} /> },
            { key: 'syncedAt', label: 'Last sync', width: 170, render: (z) => (z.syncedAt ? formatDate(z.syncedAt) : <span className="muted">never</span>) },
            { key: 'lastError', label: 'Last error', render: (z) => (z.lastError ? <span className="field-message">{z.lastError}</span> : '') },
          ]}
          rows={linked} rowKey={(z) => z.domain} dense
        />
      )}
    </Card>
  );
}

// Per-zone card: provider badge, link / unlink (root), import / push and the
// sync log. While a push is queued or a retry is scheduled the zone status is
// polled, so the outcome shows even when the job stream is not available
// (another principal's job, a retry re-queued by the service).
export function CloudflareZoneCard({ domain, onChanged }) {
  const toast = useToast();
  const confirm = useConfirm();
  const { data, loading, error, refetch } = useApi(domain ? `/dns/zones/${encodeURIComponent(domain)}/cloudflare` : null, { enabled: Boolean(domain) });
  const [busy, setBusy] = useState(null);
  const [jobId, setJobId] = useState(null);
  const [last, setLast] = useState(null);
  const polling = data?.status === 'pending' || Boolean(data?.pendingRetry);
  useEffect(() => {
    if (!polling) return undefined;
    const timer = setInterval(() => refetch(), 3000);
    return () => clearInterval(timer);
  }, [polling, refetch]);
  const run = async (what, fn, okMessage) => {
    setBusy(what);
    try { const res = await fn(); if (okMessage) toast.success(typeof okMessage === 'function' ? okMessage(res) : okMessage); refetch(); onChanged?.(); return res; } catch (err) { toast.error(err); return null; } finally { setBusy(null); }
  };
  const link = () => run('link', () => api.post(`/dns/zones/${domain}/cloudflare/link`), (r) => `Linked to Cloudflare zone ${r.data.remote?.name} (${r.data.remote?.status})`);
  const unlink = async () => {
    if (!(await confirm({ title: `Unlink ${domain} from Cloudflare?`, message: 'The panel stops pushing changes. Records already at Cloudflare are left as they are.', confirmLabel: 'Unlink', danger: true }))) return;
    run('unlink', () => api.post(`/dns/zones/${domain}/cloudflare/unlink`), 'Zone unlinked; BIND is the only provider again');
  };
  const doImport = async () => {
    if (!(await confirm({ title: `Import records from Cloudflare into ${domain}?`, message: 'Every record of the panel zone except the SOA and the apex NS records is replaced by what Cloudflare holds, then written to BIND. Record types BIND cannot hold (HTTPS, apex CNAME…) are skipped and listed.', confirmLabel: 'Import' }))) return;
    const res = await run('import', () => api.post(`/dns/zones/${domain}/cloudflare/import`), (r) => `Imported ${r.data.imported} record(s)${r.data.skipped ? `, ${r.data.skipped} skipped` : ''}`);
    if (res) setLast(res.data);
  };
  const push = async () => {
    if (!(await confirm({ title: `Push ${domain} to Cloudflare?`, message: 'Records missing at Cloudflare are created, TTL/priority differences updated and records the panel does not have are deleted. Proxied (orange cloud) settings are kept; record types the panel does not manage are left alone.', confirmLabel: 'Push' }))) return;
    const res = await run('push', () => api.post(`/dns/zones/${domain}/cloudflare/push`));
    if (res) setJobId(res.data.job.id);
  };
  if (!domain) return null;
  if (loading && !data) return <Card title="Cloudflare"><Loading /></Card>;
  if (error) return <Card title="Cloudflare"><ErrorBanner error={error} onRetry={refetch} /></Card>;
  if (!data) return null;
  const linked = data.provider === 'cloudflare';
  return (
    <Card title={<><Cloud size={16} style={{ verticalAlign: '-3px', marginRight: 6 }} />Cloudflare</>} actions={<ProviderBadge zone={{ provider: data.provider, cloudflare_status: data.status }} />}>
      {!data.configured && <p className="muted">Cloudflare is not connected on this server{linked ? '; changes to this zone are not pushed until the root administrator saves a token' : ''}.</p>}
      {data.lastError && <div className="banner banner-error"><div><strong>Last Cloudflare sync failed</strong><p>{data.lastError}</p></div></div>}
      {data.pendingRetry && <div className="banner banner-warning"><div><strong>Retry scheduled</strong><p>Attempt {data.pendingRetry.attempt} runs at {formatDate(data.pendingRetry.at)} as a new job; this card refreshes until it finishes.</p></div></div>}
      {linked ? (
        <KeyValue items={[
          ['Cloudflare zone ID', <code key="z">{data.cloudflareZoneId}</code>],
          ['Sync state', SYNC_LABEL[data.status] || data.status || '—'],
          ['Last sync', data.syncedAt ? formatDate(data.syncedAt) : 'never'],
        ]} />
      ) : data.canLink ? (
        <p className="muted">This zone is served by BIND only. Link it to the zone of the same name in the Cloudflare account to mirror it; then import Cloudflare's records here or push the panel's records there. Point the domain's nameservers at Cloudflare once the records match.</p>
      ) : (
        <p className="muted">This zone is served by BIND only. Linking a zone to the Cloudflare account is done by the root administrator; once linked, you can import and push it here.</p>
      )}
      <FormActions>
        {!linked && data.canLink && <Button variant="primary" onClick={link} loading={busy === 'link'} disabled={!data.configured}>Link to Cloudflare</Button>}
        {linked && <Button onClick={doImport} loading={busy === 'import'} disabled={!data.configured}>Import from Cloudflare</Button>}
        {linked && <Button variant="primary" onClick={push} loading={busy === 'push'} disabled={!data.configured}>Push to Cloudflare</Button>}
        {linked && data.canLink && <Button variant="danger" onClick={unlink} loading={busy === 'unlink'}>Unlink</Button>}
      </FormActions>
      {last?.skippedRecords?.length > 0 && (
        <div className="banner banner-warning"><div><strong>{last.skippedRecords.length} record(s) were not imported</strong><ul>{last.skippedRecords.map((s, i) => <li key={i}><code>{s.type} {s.name}</code> — {s.reason}</li>)}</ul></div></div>
      )}
      {jobId && <ProgressLog jobId={jobId} onFinished={(event) => { refetch(); if (event.type === 'done') toast.success('Push finished'); }} />}
      {data.log?.length > 0 && (
        <DataTable
          columns={[
            { key: 'created_at', label: 'When', width: 170, render: (l) => formatDate(l.created_at) },
            { key: 'action', label: 'Action', width: 90 },
            { key: 'status', label: 'Result', width: 110, render: (l) => <StatusPill status={l.status}>{l.status}{l.attempt > 1 ? ` (attempt ${l.attempt})` : ''}</StatusPill> },
            { key: 'summary', label: 'Details', render: (l) => (l.message ? <span className="field-message">{l.message}</span> : l.summary ? <span className="muted" style={{ fontSize: 12 }}>{Object.entries(l.summary).filter(([, v]) => typeof v !== 'object').map(([k, v]) => `${k} ${v}`).join(' · ')}</span> : '') },
            { key: 'principal', label: 'By', width: 110, render: (l) => l.principal || <span className="muted">job</span> },
          ]}
          rows={data.log} rowKey={(l) => l.id} dense
        />
      )}
    </Card>
  );
}
