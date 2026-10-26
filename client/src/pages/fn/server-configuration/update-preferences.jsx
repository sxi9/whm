import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../../api/client.js';
import { useApi } from '../../../hooks/useApi.js';
import { PageHeader, Card, Loading, KeyValue, StatusPill, formatDate } from '../../../components/Common.jsx';
import { Field, RadioGroup, Toggle, Button, FormActions } from '../../../components/Form.jsx';
import { useToast } from '../../../components/Toast.jsx';
import { RequestError, JobCard } from '../../server-configuration/Shared.jsx';

const KEYS = ['tier', 'auto', 'autoOs', 'notifyContact'];
const pick = (d) => Object.fromEntries(KEYS.map((k) => [k, d[k]]));

export default function UpdatePreferences({ fn }) {
  const toast = useToast();
  const { data, loading, error, refetch } = useApi('/server-config/updates');
  const [draft, setDraft] = useState(null);
  const [busy, setBusy] = useState(false);
  const [jobId, setJobId] = useState(null);
  const [checkError, setCheckError] = useState(null);
  const [panelResult, setPanelResult] = useState(null);
  useEffect(() => { if (data) setDraft(pick(data)); }, [data]);
  const base = data && pick(data);
  const dirty = draft && base && JSON.stringify(draft) !== JSON.stringify(base);

  const save = async () => {
    setBusy(true);
    const changed = {};
    for (const k of KEYS) if (draft[k] !== base[k]) changed[k] = draft[k];
    try { await api.put('/server-config/updates', changed); toast.success('Update preferences saved'); refetch(); } catch (err) { toast.error(err); } finally { setBusy(false); }
  };
  const check = async () => {
    setCheckError(null); setPanelResult(null);
    try {
      const { data: d } = await api.post('/server-config/updates/check');
      if (d.job) setJobId(d.job.id);
      if (d.panel) setPanelResult(d.panel);
      if (!d.job && !d.panel) toast.info('Nothing to check: no package manager and no panel feed URL');
    } catch (err) { if (err.status === 501) setCheckError(err); else toast.error(err); }
  };

  return (
    <>
      <PageHeader fn={fn} description="Choose the release tier the panel follows and the update policy. Checks themselves are run by the Software category: the daily OS package check (os-update-check) and the panel release feed. This page records what you want and notifies the server contact." actions={<Button onClick={check} disabled={data && !data.checkAvailable && !data.panel}>Check for updates now</Button>} />
      <RequestError error={error} onRetry={refetch} />
      <RequestError error={checkError} onRetry={() => { setCheckError(null); refetch(); }} />
      {loading && !data && <Loading />}
      {data && draft && (
        <>
          <Card title="Release tier" subtitle="Which release the panel feed is compared against; Software › Update Server Software reads the same setting">
            <RadioGroup name="tier" value={draft.tier} onChange={(v) => setDraft((d) => ({ ...d, tier: v }))} options={data.tiers} />
          </Card>
          <Card title="Update policy">
            <Field inline><Toggle checked={draft.auto} onChange={(v) => setDraft((d) => ({ ...d, auto: v }))} label="Panel updates: apply automatically (recorded policy)" description="The panel does not update itself in place, so this is a recorded preference only: it is reported alongside the upgrade steps in Software › Update Server Software and starts nothing on its own." /></Field>
            <Field inline><Toggle checked={draft.autoOs} onChange={(v) => setDraft((d) => ({ ...d, autoOs: v }))} label="Apply operating system package updates automatically" description="Honoured by Software: the daily OS update check runs the package manager upgrade when updates are pending (Software › System Update)." /></Field>
            <Field inline><Toggle checked={draft.notifyContact} onChange={(v) => setDraft((d) => ({ ...d, notifyContact: v }))} label="Notify the server contact when updates are available" description="After every OS update check that finds security updates, and when the panel feed publishes a newer release on the selected tier." /></Field>
            <FormActions>
              <Button variant="primary" loading={busy} disabled={!dirty} onClick={save}>Save</Button>
              <Button disabled={!dirty || busy} onClick={() => setDraft(base)}>Reset</Button>
            </FormActions>
          </Card>
          {panelResult && (
            <Card title="Panel release feed" subtitle="Checked just now">
              {panelResult.error ? <p className="muted">Feed check failed: {panelResult.error}</p> : <KeyValue items={[['Installed', panelResult.current], ['Latest on tier', panelResult.latest ?? 'unknown'], ['Update available', panelResult.updateAvailable ? <StatusPill key="u" status="warning">yes</StatusPill> : <StatusPill key="u" status="ok">no</StatusPill>]]} />}
            </Card>
          )}
          <JobCard jobId={jobId} title="OS update check (Software)" onFinished={() => refetch()} />
          <div className="form-grid">
            <Card title="Panel">
              {data.panel ? <KeyValue items={[['Installed version', data.panel.currentVersion], ['Latest on tier', data.panel.latest?.version ?? 'unknown (no feed checked yet)'], ['Update available', data.panel.updateAvailable == null ? 'unknown' : data.panel.updateAvailable ? <StatusPill key="u" status="warning">yes</StatusPill> : <StatusPill key="u" status="ok">no</StatusPill>], ['Install method', data.panel.installMethod], ['Feed checked', formatDate(data.panel.lastCheck?.at)]]} /> : <p className="muted">The Software category is not loaded; panel release information is unavailable.</p>}
              <p className="muted" style={{ marginTop: 8 }}>Feed URL and manual upgrade steps live in <Link to="/software/update-server-software">Software › Update Server Software</Link>.</p>
            </Card>
            <Card title="Operating system packages">
              {data.os && !data.os.unavailable ? <KeyValue items={[['Package manager', data.os.manager], ['Pending updates', data.os.count], ['Security updates', data.os.security], ['Reboot required', data.os.rebootRequired ? <StatusPill key="r" status="warning">yes</StatusPill> : 'no'], ['Checked', formatDate(data.os.checkedAt)]]} /> : <p className="muted">{data.os?.reason || 'No package manager detected or the Software category is not loaded.'}</p>}
              <KeyValue items={[['Daily check schedule', data.schedule ? <>{data.schedule.cron} <StatusPill status={data.schedule.enabled ? 'enabled' : 'disabled'}>{data.schedule.enabled ? 'enabled' : 'disabled'}</StatusPill></> : 'not registered'], ['Last run', formatDate(data.schedule?.lastRunAt)], ['Next run', formatDate(data.schedule?.nextRunAt)]]} />
              <p className="muted" style={{ marginTop: 8 }}>Apply pending packages from <Link to="/software/system-update">Software › System Update</Link>; adjust the check schedule in <Link to="/server-configuration/configure-cpanel-cron-jobs">Configure cPanel Cron Jobs</Link>.</p>
            </Card>
          </div>
          {data.lastCheck && (
            <Card title="Last update check" subtitle={formatDate(data.lastCheck.at)}>
              <KeyValue items={[['Tier', data.lastCheck.tier], ['Panel', data.lastCheck.panel ? (data.lastCheck.panel.error ? `feed check failed: ${data.lastCheck.panel.error}` : `${data.lastCheck.panel.current} → ${data.lastCheck.panel.latest ?? '?'}${data.lastCheck.panel.updateAvailable ? ' (update available)' : ''}`) : 'not checked'], ['OS packages', data.lastCheck.os ? `${data.lastCheck.os.count} pending, ${data.lastCheck.os.security} security${data.lastCheck.os.rebootRequired ? ', reboot required' : ''}` : 'not checked']]} />
            </Card>
          )}
        </>
      )}
    </>
  );
}
