import { useEffect, useState } from 'react';
import { api } from '../../../api/client.js';
import { useApi } from '../../../hooks/useApi.js';
import { PageHeader, Card, Loading, StatusPill, KeyValue, formatDate } from '../../../components/Common.jsx';
import { DataTable } from '../../../components/DataTable.jsx';
import { Field, Select, TextInput, NumberInput, Toggle, Button, FormActions, RadioGroup } from '../../../components/Form.jsx';
import { ProgressLog } from '../../../components/ProgressLog.jsx';
import { useConfirm } from '../../../components/Modal.jsx';
import { useToast } from '../../../components/Toast.jsx';
import { RequestError, Tabs, ExpiryPill, StatePill, isCapabilityError } from '../../ssl/Shared.jsx';

export default function ManageAutossl({ fn }) {
  const toast = useToast();
  const confirm = useConfirm();
  const { data, loading, error, refetch } = useApi('/ssl/autossl');
  const runs = useApi('/ssl/autossl/runs?limit=20');
  const [tab, setTab] = useState('providers');
  const [draft, setDraft] = useState(null);
  const [busy, setBusy] = useState(false);
  const [jobId, setJobId] = useState(null);
  const [exclusion, setExclusion] = useState({ kind: 'domain', value: '', reason: '' });
  const [runFor, setRunFor] = useState('');
  const [openRun, setOpenRun] = useState(null);

  useEffect(() => { if (data) setDraft(data.settings); }, [data]);

  const save = async () => {
    setBusy(true);
    try {
      await api.put('/ssl/autossl/settings', { provider: draft.provider, email: draft.email || '', method: draft.method, staging: Boolean(draft.staging), keyType: draft.keyType, renewDays: Number(draft.renewDays), includeWww: Boolean(draft.includeWww), replaceCustom: Boolean(draft.replaceCustom) });
      toast.success(draft.provider === 'disabled' ? 'AutoSSL disabled' : `AutoSSL uses ${draft.provider}`);
      refetch();
    } catch (err) { toast.error(isCapabilityError(err) ? `${err.message}` : err); } finally { setBusy(false); }
  };
  const runNow = async (force = false) => {
    if (force && !(await confirm({ title: 'Force renewal?', message: 'Every eligible certificate is re-issued even if it is far from expiry. Let\'s Encrypt rate-limits duplicate certificates (5 per week per name set).', confirmLabel: 'Force run', danger: true }))) return;
    setBusy(true);
    try {
      const { data: d } = await api.post('/ssl/autossl/run', { ...(runFor ? { domain: runFor } : {}), force });
      setJobId(d.job.id);
      setTab('log');
    } catch (err) { toast.error(err); } finally { setBusy(false); }
  };
  const addExclusion = async () => {
    try { await api.post('/ssl/autossl/exclusions', { kind: exclusion.kind, value: exclusion.value.trim(), ...(exclusion.reason ? { reason: exclusion.reason } : {}) }); setExclusion({ kind: 'domain', value: '', reason: '' }); toast.success('Excluded'); refetch(); } catch (err) { toast.error(err); }
  };
  const removeExclusion = async (e) => { try { await api.delete(`/ssl/autossl/exclusions/${e.id}`); refetch(); } catch (err) { toast.error(err); } };

  const providerOptions = data ? [
    { value: 'disabled', label: 'Disabled', description: 'No automatic issuance. Certificates are installed by hand.' },
    { value: 'certbot', label: `Let's Encrypt via certbot ${data.detect.certbot ? '' : '(not installed)'}`, description: 'The EFF client. Certificates live in /etc/letsencrypt and are mirrored to /etc/ssl/whm.' },
    { value: 'acme.sh', label: `Let's Encrypt via acme.sh ${data.detect.acmeSh ? '' : '(not installed)'}`, description: 'Shell-only ACME client. Found in PATH or /root/.acme.sh.' },
  ] : [];

  return (
    <>
      <PageHeader fn={fn} actions={data && <Button variant="primary" loading={busy} disabled={data.settings.provider === 'disabled'} onClick={() => runNow(false)}>Run AutoSSL now</Button>} />
      <RequestError error={error} onRetry={refetch} />
      {loading && !data && <Loading />}
      {data && draft && (
        <>
          <div className="stat-grid">
            {[['Domains', data.summary.domains], ['Secured', data.summary.secured], ['Via AutoSSL', data.summary.autossl], ['Expiring soon', data.summary.expiring], ['Excluded', data.summary.excluded]].map(([k, v]) => <div className="stat" key={k}><span className="muted">{k}</span><strong>{v}</strong></div>)}
          </div>
          <Tabs value={tab} onChange={setTab} tabs={[{ value: 'providers', label: 'Providers' }, { value: 'options', label: 'Options' }, { value: 'coverage', label: 'Manage domains', count: data.coverage.length }, { value: 'exclusions', label: 'Exclusions', count: data.exclusions.length }, { value: 'log', label: 'Runs & log', count: runs.data?.length }]} />

          {tab === 'providers' && (
            <Card title="Provider" subtitle={data.detect.providers.length ? `Installed ACME clients: ${data.detect.providers.join(', ')}.` : 'No ACME client is installed. Install certbot (apt install certbot / dnf install certbot) or acme.sh, then select it here.'}>
              <RadioGroup name="provider" value={draft.provider} onChange={(v) => setDraft({ ...draft, provider: v })} options={providerOptions} />
              <Field label="Account email" help="Expiry notices from the CA go here. Optional for certbot (registered without email) and acme.sh."><TextInput type="email" value={draft.email} onChange={(v) => setDraft({ ...draft, email: v })} placeholder="hostmaster@example.com" /></Field>
              <KeyValue items={[
                ['Daily schedule', data.schedule ? <span key="s"><code>{data.schedule.cron}</code> <StatusPill status={data.schedule.enabled ? 'enabled' : 'disabled'} /> {data.schedule.nextRunAt ? `next ${formatDate(data.schedule.nextRunAt)}` : ''}</span> : '—'],
                ['Last run', data.lastRun ? <span key="l"><StatusPill status={data.lastRun.status} /> {formatDate(data.lastRun.startedAt)} — issued {data.lastRun.summary.issued ?? 0}, renewed {data.lastRun.summary.renewed ?? 0}, failed {data.lastRun.summary.failed ?? 0}</span> : 'never'],
              ]} />
              <FormActions><Button variant="primary" loading={busy} onClick={save}>Save</Button></FormActions>
            </Card>
          )}

          {tab === 'options' && (
            <Card title="Issuance options">
              <Field label="Validation method" help="Webroot writes the challenge into each domain's document root (web server must serve it). Standalone binds port 80 itself: only when no web server runs.">
                <Select value={draft.method} onChange={(v) => setDraft({ ...draft, method: v })} options={[{ value: 'webroot', label: 'HTTP-01 via document root (webroot)' }, { value: 'standalone', label: 'HTTP-01 standalone (port 80 must be free)' }]} />
              </Field>
              <Field label="Key type"><Select value={draft.keyType} onChange={(v) => setDraft({ ...draft, keyType: v })} options={[{ value: 'ecdsa', label: 'ECDSA P-256 (smaller, faster)' }, { value: 'rsa', label: 'RSA 2048' }]} /></Field>
              <Field label="Renew when fewer than (days) remain" help="Let's Encrypt certificates last 90 days; 30 is the recommended renewal window."><NumberInput value={draft.renewDays} onChange={(v) => setDraft({ ...draft, renewDays: v })} min={1} max={89} nullable={false} /></Field>
              <Field inline><Toggle checked={draft.includeWww} onChange={(v) => setDraft({ ...draft, includeWww: v })} label="Also cover www.<domain>" description="Skipped for subdomains. The www name must resolve to this server or validation fails for the whole certificate." /></Field>
              <Field inline><Toggle checked={draft.replaceCustom} onChange={(v) => setDraft({ ...draft, replaceCustom: v })} label="Replace manually installed certificates" description="Off: domains with a custom (purchased or self-signed) certificate are left alone until it expires." /></Field>
              <Field inline><Toggle checked={draft.staging} onChange={(v) => setDraft({ ...draft, staging: v })} label="Use the staging CA" description="Issues untrusted test certificates without rate limits. Turn off for production." /></Field>
              <FormActions><Button variant="primary" loading={busy} onClick={save}>Save</Button></FormActions>
            </Card>
          )}

          {tab === 'coverage' && (
            <Card padded={false} title="Domains" subtitle="Every domain the panel knows about and whether AutoSSL will act on it during the next pass.">
              <DataTable dense columns={[
                { key: 'domain', label: 'Domain', render: (d) => <code>{d.domain}</code> },
                { key: 'account', label: 'Account' },
                { key: 'type', label: 'Type' },
                { key: 'cert', label: 'Certificate', render: (d) => (d.certificate ? <span><StatePill state={d.certificate.state} /> {d.certificate.autossl ? 'AutoSSL' : 'manual'}</span> : <StatusPill status="inactive">none</StatusPill>) },
                { key: 'expires', label: 'Expires', render: (d) => <ExpiryPill notAfter={d.certificate?.notAfter} daysRemaining={d.certificate?.daysRemaining} /> },
                { key: 'next', label: 'Next pass', render: (d) => {
                  if (d.suspended) return <StatusPill status="suspended">skip: suspended</StatusPill>;
                  if (d.excluded) return <StatusPill status="disabled">skip: excluded ({d.excluded})</StatusPill>;
                  if (d.certificate && !d.certificate.autossl && !data.settings.replaceCustom && !d.certificate.expired) return <StatusPill status="inactive">skip: custom certificate</StatusPill>;
                  if (d.certificate?.autossl && d.certificate.daysRemaining > Number(data.settings.renewDays)) return <StatusPill status="ok">valid</StatusPill>;
                  return <StatusPill status="pending">{d.certificate ? 'renew' : 'issue'}</StatusPill>;
                } },
              ]} rows={data.coverage} rowKey={(d) => d.domain} emptyText="No accounts yet." rowActions={(d) => [
                { label: 'Run for this domain', primary: true, disabled: data.settings.provider === 'disabled', onClick: () => { setRunFor(d.domain); runNow(false); } },
                !d.excluded && { label: 'Exclude', onClick: () => api.post('/ssl/autossl/exclusions', { kind: 'domain', value: d.domain }).then(refetch).catch(toast.error) },
              ]} />
            </Card>
          )}

          {tab === 'exclusions' && (
            <div className="form-grid">
              <Card padded={false} title="Excluded accounts and domains">
                <DataTable dense columns={[
                  { key: 'kind', label: 'Kind' },
                  { key: 'value', label: 'Value', render: (e) => <code>{e.value}</code> },
                  { key: 'reason', label: 'Reason' },
                  { key: 'created_at', label: 'Since', render: (e) => formatDate(e.created_at) },
                ]} rows={data.exclusions} emptyText="Nothing is excluded." rowActions={(e) => [{ label: 'Include again', primary: true, onClick: () => removeExclusion(e) }]} />
              </Card>
              <Card title="Add an exclusion">
                <Field label="Kind"><Select value={exclusion.kind} onChange={(v) => setExclusion({ ...exclusion, kind: v })} options={[{ value: 'domain', label: 'Domain (and its subdomains)' }, { value: 'account', label: 'Account (all its domains)' }]} /></Field>
                <Field label={exclusion.kind === 'account' ? 'Username' : 'Domain'}><TextInput value={exclusion.value} onChange={(v) => setExclusion({ ...exclusion, value: v })} /></Field>
                <Field label="Reason"><TextInput value={exclusion.reason} onChange={(v) => setExclusion({ ...exclusion, reason: v })} placeholder="Customer supplies an EV certificate" /></Field>
                <FormActions><Button variant="primary" disabled={!exclusion.value.trim()} onClick={addExclusion}>Exclude</Button></FormActions>
              </Card>
            </div>
          )}

          {tab === 'log' && (
            <>
              <Card title="Run now" subtitle="Runs in the background; the log streams here. Scheduled passes run daily at the time shown under Providers.">
                <Field label="Limit to one domain (optional)"><Select value={runFor} onChange={setRunFor} placeholder="All domains" options={data.coverage.map((d) => d.domain)} /></Field>
                <FormActions>
                  <Button variant="primary" loading={busy} disabled={data.settings.provider === 'disabled'} onClick={() => runNow(false)}>Run</Button>
                  <Button variant="danger" loading={busy} disabled={data.settings.provider === 'disabled'} onClick={() => runNow(true)}>Force renewal</Button>
                </FormActions>
                {jobId && <ProgressLog jobId={jobId} onFinished={() => { refetch(); runs.refetch(); }} />}
              </Card>
              <Card padded={false} title="Previous runs">
                <DataTable dense columns={[
                  { key: 'startedAt', label: 'Started', render: (r) => formatDate(r.startedAt) },
                  { key: 'trigger', label: 'Trigger' },
                  { key: 'provider', label: 'Provider' },
                  { key: 'status', label: 'Status', render: (r) => <StatusPill status={r.status} /> },
                  { key: 'summary', label: 'Result', render: (r) => (r.status === 'skipped' ? r.summary.reason : `checked ${r.summary.checked ?? 0} · issued ${r.summary.issued ?? 0} · renewed ${r.summary.renewed ?? 0} · skipped ${r.summary.skipped ?? 0} · failed ${r.summary.failed ?? 0}`) },
                ]} rows={runs.data || []} emptyText="AutoSSL has not run yet." rowActions={(r) => [{ label: openRun === r.id ? 'Hide details' : 'Details', primary: true, onClick: () => setOpenRun(openRun === r.id ? null : r.id) }]} />
                {openRun && runs.data?.find((r) => r.id === openRun) && (
                  <div className="table-wrap" style={{ borderTop: '1px solid var(--border)' }}>
                    <table>
                      <thead><tr><th>Domain</th><th>Account</th><th>Action</th><th>Message</th></tr></thead>
                      <tbody>{runs.data.find((r) => r.id === openRun).entries.map((e) => <tr key={e.domain}><td><code>{e.domain}</code></td><td>{e.account}</td><td><StatusPill status={e.action === 'failed' ? 'failed' : e.action === 'skip' ? 'inactive' : 'ok'}>{e.action}</StatusPill></td><td className="small">{e.message}</td></tr>)}</tbody>
                    </table>
                  </div>
                )}
              </Card>
            </>
          )}
        </>
      )}
    </>
  );
}
