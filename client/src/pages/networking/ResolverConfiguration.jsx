import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api/client.js';
import { useApi } from '../../hooks/useApi.js';
import { Card, StatusPill, Loading, KeyValue, CapabilityNotice, formatDate } from '../../components/Common.jsx';
import { Field, TextInput, Toggle, Button, FormActions, ErrorBanner } from '../../components/Form.jsx';
import { DataTable } from '../../components/DataTable.jsx';
import { useToast } from '../../components/Toast.jsx';
import { useConfirm } from '../../components/Modal.jsx';

const V4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
const V6 = /^[0-9a-f:]+$/i;
export const isIp = (v) => V4.test(v) || (v.includes(':') && V6.test(v) && v.split(':').length <= 8 && (v.match(/::/g) || []).length <= 1);
const DOMAIN = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;
const SLOTS = ['Primary', 'Secondary', 'Third', 'Fourth'];

const MANAGER_TEXT = {
  'systemd-resolved': { tone: 'info', text: 'systemd-resolved manages /etc/resolv.conf (the 127.0.0.53 stub). Saving writes a drop-in under /etc/systemd/resolved.conf.d and restarts the resolver, so the file keeps pointing at the stub while the upstream servers change.' },
  networkmanager: { tone: 'warning', text: 'NetworkManager generated /etc/resolv.conf. The panel writes the file directly; NetworkManager may overwrite it on the next connection change unless its DNS handling is set to "none".' },
  resolvconf: { tone: 'warning', text: 'resolvconf generated /etc/resolv.conf and may overwrite the panel\'s file on the next interface event.' },
  dhcp: { tone: 'warning', text: 'A DHCP client wrote /etc/resolv.conf and may replace it on lease renewal.' },
  whm: { tone: 'ok', text: '/etc/resolv.conf is managed by this panel.' },
  file: { tone: 'ok', text: '/etc/resolv.conf is a plain file; the panel rewrites it in place (a .whm-bak copy is kept).' },
};

function TestResults({ test }) {
  if (!test) return null;
  return (
    <div style={{ marginTop: 12 }}>
      <p className="muted">{test.healthy} of {test.total} resolver{test.total === 1 ? '' : 's'} answered every lookup ({test.names.join(', ')}).</p>
      <div className="table-wrap">
        <table>
          <thead><tr><th>Resolver</th><th>Status</th><th>Lookups</th><th style={{ textAlign: 'right' }}>Avg time</th></tr></thead>
          <tbody>
            {test.servers.map((s) => (
              <tr key={s.server}>
                <td><code>{s.server}</code></td>
                <td><StatusPill status={s.ok ? 'ok' : s.reachable ? 'warning' : 'failed'}>{s.ok ? 'healthy' : s.reachable ? 'partial' : 'unreachable'}</StatusPill></td>
                <td>{s.lookups.map((l) => <div key={l.name}><code>{l.name}</code> → {l.ok ? l.answers.join(', ') : <span className="muted">{l.error || 'no answer'}</span>} <span className="muted">({l.ms} ms)</span></div>)}</td>
                <td style={{ textAlign: 'right' }}>{s.avgMs != null ? `${s.avgMs} ms` : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function ResolverConfiguration() {
  const toast = useToast();
  const confirm = useConfirm();
  const { data, loading, error, refetch } = useApi('/networking/resolvers');
  const { data: history, refetch: refetchHistory } = useApi('/networking/history?kind=resolvers&limit=20');
  const [servers, setServers] = useState(['', '', '', '']);
  const [search, setSearch] = useState('');
  const [applyToDns, setApplyToDns] = useState(true);
  const [takeOver, setTakeOver] = useState(false);
  const [test, setTest] = useState(null);
  const [testing, setTesting] = useState(false);
  const [testError, setTestError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(null);
  const [saved, setSaved] = useState(null);

  useEffect(() => {
    if (!data) return;
    const current = data.managedBy === 'systemd-resolved' && data.panel.resolvers.length ? data.panel.resolvers : data.nameservers;
    setServers([0, 1, 2, 3].map((i) => current[i] || ''));
    setSearch((data.search.length ? data.search : data.panel.search).join(' '));
  }, [data]);

  const list = servers.map((s) => s.trim()).filter(Boolean);
  const errors = useMemo(() => servers.map((s) => (s.trim() && !isIp(s.trim()) ? 'Not a valid IPv4 or IPv6 address' : list.filter((x) => x === s.trim()).length > 1 ? 'Listed twice' : null)), [servers, list]);
  const searchList = search.split(/[\s,]+/).map((s) => s.trim().toLowerCase()).filter(Boolean);
  const searchError = searchList.some((s) => !DOMAIN.test(s)) ? 'Search domains must be valid domain names' : searchList.length > 6 ? 'At most 6 search domains' : null;
  const valid = list.length > 0 && errors.every((e) => !e) && !searchError;
  const dirty = data && (list.join(',') !== data.nameservers.join(',') || searchList.join(' ') !== data.search.join(' '));

  const setSlot = (i, v) => setServers((s) => s.map((x, j) => (j === i ? v : x)));
  const applyPreset = (p) => { setServers([0, 1, 2, 3].map((i) => p.nameservers[i] || '')); setTest(null); };

  const runTest = async (which = list) => {
    setTesting(true);
    setTestError(null);
    try {
      const { data: t } = await api.post('/networking/resolvers/test', which.length ? { nameservers: which } : {});
      setTest(t);
      return t;
    } catch (err) { setTestError(err); return null; } finally { setTesting(false); }
  };

  const save = async () => {
    if (!valid) return;
    let message = `Nameservers: ${list.join(', ')}${searchList.length ? `; search: ${searchList.join(' ')}` : ''}. Every program on this server resolves names through these from now on; a wrong address breaks mail delivery, updates and the panel's own lookups.`;
    if (data.managedBy === 'systemd-resolved' && !takeOver) message += ' The upstream servers of systemd-resolved are changed and the service restarted.';
    if (data.managedBy === 'systemd-resolved' && takeOver) message += ' systemd-resolved will stop managing /etc/resolv.conf; the file is replaced with a static one.';
    if (!(await confirm({ title: 'Apply resolver configuration?', message, confirmLabel: 'Apply', danger: true }))) return;
    setSaving(true);
    setSaveError(null);
    try {
      const { data: r } = await api.put('/networking/resolvers', { nameservers: list, search: searchList, applyToDns, mode: takeOver ? 'file' : 'auto' });
      setSaved(r);
      if (r.test) setTest(r.test);
      if (r.applied === false) toast.warning('Resolvers written but /etc/resolv.conf does not show them yet; another tool may manage the file');
      else toast.success(r.target === 'resolved' ? `Resolvers applied to systemd-resolved${r.restarted ? ' and the service restarted' : ''}` : 'Resolvers written to /etc/resolv.conf');
      await Promise.all([refetch(), refetchHistory()]);
    } catch (err) { setSaveError(err); toast.error(err); } finally { setSaving(false); }
  };

  const manager = data ? MANAGER_TEXT[data.managedBy] || MANAGER_TEXT.file : null;

  return (
    <>
      {loading && !data && <Loading />}
      <ErrorBanner error={error} onRetry={refetch} />
      {data && (
        <Card title="Current configuration" subtitle={`Read from ${data.path}`} actions={<Button size="sm" onClick={() => { refetch(); setTest(null); }}>Refresh</Button>}>
          <div className={`banner banner-${manager.tone === 'ok' ? 'info' : manager.tone}`}><div>{manager.text}</div></div>
          <KeyValue items={[
            ['Nameservers in use', data.nameservers.length ? data.nameservers.map((n) => <code key={n} style={{ marginRight: 6 }}>{n}</code>) : <StatusPill status="warning">none — resolution is broken</StatusPill>],
            data.search.length > 0 && ['Search domains', data.search.join(' ')],
            data.options.length > 0 && ['Options', data.options.join(' ')],
            ['Managed by', <code key="m">{data.managedBy}</code>],
            ['Panel writes to', <code key="w">{data.writePath}</code>],
            data.resolved?.installed && ['systemd-resolved', <StatusPill key="r" status={data.resolved.active ? 'active' : 'inactive'}>{data.resolved.active ? 'running' : 'stopped'}</StatusPill>],
            ['DNS Functions lookups use', data.panel.resolvers.length ? data.panel.resolvers.join(', ') : <span key="p" className="muted">system resolvers</span>],
            data.lastChange && ['Last change', <span key="l">{(data.lastChange.before?.nameservers || []).join(', ') || '—'} → {(data.lastChange.after?.nameservers || []).join(', ')} by {data.lastChange.principal || 'system'} on {formatDate(data.lastChange.createdAt)}</span>],
          ]} />
          <details style={{ marginTop: 10 }}>
            <summary className="muted">Show {data.path}</summary>
            <pre className="log">{data.raw || '(empty)'}</pre>
            {data.dropIn && <><p className="muted">Drop-in <code>{data.dropIn.path}</code>:</p><pre className="log">{data.dropIn.content}</pre></>}
          </details>
        </Card>
      )}
      {data && (
        <Card title="Resolvers" subtitle="Up to four nameservers, tried in order. Use a local caching resolver (127.0.0.1) when BIND runs on this server, or a public service.">
          <div className="row-actions" style={{ flexWrap: 'wrap', marginBottom: 12 }}>
            {data.presets.map((p) => <Button key={p.name} size="sm" onClick={() => applyPreset(p)}>{p.name}</Button>)}
          </div>
          <div className="form-grid">
            {servers.map((s, i) => (
              <Field key={SLOTS[i]} label={`${SLOTS[i]} resolver`} required={i === 0} error={errors[i]}>
                <TextInput value={s} onChange={(v) => { setSlot(i, v); setTest(null); }} placeholder={i === 0 ? '1.1.1.1' : 'optional'} autoComplete="off" spellCheck={false} />
              </Field>
            ))}
          </div>
          <Field label="Search domains" help="Space-separated; appended to single-label names. Usually empty on a server." error={searchError}>
            <TextInput value={search} onChange={setSearch} placeholder="example.com" autoComplete="off" spellCheck={false} />
          </Field>
          <Field inline><Toggle checked={applyToDns} onChange={setApplyToDns} label="Use these resolvers for the panel's DNS checks" description="DNS Functions (nameserver report, hostname check) query these servers instead of the system defaults." /></Field>
          {data.managedBy === 'systemd-resolved' && (
            <Field inline><Toggle checked={takeOver} onChange={setTakeOver} label="Replace /etc/resolv.conf with a static file" description="Bypasses the systemd-resolved stub. Only do this if you also disable systemd-resolved; otherwise it regenerates the file." /></Field>
          )}
          <FormActions>
            <Button variant="primary" loading={saving} disabled={!valid} onClick={save}>{dirty ? 'Apply resolvers' : 'Re-apply resolvers'}</Button>
            <Button loading={testing} disabled={!list.length || errors.some(Boolean)} onClick={() => runTest()}>Test these resolvers</Button>
            <Button loading={testing} disabled={!data.nameservers.length} onClick={() => runTest([])}>Test current</Button>
          </FormActions>
          <CapabilityNotice error={saveError} onRetry={refetch} />
          {saveError && saveError.status !== 501 && <ErrorBanner error={saveError} />}
          <ErrorBanner error={testError} />
          {saved && (
            <div className="banner banner-info" style={{ marginTop: 12 }}>
              <div>
                <strong>Written to <code>{saved.path}</code></strong>
                {saved.target === 'resolved' && <div>systemd-resolved {saved.restarted ? 'restarted' : 'was not restarted'}.</div>}
                {saved.applied === false && <div>/etc/resolv.conf does not show the new servers yet.</div>}
                {saved.notes?.map((n) => <div key={n} className="muted">{n}</div>)}
                {saved.appliedToDns && <div className="muted">DNS Functions now query these resolvers; see the <Link to="/dns-functions/nameserver-record-report">Nameserver Record Report</Link>.</div>}
              </div>
            </div>
          )}
          <TestResults test={test} />
        </Card>
      )}
      <Card title="Change history" padded={false}>
        <DataTable
          columns={[
            { key: 'createdAt', label: 'When', render: (r) => formatDate(r.createdAt) },
            { key: 'principal', label: 'By', render: (r) => r.principal || <span className="muted">system</span> },
            { key: 'before', label: 'Before', render: (r) => <code>{(r.before?.nameservers || []).join(', ') || '—'}</code> },
            { key: 'after', label: 'After', render: (r) => <code>{(r.after?.nameservers || []).join(', ')}</code> },
            { key: 'detail', label: 'Target', render: (r) => r.detail || '—' },
          ]}
          rows={history || []} rowKey={(r) => r.id} emptyText="No resolver changes recorded yet" dense
        />
      </Card>
    </>
  );
}
