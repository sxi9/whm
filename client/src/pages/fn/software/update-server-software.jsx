import { useEffect, useState } from 'react';
import { api } from '../../../api/client.js';
import { useApi } from '../../../hooks/useApi.js';
import { PageHeader, Card, StatusPill, KeyValue, Loading, formatDate } from '../../../components/Common.jsx';
import { Field, TextInput, Select, Toggle, Button, FormActions, ErrorBanner } from '../../../components/Form.jsx';
import { useToast } from '../../../components/Toast.jsx';
import { RequestError } from '../../software/Shared.jsx';

// GET answers with the credentials stripped from the feed URL; sending that
// redacted echo back would replace the stored user:password. Only a URL the
// admin actually changed goes on the wire.
export function settingsBody(form, data) {
  const body = { tier: form.tier, autoUpdate: form.autoUpdate };
  if (form.url !== (data?.updateUrl || '')) body.url = form.url;
  return body;
}

export default function UpdateServerSoftware({ fn }) {
  const toast = useToast();
  const { data, loading, error, refetch, setData } = useApi('/software/panel/update');
  const [form, setForm] = useState({ url: '', tier: 'stable', autoUpdate: false });
  const [busy, setBusy] = useState(null);
  const [saveError, setSaveError] = useState(null);

  useEffect(() => { if (data) setForm({ url: data.updateUrl || '', tier: data.tier, autoUpdate: data.autoUpdate }); }, [data]);

  const check = async () => {
    setBusy('check');
    try { const { data: d } = await api.post('/software/panel/update/check'); setData(d); toast[d.lastCheck?.ok ? 'success' : 'warning'](d.lastCheck?.ok ? `Latest release: ${d.latest.version}` : `Check failed: ${d.lastCheck?.error}`); } catch (err) { toast.error(err); } finally { setBusy(null); }
  };
  const save = async () => {
    setBusy('save');
    setSaveError(null);
    try { const { data: d } = await api.put('/software/panel/update/settings', settingsBody(form, data)); setData(d); toast.success('Update settings saved'); } catch (err) { setSaveError(err); toast.error(err); } finally { setBusy(null); }
  };
  const dirty = data && (form.url !== (data.updateUrl || '') || form.tier !== data.tier || form.autoUpdate !== data.autoUpdate);

  return (
    <>
      <PageHeader fn={fn} />
      <RequestError error={error} onRetry={refetch} />
      {loading && !data && <Loading />}
      {data && (
        <>
          <Card title="Panel version" actions={<Button variant="primary" loading={busy === 'check'} disabled={!data.updateUrl} onClick={check}>Check for updates</Button>}>
            <KeyValue items={[
              ['Installed version', <code key="v">{data.currentVersion}</code>],
              ['Latest available', data.latest ? <span key="l"><code>{data.latest.version}</code> <StatusPill status={data.updateAvailable ? 'warning' : 'ok'}>{data.updateAvailable ? 'update available' : 'up to date'}</StatusPill></span> : <span className="muted">unknown — run a check</span>],
              ['Release tier', data.tier],
              ['Last check', data.lastCheck ? <span key="c">{formatDate(data.lastCheck.at)} · <StatusPill status={data.lastCheck.ok ? 'ok' : 'failed'}>{data.lastCheck.ok ? 'ok' : data.lastCheck.error}</StatusPill></span> : 'never'],
              ['Install method', data.installMethod === 'git' ? `git checkout at ${data.repoRoot}` : data.installMethod],
              data.latest?.publishedAt && ['Published', formatDate(data.latest.publishedAt)],
            ]} />
            {data.latest?.notes && <><h3 style={{ marginTop: 14 }}>Release notes</h3><pre className="log">{data.latest.notes}</pre></>}
          </Card>
          <Card title={data.updateAvailable ? `How to upgrade to ${data.latest.version}` : 'How upgrades are applied'} subtitle={data.selfUpdate.reason}>
            <ol>
              {data.instructions.map((step, i) => <li key={i} style={{ marginBottom: 6 }}><code>{step}</code></li>)}
            </ol>
            {data.latest?.url && <p>Release download: <a href={data.latest.url} target="_blank" rel="noreferrer">{data.latest.url}</a></p>}
            <p className="muted">The panel does not overwrite its own running code from the web interface; the install script performs the upgrade (backup, dependency install, migrations, service restart) so a failed step never leaves the panel half-updated.</p>
          </Card>
          <Card title="Update settings">
            <div className="form-grid">
              <Field label="Update feed URL" help={data.updateUrlHasCredentials ? 'The stored URL carries credentials (user:password@host), hidden here. Leave the field unchanged to keep them, or enter the full URL again to replace them.' : 'JSON document with { "version": "x.y.z", "url": "...", "notes": "..." } or { "tiers": { "stable": {...}, "edge": {...} } }'}>
                <TextInput value={form.url} onChange={(v) => setForm({ ...form, url: v })} placeholder="https://updates.example.com/whm/latest.json" />
              </Field>
              <Field label="Release tier"><Select value={form.tier} onChange={(v) => setForm({ ...form, tier: v })} options={[{ value: 'stable', label: 'Stable' }, { value: 'release', label: 'Release' }, { value: 'edge', label: 'Edge (pre-release)' }]} /></Field>
            </div>
            <Toggle checked={form.autoUpdate} onChange={(v) => setForm({ ...form, autoUpdate: v })} label="Notify when a new version is published" description="Stored as the Update Preferences policy; the nightly job records the latest version so the dashboard can flag it." />
            <ErrorBanner error={saveError} />
            <FormActions><Button variant="primary" loading={busy === 'save'} disabled={!dirty} onClick={save}>Save</Button></FormActions>
          </Card>
        </>
      )}
    </>
  );
}
