import { useState } from 'react';
import { api } from '../../../api/client.js';
import { useApi } from '../../../hooks/useApi.js';
import { PageHeader, Card, StatusPill, Loading, formatDate } from '../../../components/Common.jsx';
import { DataTable } from '../../../components/DataTable.jsx';
import { Field, TextInput, Toggle, Button, FormActions } from '../../../components/Form.jsx';
import { ProgressLog } from '../../../components/ProgressLog.jsx';
import { useToast } from '../../../components/Toast.jsx';
import { useConfirm } from '../../../components/Modal.jsx';
import { RequestError } from '../../security/Shared.jsx';

const PRESETS = [
  { name: 'owasp-crs', label: 'OWASP Core Rule Set 4.x', url: 'https://github.com/coreruleset/coreruleset/archive/refs/tags/v4.7.0.tar.gz' },
  { name: 'comodo', label: 'Comodo WAF (requires your account URL)', url: '' },
];

export default function ModsecurityVendors({ fn }) {
  const toast = useToast();
  const confirm = useConfirm();
  const { data, loading, error, refetch } = useApi('/security/modsec');
  const [form, setForm] = useState({ name: '', url: '' });
  const [jobId, setJobId] = useState(null);
  const [busy, setBusy] = useState(false);

  const install = async () => {
    setBusy(true);
    try { const { data: d } = await api.post('/security/modsec/vendors', { name: form.name.trim(), url: form.url.trim() }); setJobId(d.job.id); toast.info(`Installing ${form.name}…`); setForm({ name: '', url: '' }); } catch (err) { toast.error(err); } finally { setBusy(false); }
  };
  const update = async (v) => { try { const { data: d } = await api.post(`/security/modsec/vendors/${v.name}/update`); setJobId(d.job.id); } catch (err) { toast.error(err); } };
  const toggle = async (v, enabled) => { try { await api.patch(`/security/modsec/vendors/${v.name}`, { enabled }); toast.success(`${v.name} ${enabled ? 'enabled' : 'disabled'}; Apache reloaded`); refetch(); } catch (err) { toast.error(err); } };
  const remove = async (v) => {
    if (!(await confirm({ title: `Remove vendor "${v.name}"?`, message: 'Its rule files are deleted and Apache is reloaded without them.', confirmLabel: 'Remove', danger: true }))) return;
    try { await api.delete(`/security/modsec/vendors/${v.name}`); toast.success('Vendor removed'); refetch(); } catch (err) { toast.error(err); }
  };

  return (
    <>
      <PageHeader fn={fn} />
      <RequestError error={error} onRetry={refetch} />
      {loading && !data && <Loading />}
      {data && !data.installed && <RequestError error={{ status: 501, code: 'capability_missing', message: 'ModSecurity is not installed on this server.' }} onRetry={refetch} />}
      {data && data.installed && (
        <>
          <Card title="Installed vendors" padded={false}>
            <DataTable columns={[
              { key: 'name', label: 'Vendor', render: (v) => <code>{v.name}</code> },
              { key: 'url', label: 'Source', render: (v) => <a href={v.url} target="_blank" rel="noreferrer" className="small">{v.url}</a> },
              { key: 'installed_at', label: 'Installed / updated', render: (v) => formatDate(v.installed_at) },
              { key: 'enabled', label: 'Enabled', render: (v) => <Toggle checked={v.enabled} onChange={(on) => toggle(v, on)} /> },
            ]} rows={data.vendors} rowKey={(v) => v.name} emptyText="No vendor rule sets installed. Add the OWASP Core Rule Set below."
              rowActions={(v) => [{ label: 'Update', primary: true, onClick: () => update(v) }, { label: 'Remove', danger: true, onClick: () => remove(v) }]} />
          </Card>
          {jobId && <Card title="Installation progress"><ProgressLog jobId={jobId} onFinished={() => refetch()} /></Card>}
          <Card title="Add a vendor" subtitle="A .tar.gz, .tar.bz2, .tar.xz, .tar or .zip archive over https containing the rule files (a rules/ directory and optional crs-setup.conf). Downloaded, extracted and validated with apachectl -t before Apache is reloaded.">
            {data.layout?.distroCrs?.active && (
              <div className="banner banner-warning" style={{ marginBottom: 10 }}>
                <div>
                  <strong>The distribution's OWASP Core Rule Set is already loaded</strong> by <code>{data.layout.distroCrs.file}</code> (<code>{data.layout.distroCrs.directive}</code>). Installing the OWASP CRS preset as a vendor would define the same rule ids twice, so <code>apachectl -t</code> rejects it and the install is rolled back. Disable that include first (on Debian: comment it out in <code>security2.conf</code>), or add only vendors that do not duplicate the packaged CRS.
                </div>
              </div>
            )}
            <div className="row-actions" style={{ marginBottom: 10 }}>
              {PRESETS.map((p) => <Button key={p.name} size="sm" disabled={p.name === 'owasp-crs' && Boolean(data.layout?.distroCrs?.active)} onClick={() => setForm({ name: p.name, url: p.url })}>{p.label}</Button>)}
            </div>
            <div className="form-grid">
              <Field label="Name" required help="Lowercase identifier"><TextInput value={form.name} onChange={(v) => setForm({ ...form, name: v })} placeholder="owasp-crs" /></Field>
              <Field label="Archive URL (https)" required><TextInput value={form.url} onChange={(v) => setForm({ ...form, url: v })} placeholder="https://…/rules.tar.gz" /></Field>
            </div>
            <FormActions><Button variant="primary" loading={busy} disabled={!form.name.trim() || !form.url.trim()} onClick={install}>Install</Button></FormActions>
            <p className="muted">Engine status: <StatusPill status={data.effective.SecRuleEngine === 'On' ? 'ok' : 'warning'}>{data.effective.SecRuleEngine || 'Off'}</StatusPill></p>
          </Card>
        </>
      )}
    </>
  );
}
