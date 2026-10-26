import { useState } from 'react';
import { api } from '../../../api/client.js';
import { PageHeader, Card, Loading, StatusPill } from '../../../components/Common.jsx';
import { Field, NumberInput, Select, Toggle, TextInput, Button } from '../../../components/Form.jsx';
import { useConfirm } from '../../../components/Modal.jsx';
import { useToast } from '../../../components/Toast.jsx';
import { useSettingsForm, SaveBar, RequestError, DaemonNotice, LastApply } from '../../service-config/Shared.jsx';

const POLICY_LABELS = { panel: ['Panel logs', 'panelLogs', '/var/log/whm/*.log — the WHM panel and agent logs'], accounts: ['Account logs', 'accountLogs', '/var/log/whm/domlogs/<user>/*.log — per-domain Apache access/error logs, rotated as root in a root-owned tree — plus one stanza per account for /home/<user>/logs/*.log (the PHP-FPM error log), rotated as that account (su <user>) because the directory belongs to the tenant'], webserver: ['Web server logs', 'webServerLogs', '/var/log/apache2, /var/log/httpd and /var/log/nginx — leave off when the distribution already ships a policy for them'] };

export default function LogRotationConfiguration({ fn }) {
  const toast = useToast();
  const confirm = useConfirm();
  const form = useSettingsForm('/service-config/logrotate');
  const { data, draft, set } = form;
  const [running, setRunning] = useState(null);
  const [output, setOutput] = useState(null);

  const run = async (name, force) => {
    if (force && !(await confirm({ title: `Force-rotate ${name} logs?`, message: 'Every matching log file is rotated now regardless of size or age.', confirmLabel: 'Rotate now' }))) return;
    setRunning(name); setOutput(null);
    try { const { data: d } = await api.post(`/service-config/logrotate/${name}/run`, { force }); setOutput({ name, ...d }); d.ok ? toast.success(`logrotate ${name}: done`) : toast.error('logrotate reported errors'); } catch (err) { toast.error(err); } finally { setRunning(null); }
  };

  return (
    <>
      <PageHeader fn={fn} description="Rotation policy for panel, account and web server logs, written as managed files under /etc/logrotate.d (whm-panel, whm-accounts, whm-webserver) and validated with logrotate -d before they are kept." />
      <RequestError error={form.error} onRetry={form.refetch} />
      {form.loading && !data && <Loading />}
      {data && draft && (
        <>
          <DaemonNotice installed={data.installed} message="logrotate is not installed on this server. Install the logrotate package; the policy you save here is written once it is." onRetry={form.refetch} />
          <Card title="Policy" className="config-fields" actions={<LastApply apply={data.lastApply} />}>
            <div className="form-grid">
              <Field label="Frequency"><Select value={draft.frequency} onChange={set('frequency')} options={['hourly', 'daily', 'weekly', 'monthly', 'yearly']} /></Field>
              <Field label="Keep (rotations)" help="rotate N: how many old files to keep; 0 deletes instead of rotating"><NumberInput value={draft.rotate} onChange={set('rotate')} min={0} max={3650} nullable={false} /></Field>
              <Field label="Rotate when larger than" help="maxsize, e.g. 100M; empty = only by schedule"><TextInput value={draft.maxSize} onChange={set('maxSize')} placeholder="100M" /></Field>
            </div>
            <Field inline><Toggle checked={draft.compress} onChange={set('compress')} label="Compress rotated logs (gzip)" /></Field>
            <Field inline><Toggle checked={draft.delaycompress} onChange={set('delaycompress')} label="Delay compression by one cycle" description="Keeps the most recent rotation readable while the daemon finishes writing" disabled={!draft.compress} /></Field>
            <Field inline><Toggle checked={draft.missingok} onChange={set('missingok')} label="Ignore missing files (missingok)" /></Field>
            <Field inline><Toggle checked={draft.notifempty} onChange={set('notifempty')} label="Skip empty logs (notifempty)" /></Field>
            <Field inline><Toggle checked={draft.dateext} onChange={set('dateext')} label="Date suffix instead of numbers (dateext)" /></Field>
            <Field inline><Toggle checked={draft.postrotateWeb} onChange={set('postrotateWeb')} label="Reload Apache after rotating account/web logs" description="postrotate: systemctl reload apache2|httpd" /></Field>
          </Card>
          <Card title="Managed policies" subtitle={`Files under ${data.managed?.dir || '/etc/logrotate.d'}`}>
            <div className="table-wrap">
              <table>
                <thead><tr><th>Policy</th><th>Paths</th><th>Enabled</th><th>On disk</th><th /></tr></thead>
                <tbody>
                  {data.policies.map((p) => {
                    const [label, key, help] = POLICY_LABELS[p.name];
                    return (
                      <tr key={p.name}>
                        <td><strong>{label}</strong><div className="small muted">{help}</div></td>
                        <td>
                          <code className="small">{p.perAccount ? `${p.preview.stanzas[0].paths.join(' ')} + ${Math.max(0, p.preview.stanzas.length - 1)} account stanza(s)` : p.paths.length ? p.paths.join(' ') : '(nothing left to rotate)'}</code>
                          {p.coveredBy?.length > 0 && <div className="small muted">Already rotated by the distribution: {p.coveredBy.join(', ')}{p.paths.length ? ' (those logs are left out)' : ' (no file is written)'}</div>}
                        </td>
                        <td><Toggle checked={draft[key]} onChange={set(key)} /></td>
                        <td>{p.file?.exists ? <StatusPill status="ok">whm-{p.name}</StatusPill> : <StatusPill status="pending">not written</StatusPill>}</td>
                        <td className="actions-col"><div className="row-actions"><Button size="sm" disabled={!p.file?.exists || !data.installed} loading={running === p.name} onClick={() => run(p.name, false)}>Run</Button><Button size="sm" disabled={!p.file?.exists || !data.installed} onClick={() => run(p.name, true)}>Force</Button></div></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {output && <div style={{ marginTop: 12 }}><StatusPill status={output.ok ? 'ok' : 'failed'}>logrotate {output.name}{output.force ? ' (forced)' : ''}</StatusPill><pre className="log" style={{ marginTop: 8 }}>{output.output || '(no output)'}</pre></div>}
          </Card>
          <Card title="Preview">
            {data.policies.filter((p) => draft[POLICY_LABELS[p.name][1]]).map((p) => <details key={p.name} open={p.name === 'accounts'}><summary>whm-{p.name}</summary><pre className="log">{renderPreview(p.preview, draft)}</pre></details>)}
          </Card>
          <SaveBar form={form} label="Save and write policies" />
        </>
      )}
    </>
  );
}

// Client-side mirror of the server renderer so the preview follows the draft.
function renderPreview(p, s) {
  const lines = [];
  const blocks = p.stanzas?.length ? p.stanzas : [{ paths: p.paths, su: p.su, postrotate: p.postrotate }];
  for (const b of blocks) {
    lines.push(`${b.paths.join(' ')} {`);
    if (b.su) lines.push(`    su ${b.su.user} ${b.su.group}`);
    lines.push(`    ${s.frequency}`, `    rotate ${s.rotate}`);
    if (s.maxSize) lines.push(`    maxsize ${s.maxSize}`);
    for (const k of ['compress', 'delaycompress', 'missingok', 'notifempty', 'dateext']) if (s[k] && (k !== 'delaycompress' || s.compress)) lines.push(`    ${k}`);
    if (p.copytruncate) lines.push('    copytruncate');
    if (!s.compress) lines.push('    nocompress');
    if ((b.postrotate ?? p.postrotate) !== 'none' && s.postrotateWeb) lines.push('    sharedscripts', '    postrotate', '        systemctl reload apache2.service || systemctl reload httpd.service || true', '    endscript');
    lines.push('}');
  }
  return lines.join('\n');
}
