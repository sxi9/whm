import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api, queryString } from '../../../api/client.js';
import { useApi } from '../../../hooks/useApi.js';
import { useAuth } from '../../../auth/AuthContext.jsx';
import { PageHeader, Card, StatusPill, Loading, formatDate } from '../../../components/Common.jsx';
import { DataTable, useTableState } from '../../../components/DataTable.jsx';
import { Select, Toggle, Button, ErrorBanner } from '../../../components/Form.jsx';
import { useConfirm } from '../../../components/Modal.jsx';
import { useToast } from '../../../components/Toast.jsx';
import { RequestError, PhpVersionPill, useJobRunner, JobPanel, runtimeInstallBody, CodeList, SourceBuildPill, sourceBuildMessage, PHP_SOURCE_PREFIX } from '../../software/Shared.jsx';

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

const STATE_PILL = {
  installed: ['installed', 'Installed'],
  available: ['info', 'Available'],
  unsupported: ['failed', 'Not available for this OS'],
  unknown: ['unknown', 'Unknown'],
};

export function PhpStatePill({ state }) {
  const [status, text] = STATE_PILL[state] || STATE_PILL.unknown;
  return <StatusPill status={status}>{text}</StatusPill>;
}

// Why a version cannot be removed right now; null when it can.
export function removeBlocker(v, installedCount = 2) {
  if (!v.installed) return null;
  if (v.isSystemDefault) return 'This is the system default; set another version as default first';
  if (v.isDefault) return 'This is the CLI default (/usr/bin/php); set another version as default first';
  if (installedCount < 2) return 'This is the only installed version; install another one first';
  if (v.domains > 0) return `${v.domains} domain(s) run this version; move them to another version first`;
  if (v.webDefault) return 'Apache Configuration pins this version as the web default; change it there first';
  if (v.plans > 0) return `${v.plans} package(s) default to this version; change them first`;
  if (v.vhosts > 0) return `${v.vhosts} web vhost(s) are rendered with this version; move them first`;
  return null;
}

// The packages a refused removal would have taken with the version (422 with
// fields.extra from POST /software/php/remove); null for any other error.
export function removalExtras(err) {
  const extra = err?.status === 422 ? err?.fields?.extra : null;
  return Array.isArray(extra) && extra.length ? extra.filter((p) => typeof p === 'string') : null;
}

// The Remove confirm: the plain removal, or, with the simulated extra
// packages, the "Remove anyway" step a root may take after the refusal.
export function removeConfirm(v, extra = null) {
  const label = v.label || `PHP ${v.id}`;
  if (extra?.length) {
    const apps = [...new Set(extra.map((p) => (/^roundcube/.test(p) ? 'webmail' : /^phpmyadmin/i.test(p) ? 'phpMyAdmin' : null)).filter(Boolean))];
    return {
      title: `Remove ${label} anyway?`,
      message: <>The package manager would also remove <CodeList names={extra} />{apps.length ? <> — {apps.join(' and ')} on the server hostname site would stop answering until published on another version</> : null}. Move what depends on PHP {v.id} to another version first, or remove it anyway (the removal is audited as forced).</>,
      confirmLabel: 'Remove anyway',
      danger: true,
    };
  }
  const message = v.source
    ? `Stops and removes the keel-php${v.id}-fpm service, the php${v.id} link in /usr/local/bin and the whole build under ${PHP_SOURCE_PREFIX}/${v.id}. Nothing runs on it (no domain is pinned to it and it is not the system default).`
    : `Removes every php${v.id}-* package; /etc/php/${v.id} is kept. Nothing runs on it (no domain is pinned to it and it is not the system default). The removal is simulated first and refused when other packages (webmail, phpMyAdmin) would go with it.`;
  return { title: `Remove ${label}?`, message, confirmLabel: 'Remove', danger: true };
}

// The offered list after toggling one version; null (= every installed version)
// is expanded to the installed ids so the server gets an explicit list.
export function toggleOffered(catalog, id, on) {
  const installed = (catalog?.versions || []).filter((v) => v.installed).map((v) => v.id);
  const current = catalog?.offered == null ? installed : catalog.offered.filter((x) => installed.includes(x));
  const next = on ? [...new Set([...current, id])] : current.filter((x) => x !== id);
  return installed.filter((x) => next.includes(x));
}

const versionLabel = (v) => `${v.label || `PHP ${v.id}`}${v.version ? ` (${v.version})` : ''}`;

// What the row's Update button sends (POST /software/php/update, contract §63).
export const phpUpdateBody = (v) => ({ version: v.id });

// Confirm copy for an installed row with a candidate.
export function phpUpdateMessage(v) {
  const u = v.update || {};
  const reasons = u.reasons?.length ? ` ${u.reasons.join(' ')}` : '';
  return v.source || v.layout === 'keel'
    ? `Rebuilds PHP ${v.id} from the official php.net ${u.candidate} source over ${PHP_SOURCE_PREFIX}/${v.id} (about 15 minutes) and restarts keel-php${v.id}-fpm.${reasons}`
    : `Upgrades the pending php${v.id}-* packages to ${u.candidate} and reloads ${v.fpmUnit || 'PHP-FPM'}.${reasons}`;
}

// "Check for updates": a fresh php.net lookup and OS update check on the
// server, then the caller's catalog again so every row shows the new verdict.
export async function checkForUpdates(refetch) {
  await api.post('/software/updates/critical/refresh');
  await refetch?.();
}

// The update state of an installed row (null for one that is not installed):
// the row's `update` wins; without one the catalog's check times say the
// version is current — only when the source that would know (the OS package
// check, or php.net for a Keel build) has really been consulted; otherwise
// nothing has been checked yet and no verdict is given.
export function updateState(v, stamp, checking = false) {
  if (!v?.installed) return null;
  const u = v.update;
  if (u?.candidate) return { kind: u.severity === 'critical' || u.severity === 'security' ? 'security' : 'update', candidate: u.candidate, reasons: u.reasons || [], checkedAt: u.checkedAt ?? stamp?.checkedAt ?? null };
  if (u) return { kind: 'nofix', candidate: null, reasons: u.reasons || [], checkedAt: u.checkedAt ?? stamp?.checkedAt ?? null };
  if (checking || !stamp) return { kind: 'checking', candidate: null, reasons: [], checkedAt: null };
  const keel = Boolean(v.source || v.layout === 'keel' || v.method === 'source');
  const at = keel ? stamp.releasesCheckedAt : stamp.packagesCheckedAt;
  if (!at) return { kind: 'unknown', candidate: null, reasons: [], checkedAt: null };
  return { kind: keel ? 'latest' : 'distro', candidate: null, reasons: [], checkedAt: at };
}

const checkedLine = (label, at) => `${label} · checked ${formatDate(at)}`;

export function PhpUpdateCell({ row, stamp, checking, busy, onUpdate }) {
  const s = updateState(row, stamp, checking);
  if (!s) return <span className="muted">—</span>;
  const title = s.reasons.length ? s.reasons.join('\n') : undefined;
  if (s.kind === 'checking') return <span className="muted small">Checking…</span>;
  if (s.kind === 'unknown') return <span className="muted small">Not checked yet — use Check for updates</span>;
  if (s.kind === 'security' || s.kind === 'update') {
    return (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }} title={title}>
        {s.kind === 'security' ? <><StatusPill status="failed">Security update</StatusPill><span>{s.candidate}</span></> : <span>Update available: <strong>{s.candidate}</strong></span>}
        <Button size="sm" variant={s.kind === 'security' ? 'danger' : 'primary'} loading={busy} title={title} onClick={() => onUpdate(row)}>Update</Button>
      </span>
    );
  }
  if (s.kind === 'nofix') return <span title={title}><StatusPill status="failed">Advisory</StatusPill> <span className="muted small">no fix available yet</span></span>;
  return (
    <span className="muted">
      Up to date{row.version ? ` · ${row.version}` : ''}
      <br /><span className="small">{checkedLine(s.kind === 'latest' ? 'Latest php.net release' : 'Distribution packages', s.checkedAt)}</span>
    </span>
  );
}

export default function MultiPhpManager({ fn }) {
  const toast = useToast();
  const confirm = useConfirm();
  const { user } = useAuth();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const isRoot = user?.role === 'root';
  const versions = useApi('/software/php/versions');
  const catalog = useApi('/software/php/catalog', { enabled: isRoot });
  const table = useTableState({ pageSize: 50, sort: 'domain', dir: 'asc' });
  const domains = useApi(`/software/php/domains${queryString(table.state)}`);
  const pools = useApi('/software/php/pools', { enabled: isRoot });
  const [bulkVersion, setBulkVersion] = useState('');
  const [selected, setSelected] = useState([]);
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState(null);
  const refetchAll = () => { versions.refetch(); catalog.refetch(); domains.refetch(); pools.refetch(); };
  const check = async () => {
    setChecking(true); setError(null);
    try { await checkForUpdates(catalog.refetch); toast.success('Update check finished'); } catch (err) { setError(err); toast.error(err); } finally { setChecking(false); }
  };
  const runner = useJobRunner({ onFinished: refetchAll });
  const deepLinked = useRef(false);

  const installed = versions.data?.versions || [];
  const options = installed.map((v) => ({ value: v.id, label: `${v.label || v.id}${v.version ? ` (${v.version})` : ''}${v.isDefault ? ' · CLI default' : ''}` }));
  const current = catalog.data?.effectiveDefault ?? versions.data?.effectiveDefault;
  const rows = domains.data?.domains || [];
  const matrix = catalog.data?.versions || [];
  // One OS note shared by every uninstalled version is printed once above the rows.
  const noted = matrix.filter((v) => !v.installed && v.note);
  const sharedNote = noted.length > 1 && noted.every((v) => v.note === noted[0].note) ? noted[0].note : null;

  const setDefault = async (version) => {
    if (!version || version === current) return;
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
      refetchAll();
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
      setSelected([]); domains.refetch(); catalog.refetch();
    } catch (err) { setError(err); toast.error(err); } finally { setBusy(false); }
  };
  const install = async (v) => {
    const source = v.method === 'source';
    const message = source
      ? sourceBuildMessage(v.id)
      : <>Installs {v.packages?.length ? <CodeList names={v.packages} /> : 'the version packages'} side by side with PHP-FPM; the CLI default stays as it is.{v.state === 'unknown' && v.note ? ` ${v.note}` : ''}</>;
    if (!(await confirm({ title: `Install ${versionLabel(v)}?`, message, confirmLabel: source ? 'Build and install' : 'Install' }))) return;
    runner.start(() => api.post('/software/runtimes/install', runtimeInstallBody('php', v.id, source ? 'source' : undefined)), `Install ${versionLabel(v)}`);
  };
  const remove = async (v) => {
    if (!(await confirm(removeConfirm(v)))) return;
    // The server simulates the removal first: when the package manager would
    // take other packages with the version (roundcube-core, phpmyadmin) the
    // request answers 422 with them, and only root may force it.
    let extra = null;
    const started = await runner.start(async () => {
      try { return await api.post('/software/php/remove', { version: v.id }); } catch (err) { extra = isRoot ? removalExtras(err) : null; throw err; }
    }, `Remove ${versionLabel(v)}`);
    if (started || !extra) return;
    if (!(await confirm(removeConfirm(v, extra)))) return;
    runner.start(() => api.post('/software/php/remove', { version: v.id, force: true }), `Remove ${versionLabel(v)} (forced)`);
  };
  // Direct update of an installed version (contract §63): the row's `update`
  // comes from the same list as the Home banner; null means nothing newer.
  const update = async (v) => {
    const u = v.update;
    if (!u?.candidate) return;
    if (!(await confirm({ title: `Update ${versionLabel(v)} to ${u.candidate}?`, message: phpUpdateMessage(v), confirmLabel: 'Update', danger: u.severity === 'critical' }))) return;
    runner.start(() => api.post('/software/php/update', phpUpdateBody(v)), `Update ${versionLabel(v)}`);
  };
  const setOffered = async (v, on) => {
    setBusy(true); setError(null);
    try {
      await api.put('/software/php/offered', { versions: toggleOffered(catalog.data, v.id, on) });
      toast.success(`${v.label || `PHP ${v.id}`} is ${on ? 'now' : 'no longer'} offered to accounts`);
      catalog.refetch();
    } catch (err) { setError(err); toast.error(err); } finally { setBusy(false); }
  };

  useEffect(() => {
    const wanted = params.get('install');
    if (!wanted || deepLinked.current || !catalog.data) return;
    deepLinked.current = true;
    const v = matrix.find((x) => x.id === wanted);
    setParams((p) => { const n = new URLSearchParams(p); n.delete('install'); return n; }, { replace: true });
    if (v && !v.installed && v.state !== 'unsupported') install(v);
  }, [params, catalog.data]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <>
      <PageHeader fn={fn} actions={<>{isRoot && <Button variant="primary" loading={checking} onClick={check}>Check for updates</Button>}<Link className="btn" to="/software/multiphp-ini-editor">INI editor</Link></>} />
      <RequestError error={versions.error} onRetry={versions.refetch} />
      <RequestError error={catalog.error} onRetry={catalog.refetch} />
      {(versions.loading && !versions.data) && <Loading text="Detecting PHP versions…" />}
      {isRoot && catalog.data && (
        <Card title="PHP versions" subtitle={`Every version of the catalog for ${catalog.data.os?.id || catalog.data.family || 'this host'}${catalog.data.os?.versionId ? ` ${catalog.data.os.versionId}` : ''}: install, remove, pick the system default and choose what accounts may select.`} actions={<Button onClick={refetchAll}>Re-detect</Button>} padded={false}>
          <div className="table-wrap">
            <table>
              <thead><tr><th style={{ minWidth: 220 }}>Version</th><th>State</th><th>PHP-FPM</th><th>Updates</th><th>Default</th><th>Domains</th><th>Offered to accounts</th><th /></tr></thead>
              <tbody>
                {matrix.length === 0 && <tr><td colSpan={8} className="table-state">The catalog is empty for this OS. Add a version with <Link to="/software/easyapache-4">EasyApache 4</Link> or install packages by hand.</td></tr>}
                {matrix.some((v) => !v.installed && v.method === 'source') && <tr><td colSpan={8} className="muted small" style={{ padding: '8px 16px' }}>Versions marked <em>Source build</em> have no packages for this OS yet; Install compiles them from the official php.net source into {PHP_SOURCE_PREFIX}/&lt;version&gt; with their own PHP-FPM service (about 15 minutes, the build log streams below).</td></tr>}
                {sharedNote && <tr><td colSpan={8} className="muted small" style={{ padding: '8px 16px' }}>{sharedNote}</td></tr>}
                {matrix.map((v) => {
                  const blocker = removeBlocker(v, matrix.filter((x) => x.installed).length);
                  return (
                    <tr key={v.id}>
                      <td><strong>{v.label || `PHP ${v.id}`}</strong> {v.version && <span className="muted">{v.version}</span>} <SourceBuildPill row={v} /> <PhpAdvisoryBadge advisories={v.advisories} />
                        {v.installed && v.binary && <><br /><code className="small">{v.binary}</code></>}
                        {!v.installed && v.method === 'source' && <><br /><code className="small">{PHP_SOURCE_PREFIX}/{v.id}</code></>}
                        {!v.installed && v.note && v.note !== sharedNote && <><br /><span className="muted small" style={{ display: 'block', maxWidth: 360 }}>{v.note}</span></>}
                      </td>
                      <td><PhpStatePill state={v.state} /></td>
                      <td>{v.installed ? (v.fpmInstalled ? <StatusPill status={v.fpmActive ? 'active' : v.fpmActive === false ? 'inactive' : 'unknown'}>{v.fpmUnit || 'FPM'}{v.fpmActive === false ? ' · stopped' : ''}</StatusPill> : <StatusPill status="not-installed">no FPM</StatusPill>) : <span className="muted">—</span>}</td>
                      <td><PhpUpdateCell row={v} stamp={catalog.data.updates} checking={checking} busy={runner.busy} onUpdate={update} /></td>
                      <td>{v.isSystemDefault && <StatusPill status="ok">system default</StatusPill>}{v.isDefault && !v.isSystemDefault && <StatusPill status="info">CLI</StatusPill>}</td>
                      <td>{v.installed ? v.domains ?? 0 : <span className="muted">—</span>}</td>
                      <td style={{ whiteSpace: 'nowrap' }}><Toggle checked={Boolean(v.offered)} disabled={!v.installed || busy} onChange={(on) => setOffered(v, on)} label={v.installed ? (v.offered ? 'Offered' : 'Hidden') : 'Install first'} /></td>
                      <td className="actions-col">
                        {!v.installed && <Button size="sm" loading={runner.busy} disabled={v.state === 'unsupported'} title={v.state === 'unsupported' ? v.note || 'Not available for this OS' : v.method === 'source' ? `Built from the php.net source into ${PHP_SOURCE_PREFIX}/${v.id}` : undefined} onClick={() => install(v)}>Install</Button>}
                        {v.installed && !v.isSystemDefault && <Button size="sm" loading={busy} onClick={() => setDefault(v.id)}>Set as default</Button>}
                        {v.installed && <Button size="sm" variant="danger" loading={runner.busy} disabled={Boolean(blocker)} title={blocker || undefined} onClick={() => remove(v)}>Remove</Button>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div style={{ padding: '0 16px 12px' }}>
            <ErrorBanner error={error || runner.error} />
            <p className="muted small"><em>Updates</em> compares every installed version with the pending packages of the last OS update check and, for a Keel build, with php.net's latest release of its branch; <em>Check for updates</em> runs both checks again. An Update runs as a job below (packages are upgraded and PHP-FPM reloaded; a Keel build is rebuilt from the newer php.net source and its service restarted, about 15 minutes).</p>
            <p className="muted small">Accounts see only the versions switched to <em>Offered</em> (all installed ones until you hide one); a version a domain already runs stays selectable for that domain. A plan's own version list narrows it further.</p>
          </div>
        </Card>
      )}
      {!isRoot && versions.data && (
        <Card title="Installed PHP versions" subtitle="Detected from /etc/php/*, /opt/cpanel/ea-php*, Remi SCL and the stock php package." actions={<Button onClick={() => versions.refetch()}>Re-detect</Button>}>
          <div className="table-wrap">
            <table>
              <thead><tr><th>Version</th><th>Binary</th><th>PHP-FPM</th><th>php.ini</th><th>Default</th></tr></thead>
              <tbody>
                {installed.length === 0 && <tr><td colSpan={5} className="table-state">No PHP installation found on this server.</td></tr>}
                {installed.map((v) => (
                  <tr key={v.id}>
                    <td><strong>{v.label || v.id}</strong> <span className="muted">{v.version}</span> <PhpAdvisoryBadge advisories={v.advisories} /></td>
                    <td><code className="small">{v.binary}</code></td>
                    <td>{v.fpmInstalled ? <StatusPill status={v.fpmActive ? 'active' : v.fpmActive === false ? 'inactive' : 'unknown'}>{v.fpmUnit}{v.fpmActive === false ? ' · stopped' : ''}</StatusPill> : <StatusPill status="not-installed">no FPM</StatusPill>}</td>
                    <td><code className="small">{v.iniPath || '—'}</code></td>
                    <td>{v.id === current && <StatusPill status="ok">system default</StatusPill>}{v.isDefault && v.id !== current && <StatusPill status="info">CLI</StatusPill>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <ErrorBanner error={error} />
        </Card>
      )}
      <JobPanel runner={runner} title="PHP version job" />
      <Card title="PHP version per domain" subtitle={domains.data ? `${domains.meta?.total ?? domains.data.domains.length} domains · system default ${domains.data.systemDefault.effective || 'not set'}` : undefined} padded={false}>
        <RequestError error={domains.error} onRetry={domains.refetch} />
        {selected.length > 0 && (
          <div className="datatable-actions" style={{ padding: '12px 16px 0' }}>
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
          {pools.data.pools.length === 0 ? <p className="muted">No pool files found; pools appear here once a PHP-FPM version is installed.</p> : (
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
