import { useState } from 'react';
import { api } from '../../../api/client.js';
import { useApi } from '../../../hooks/useApi.js';
import { useAuth } from '../../../auth/AuthContext.jsx';
import { CATEGORIES } from '../../../nav.js';
import { PageHeader, Card, Loading, StatusPill } from '../../../components/Common.jsx';
import { RadioGroup, Button, FormActions } from '../../../components/Form.jsx';
import { useToast } from '../../../components/Toast.jsx';
import { useConfirm } from '../../../components/Modal.jsx';
import { RequestError } from '../../server-configuration/Shared.jsx';

const labelFor = (slug) => CATEGORIES.find((c) => c.slug === slug)?.label || slug;

export function profileSwitchMessage(def, restoreLabel = 'Standard Node') {
  const hidden = def.hiddenCategories.length
    ? `${def.hiddenCategories.length} categories (${def.hiddenCategories.map(labelFor).join(', ')}) disappear from the sidebar, the Tools grid and search for every user as soon as the profile is applied; their pages stay reachable by URL and their APIs stay mounted. Switching back to ${restoreLabel} brings them back.`
    : 'Every category stays visible.';
  return `Service monitoring follows the profile (${def.monitoredServices.join(', ')}). ${hidden} No daemon is stopped or uninstalled.`;
}

export default function ServerProfile({ fn }) {
  const toast = useToast();
  const confirm = useConfirm();
  const { refresh } = useAuth();
  const { data, loading, error, refetch } = useApi('/server-config/profile');
  const [choice, setChoice] = useState(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const selected = choice ?? data?.current;
  const def = data?.profiles.find((p) => p.name === selected);

  const apply = async () => {
    const ok = await confirm({ title: `Switch to ${def.label}?`, message: profileSwitchMessage(def, data.profiles.find((p) => p.name === 'standard')?.label), confirmLabel: 'Apply profile' });
    if (!ok) return;
    setBusy(true);
    try { const { data: d } = await api.put('/server-config/profile', { name: selected }); setResult(d); setChoice(null); toast.success(`Profile set to ${def.label}; service monitoring updated`); refetch(); refresh(); } catch (err) { toast.error(err); } finally { setBusy(false); }
  };

  return (
    <>
      <PageHeader fn={fn} description="A profile declares which roles this server fulfils. It drives which services are monitored and what linked nodes and integrations expect from it, and it publishes the list of categories that do not apply to this role. It never installs or removes software." />
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
            <Card title="Categories not applicable to this role" subtitle="Published as profile.hiddenCategories in GET /api/auth/me and /api/system/status. The shell hides them from the sidebar, the Tools grid and search for every user; their pages stay reachable by URL and their APIs stay mounted.">
              {def.hiddenCategories.length === 0 ? <p className="muted">Every category applies to this profile.</p> : <ul>{def.hiddenCategories.map((slug) => <li key={slug}>{labelFor(slug)} <small className="muted"><code>{slug}</code></small></li>)}</ul>}
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
