import { useState } from 'react';
import { api } from '../../../api/client.js';
import { useApi } from '../../../hooks/useApi.js';
import { CATEGORIES } from '../../../nav.js';
import { PageHeader, Card, Loading, StatusPill } from '../../../components/Common.jsx';
import { RadioGroup, Button, FormActions } from '../../../components/Form.jsx';
import { useToast } from '../../../components/Toast.jsx';
import { useConfirm } from '../../../components/Modal.jsx';
import { RequestError } from '../../server-configuration/Shared.jsx';

const labelFor = (slug) => CATEGORIES.find((c) => c.slug === slug)?.label || slug;

export default function ServerProfile({ fn }) {
  const toast = useToast();
  const confirm = useConfirm();
  const { data, loading, error, refetch } = useApi('/server-config/profile');
  const [choice, setChoice] = useState(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const selected = choice ?? data?.current;
  const def = data?.profiles.find((p) => p.name === selected);

  const apply = async () => {
    const ok = await confirm({ title: `Switch to ${def.label}?`, message: `Service monitoring follows the profile (${def.monitoredServices.join(', ')}) and ${def.hiddenCategories.length ? `${def.hiddenCategories.length} categories are hidden from the sidebar` : 'every category is shown'}. No daemon is stopped or uninstalled.`, confirmLabel: 'Apply profile' });
    if (!ok) return;
    setBusy(true);
    try { const { data: d } = await api.put('/server-config/profile', { name: selected }); setResult(d); setChoice(null); toast.success(`Profile set to ${def.label}; reload the page for the sidebar to follow`); refetch(); } catch (err) { toast.error(err); } finally { setBusy(false); }
  };

  return (
    <>
      <PageHeader fn={fn} description="A profile declares which roles this server fulfils. It drives which services are monitored, which categories the interface shows and what linked nodes expect from it. It never installs or removes software." />
      <RequestError error={error} onRetry={refetch} />
      {loading && !data && <Loading />}
      {data && def && (
        <>
          <Card title="Profile" subtitle={`Active: ${data.profiles.find((p) => p.name === data.current)?.label}`}>
            <RadioGroup name="profile" value={selected} onChange={setChoice} options={data.profiles.map((p) => ({ value: p.name, label: p.label, description: p.description }))} />
            <FormActions>
              <Button variant="primary" loading={busy} disabled={selected === data.current} onClick={apply}>Apply profile</Button>
              {choice && choice !== data.current && <Button onClick={() => setChoice(null)}>Cancel</Button>}
            </FormActions>
          </Card>
          <div className="form-grid">
            <Card title="Monitored services" subtitle={selected === data.current ? 'As configured now' : `After switching to ${def.label}`}>
              <div className="table-wrap"><table><thead><tr><th>Service</th><th>Monitored</th></tr></thead><tbody>
                {data.services.map((s) => { const will = def.monitoredServices.includes(s.name); return <tr key={s.name}><td>{s.displayName}<br /><small className="muted"><code>{s.name}</code></small></td><td><StatusPill status={will ? 'enabled' : 'disabled'}>{will ? 'monitored' : 'not monitored'}</StatusPill>{will !== s.monitored && <small className="muted"> (now: {s.monitored ? 'monitored' : 'off'})</small>}</td></tr>; })}
              </tbody></table></div>
            </Card>
            <Card title="Hidden categories" subtitle="Reported in GET /api/system/status as profile.hiddenCategories">
              {def.hiddenCategories.length === 0 ? <p className="muted">Every category is shown in this profile.</p> : <ul>{def.hiddenCategories.map((slug) => <li key={slug}>{labelFor(slug)} <small className="muted"><code>{slug}</code></small></li>)}</ul>}
            </Card>
          </div>
          {result && (
            <Card title="Applied">
              <p>Switched from <strong>{result.previous}</strong> to <strong>{result.current}</strong>. {result.changes.length === 0 ? 'No monitoring change was needed.' : `${result.changes.length} monitoring change(s):`}</p>
              {result.changes.length > 0 && <ul>{result.changes.map((c) => <li key={c.service}><code>{c.service}</code> → {c.monitored ? 'monitored' : 'not monitored'}</li>)}</ul>}
            </Card>
          )}
        </>
      )}
    </>
  );
}
