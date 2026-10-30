import { useState } from 'react';
import { Download, RefreshCw } from 'lucide-react';
import { api } from '../../../api/client.js';
import { useApi } from '../../../hooks/useApi.js';
import { useAuth } from '../../../auth/AuthContext.jsx';
import { PageHeader, Card, StatusPill, KeyValue, Loading, CapabilityNotice, formatDate } from '../../../components/Common.jsx';
import { Field, TextInput, NumberInput, Select, Toggle, Button, ErrorBanner } from '../../../components/Form.jsx';
import { useConfirm } from '../../../components/Modal.jsx';
import { useToast } from '../../../components/Toast.jsx';
import { RequestError, useJobRunner, JobPanel } from '../../software/Shared.jsx';
import { CapabilitySummary } from '../../apps/Shared.jsx';

const NODE_VERSION = /^\d{1,3}\.\d{1,3}\.\d{1,3}$/;

// The API clears capabilities.python whenever no interpreter can create a
// venv (python3 on PATH alone is not enough), so the page offers the one-click
// capability install instead of a hand-install recipe. Null means usable.
export function pythonMissingMessage(data) {
  const list = data?.python || [];
  const usable = list.some((p) => p.venv);
  if (data?.capabilities?.python !== false && usable) return null;
  const lead = list.length ? 'An interpreter without venv support cannot run applications.' : 'No Python 3 found.';
  return `${lead} Python applications need python3 with the venv module: python3, python3-venv and python3-pip (Debian/Ubuntu) or python3 and python3-pip (RHEL).`;
}

export function gitMissingMessage(data) {
  if (data?.git?.installed !== false && data?.capabilities?.git !== false) return null;
  return 'git is not installed on this server; deploying or pulling an application from a repository is refused until it is.';
}

const capabilityError = (message) => ({ code: 'capability_missing', status: 501, message });

export function NodeRuntimeTable({ node, defaultNode, onDefault, onRemove, isRoot }) {
  const list = node || [];
  return (
    <div className="table-wrap">
      <table className="dense">
        <thead><tr><th>Version</th><th>Source</th><th>Binary</th><th>Applications</th><th>Default</th>{isRoot && <th />}</tr></thead>
        <tbody>
          {list.length === 0 && <tr><td colSpan={6} className="table-state">No Node.js found. Install the distribution package or a managed version below.</td></tr>}
          {list.map((n) => {
            const key = n.source === 'system' ? 'system' : n.version;
            return (
              <tr key={`${n.source}-${n.version}`}>
                <td><strong>{n.version}</strong>{n.ok === false && <span className="muted small"> · could not run</span>}</td>
                <td><StatusPill status={n.missing ? 'warning' : n.source === 'system' ? 'ok' : 'installed'}>{n.source === 'system' ? 'system' : 'managed'}{n.missing ? ' · files missing' : ''}</StatusPill>{n.installedAt && <div className="muted small">installed {formatDate(n.installedAt)}</div>}</td>
                <td><code className="small">{n.bin}</code>{n.npm && <div className="muted small">npm: <code className="small">{n.npm}</code></div>}</td>
                <td>{n.apps ? <StatusPill status="info">{n.apps} app{n.apps === 1 ? '' : 's'}</StatusPill> : <span className="muted">none</span>}</td>
                <td>
                  <label className="radio" style={{ alignItems: 'center' }}>
                    <input type="radio" name="default-node" checked={defaultNode === key} onChange={() => onDefault?.(key)} disabled={!isRoot || n.missing} aria-label={`Make ${n.version} the default`} />
                    <span>{defaultNode === key ? 'default' : ''}</span>
                  </label>
                </td>
                {isRoot && <td className="actions-col">{n.source === 'managed' && <Button size="sm" variant="danger" onClick={() => onRemove?.(n)} disabled={Boolean(n.apps)} title={n.apps ? 'Used by applications' : undefined}>Remove</Button>}</td>}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function PythonRuntimeTable({ python }) {
  const list = python || [];
  return (
    <div className="table-wrap">
      <table className="dense">
        <thead><tr><th>Version</th><th>Interpreter</th><th>venv</th><th>Default</th></tr></thead>
        <tbody>
          {list.length === 0 && <tr><td colSpan={4} className="table-state">No Python 3 interpreter found.</td></tr>}
          {list.map((p) => (
            <tr key={p.bin}>
              <td><strong>{p.version}</strong></td>
              <td><code className="small">{p.bin}</code></td>
              <td><StatusPill status={p.venv ? 'ok' : 'warning'}>{p.venv ? 'available' : 'missing'}</StatusPill></td>
              <td>{p.default && <StatusPill status="info">default</StatusPill>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function AvailableNodeList({ available, installed, onInstall, busy }) {
  const list = available || [];
  const groups = [['lts', 'LTS lines'], ['current', 'Current']];
  if (!list.length) return <p className="muted">No releases listed.</p>;
  return groups.map(([line, label]) => {
    const rows = list.filter((r) => r.line === line);
    if (!rows.length) return null;
    return (
      <div key={line} style={{ marginBottom: 12 }}>
        <h3 style={{ marginBottom: 6 }}>{label}</h3>
        <div className="table-wrap">
          <table className="dense">
            <thead><tr><th>Version</th><th>Codename</th><th>Released</th><th /></tr></thead>
            <tbody>
              {rows.map((r) => {
                const have = r.installed || installed?.has(r.version);
                return (
                  <tr key={r.version}>
                    <td><strong>{r.version}</strong></td>
                    <td>{r.lts ? <StatusPill status="ok">{r.lts}</StatusPill> : <span className="muted">—</span>}</td>
                    <td>{r.date || '—'}</td>
                    <td className="actions-col">{have ? <StatusPill status="installed">installed</StatusPill> : <Button size="sm" icon={Download} onClick={() => onInstall(r.version)} loading={busy}>Install</Button>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    );
  });
}

function PolicyCard() {
  const toast = useToast();
  const policy = useApi('/apps/settings');
  const [edited, setEdited] = useState(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const draft = edited || (policy.data && { lo: policy.data.portRange[0], hi: policy.data.portRange[1], allowResellers: policy.data.allowResellers, defaultMemoryMb: policy.data.defaultMemoryMb });
  const setDraft = setEdited;
  const save = async () => {
    setSaving(true); setError(null);
    try {
      await api.put('/apps/settings', { portRange: [Number(draft.lo), Number(draft.hi)], allowResellers: Boolean(draft.allowResellers), defaultMemoryMb: Number(draft.defaultMemoryMb) });
      toast.success('Application policy saved');
      setEdited(null);
      policy.refetch();
    } catch (err) { setError(err); } finally { setSaving(false); }
  };
  return (
    <Card title="Policy" subtitle="Port range for application services, who may create applications, and the default memory limit.">
      <RequestError error={policy.error} onRetry={policy.refetch} />
      {draft && (
        <>
          <div className="form-grid">
            <Field label="Port range start" help="Services bind 127.0.0.1:<port>"><NumberInput value={draft.lo} onChange={(lo) => setDraft({ ...draft, lo })} min={1024} max={65535} nullable={false} /></Field>
            <Field label="Port range end"><NumberInput value={draft.hi} onChange={(hi) => setDraft({ ...draft, hi })} min={1024} max={65535} nullable={false} /></Field>
            <Field label="Default memory limit (MB)"><NumberInput value={draft.defaultMemoryMb} onChange={(defaultMemoryMb) => setDraft({ ...draft, defaultMemoryMb })} min={64} max={65536} nullable={false} /></Field>
            <div className="field"><Toggle checked={draft.allowResellers} onChange={(allowResellers) => setDraft({ ...draft, allowResellers })} label="Resellers may manage applications" description="For the accounts they own; runtimes and templates stay root-only" /></div>
          </div>
          <ErrorBanner error={error} />
          <div className="form-actions"><Button variant="primary" onClick={save} loading={saving}>Save policy</Button></div>
        </>
      )}
    </Card>
  );
}

export default function RuntimeVersions({ fn }) {
  const toast = useToast();
  const confirm = useConfirm();
  const { user } = useAuth();
  const isRoot = user?.role === 'root';
  const runtimes = useApi('/apps/runtimes');
  const available = useApi('/apps/runtimes/node/available', { enabled: isRoot });
  const runner = useJobRunner({ onFinished: () => { runtimes.refetch(); available.refetch(); } });
  const [edited, setEdited] = useState(null);
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const data = runtimes.data;
  const defaults = edited || data?.defaults || { node: 'system', python: 'system' };
  const setDefaults = setEdited;

  const install = (version) => {
    if (!NODE_VERSION.test(version)) { toast.error('Node.js versions look like 20.11.0'); return; }
    runner.start(() => api.post('/apps/runtimes/node/install', { version }), `Install Node.js ${version}`).then((d) => { if (d) setTyped(''); });
  };
  const remove = async (n) => {
    if (!(await confirm({ title: `Remove Node.js ${n.version}?`, message: `${n.path || n.bin} is deleted. Applications pinned to it are refused above, so none should break.`, confirmLabel: 'Remove', danger: true }))) return;
    setBusy(true); setError(null);
    try { await api.delete(`/apps/runtimes/node/${encodeURIComponent(n.version)}`); toast.success(`Node.js ${n.version} removed`); runtimes.refetch(); available.refetch(); } catch (err) { setError(err); toast.error(err); } finally { setBusy(false); }
  };
  const saveDefaults = async () => {
    setBusy(true); setError(null);
    try {
      const { data: d } = await api.put('/apps/runtimes/defaults', { node: defaults.node, python: defaults.python });
      setEdited(null);
      toast.success(`Defaults saved: Node.js ${d.node}, Python ${d.python}`);
      runtimes.refetch();
    } catch (err) { setError(err); toast.error(err); } finally { setBusy(false); }
  };
  const pythonMinors = [...new Set((data?.python || []).filter((p) => p.venv).map((p) => String(p.version).split('.').slice(0, 2).join('.')))];
  const pythonOptions = [{ value: 'system', label: 'system (first interpreter with venv)' }, ...pythonMinors.map((v) => ({ value: v, label: `Python ${v}` }))];
  const dirty = Boolean(data?.defaults) && (defaults.node !== data.defaults.node || defaults.python !== data.defaults.python);
  const managedInstalled = new Set((data?.node || []).filter((n) => n.source === 'managed').map((n) => n.version));
  const pythonMissing = pythonMissingMessage(data);
  const gitMissing = gitMissingMessage(data);

  return (
    <>
      <PageHeader fn={fn} actions={<Button icon={RefreshCw} onClick={() => { runtimes.refetch(); available.refetch(); }}>Re-detect</Button>} />
      <RequestError error={runtimes.error} onRetry={runtimes.refetch} />
      {runtimes.loading && !data && <Loading text="Detecting runtimes…" />}
      {data && (
        <>
          <CapabilitySummary capabilities={data.capabilities} />
          {data.error && <div className="banner banner-warning"><div><strong>Runtime detection failed</strong><p>{data.error}</p></div></div>}
          <Card title="Node.js" subtitle={`System Node.js from the distribution plus managed versions under /opt/whm/runtimes/node/<version> (${data.arch})`}
            actions={isRoot && <Button variant="primary" onClick={saveDefaults} loading={busy} disabled={!dirty}>Save defaults</Button>}>
            <NodeRuntimeTable node={data.node} defaultNode={defaults.node} onDefault={(node) => setDefaults({ ...defaults, node })} onRemove={remove} isRoot={isRoot} />
            <ErrorBanner error={error} />
          </Card>
          {isRoot && (
            <Card title="Install a Node.js version" subtitle="Downloaded from nodejs.org, verified against SHASUMS256.txt and unpacked as root into /opt/whm/runtimes/node/<version>.">
              <div className="form-grid" style={{ alignItems: 'end' }}>
                <Field label="Version" help="Any release with Linux builds, e.g. 20.11.0"><TextInput value={typed} onChange={setTyped} placeholder="22.11.0" /></Field>
                <div className="action-row"><Button variant="primary" icon={Download} onClick={() => install(typed.trim())} loading={runner.busy} disabled={!typed.trim()}>Install</Button></div>
              </div>
              <RequestError error={available.error} onRetry={available.refetch} />
              {available.loading && !available.data && <Loading text="Fetching the release index…" />}
              {available.data?.error && <p className="muted">The release index could not be fetched ({available.data.error}); type a version above.</p>}
              {available.data && <AvailableNodeList available={available.data.available} installed={managedInstalled} onInstall={install} busy={runner.busy} />}
            </Card>
          )}
          <JobPanel runner={runner} title="Installing Node.js" />
          <Card title="Python" subtitle="Interpreters on the search path; applications run inside a virtual environment, so venv support is required."
            actions={isRoot && <Select value={defaults.python} onChange={(python) => setDefaults({ ...defaults, python })} options={pythonOptions} style={{ width: 240 }} aria-label="Default Python" />}>
            <PythonRuntimeTable python={data.python} />
            {pythonMissing && <div style={{ marginTop: 10 }}><CapabilityNotice capability="python" error={capabilityError(pythonMissing)} onRetry={runtimes.refetch} /></div>}
            {!pythonMissing && data.python?.some((p) => !p.venv) && (
              <p className="muted" style={{ marginTop: 10 }}>An interpreter without venv support cannot run applications; the default is the first one that can create a virtual environment.</p>
            )}
          </Card>
          <Card title="Tools">
            <KeyValue items={[
              ['git', data.git?.installed ? <StatusPill key="g" status="installed">{data.git.version ? `git ${data.git.version}` : 'installed'}</StatusPill> : <span key="g"><StatusPill status="not-installed">not installed</StatusPill> <span className="muted small">needed to deploy from a repository</span></span>],
              ['Architecture', data.arch],
              ['Apache', <StatusPill key="a" status={data.capabilities?.apache ? 'installed' : 'not-installed'}>{data.capabilities?.apache ? 'installed' : 'missing'}</StatusPill>],
              ['systemd', <StatusPill key="s" status={data.capabilities?.systemd ? 'installed' : 'not-installed'}>{data.capabilities?.systemd ? 'available' : 'missing'}</StatusPill>],
              ['ACL tools (setfacl)', <StatusPill key="acl" status={data.capabilities?.acl ? 'installed' : 'unknown'}>{data.capabilities?.acl ? 'installed' : 'missing (chmod fallback for static builds)'}</StatusPill>],
            ]} />
            {gitMissing && <div style={{ marginTop: 10 }}><CapabilityNotice capability="git" error={capabilityError(gitMissing)} onRetry={runtimes.refetch} /></div>}
          </Card>
          {isRoot && <PolicyCard />}
        </>
      )}
    </>
  );
}
