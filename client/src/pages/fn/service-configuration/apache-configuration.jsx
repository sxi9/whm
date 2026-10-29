import { useState } from 'react';
import { api } from '../../../api/client.js';
import { PageHeader, Card, Loading, StatusPill, KeyValue, CapabilityNotice, formatBytes, formatDuration } from '../../../components/Common.jsx';
import { Field, TextInput, NumberInput, Select, Toggle, Textarea, Button, FormActions } from '../../../components/Form.jsx';
import { useConfirm } from '../../../components/Modal.jsx';
import { useToast } from '../../../components/Toast.jsx';
import { useSettingsForm, SaveBar, RequestError, LastApply, UnitPill, Tabs, ListEditor } from '../../service-config/Shared.jsx';

const TOKENS = ['Prod', 'Major', 'Minor', 'Min', 'OS', 'Full'];
const MPMS = [{ value: 'event', label: 'event (threaded, recommended with PHP-FPM)' }, { value: 'worker', label: 'worker (threaded)' }, { value: 'prefork', label: 'prefork (one process per request; required by mod_php)' }];

export default function ApacheConfiguration({ fn }) {
  const toast = useToast();
  const confirm = useConfirm();
  const [tab, setTab] = useState('global');
  const [test, setTest] = useState(null);
  const [testing, setTesting] = useState(false);
  const [busy, setBusy] = useState(null);
  const form = useSettingsForm('/service-config/apache', {
    confirm: async (draft, base) => (draft.mpm.module !== base.mpm.module ? confirm({ title: 'Switch MPM?', message: `Changing the MPM from ${base.mpm.module} to ${draft.mpm.module} restarts Apache; every site is unavailable for a moment. mod_php (if loaded) only works with prefork.`, confirmLabel: 'Switch and restart', danger: true }) : true),
  });
  const { data, draft, set, patch } = form;
  const setMpm = (k) => (v) => patch({ mpm: { ...draft.mpm, [k]: v } });

  const runTest = async () => {
    setTesting(true); setTest(null);
    try { const { data: d } = await api.post('/service-config/apache/configtest', { customDirectives: draft.customDirectives, mpm: draft.mpm, directoryIndex: draft.directoryIndex }); setTest(d); d.ok ? toast.success('Syntax OK') : toast.error('Apache rejected the configuration'); } catch (err) { setTest({ ok: false, output: err.message, error: err }); if (err.status !== 501) toast.error(err); } finally { setTesting(false); }
  };
  const action = async (verb) => {
    if (verb === 'restart' && !(await confirm({ title: 'Restart Apache?', message: 'Open connections are dropped while Apache restarts.', confirmLabel: 'Restart', danger: true }))) return;
    setBusy(verb);
    try { const { data: d } = await api.post(`/service-config/apache/${verb}`); toast.success(`Apache ${verb === 'reload' ? 'reloaded' : 'restarted'}${d.unit ? ` (${d.unit})` : ''}`); form.refetch(); } catch (err) { toast.error(err); } finally { setBusy(null); }
  };
  const syncVhosts = async () => {
    setBusy('sync');
    try { const { data: d } = await api.post('/service-config/apache/vhosts/sync', {}); toast.success(`Virtual host sync queued (job #${d.job.id})`); } catch (err) { toast.error(err); } finally { setBusy(null); }
  };
  // The flag lives in the panel settings; the vhosts that carry a certificate
  // are re-rendered by the sync job so the change reaches Apache.
  const setForceHttps = async (enabled) => {
    setBusy('https');
    try {
      await api.put('/system/settings', { 'web.force_https': enabled });
      const { data: d } = await api.post('/service-config/apache/vhosts/sync', {});
      toast.success(`HTTP to HTTPS redirect ${enabled ? 'enabled' : 'disabled'}; virtual hosts re-render in job #${d.job.id}`);
      form.refetch();
    } catch (err) { toast.error(err); } finally { setBusy(null); }
  };

  const threaded = draft?.mpm?.module !== 'prefork';
  return (
    <>
      <PageHeader fn={fn} description="Global Apache directives rendered into a managed include (conf-enabled/whm.conf or conf.d/whm.conf), the MPM, mod_status and an include editor. Every save runs the configuration test first and rolls back if Apache rejects it." actions={data?.installed && (
        <>
          <Button onClick={() => action('reload')} loading={busy === 'reload'}>Reload</Button>
          <Button onClick={() => action('restart')} loading={busy === 'restart'} variant="danger">Restart</Button>
        </>
      )} />
      <RequestError error={form.error} onRetry={form.refetch} />
      {form.loading && !data && <Loading />}
      {data && (
        <>
          {!data.installed && <CapabilityNotice capability="apache" error={{ code: 'capability_missing', message: 'Apache is not installed on this server. Install apache2 (Debian/Ubuntu) or httpd (RHEL); the settings you save here are kept and applied once it is.' }} onRetry={form.refetch} />}
          <Card title="Server" actions={<LastApply apply={data.lastApply} />}>
            <KeyValue items={[
              ['Unit', <UnitPill key="u" unit={data.status?.unit} />],
              ['Version', data.status?.version || data.detect?.version || '—'],
              ['Layout', data.detect?.flavor ? `${data.detect.flavor} (${data.detect.root})` : '—'],
              ['Running MPM', data.status?.mpm || data.detect?.mpm || '—'],
              ['Listening on', data.ports ? <span key="p"><code>{data.ports.bind ? `${data.ports.bind}:` : ''}{data.ports.http}</code>{data.ports.https ? <> and <code>{data.ports.bind ? `${data.ports.bind}:` : ''}{data.ports.https}</code> (TLS)</> : <> only; HTTPS is terminated by the reverse proxy</>}{data.ports.bind && <span className="small muted"> — bound behind the NGINX proxy (Software › NGINX Manager); every virtual host uses this address</span>}</span> : '—'],
              ['Domain logs', <span key="l"><code>{data.domlogsRoot || '/var/log/whm/domlogs'}/&lt;user&gt;/</code> <span className="small muted">root-owned, readable by the account</span></span>],
              ['Managed include', data.include?.path ? <span key="i"><code>{data.include.path}</code> {data.include.exists ? <StatusPill status="ok">present{data.include.enabled ? ', enabled' : ', not enabled'}</StatusPill> : <StatusPill status="pending">not written yet</StatusPill>}</span> : '—'],
              ['Virtual hosts', <span key="v">{data.vhosts.total} total · {data.vhosts.applied} applied · {data.vhosts.pending} pending · {data.vhosts.failed} failed <Button size="sm" onClick={syncVhosts} loading={busy === 'sync'} disabled={!data.installed}>Re-render all</Button></span>],
              ['Hostname site', data.hostnameVhost ? <span key="h"><code>{data.hostnameVhost.domain}</code> <StatusPill status={data.hostnameVhost.status === 'applied' ? 'ok' : data.hostnameVhost.status === 'pending' ? 'pending' : 'failed'}>{data.hostnameVhost.status}</StatusPill> <span className="small muted">landing page from <code>{data.landingDocroot || '/var/www/whm-default'}</code>{data.hostnameVhost.ssl ? ', HTTPS' : ', no certificate yet'}; edit it under Account Functions › Web Template Editor</span></span> : <span key="h" className="muted">not rendered yet (set a fully qualified hostname in Networking Setup › Change Hostname)</span>],
              ['HTTPS redirect', <div key="r"><Toggle checked={Boolean(data.forceHttps)} onChange={setForceHttps} disabled={busy === 'https'} label="Redirect HTTP to HTTPS when a certificate is installed" description="Every virtual host with a certificate answers port 80 with a 301 to https:// (the ACME challenge path stays on HTTP). Sites without a certificate are not touched." />{data.rewriteModule === false && <div className="banner banner-warning"><div>mod_rewrite is not loaded, so the redirect block in each virtual host is inert. Run <code>a2enmod rewrite</code> (Debian/Ubuntu) or load <code>mod_rewrite</code> (RHEL) and reload Apache.</div></div>}</div>],
              ['PHP-FPM', data.php?.versions?.length ? data.php.versions.map((v) => `${v.version} (${v.poolDir})`).join(', ') : 'no PHP-FPM trees found'],
              data.status?.serverStatus && ['mod_status', <span key="s">{data.status.serverStatus.busyWorkers} busy / {data.status.serverStatus.idleWorkers} idle workers · {data.status.serverStatus.requestsPerSecond?.toFixed?.(2) ?? data.status.serverStatus.requestsPerSecond} req/s · {formatBytes((data.status.serverStatus.totalKBytes || 0) * 1024)} served · up {formatDuration(data.status.serverStatus.uptimeSeconds)}</span>],
              data.status?.modules?.length && ['Loaded modules', <span key="m" className="small">{data.status.modules.map((m) => m.name).join(', ')}</span>],
            ]} />
          </Card>
          {draft && (
            <>
              <Tabs value={tab} onChange={setTab} tabs={[{ value: 'global', label: 'Global directives' }, { value: 'mpm', label: 'MPM / workers' }, { value: 'include', label: 'Include editor' }]} />
              {tab === 'global' && (
                <Card className="config-fields">
                  <div className="form-grid">
                    <Field label="Timeout (s)" help="Timeout: how long Apache waits for I/O on a request"><NumberInput value={draft.timeout} onChange={set('timeout')} min={1} max={86400} nullable={false} /></Field>
                    <Field inline><Toggle checked={draft.keepAlive} onChange={set('keepAlive')} label="KeepAlive" description="Allow several requests per TCP connection" /></Field>
                    <Field label="MaxKeepAliveRequests" help="0 = unlimited"><NumberInput value={draft.maxKeepAliveRequests} onChange={set('maxKeepAliveRequests')} min={0} nullable={false} /></Field>
                    <Field label="KeepAliveTimeout (s)"><NumberInput value={draft.keepAliveTimeout} onChange={set('keepAliveTimeout')} min={1} max={3600} nullable={false} /></Field>
                    <Field label="ServerTokens" help="How much the Server header reveals"><Select value={draft.serverTokens} onChange={set('serverTokens')} options={TOKENS} /></Field>
                    <Field label="ServerSignature"><Select value={draft.serverSignature} onChange={set('serverSignature')} options={['On', 'Off', 'EMail']} /></Field>
                    <Field label="TraceEnable" help="off blocks the TRACE method (recommended)"><Select value={draft.traceEnable} onChange={set('traceEnable')} options={['on', 'off', 'extended']} /></Field>
                    <Field label="HostnameLookups" help="Off keeps logging fast; names are resolved by the log analysers"><Select value={draft.hostnameLookups} onChange={set('hostnameLookups')} options={['On', 'Off', 'Double']} /></Field>
                    <Field label="ServerAdmin" help="Shown on error pages; empty keeps the distribution default"><TextInput value={draft.serverAdmin} onChange={set('serverAdmin')} placeholder="webmaster@example.com" /></Field>
                    <Field label="FileETag"><Select value={draft.fileETag} onChange={set('fileETag')} options={['None', 'MTime Size', 'INode MTime Size', 'All']} /></Field>
                    <Field label="LimitRequestBody (bytes)" help="0 = unlimited"><NumberInput value={draft.limitRequestBody} onChange={set('limitRequestBody')} min={0} nullable={false} /></Field>
                    <Field label="Default PHP-FPM version for new accounts" help="Used when the package does not name one"><Select value={draft.defaultPhpVersion ?? ''} onChange={(v) => set('defaultPhpVersion')(v || null)} options={(data.php?.versions || []).map((v) => ({ value: v.version, label: `PHP ${v.version}` }))} placeholder="Newest installed" /></Field>
                  </div>
                  <Field label="DirectoryIndex" help="One per line; the first existing file is served for a directory request"><ListEditor value={draft.directoryIndex} onChange={set('directoryIndex')} placeholder="index.php" /></Field>
                  <Field inline><Toggle checked={draft.serverStatus} onChange={set('serverStatus')} label="Enable mod_status at /server-status for localhost" description="Needed for the worker counters on this page (Require local)" /></Field>
                </Card>
              )}
              {tab === 'mpm' && (
                <Card className="config-fields" subtitle="Values are rendered inside <IfModule mpm_*_module> so only the active MPM reads them. Changing the module itself restarts Apache.">
                  <Field label="MPM module"><Select value={draft.mpm.module} onChange={setMpm('module')} options={MPMS} /></Field>
                  <div className="form-grid">
                    <Field label="StartServers"><NumberInput value={draft.mpm.startServers} onChange={setMpm('startServers')} min={1} nullable={false} /></Field>
                    <Field label="ServerLimit"><NumberInput value={draft.mpm.serverLimit} onChange={setMpm('serverLimit')} min={1} nullable={false} /></Field>
                    <Field label="MaxRequestWorkers" help="Hard cap on simultaneous requests"><NumberInput value={draft.mpm.maxRequestWorkers} onChange={setMpm('maxRequestWorkers')} min={1} nullable={false} /></Field>
                    <Field label="MaxConnectionsPerChild" help="0 = never recycle"><NumberInput value={draft.mpm.maxConnectionsPerChild} onChange={setMpm('maxConnectionsPerChild')} min={0} nullable={false} /></Field>
                    {!threaded && <Field label="MinSpareServers"><NumberInput value={draft.mpm.minSpareServers} onChange={setMpm('minSpareServers')} min={1} nullable={false} /></Field>}
                    {!threaded && <Field label="MaxSpareServers"><NumberInput value={draft.mpm.maxSpareServers} onChange={setMpm('maxSpareServers')} min={1} nullable={false} /></Field>}
                    {threaded && <Field label="MinSpareThreads"><NumberInput value={draft.mpm.minSpareThreads} onChange={setMpm('minSpareThreads')} min={1} nullable={false} /></Field>}
                    {threaded && <Field label="MaxSpareThreads"><NumberInput value={draft.mpm.maxSpareThreads} onChange={setMpm('maxSpareThreads')} min={1} nullable={false} /></Field>}
                    {threaded && <Field label="ThreadsPerChild"><NumberInput value={draft.mpm.threadsPerChild} onChange={setMpm('threadsPerChild')} min={1} nullable={false} /></Field>}
                  </div>
                  {threaded && data.status?.modules?.some((m) => /^php\d/.test(m.name)) && <div className="banner banner-warning"><div>mod_php is loaded; the {draft.mpm.module} MPM cannot be enabled until PHP runs through PHP-FPM.</div></div>}
                </Card>
              )}
              {tab === 'include' && (
                <Card title="Custom directives" subtitle="Appended verbatim to the managed include. Use Test configuration before saving; a rejected save is rolled back automatically.">
                  <Textarea value={draft.customDirectives} onChange={set('customDirectives')} rows={14} mono placeholder={'# e.g.\nServerName panel.example.com\n<IfModule mod_headers.c>\n  Header always set X-Content-Type-Options nosniff\n</IfModule>'} />
                  <FormActions>
                    <Button onClick={runTest} loading={testing} disabled={!data.installed}>Test configuration</Button>
                  </FormActions>
                  {test && (
                    <div className={`banner ${test.ok ? 'banner-info' : 'banner-error'}`}><div><strong>{test.ok ? 'Syntax OK' : 'Configuration rejected'}</strong><pre className="log" style={{ marginTop: 8 }}>{test.output}</pre></div></div>
                  )}
                  {data.include?.content && <details style={{ marginTop: 12 }}><summary>Current managed include on disk</summary><pre className="log">{data.include.content}</pre></details>}
                </Card>
              )}
              <SaveBar form={form} />
            </>
          )}
        </>
      )}
    </>
  );
}
