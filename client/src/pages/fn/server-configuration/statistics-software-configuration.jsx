import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../../api/client.js';
import { useApi } from '../../../hooks/useApi.js';
import { PageHeader, Card, Loading, StatusPill, KeyValue, formatDate } from '../../../components/Common.jsx';
import { Field, Toggle, Select, Button, FormActions } from '../../../components/Form.jsx';
import { useToast } from '../../../components/Toast.jsx';
import { useConfirm } from '../../../components/Modal.jsx';
import { RequestError, JobCard, LastJob, CronField } from '../../server-configuration/Shared.jsx';

const GENERATORS = [
  { key: 'awstats', label: 'AWStats', blurb: 'Detailed visitor, referrer, robot and bandwidth reports. Output in ~/tmp/awstats with a per-domain config in /etc/awstats.' },
  { key: 'webalizer', label: 'Webalizer', blurb: 'Fast incremental HTML reports. Output in ~/tmp/webalizer.' },
  { key: 'analog', label: 'Analog', blurb: 'Compact summary report (index.html) in ~/tmp/analog.' },
];

export default function StatisticsSoftwareConfiguration({ fn }) {
  const toast = useToast();
  const confirm = useConfirm();
  const { data, loading, error, refetch } = useApi('/server-config/stats');
  const [draft, setDraft] = useState(null);
  const [busy, setBusy] = useState(false);
  const [jobId, setJobId] = useState(null);
  const [runError, setRunError] = useState(null);
  useEffect(() => { if (data) setDraft({ generators: data.generators, defaultGenerator: data.defaultGenerator, allowUserChoice: data.allowUserChoice, includeSuspended: data.includeSuspended }); }, [data]);
  const base = data && { generators: data.generators, defaultGenerator: data.defaultGenerator, allowUserChoice: data.allowUserChoice, includeSuspended: data.includeSuspended };
  const dirty = draft && base && JSON.stringify(draft) !== JSON.stringify(base);

  const save = async (extra = {}) => {
    setBusy(true);
    const body = { ...extra };
    if (draft && base) for (const k of Object.keys(draft)) if (JSON.stringify(draft[k]) !== JSON.stringify(base[k])) body[k] = draft[k];
    try { await api.put('/server-config/stats', body); toast.success('Statistics settings saved'); refetch(); } catch (err) { toast.error(err); } finally { setBusy(false); }
  };
  const run = async (generator) => {
    if (!(await confirm({ title: 'Generate statistics now?', message: `Runs ${generator || 'every enabled generator'} for all ${data.domains} active domain(s) as a background job. Large logs take a while.`, confirmLabel: 'Generate' }))) return;
    setRunError(null);
    try { const { data: d } = await api.post('/server-config/stats/run', generator ? { generator } : {}); setJobId(d.job.id); if (d.skipped.length) toast.warning(`Skipped (not installed): ${d.skipped.join(', ')}`); } catch (err) { if (err.status === 501) setRunError(err); else toast.error(err); }
  };

  const det = data?.detect?.generators || {};
  return (
    <>
      <PageHeader fn={fn} description="Choose which web statistics generators process the per-domain access logs, which one accounts get by default and how often statistics are rebuilt." actions={data && <Button variant="primary" onClick={() => run()}>Generate now</Button>} />
      <RequestError error={error} onRetry={refetch} />
      {loading && !data && <Loading />}
      {data && draft && (
        <>
          <RequestError error={runError} onRetry={() => { setRunError(null); refetch(); }} />
          <Card title="Generators" subtitle={data.detect?.domlogsRoot ? `Logs are read from ${data.detect.domlogsRoot}/<user>/<domain>-access.log` : undefined}>
            <div className="table-wrap"><table>
              <thead><tr><th>Generator</th><th>Installed</th><th>Enabled</th><th /></tr></thead>
              <tbody>
                {GENERATORS.map((g) => {
                  const d = det[g.key] || {};
                  return (
                    <tr key={g.key}>
                      <td><strong>{g.label}</strong><br /><small className="muted">{g.blurb}</small></td>
                      <td>{d.installed ? <StatusPill status="installed">{d.version ? `v${d.version}` : 'installed'}</StatusPill> : <><StatusPill status="not-installed">not installed</StatusPill><br /><small className="muted">{d.packages ? <Link to="/software/install-distro-packages">install {d.packages.apt?.[0]}</Link> : null}</small></>}</td>
                      <td><Toggle checked={Boolean(draft.generators[g.key])} onChange={(v) => setDraft((x) => ({ ...x, generators: { ...x.generators, [g.key]: v } }))} /></td>
                      <td><Button size="sm" disabled={!d.installed} onClick={() => run(g.key)}>Run {g.label}</Button></td>
                    </tr>
                  );
                })}
              </tbody>
            </table></div>
            <div className="form-grid" style={{ marginTop: 12 }}>
              <Field label="Default generator for new accounts" help="Must be one of the enabled generators"><Select value={draft.defaultGenerator} onChange={(v) => setDraft((x) => ({ ...x, defaultGenerator: v }))} options={GENERATORS.map((g) => ({ value: g.key, label: g.label, disabled: !draft.generators[g.key] }))} /></Field>
            </div>
            <Field inline><Toggle checked={draft.allowUserChoice} onChange={(v) => setDraft((x) => ({ ...x, allowUserChoice: v }))} label="Let account owners choose their generator" description="Shown in cPanel › Metrics when more than one generator is enabled." /></Field>
            <Field inline><Toggle checked={draft.includeSuspended} onChange={(v) => setDraft((x) => ({ ...x, includeSuspended: v }))} label="Process suspended accounts too" /></Field>
            <FormActions>
              <Button variant="primary" loading={busy} disabled={!dirty} onClick={() => save()}>Save</Button>
              <Button disabled={!dirty || busy} onClick={() => setDraft(base)}>Reset</Button>
            </FormActions>
          </Card>
          <div className="form-grid">
            <Card title="Schedule" actions={data.schedule && <StatusPill status={data.schedule.enabled ? 'enabled' : 'disabled'}>{data.schedule.enabled ? 'enabled' : 'disabled (no generator on)'}</StatusPill>}>
              {data.schedule ? (
                <>
                  <Field label="Cron expression" help="Nightly after log rotation is typical"><CronField value={data.schedule.cron} onSave={(cron) => save({ cron })} saving={busy} /></Field>
                  <KeyValue items={[['Last run', formatDate(data.schedule.lastRunAt)], ['Next run', formatDate(data.schedule.nextRunAt)], ['Active domains', data.domains]]} />
                  <p className="muted">The schedule follows the generators: it is disabled automatically while none is enabled. Edit it with the other panel schedules in <Link to="/server-configuration/configure-cpanel-cron-jobs">Configure cPanel Cron Jobs</Link>.</p>
                </>
              ) : <p className="muted">Schedule not registered.</p>}
            </Card>
            <Card title="Last run" actions={<LastJob job={data.lastJob} />}>
              {data.lastRun ? <KeyValue items={[['When', formatDate(data.lastRun.at)], ['Generators', (data.lastRun.generators || []).join(', ') || '—'], ['Domains', data.lastRun.domains], ['Generated', data.lastRun.generated], ['Skipped (no log yet)', data.lastRun.skipped], ['Failed', data.lastRun.failed]]} /> : <p className="muted">Statistics have not been generated yet.</p>}
            </Card>
          </div>
          <JobCard jobId={jobId} title="Statistics generation" onFinished={() => refetch()} />
        </>
      )}
    </>
  );
}
