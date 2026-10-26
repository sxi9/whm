import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../../api/client.js';
import { useApi } from '../../../hooks/useApi.js';
import { PageHeader, Card, Loading, KeyValue, StatusPill, formatDate } from '../../../components/Common.jsx';
import { Field, RadioGroup, Toggle, Button, FormActions } from '../../../components/Form.jsx';
import { useToast } from '../../../components/Toast.jsx';
import { RequestError, JobCard, CronField } from '../../server-configuration/Shared.jsx';

export default function UpdatePreferences({ fn }) {
  const toast = useToast();
  const { data, loading, error, refetch } = useApi('/server-config/updates');
  const [draft, setDraft] = useState(null);
  const [busy, setBusy] = useState(false);
  const [jobId, setJobId] = useState(null);
  useEffect(() => { if (data) setDraft({ tier: data.tier, auto: data.auto, autoOs: data.autoOs, notifyContact: data.notifyContact, scheduleEnabled: data.schedule?.enabled ?? true }); }, [data]);
  const base = data && { tier: data.tier, auto: data.auto, autoOs: data.autoOs, notifyContact: data.notifyContact, scheduleEnabled: data.schedule?.enabled ?? true };
  const dirty = draft && base && JSON.stringify(draft) !== JSON.stringify(base);

  const save = async (extra = {}) => {
    setBusy(true);
    const changed = { ...extra };
    for (const k of Object.keys(draft || {})) if (draft[k] !== base[k]) changed[k] = draft[k];
    try { await api.put('/server-config/updates', changed); toast.success('Update preferences saved'); refetch(); } catch (err) { toast.error(err); } finally { setBusy(false); }
  };
  const check = async () => {
    try { const { data: d } = await api.post('/server-config/updates/check'); setJobId(d.job.id); } catch (err) { toast.error(err); }
  };

  return (
    <>
      <PageHeader fn={fn} description="Choose the release tier the panel follows and whether updates (panel and operating system) apply automatically. The weekly check records what is pending and can notify the server contact." actions={<Button onClick={check}>Check for updates now</Button>} />
      <RequestError error={error} onRetry={refetch} />
      {loading && !data && <Loading />}
      {data && draft && (
        <>
          <Card title="Release tier">
            <RadioGroup name="tier" value={draft.tier} onChange={(v) => setDraft((d) => ({ ...d, tier: v }))} options={data.tiers} />
          </Card>
          <Card title="Automatic updates">
            <Field inline><Toggle checked={draft.auto} onChange={(v) => setDraft((d) => ({ ...d, auto: v }))} label="Apply panel updates automatically" description="When the release feed publishes a newer version on the selected tier." /></Field>
            <Field inline><Toggle checked={draft.autoOs} onChange={(v) => setDraft((d) => ({ ...d, autoOs: v }))} label="Apply operating system package updates automatically" description="Runs the package manager upgrade from the daily OS update check (Software › System Update)." /></Field>
            <Field inline><Toggle checked={draft.notifyContact} onChange={(v) => setDraft((d) => ({ ...d, notifyContact: v }))} label="Notify the server contact when updates are available" description="Security package updates or a newer panel release." /></Field>
            <Field inline><Toggle checked={draft.scheduleEnabled} onChange={(v) => setDraft((d) => ({ ...d, scheduleEnabled: v }))} label="Weekly update check" description={data.schedule ? `Cron ${data.schedule.cron} · next ${formatDate(data.schedule.nextRunAt)}` : 'Schedule not registered'} /></Field>
            {data.schedule && <Field label="Check schedule (cron)"><CronField value={data.schedule.cron} onSave={(cron) => save({ cron })} saving={busy} /></Field>}
            <FormActions>
              <Button variant="primary" loading={busy} disabled={!dirty} onClick={() => save()}>Save</Button>
              <Button disabled={!dirty || busy} onClick={() => setDraft(base)}>Reset</Button>
            </FormActions>
          </Card>
          <JobCard jobId={jobId} title="Update check" onFinished={() => refetch()} />
          <div className="form-grid">
            <Card title="Panel">
              {data.panel ? <KeyValue items={[['Installed version', data.panel.currentVersion], ['Latest on tier', data.panel.latest?.version ?? 'unknown (no feed checked yet)'], ['Update available', data.panel.updateAvailable == null ? 'unknown' : data.panel.updateAvailable ? <StatusPill key="u" status="warning">yes</StatusPill> : <StatusPill key="u" status="ok">no</StatusPill>], ['Install method', data.panel.installMethod]]} /> : <p className="muted">The Software category is not loaded; panel release information is unavailable.</p>}
              <p className="muted" style={{ marginTop: 8 }}>Feed URL and manual upgrade steps live in <Link to="/software/update-server-software">Software › Update Server Software</Link>.</p>
            </Card>
            <Card title="Operating system packages">
              {data.os && !data.os.unavailable ? <KeyValue items={[['Package manager', data.os.manager], ['Pending updates', data.os.count], ['Security updates', data.os.security], ['Reboot required', data.os.rebootRequired ? <StatusPill key="r" status="warning">yes</StatusPill> : 'no'], ['Checked', formatDate(data.os.checkedAt)], ['Daily OS check', data.osSchedule ? `${data.osSchedule.cron} (${data.osSchedule.enabled ? 'on' : 'off'})` : 'n/a']]} /> : <p className="muted">{data.os?.reason || 'No package manager detected or the Software category is not loaded.'}</p>}
              <p className="muted" style={{ marginTop: 8 }}>Apply pending packages from <Link to="/software/system-update">Software › System Update</Link>.</p>
            </Card>
          </div>
          {data.lastCheck && (
            <Card title="Last update check" subtitle={formatDate(data.lastCheck.at)}>
              <KeyValue items={[['Tier', data.lastCheck.tier], ['Panel', data.lastCheck.panel ? `${data.lastCheck.panel.current} → ${data.lastCheck.panel.latest ?? '?'}${data.lastCheck.panel.updateAvailable ? ' (update available)' : ''}` : 'not checked'], ['OS packages', data.lastCheck.os ? `${data.lastCheck.os.count} pending, ${data.lastCheck.os.security} security` : 'not checked']]} />
            </Card>
          )}
        </>
      )}
    </>
  );
}
