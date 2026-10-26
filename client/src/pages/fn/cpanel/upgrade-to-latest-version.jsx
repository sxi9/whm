import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowUpCircle, ShieldCheck, AlertTriangle, KeyRound } from 'lucide-react';
import { api } from '../../../api/client.js';
import { useApi } from '../../../hooks/useApi.js';
import { PageHeader, Card, StatusPill, Loading, KeyValue, formatDate } from '../../../components/Common.jsx';
import { Field, TextInput, Textarea, Toggle, Button, FormActions, ErrorBanner } from '../../../components/Form.jsx';
import { ProgressLog } from '../../../components/ProgressLog.jsx';
import { useConfirm } from '../../../components/Modal.jsx';
import { useToast } from '../../../components/Toast.jsx';
import { renderMarkdown } from '../../plugins/PluginPage.jsx';

function ReleaseKeys({ keys, onChanged }) {
  const toast = useToast();
  const confirm = useConfirm();
  const [kid, setKid] = useState('');
  const [pem, setPem] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const add = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try { await api.post('/cpanel/upgrade/keys', { kid: kid.trim(), pem }); toast.success(`Key ${kid.trim()} trusted`); setKid(''); setPem(''); onChanged(); } catch (err) { setError(err); } finally { setBusy(false); }
  };
  const remove = async (k) => {
    if (!(await confirm({ title: `Stop trusting key “${k.kid}”?`, message: 'Releases signed with it will no longer verify.', confirmLabel: 'Remove', danger: true }))) return;
    try { await api.delete(`/cpanel/upgrade/keys/${encodeURIComponent(k.kid)}`); toast.success('Key removed'); onChanged(); } catch (err) { toast.error(err); }
  };
  return (
    <Card title="Trusted release-signing keys" subtitle="Ed25519 public keys (PEM) that may sign releases; the feed's signature covers the archive's SHA-256 digest">
      {keys.length === 0 ? <p className="muted"><KeyRound size={16} /> No keys trusted: a release's signature cannot be checked, only its checksum.</p> : (
        <div className="table-wrap">
          <table>
            <thead><tr><th>Key id</th><th>Fingerprint</th><th>Added</th><th /></tr></thead>
            <tbody>{keys.map((k) => <tr key={k.kid}><td><code>{k.kid}</code> {!k.valid && <StatusPill status="failed">invalid</StatusPill>}</td><td className="mono small">{k.fingerprint || k.error}</td><td className="small">{formatDate(k.addedAt)}</td><td className="actions-col"><Button size="sm" variant="danger" onClick={() => remove(k)}>Remove</Button></td></tr>)}</tbody>
          </table>
        </div>
      )}
      <form onSubmit={add} className="form-narrow" style={{ marginTop: 12 }}>
        <Field label="Key id" help="Matches the feed's keyId, for example release-2026" error={error?.fields?.kid}><TextInput value={kid} onChange={setKid} className="input mono" maxLength={64} /></Field>
        <Field label="Public key (PEM)" error={error?.fields?.pem}><Textarea value={pem} onChange={setPem} rows={4} mono placeholder={'-----BEGIN PUBLIC KEY-----\n…\n-----END PUBLIC KEY-----'} /></Field>
        <ErrorBanner error={error && !error.fields ? error : null} />
        <FormActions><Button type="submit" variant="primary" loading={busy} disabled={!kid.trim() || !pem.includes('BEGIN PUBLIC KEY')}>Trust key</Button></FormActions>
      </form>
    </Card>
  );
}

export default function UpgradeToLatestVersion({ fn }) {
  const toast = useToast();
  const confirm = useConfirm();
  const { data, loading, error, refetch } = useApi('/cpanel/upgrade');
  const [checking, setChecking] = useState(false);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState(null);
  const [allowUnverified, setAllowUnverified] = useState(false);
  const [jobId, setJobId] = useState(null);
  const activeJobId = jobId || data?.activeJob?.id || null;

  const check = async () => {
    setChecking(true);
    try {
      const res = await api.post('/cpanel/upgrade/check');
      const d = res.data;
      if (d.lastCheck?.error) toast.error({ message: `Update check failed: ${d.lastCheck.error}` });
      else toast.success(d.updateAvailable ? `Version ${d.latest.version} is available` : `You are running the latest version (${d.currentVersion})`);
      refetch();
    } catch (err) { toast.error(err); } finally { setChecking(false); }
  };
  const start = async () => {
    const ok = await confirm({
      title: `Upgrade to ${data.latest.version}?`,
      message: `The release is downloaded and verified, then scripts/install.sh --upgrade runs as a detached systemd unit: it redeploys the code, rebuilds the interface and restarts whm-agentd and whm-panel. Sessions survive, but the panel is unavailable for a minute and this log stream ends when it restarts. Type UPGRADE to continue.`,
      confirmLabel: 'Start upgrade', danger: true, typeToConfirm: 'UPGRADE',
    });
    if (!ok) return;
    setStarting(true);
    setStartError(null);
    try {
      const res = await api.post('/cpanel/upgrade/start', { allowUnverified });
      setJobId(res.data.job.id);
      toast.success('Upgrade started');
    } catch (err) { setStartError(err); } finally { setStarting(false); }
  };

  if (loading && !data) return <><PageHeader fn={fn} /><Loading /></>;
  if (error) return <><PageHeader fn={fn} /><ErrorBanner error={error} onRetry={refetch} /></>;
  if (!data) return null;
  const v = data.verification;
  const verifiable = Boolean(v?.sha256 && (!v.signature || v.trustedKey));
  const last = data.last;

  return (
    <>
      <PageHeader fn={fn} actions={<Button onClick={refetch}>Refresh</Button>} />
      <Card title="Version" actions={<Button variant="primary" loading={checking} disabled={!data.updateUrlConfigured} onClick={check}>Check for updates</Button>}>
        <KeyValue items={[
          ['Running', <span key="r"><strong>{data.currentVersion}</strong> <span className="muted">({data.installMethod === 'git' ? `git checkout at ${data.repoRoot}` : data.installMethod === 'install-script' ? `installed with scripts/install.sh at ${data.repoRoot}` : 'manual install'})</span></span>],
          ['Latest', data.latest ? <span key="l"><strong>{data.latest.version}</strong> {data.updateAvailable ? <StatusPill status="warning">update available</StatusPill> : <StatusPill status="ok">up to date</StatusPill>}{data.latest.publishedAt ? <span className="muted"> · published {data.latest.publishedAt}</span> : null}</span> : <span key="l" className="muted">not checked yet</span>],
          ['Release feed', data.updateUrlConfigured ? <span key="u"><code className="small">{data.updateUrl}</code> · tier <code>{data.tier}</code></span> : <span key="u" className="muted">none configured — set it under <Link to="/server-configuration/update-preferences">Update Preferences</Link></span>],
          ['Last check', data.lastCheck ? <span key="c">{formatDate(data.lastCheck.at)} {data.lastCheck.ok ? <StatusPill status="ok">ok</StatusPill> : <StatusPill status="failed">{data.lastCheck.error}</StatusPill>}</span> : null],
        ]} />
        {data.latest?.notes && <><h3>Release notes</h3><div className="markdown">{renderMarkdown(data.latest.notes)}</div></>}
      </Card>

      {data.updateAvailable && (
        <Card title={`Upgrade to ${data.latest.version}`} subtitle="Download, verify, unpack and run the installer">
          {!data.canRun && (
            <div className="banner banner-warning"><AlertTriangle size={18} /><div><strong>Automatic upgrade is not available here</strong><p>{data.reason}</p></div></div>
          )}
          <KeyValue items={[
            ['Archive', data.latest.url ? <code key="a" className="small">{data.latest.url}</code> : <StatusPill key="a" status="failed">no download URL in the feed</StatusPill>],
            ['SHA-256', v?.sha256 ? <span key="s"><ShieldCheck size={14} /> published; verified before unpacking</span> : <StatusPill key="s" status="warning">not published</StatusPill>],
            ['Signature', v?.signature ? (v.trustedKey ? <span key="g"><ShieldCheck size={14} /> published; verified with trusted key {v.keyId ? <code>{v.keyId}</code> : null}</span> : <StatusPill key="g" status="warning">published but no trusted key {v.keyId ? `"${v.keyId}"` : ''}</StatusPill>) : <span key="g" className="muted">not published</span>],
          ]} />
          {!verifiable && (
            <Field inline>
              <Toggle checked={allowUnverified} onChange={setAllowUnverified} label="Install even though the release cannot be fully verified" description="Only do this for a feed you control. The download still has to come over HTTPS." />
            </Field>
          )}
          <div className="action-row">
            <Button variant="danger" icon={ArrowUpCircle} loading={starting} disabled={!data.canRun || !data.latest.url || Boolean(activeJobId) || (!verifiable && !allowUnverified)} onClick={start}>Download and upgrade</Button>
          </div>
          <ErrorBanner error={startError} />
        </Card>
      )}

      {activeJobId && (
        <Card title="Upgrade progress" subtitle="The installer's output is streamed here until the panel restarts; after that the result appears under “Last upgrade” once you reload.">
          <ProgressLog jobId={activeJobId} onFinished={() => refetch()} />
        </Card>
      )}

      {last && (
        <Card title="Last upgrade" actions={<StatusPill status={last.status === 'succeeded' ? 'ok' : last.status === 'failed' ? 'failed' : last.status === 'running' ? 'running' : 'unknown'}>{last.status}</StatusPill>}>
          <KeyValue items={[['Version', `${last.fromVersion} → ${last.version}`], ['Started', `${formatDate(last.startedAt)}${last.by ? ` by ${last.by}` : ''}`], last.finishedAt && ['Finished', formatDate(last.finishedAt)], ['Unit', <code key="u">{last.unit}</code>], ['Log file', <code key="f" className="small">{last.logFile}</code>]]} />
          {last.log && <pre className="log">{last.log}</pre>}
        </Card>
      )}

      <ReleaseKeys keys={data.releaseKeys} onChanged={refetch} />

      <Card title="Manual upgrade" subtitle="What the automatic path does, for servers where it is not available">
        <ol>{data.instructions.map((s) => <li key={s}><code>{s}</code></li>)}</ol>
        <p className="muted small">The feed is a JSON document with <code>version</code>, <code>url</code> (https), <code>sha256</code>, optional <code>signature</code> (base64 Ed25519 over the raw SHA-256 digest), <code>keyId</code>, <code>notes</code> and <code>publishedAt</code>, either at the top level or under <code>tiers.&lt;tier&gt;</code>.</p>
      </Card>
    </>
  );
}
