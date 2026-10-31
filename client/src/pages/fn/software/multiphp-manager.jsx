import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, queryString } from '../../../api/client.js';
import { useApi } from '../../../hooks/useApi.js';
import { useAuth } from '../../../auth/AuthContext.jsx';
import { PageHeader, Card, StatusPill, Loading } from '../../../components/Common.jsx';
import { DataTable, useTableState } from '../../../components/DataTable.jsx';
import { Field, Select, Button, ErrorBanner } from '../../../components/Form.jsx';
import { useConfirm } from '../../../components/Modal.jsx';
import { useToast } from '../../../components/Toast.jsx';
import { RequestError, PhpVersionPill, useJobRunner, JobPanel, JobHistory } from '../../software/Shared.jsx';

// Which action a catalog row offers and why it may be disabled; the server
// decides for real (409 for the default / a used version, 501 without a
// package manager), this only keeps the buttons honest.
export function phpRowAction(v, source) {
  if (v.installed) {
    if (v.removable) return { kind: 'remove', disabled: false, reason: null };
    const reason = v.isDefault ? 'system default' : v.isCliDefault ? 'CLI default (/usr/bin/php)' : v.inUse ? `used by ${v.inUseDetail || `${v.inUse} domain${v.inUse === 1 ? '' : 's'}`}` : 'not a versioned package set';
    return { kind: 'remove', disabled: true, reason };
  }
  if (v.offered) return { kind: 'install', disabled: false, reason: null };
  if (source?.supported && !source.configured) return { kind: 'install', disabled: false, reason: `enables ${source.label} first` };
  return { kind: 'install', disabled: true, reason: source?.configured ? `not offered by ${source.label}` : source?.reason || 'no PHP package source for this host' };
}

// apt/dnf hold one lock: every row waits while a request is in flight or the
// started job is still running (the server refuses a second job as well).
export const phpRowLocked = (action, runner) => Boolean(action.disabled || runner?.busy || runner?.running);

// Install a PHP version: every branch the family's package source can offer
// (ppa:ondrej/php on Ubuntu, packages.sury.org on Debian, Remi on the RHEL
// family) with an install job per branch and a removal for spare ones.
export function PhpInstallCard({ enabled = true, onChanged }) {
  const confirm = useConfirm();
  const installable = useApi('/software/php/installable', { enabled });
  const runner = useJobRunner({ onFinished: () => { installable.refetch(); onChanged?.(); } });
  const [pending, setPending] = useState(null);
  const d = installable.data;
  const source = d?.source;

  const install = async (v) => {
    const note = v.offered ? '' : source?.configured ? ` ${source.label} does not offer it on this host; the job reports that and stops.` : ` ${source?.label || 'The PHP package source'} is enabled first and the package index refreshed (and removed again should the refresh fail).`;
    if (!(await confirm({ title: `Install PHP ${v.version}?`, message: `PHP-FPM, the CLI and the common extensions (MySQL, GD, mbstring, XML, zip, intl, bcmath, SOAP, opcache; those the repository does not ship are skipped) are installed with the package manager as a background job and the FPM unit is enabled.${note} Domains, new accounts and the system default keep their current version; if the install moves /usr/bin/php to the new branch, the job points it back.`, confirmLabel: `Install PHP ${v.version}` }))) return;
    setPending(v.version);
    try { await runner.start(() => api.post('/software/php/install', { version: v.version }), `Install PHP ${v.version}`); } finally { setPending(null); }
  };
  const remove = async (v) => {
    if (!(await confirm({ title: `Remove PHP ${v.version}?`, message: `The ${v.id} package set is purged (packages and their configuration tree) after its ${v.fpmUnit || 'PHP-FPM'} unit is stopped. Only a version that no domain, rendered vhost, PHP-FPM pool, hosting package or the Apache web default uses, and that is neither the system nor the CLI default, can be removed; the server checks all of that again when the job starts.`, confirmLabel: 'Remove', danger: true, typeToConfirm: v.id }))) return;
    setPending(v.version);
    try { await runner.start(() => api.delete(`/software/php/versions/${encodeURIComponent(v.id)}`), `Remove PHP ${v.version}`); } finally { setPending(null); }
  };

  return (
    <>
      <Card title="Install a PHP version" subtitle="Add another PHP branch next to the installed ones. The package manager does the work as a background job; the log appears below."
        actions={<>
          {source && <StatusPill status={source.configured ? 'ok' : source.supported ? 'inactive' : 'not-installed'}>{source.label ? `${source.label} · ${source.configured ? 'enabled' : source.supported ? 'not enabled yet' : 'unavailable'}` : 'no PHP source for this host'}</StatusPill>}
          <Button size="sm" onClick={() => installable.refetch()} loading={installable.loading && Boolean(d)}>Re-check</Button>
        </>}>
        <RequestError error={installable.error} onRetry={installable.refetch} />
        {installable.loading && !d && <Loading text="Asking the package manager which PHP versions it offers…" />}
        {d && (
          <>
            <p className="muted small">
              {d.os?.name || d.family}{d.os?.codename ? ` (${d.os.codename})` : ''} · {d.manager || 'no package manager'}{d.stock ? ` · the distribution's own branch is PHP ${d.stock}` : ''}
              {source?.url && <> · source: <a href={source.url} target="_blank" rel="noreferrer noopener">{source.url}</a></>}
              {source && !source.configured && source.supported && <> — enabled automatically on the first install of a version the distribution does not ship.</>}
              {source && !source.supported && source.reason && <> — {source.reason}</>}
            </p>
            <div className="table-wrap">
              <table>
                <thead><tr><th>Version</th><th>Status</th><th>Source</th><th>In use by</th><th className="actions-col">Action</th></tr></thead>
                <tbody>
                  {d.versions.map((v) => {
                    const action = phpRowAction(v, source);
                    const busy = runner.busy && pending === v.version;
                    return (
                      <tr key={v.id}>
                        <td><strong>{v.label || `PHP ${v.version}`}</strong>{v.stock && <> <StatusPill status="info">distribution</StatusPill></>}<PhpAdvisoryBadge advisories={v.advisories} /></td>
                        <td>
                          {v.installed ? <StatusPill status="installed">installed{v.installedVersion ? ` · ${v.installedVersion}` : ''}</StatusPill> : v.offered ? <StatusPill status="pending">available{v.candidate ? ` · ${v.candidate}` : ''}</StatusPill> : <StatusPill status="not-installed">not offered</StatusPill>}
                          {v.isDefault && <> <StatusPill status="ok">system default</StatusPill></>}
                          {v.isCliDefault && !v.isDefault && <> <StatusPill status="info">CLI</StatusPill></>}
                        </td>
                        <td className="small">{v.source === 'distro' ? 'distribution' : v.source || (v.installed ? v.layout || '—' : '—')}</td>
                        <td className="small">{v.inUseDetail || (v.inUse ? `${v.inUse}` : '—')}</td>
                        <td className="actions-col">
                          {action.kind === 'install'
                            ? <Button size="sm" variant="primary" loading={busy} disabled={phpRowLocked(action, runner)} title={action.reason || undefined} onClick={() => install(v)}>Install</Button>
                            : <Button size="sm" variant="danger" loading={busy} disabled={phpRowLocked(action, runner)} title={action.reason || undefined} onClick={() => remove(v)}>Remove</Button>}
                          {action.reason && <div className="muted small">{action.reason}</div>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <ErrorBanner error={runner.error} />
          </>
        )}
      </Card>
      <JobPanel runner={runner} title="PHP install log" />
      {d?.recent?.length > 0 && <Card title="Previous PHP installs and removals"><JobHistory jobs={d.recent} onSelect={(id) => runner.setJobId(id)} /></Card>}
    </>
  );
}

// Security Center's advisory rules (setting security.advisories) mark versions
// with a known vulnerability; the Security Advisor page carries the details.
export function PhpAdvisoryBadge({ advisories }) {
  if (!Array.isArray(advisories) || !advisories.length) return null;
  const worst = advisories.find((a) => a.grade === 'critical') || advisories[0];
  const fixes = [...new Set(advisories.map((a) => a.fixedIn).filter(Boolean))];
  const title = advisories.map((a) => `${a.id}: ${a.title}`).join('\n');
  return (
    <span title={title} style={{ marginLeft: 6 }}>
      <StatusPill status={worst.grade === 'critical' ? 'failed' : worst.unknown ? 'unknown' : 'warning'}>
        {advisories.length === 1 ? worst.id : `${advisories.length} advisories`}{fixes.length ? ` · update to ${fixes.join(', ')}` : ' · no fix for this branch'}
      </StatusPill>
      {' '}<Link className="small" to="/security-center/security-advisor">details</Link>
    </span>
  );
}

export default function MultiPhpManager({ fn }) {
  const toast = useToast();
  const confirm = useConfirm();
  const { user } = useAuth();
  const navigate = useNavigate();
  const isRoot = user?.role === 'root';
  const versions = useApi('/software/php/versions');
  const table = useTableState({ pageSize: 50, sort: 'domain', dir: 'asc' });
  const domains = useApi(`/software/php/domains${queryString(table.state)}`);
  const pools = useApi('/software/php/pools', { enabled: isRoot });
  const [defaultDraft, setDefaultDraft] = useState('');
  const [bulkVersion, setBulkVersion] = useState('');
  const [selected, setSelected] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const runner = useJobRunner({ onFinished: () => { versions.refetch(); domains.refetch(); } });

  const installed = versions.data?.versions || [];
  const options = installed.map((v) => ({ value: v.id, label: `${v.label || v.id}${v.version ? ` (${v.version})` : ''}${v.isDefault ? ' · CLI default' : ''}` }));
  const current = versions.data?.effectiveDefault;
  const rows = domains.data?.domains || [];

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
                {installed.length === 0 && <tr><td colSpan={5} className="table-state">No PHP installation found. Install a version with the card below, or build a web stack with <Link to="/software/easyapache-4">EasyApache 4</Link>.</td></tr>}
                {installed.map((v) => (
                  <tr key={v.id}>
                    <td><strong>{v.label || v.id}</strong> <span className="muted small">{v.version}</span> <PhpAdvisoryBadge advisories={v.advisories} /></td>
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
      {isRoot && <PhpInstallCard onChanged={() => { versions.refetch(); domains.refetch(); pools.refetch(); }} />}
      <Card title="PHP version per domain" subtitle={domains.data ? `${domains.meta?.total ?? domains.data.domains.length} domains · system default ${domains.data.systemDefault.effective || 'not set'}` : undefined} padded={false}>
        <RequestError error={domains.error} onRetry={domains.refetch} />
        {selected.length > 0 && (
          <div className="action-row" style={{ padding: '12px 16px 0', display: 'flex', gap: 8, alignItems: 'center' }}>
            <Select value={bulkVersion} onChange={setBulkVersion} options={[{ value: '', label: 'Inherit system default' }, ...options]} />
            <Button variant="primary" loading={busy} onClick={() => apply(selected, bulkVersion)}>Apply to {selected.length} selected</Button>
          </div>
        )}
        <DataTable dense searchable q={table.state.q} onSearch={table.setSearch} searchPlaceholder="Filter by domain or account" total={domains.meta?.total ?? null} page={table.state.page} pageSize={table.state.pageSize} onPageChange={table.setPage} sort={table.state.sort} dir={table.state.dir} onSortChange={table.setSort} selectable selected={selected} onSelectedChange={setSelected} rowKey={(d) => d.domain} loading={domains.loading} rows={rows}
          columns={[
            { key: 'domain', label: 'Domain', sortable: true, render: (d) => <><code>{d.domain}</code>{d.suspended && <StatusPill status="suspended">suspended</StatusPill>}</> },
            { key: 'account', label: 'Account', sortable: true },
            { key: 'type', label: 'Type' },
            { key: 'effective', label: 'PHP version', sortable: true, render: (d) => <PhpVersionPill version={d.effective} inherited={d.inherited} /> },
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
