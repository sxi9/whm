import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api/client.js';
import { useApi } from '../../hooks/useApi.js';
import { Card, StatusPill, Loading, KeyValue, CapabilityNotice, formatDate } from '../../components/Common.jsx';
import { Field, TextInput, Toggle, Button, FormActions, ErrorBanner } from '../../components/Form.jsx';
import { useToast } from '../../components/Toast.jsx';
import { useConfirm } from '../../components/Modal.jsx';

const RESERVED = new Set(['localhost', 'localhost.localdomain', 'localhost6', 'localhost6.localdomain6', 'ip6-localhost', 'ip6-loopback']);
const RESERVED_LABELS = new Set(['localhost', 'localhost6', 'ip6-localhost', 'ip6-loopback']);
const LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

// Mirrors the server's rules so the form can explain problems before submitting.
export function hostnameProblems(value) {
  const hostname = String(value || '').trim().toLowerCase().replace(/\.+$/, '');
  if (!hostname) return [];
  const problems = [];
  const labels = hostname.split('.');
  if (labels.some((l) => !LABEL_RE.test(l))) problems.push('Labels may only use letters, digits and "-" and cannot start or end with "-"');
  if (labels.length < 3) problems.push('Use at least three labels, like host.example.com');
  if (/^\d+$/.test(labels.at(-1))) problems.push('The hostname cannot be an IP address');
  if (labels[0] === 'www') problems.push('The hostname cannot start with "www"');
  if (RESERVED.has(hostname)) problems.push('That name is reserved for the loopback interface');
  else if (RESERVED_LABELS.has(labels[0])) problems.push(`The short name "${labels[0]}" is reserved for the loopback interface`);
  if (/\.(local|localdomain|localhost|arpa|internal|invalid|example|test)$/.test(hostname)) problems.push('That suffix is not resolvable on the public internet');
  return problems;
}

const isCapability = (e) => e && (e.status === 501 || e.code === 'capability_missing' || e.code === 'binary_not_found');

function StepList({ steps }) {
  const labels = { hostname: 'System hostname', hosts: '/etc/hosts', settings: 'Panel setting', certs: 'Service SSL certificates', dns: 'DNS A record' };
  return (
    <ul className="step-list" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
      {steps.map((s) => (
        <li key={s.step} style={{ display: 'flex', gap: 10, alignItems: 'flex-start', padding: '6px 0', borderBottom: '1px dashed var(--border)' }}>
          <StatusPill status={s.ok ? (s.skipped ? 'disabled' : 'ok') : 'failed'}>{s.ok ? (s.skipped ? 'skipped' : 'done') : 'failed'}</StatusPill>
          <div>
            <strong>{labels[s.step] || s.step}</strong>
            {s.detail && <div className="muted"><code>{s.detail}</code></div>}
            {s.error && <div className="muted">{s.error}{isCapability(s) ? (s.step === 'dns' ? ' (install the DNS server to publish records)' : ' (install openssl to re-issue certificates)') : ''}</div>}
            {s.step === 'certs' && s.manual?.length > 0 && <div className="muted">Re-issue or re-install the certificate for <strong>{s.manual.join(', ')}</strong> from <Link to="/service-configuration/manage-service-ssl-certificates">Manage Service SSL Certificates</Link>.</div>}
          </div>
        </li>
      ))}
    </ul>
  );
}

export function ChangeHostname() {
  const toast = useToast();
  const confirm = useConfirm();
  const { data: status, loading, error, refetch } = useApi('/networking/hostname');
  const [hostname, setHostname] = useState('');
  const [ip, setIp] = useState('');
  const [updateHosts, setUpdateHosts] = useState(true);
  const [addDnsRecord, setAddDnsRecord] = useState(false);
  const [reissueServiceCerts, setReissueServiceCerts] = useState(true);
  const [preview, setPreview] = useState(null);
  const [previewError, setPreviewError] = useState(null);
  const [result, setResult] = useState(null);
  const [submitError, setSubmitError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [savingDefaults, setSavingDefaults] = useState(false);
  const seeded = useRef(false);

  // The toggles are seeded from the saved defaults once; a refetch (after a
  // change, or Refresh) must not discard what the admin picked.
  useEffect(() => {
    if (!status) return;
    setHostname((h) => h || status.current || '');
    if (seeded.current) return;
    seeded.current = true;
    setUpdateHosts(status.defaults?.updateHosts ?? true);
    setAddDnsRecord(Boolean(status.capability?.dns && (status.defaults?.addDnsRecord ?? true)));
  }, [status]);

  const defaultsDirty = status && (updateHosts !== (status.defaults?.updateHosts ?? true) || addDnsRecord !== (status.defaults?.addDnsRecord ?? true));
  const saveDefaults = async () => {
    setSavingDefaults(true);
    try {
      await api.put('/networking/hostname/defaults', { updateHosts, addDnsRecord });
      toast.success('Saved as the defaults for future hostname changes');
      await refetch();
    } catch (err) { toast.error(err); } finally { setSavingDefaults(false); }
  };

  const problems = useMemo(() => hostnameProblems(hostname), [hostname]);
  const normalized = hostname.trim().toLowerCase().replace(/\.+$/, '');
  const unchanged = normalized && normalized === status?.current && status?.inSync;
  const canSubmit = normalized && !problems.length && !busy;
  const body = () => ({ hostname: normalized, ...(ip.trim() ? { ip: ip.trim() } : {}) });

  useEffect(() => { setPreview(null); setPreviewError(null); }, [hostname, ip]);

  const doPreview = async () => {
    setPreviewError(null);
    try {
      const { data } = await api.post('/networking/hostname/preview', body());
      setPreview(data);
    } catch (err) { setPreviewError(err); }
  };

  const submit = async (e) => {
    e.preventDefault();
    if (!canSubmit) return;
    const ok = await confirm({
      title: `Change the hostname to ${normalized}?`,
      message: `hostnamectl sets the kernel hostname immediately${updateHosts ? ', /etc/hosts is rewritten to map it to ' + (ip.trim() || status?.ip || '127.0.1.1') : ''}${reissueServiceCerts ? ', self-signed service certificates that name the old host are re-issued' : ''}${addDnsRecord ? ', and an A record is added to the DNS zone' : ''}. Mail and web daemons pick the new name up when they are restarted. Type the new hostname to confirm.`,
      confirmLabel: 'Change hostname', danger: true, typeToConfirm: normalized,
    });
    if (!ok) return;
    setBusy(true);
    setSubmitError(null);
    setResult(null);
    try {
      const { data } = await api.post('/networking/hostname', { ...body(), updateHosts, addDnsRecord, reissueServiceCerts });
      setResult(data);
      if (data.ok) toast.success(`Hostname changed to ${data.hostname}`);
      else toast.warning(`Hostname changed to ${data.hostname}, but some steps failed; see below`);
      setPreview(null);
      await refetch();
    } catch (err) {
      setSubmitError(err);
      toast.error(err);
    } finally { setBusy(false); }
  };

  return (
    <>
      {loading && !status && <Loading />}
      <ErrorBanner error={error} onRetry={refetch} />
      {status && (
        <Card title="Current hostname" actions={<Button size="sm" onClick={() => refetch()}>Refresh</Button>}>
          <KeyValue items={[
            ['System hostname', <span key="h"><code>{status.current || '(unknown)'}</code> {status.validation?.ok ? <StatusPill status="ok">fully qualified</StatusPill> : <StatusPill status="warning">{status.validation?.problems?.[0] || 'not valid'}</StatusPill>}</span>],
            ['Panel setting (basic.hostname)', <span key="c"><code>{status.configured || '(not set)'}</code> {status.inSync ? <StatusPill status="ok">in sync</StatusPill> : <StatusPill status="warning">differs</StatusPill>}</span>],
            ['Main IP address', status.ip ? <span key="i"><code>{status.ip}</code>{!status.configuredIp && <span className="muted"> (detected; set it in <Link to="/server-configuration/basic-webhost-manager-setup">Basic Setup</Link>)</span>}</span> : <span key="i" className="muted">none detected</span>],
            ['/etc/hosts entry', status.hosts?.error ? <StatusPill key="e" status="warning">{status.hosts.error}</StatusPill> : status.hosts?.entry ? <span key="e"><code>{status.hosts.entry.ip} {status.hosts.entry.names.join(' ')}</code> {status.hosts.ok ? <StatusPill status="ok">{status.hosts.loopback && status.hosts.entry.ip !== status.ip ? 'loopback' : 'ok'}</StatusPill> : <StatusPill status="warning">points elsewhere</StatusPill>}</span> : <StatusPill key="e" status="warning">missing</StatusPill>],
            status.dns && ['DNS A record', status.dns.error ? <span key="d" className="muted">{status.dns.error}</span> : status.dns.record ? <span key="d"><code>{status.dns.recordName} IN A {status.dns.record.value}</code> in <Link to={`/dns-functions/dns-zone-manager?domain=${status.dns.zone}`}>{status.dns.zone}</Link></span> : <span key="d"><StatusPill status="warning">missing</StatusPill> <Link to="/dns-functions/add-an-a-entry-for-your-hostname">Add an A entry</Link></span>],
            ['Resolves publicly', status.resolves ? (status.resolves.matches ? <StatusPill key="r" status="ok">yes → {status.resolves.answers.join(', ')}</StatusPill> : <StatusPill key="r" status="warning">{status.resolves.answers?.length ? `resolves to ${status.resolves.answers.join(', ')}` : status.resolves.error || 'no answer'}</StatusPill>) : <span key="r" className="muted">not checked</span>],
            ['hostnamectl', status.capability?.hostnamectl ? <StatusPill key="k" status="installed">available</StatusPill> : <StatusPill key="k" status="not-installed">not installed</StatusPill>],
            status.lastChange && ['Last change', <span key="l">{status.lastChange.before?.hostname || '—'} → {status.lastChange.after?.hostname} by {status.lastChange.principal || 'system'} on {formatDate(status.lastChange.createdAt)}</span>],
          ]} />
        </Card>
      )}
      <Card title="New hostname" subtitle="Must be fully qualified (host.example.com), must not start with www and must not be a domain hosted on this server.">
        {status && !status.capability?.hostnamectl && <CapabilityNotice error={{ code: 'capability_missing', message: 'hostnamectl (systemd) is not installed, so the system hostname cannot be changed from the panel.' }} onRetry={refetch} />}
        <form onSubmit={submit} className="form-narrow">
          <Field label="Hostname" required error={problems} help={!problems.length && normalized ? `Short name: ${normalized.split('.')[0]}` : undefined}>
            <TextInput value={hostname} onChange={setHostname} placeholder="host.example.com" autoComplete="off" spellCheck={false} />
          </Field>
          <Field label="IP address for /etc/hosts" help={`Blank uses the main IP${status?.ip ? ` (${status.ip})` : ''}; 127.0.1.1 is used when no address is known.`}>
            <TextInput value={ip} onChange={setIp} placeholder={status?.ip || '203.0.113.10'} />
          </Field>
          <Field inline><Toggle checked={updateHosts} onChange={setUpdateHosts} label="Update /etc/hosts" description="Map the new name to the IP above and drop the old name. Required for sudo, Exim and local tools to resolve the hostname." /></Field>
          <Field inline><Toggle checked={reissueServiceCerts} onChange={setReissueServiceCerts} label="Re-issue self-signed service certificates" description="Service certificates (Exim, Dovecot, Apache, FTP, panel) that are self-signed and name the old host are regenerated for the new name. CA-issued certificates are never replaced; they are listed for manual re-issue." /></Field>
          <Field inline><Toggle checked={addDnsRecord} onChange={setAddDnsRecord} disabled={!status?.capability?.dns} label="Add an A record for the hostname" description={status?.capability?.dns ? 'Creates the record in the matching zone (creating the parent zone when needed) through DNS Functions.' : 'DNS Functions are not available on this panel.'} /></Field>
          {unchanged && <p className="muted">This is already the hostname; applying again only repairs /etc/hosts and the DNS record.</p>}
          <FormActions>
            <Button type="submit" variant="danger" loading={busy} disabled={!canSubmit}>Change hostname</Button>
            <Button onClick={doPreview} disabled={!normalized || problems.length > 0}>Preview /etc/hosts</Button>
            <Button size="sm" onClick={saveDefaults} loading={savingDefaults} disabled={!defaultsDirty} title="Remember the /etc/hosts and DNS record choices for future hostname changes">Save toggles as defaults</Button>
          </FormActions>
        </form>
        <ErrorBanner error={previewError} />
        {preview && (
          <div style={{ marginTop: 14 }}>
            {preview.conflict && <div className="banner banner-error"><div><strong>{preview.hostname}</strong> is a {preview.conflict.type} domain of account <code>{preview.conflict.account}</code>; the server will refuse it.</div></div>}
            <p className="muted">{preview.changed ? `New entry: ${preview.entry.ip} ${preview.entry.names.join(' ')}` : '/etc/hosts already contains this mapping; nothing would change.'}</p>
            <div className="form-grid">
              <div><strong>Before</strong><pre className="log">{preview.before || '(empty)'}</pre></div>
              <div><strong>After</strong><pre className="log">{preview.after}</pre></div>
            </div>
          </div>
        )}
        <CapabilityNotice error={submitError} onRetry={refetch} />
        {submitError && !isCapability(submitError) && <ErrorBanner error={submitError} />}
      </Card>
      {result && (
        <Card title={result.ok ? `Hostname changed to ${result.hostname}` : `Hostname changed to ${result.hostname} with problems`}>
          <StepList steps={result.steps} />
          <p className="muted" style={{ marginTop: 12 }}>
            Previous hostname: <code>{result.previous || '—'}</code>. Apache, Exim and Dovecot read the hostname at start-up; restart them from{' '}
            <Link to="/restart-services/mail-server-exim">Mail Server (Exim)</Link>, <Link to="/restart-services/imap-server">IMAP Server</Link> and <Link to="/restart-services/http-server-apache">HTTP Server</Link>. Service certificates are managed in <Link to="/service-configuration/manage-service-ssl-certificates">Manage Service SSL Certificates</Link>.
          </p>
        </Card>
      )}
    </>
  );
}
