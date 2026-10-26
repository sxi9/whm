import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../../api/client.js';
import { useApi } from '../../../hooks/useApi.js';
import { PageHeader, Card, StatusPill, Loading, KeyValue, formatDuration } from '../../../components/Common.jsx';
import { Field, TextInput, Toggle, Button, FormActions, ErrorBanner } from '../../../components/Form.jsx';
import { useToast } from '../../../components/Toast.jsx';
import { useConfirm } from '../../../components/Modal.jsx';
import { RequestError } from '../../databases/Shared.jsx';

export default function EditDatabaseConfiguration({ fn }) {
  const toast = useToast();
  const confirm = useConfirm();
  const { data, loading, error, refetch } = useApi('/databases/config');
  const [draft, setDraft] = useState({});
  const [custom, setCustom] = useState({ key: '', value: '' });
  const [restart, setRestart] = useState(true);
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState(null);
  useEffect(() => { if (data) setDraft({ ...data.settings }); }, [data]);

  const dirty = useMemo(() => data && JSON.stringify(draft) !== JSON.stringify(data.settings), [draft, data]);
  const setKey = (k, v) => setDraft((d) => { const n = { ...d }; if (v === '' || v == null) delete n[k]; else n[k] = v; return n; });
  const tunables = data?.tunables || [];
  const customKeys = Object.keys(draft).filter((k) => !tunables.some((t) => t.key === k));
  const runtimeValue = (label) => data?.runtime?.variables?.[label];

  const save = async () => {
    if (restart && !(await confirm({ title: 'Save and restart the database server?', message: 'The managed include is validated with the server binary before the restart. Connections are dropped for a few seconds while it restarts.', confirmLabel: 'Save and restart', danger: true }))) return;
    setBusy(true); setSaveError(null);
    try {
      const settings = {};
      for (const k of new Set([...Object.keys(draft), ...Object.keys(data.settings)])) settings[k] = draft[k] ?? null;
      const { data: res } = await api.put('/databases/config', { settings, restart });
      toast.success(res.restart ? `Configuration written and ${res.restart.unit} restarted (${res.restart.state})` : 'Configuration written; restart the server to apply it');
      await refetch();
    } catch (err) { setSaveError(err); } finally { setBusy(false); }
  };

  const restartNow = async () => {
    if (!(await confirm({ title: 'Restart the database server?', message: 'Active connections are dropped briefly.', confirmLabel: 'Restart', danger: true }))) return;
    setBusy(true);
    try { const { data: res } = await api.post('/databases/restart'); toast.success(`${res.unit} restarted: ${res.state}`); refetch(); } catch (err) { toast.error(err); } finally { setBusy(false); }
  };

  return (
    <>
      <PageHeader fn={fn} description="Tune the local MySQL/MariaDB server through a panel-managed include file that overrides the distribution defaults. Changes are validated with the server binary and rolled back if rejected; a restart applies them." actions={<><Button onClick={() => refetch()}>Refresh</Button><Button variant="danger" onClick={restartNow} loading={busy}>Restart server</Button></>} />
      {error?.code === 'unsupported_engine'
        ? <div className="banner banner-info"><div><strong>Not available for the active profile</strong><p>{error.message} <Link to="/database-services/manage-database-profiles">Manage Database Profiles</Link></p></div></div>
        : <RequestError error={error} onRetry={refetch} />}
      {loading && !data && <Loading />}
      {data && (
        <>
          <Card title="Server status">
            <div className="stat-grid">
              <div className="stat"><div className="label">Unit</div><div className="value">{data.unit?.unit ? <StatusPill status={data.unit.state === 'active' ? 'active' : 'down'}>{data.unit.unit} · {data.unit.state}</StatusPill> : <span className="muted">unknown</span>}</div></div>
              <div className="stat"><div className="label">Uptime</div><div className="value">{data.runtime?.status?.Uptime != null ? formatDuration(data.runtime.status.Uptime) : '—'}</div></div>
              <div className="stat"><div className="label">Connections</div><div className="value">{data.runtime?.status?.Threads_connected ?? '—'}<span className="muted" style={{ fontSize: 13 }}> / max used {data.runtime?.status?.Max_used_connections ?? '—'}</span></div></div>
              <div className="stat"><div className="label">Slow queries</div><div className="value">{data.runtime?.status?.Slow_queries ?? '—'}</div></div>
            </div>
            {data.runtime?.error && <p className="muted">Live values unavailable: {data.runtime.error}</p>}
            <KeyValue items={[['Managed include', <code key="p">{data.path}</code>], ['Main configuration', data.layout?.mainConf ? <code key="m">{data.layout.mainConf}</code> : '—'], ['Configuration directories', data.layout?.confDirs?.join(', ')]]} />
          </Card>
          <Card title="Options" subtitle="Blank keeps the distribution default. Values are written to the [mysqld] section of the managed include." padded={false}>
            <div className="table-wrap">
              <table>
                <thead><tr><th style={{ width: 260 }}>Option</th><th>Description</th><th style={{ width: 160 }}>Running value</th><th style={{ width: 220 }}>Override</th></tr></thead>
                <tbody>
                  {tunables.map((t) => (
                    <tr key={t.key}>
                      <td><code>{t.label}</code></td>
                      <td className="muted">{t.help}</td>
                      <td><code>{runtimeValue(t.label) ?? '—'}</code></td>
                      <td><TextInput value={draft[t.key] ?? ''} onChange={(v) => setKey(t.key, v)} placeholder={t.type === 'flag' ? 'present / blank' : t.type === 'onoff' ? 'ON / OFF' : 'default'} /></td>
                    </tr>
                  ))}
                  {customKeys.map((k) => (
                    <tr key={k}>
                      <td><code>{k}</code></td>
                      <td className="muted">custom option</td>
                      <td><code>{runtimeValue(k.replace(/-/g, '_')) ?? '—'}</code></td>
                      <td><div className="row-actions"><TextInput value={draft[k] ?? ''} onChange={(v) => setDraft((d) => ({ ...d, [k]: v }))} /><Button size="sm" variant="danger-ghost" onClick={() => setKey(k, '')}>Remove</Button></div></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="card-body">
              <div className="form-grid">
                <Field label="Add another option" help="Lowercase option name, dashes or underscores (e.g. innodb-io-capacity)"><TextInput value={custom.key} onChange={(v) => setCustom((c) => ({ ...c, key: v }))} placeholder="innodb-io-capacity" /></Field>
                <Field label="Value" help="Blank for flag options such as skip-name-resolve"><TextInput value={custom.value} onChange={(v) => setCustom((c) => ({ ...c, value: v }))} placeholder="2000" /></Field>
                <FormActions><Button disabled={!custom.key.trim()} onClick={() => { setDraft((d) => ({ ...d, [custom.key.trim().toLowerCase().replace(/_/g, '-')]: custom.value.trim() })); setCustom({ key: '', value: '' }); }}>Add option</Button></FormActions>
              </div>
              <ErrorBanner error={saveError} />
              <FormActions>
                <Button variant="primary" loading={busy} disabled={!dirty} onClick={save}>Save configuration</Button>
                <Button disabled={!dirty || busy} onClick={() => setDraft({ ...data.settings })}>Reset</Button>
                <Toggle checked={restart} onChange={setRestart} label="Restart the server after saving" />
              </FormActions>
            </div>
          </Card>
          <Card title="Managed include contents">
            <pre className="log">{data.raw ?? `(not created yet — will be written to ${data.path})`}</pre>
          </Card>
          {data.files?.length > 0 && (
            <Card title="Distribution [mysqld] settings" subtitle="What the server reads before the managed include; overrides above win.">
              {data.files.map((f) => (
                <div key={f.path} style={{ marginBottom: 10 }}>
                  <h3><code>{f.path}</code></h3>
                  {Object.keys(f.mysqld).length ? <KeyValue items={Object.entries(f.mysqld).map(([k, v]) => [k, v || '(flag)'])} /> : <p className="muted">no [mysqld] options</p>}
                </div>
              ))}
            </Card>
          )}
        </>
      )}
    </>
  );
}
