import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../../../api/client.js';
import { useApi } from '../../../hooks/useApi.js';
import { useAuth } from '../../../auth/AuthContext.jsx';
import { PageHeader, Card, StatusPill, Loading } from '../../../components/Common.jsx';
import { DataTable } from '../../../components/DataTable.jsx';
import { Field, Select, Button, ErrorBanner } from '../../../components/Form.jsx';
import { useConfirm } from '../../../components/Modal.jsx';
import { useToast } from '../../../components/Toast.jsx';
import { RequestError, PhpVersionPill, useJobRunner, JobPanel } from '../../software/Shared.jsx';

export default function MultiPhpManager({ fn }) {
  const toast = useToast();
  const confirm = useConfirm();
  const { user } = useAuth();
  const navigate = useNavigate();
  const isRoot = user?.role === 'root';
  const versions = useApi('/software/php/versions');
  const domains = useApi('/software/php/domains');
  const pools = useApi('/software/php/pools', { enabled: isRoot });
  const [defaultDraft, setDefaultDraft] = useState('');
  const [bulkVersion, setBulkVersion] = useState('');
  const [selected, setSelected] = useState([]);
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const runner = useJobRunner({ onFinished: () => { versions.refetch(); domains.refetch(); } });

  const installed = versions.data?.versions || [];
  const options = installed.map((v) => ({ value: v.id, label: `${v.label || v.id}${v.version ? ` (${v.version})` : ''}${v.isDefault ? ' · CLI default' : ''}` }));
  const current = versions.data?.effectiveDefault;
  const rows = (domains.data?.domains || []).filter((d) => !q || d.domain.includes(q.toLowerCase()) || d.account.includes(q.toLowerCase()));

  const setDefault = async () => {
    const version = defaultDraft || current;
    if (!(await confirm({ title: `Make ${version} the system default?`, message: 'The default is saved at once; every domain without an explicit version is then re-pinned to it through the web server by a background job (one vhost rewrite per domain, Apache reloaded at the end). The CLI /usr/bin/php alternative is updated when the distribution supports it. A default pinned in Apache Configuration takes precedence.', confirmLabel: 'Set default' }))) return;
    setBusy(true); setError(null);
    try {
      const { data } = await api.put('/software/php/default', { version });
      const web = data.web || {};
      const cliNote = data.cli.applied ? '' : ` (CLI link unchanged: ${data.cli.note})`;
      if (data.job) {
        runner.setJobId(data.job.id);
        toast.info(`System default PHP is now ${version}${cliNote}; job #${data.job.id} re-pins ${web.domains} inherited domain(s)`);
      } else {
        toast[web.state === 'applied' || web.state === 'not-loaded' || web.state === 'skipped' ? 'success' : 'warning'](`System default PHP is now ${version}${cliNote} — web: ${web.detail || web.state}`);
      }
      versions.refetch(); domains.refetch();
    } catch (err) { setError(err); toast.error(err); } finally { setBusy(false); }
  };
  const apply = async (list, version) => {
    setBusy(true); setError(null);
    try {
      const { data } = await api.put('/software/php/domains', { domains: list, version: version || null });
      if (data.job) {
        runner.setJobId(data.job.id);
        toast.info(`${list.length} domain(s) recorded as ${version || 'inherit'}; job #${data.job.id} applies them to the web server`);
      } else {
        const pending = data.results.filter((r) => r.web === 'recorded').length;
        const failed = data.results.filter((r) => r.web.startsWith('failed'));
        if (failed.length) toast.warning(`${list.length} domain(s) recorded, but the web server rejected ${failed[0].domain}: ${failed[0].web.replace(/^failed: /, '')}`);
        else toast.success(`${list.length} domain(s) set to ${version || 'inherit'}${pending ? ' (recorded; the web server category applies the handler when it is loaded)' : ''}`);
      }
      setSelected([]); domains.refetch();
    } catch (err) { setError(err); toast.error(err); } finally { setBusy(false); }
  };

  return (
    <>
      <PageHeader fn={fn} actions={<Link className="btn" to="/software/multiphp-ini-editor">INI editor</Link>} />
      <RequestError error={versions.error} onRetry={versions.refetch} />
      {versions.loading && !versions.data && <Loading text="Detecting PHP versions…" />}
      {versions.data && (
        <Card title="Installed PHP versions" subtitle="Detected from /etc/php/*, /opt/cpanel/ea-php*, Remi SCL and the stock php package." actions={<Button onClick={() => versions.refetch()}>Re-detect</Button>}>
          <div className="table-wrap">
            <table>
              <thead><tr><th>Version</th><th>Binary</th><th>PHP-FPM</th><th>php.ini</th><th>Default</th></tr></thead>
              <tbody>
                {installed.length === 0 && <tr><td colSpan={5} className="table-state">No PHP installation found. Add one with <Link to="/software/easyapache-4">EasyApache 4</Link> or Install Distro Packages.</td></tr>}
                {installed.map((v) => (
                  <tr key={v.id}>
                    <td><strong>{v.label || v.id}</strong> <span className="muted small">{v.version}</span></td>
                    <td><code className="small">{v.binary}</code></td>
                    <td>{v.fpmInstalled ? <StatusPill status={v.fpmActive ? 'active' : v.fpmActive === false ? 'inactive' : 'unknown'}>{v.fpmUnit}{v.fpmActive === false ? ' · stopped' : ''}</StatusPill> : <StatusPill status="not-installed">no FPM</StatusPill>}</td>
                    <td><code className="small">{v.iniPath || '—'}</code></td>
                    <td>{v.id === current && <StatusPill status="ok">system default</StatusPill>}{v.isDefault && v.id !== current && <StatusPill status="info">CLI</StatusPill>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {isRoot && installed.length > 0 && (
            <div className="form-grid" style={{ marginTop: 14, alignItems: 'end' }}>
              <Field label="System default PHP version" help="Used by every domain that does not override it.">
                <Select value={defaultDraft || current || ''} onChange={setDefaultDraft} options={options} />
              </Field>
              <div className="action-row"><Button variant="primary" loading={busy} disabled={(defaultDraft || current) === current} onClick={setDefault}>Apply default</Button></div>
            </div>
          )}
          <ErrorBanner error={error} />
        </Card>
      )}
      <JobPanel runner={runner} title="Applying PHP version to the web server" />
      <Card title="PHP version per domain" subtitle={domains.data ? `${domains.data.domains.length} domains · system default ${domains.data.systemDefault.effective || 'not set'}` : undefined} padded={false}>
        <RequestError error={domains.error} onRetry={domains.refetch} />
        {selected.length > 0 && (
          <div className="action-row" style={{ padding: '12px 16px 0', display: 'flex', gap: 8, alignItems: 'center' }}>
            <Select value={bulkVersion} onChange={setBulkVersion} options={[{ value: '', label: 'Inherit system default' }, ...options]} />
            <Button variant="primary" loading={busy} onClick={() => apply(selected, bulkVersion)}>Apply to {selected.length} selected</Button>
          </div>
        )}
        <DataTable dense searchable q={q} onSearch={setQ} searchPlaceholder="Filter by domain or account" selectable selected={selected} onSelectedChange={setSelected} rowKey={(d) => d.domain} loading={domains.loading} rows={rows}
          columns={[
            { key: 'domain', label: 'Domain', render: (d) => <><code>{d.domain}</code>{d.suspended && <StatusPill status="suspended">suspended</StatusPill>}</> },
            { key: 'account', label: 'Account' },
            { key: 'type', label: 'Type' },
            { key: 'effective', label: 'PHP version', render: (d) => <PhpVersionPill version={d.effective} inherited={d.inherited} /> },
            { key: 'set', label: 'Change', render: (d) => <Select value={d.phpVersion || ''} onChange={(v) => apply([d.domain], v)} options={[{ value: '', label: 'Inherit' }, ...options]} disabled={busy} /> },
          ]}
          rowActions={(d) => [{ label: 'INI', primary: true, onClick: () => navigate(`/software/multiphp-ini-editor?domain=${encodeURIComponent(d.domain)}`) }]}
          emptyText="No domains yet. Create an account to manage its PHP version." />
      </Card>
      {isRoot && pools.data && (
        <Card title="PHP-FPM pools" subtitle="Pool files found in each version's pool directory.">
          {pools.data.pools.length === 0 ? <p className="muted">No pool files found.</p> : (
            <div className="table-wrap">
              <table>
                <thead><tr><th>Version</th><th>Pool</th><th>User</th><th>Listen</th><th>pm</th><th>max_children</th></tr></thead>
                <tbody>{pools.data.pools.map((p) => <tr key={p.file}><td>{p.version}</td><td><code>{p.name}</code></td><td>{p.user || '—'}</td><td><code className="small">{p.listen || '—'}</code></td><td>{p.pm || '—'}</td><td>{p.maxChildren ?? '—'}</td></tr>)}</tbody>
              </table>
            </div>
          )}
        </Card>
      )}
    </>
  );
}
