import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../../api/client.js';
import { useApi } from '../../../hooks/useApi.js';
import { PageHeader, Card, StatusPill, KeyValue, Loading, formatDate } from '../../../components/Common.jsx';
import { Field, NumberInput, TextInput, Toggle, Button, FormActions, ErrorBanner } from '../../../components/Form.jsx';
import { Modal, useConfirm } from '../../../components/Modal.jsx';
import { useToast } from '../../../components/Toast.jsx';
import { RequestError, useJobRunner, JobPanel } from '../../software/Shared.jsx';

export default function NginxManager({ fn }) {
  const toast = useToast();
  const confirm = useConfirm();
  const { data, loading, error, refetch } = useApi('/software/nginx');
  const [form, setForm] = useState(null);
  const [busy, setBusy] = useState(null);
  const [saveError, setSaveError] = useState(null);
  const [result, setResult] = useState(null);
  const [config, setConfig] = useState(null);
  const runner = useJobRunner({ onFinished: () => refetch() });

  useEffect(() => { if (data) setForm({ ...data.settings }); }, [data]);
  const dirty = data && form && ['enabled', 'cache', 'apachePort', 'apacheSslPort', 'cacheMaxSizeMb', 'cacheTtl'].some((k) => form[k] !== data.settings[k]);

  const save = async () => {
    if (form.enabled && !data.settings.enabled && !(await confirm({ title: 'Enable the NGINX reverse proxy?', message: `NGINX takes over ports 80/443 and forwards to Apache on 127.0.0.1:${form.apachePort}. The config is validated with nginx -t before anything else changes. ${data.webLinked ? `Apache is then moved to 127.0.0.1:${form.apachePort} / 127.0.0.1:${form.apacheSslPort}, reachable only through the proxy.` : `Apache must be moved to 127.0.0.1:${form.apachePort} / 127.0.0.1:${form.apacheSslPort} in Apache Configuration or sites go down.`} HTTPS is terminated by NGINX only for the ${data.sslDomains} domain(s) whose certificate this panel installed (SSL/TLS); a vhost with a certificate configured outside the panel loses HTTPS until its certificate is imported there.`, confirmLabel: 'Enable proxy' }))) return;
    if (!form.enabled && data.settings.enabled && !(await confirm({ title: 'Disable the reverse proxy?', message: `The managed config is removed, NGINX is stopped and disabled so it releases ports 80/443, and the stock default site is restored. ${data.webLinked ? 'Apache is then moved back to 80/443.' : 'Apache must listen on 80/443 again.'}`, confirmLabel: 'Disable', danger: true }))) return;
    setBusy('save'); setSaveError(null);
    try {
      const { data: r } = await api.put('/software/nginx', { enabled: form.enabled, cache: form.cache, apachePort: form.apachePort, apacheSslPort: form.apacheSslPort, cacheMaxSizeMb: form.cacheMaxSizeMb, cacheTtl: form.cacheTtl });
      setResult(r);
      toast.success(form.enabled ? `Proxy configured for ${r.proxy?.domains ?? 0} domains` : 'Proxy disabled');
      refetch();
    } catch (err) { setSaveError(err); toast.error(err); } finally { setBusy(null); }
  };
  const action = async (label, fnc) => {
    setBusy(label); setSaveError(null);
    try { const { data: r } = await fnc(); setResult({ [label]: r }); toast.success(`${label}: ok`); refetch(); } catch (err) { setSaveError(err); toast.error(err); } finally { setBusy(null); }
  };
  const viewConfig = async () => { try { const { data: c } = await api.get('/software/nginx/config'); setConfig(c.content || '# no managed config present'); } catch (err) { toast.error(err); } };

  return (
    <>
      <PageHeader fn={fn} actions={data && <StatusPill status={!data.installed ? 'not-installed' : data.settings.enabled ? (data.active ? 'active' : 'warning') : 'disabled'}>{!data.installed ? 'nginx not installed' : data.settings.enabled ? (data.active ? 'proxy active' : 'proxy enabled · nginx down') : 'proxy disabled'}</StatusPill>} />
      <RequestError error={error} onRetry={refetch} />
      {loading && !data && <Loading />}
      {data && !data.installed && (
        <Card title="Install NGINX">
          <p>NGINX is not installed on this server. Installing it adds the distro <code>nginx</code> package and enables its unit; it stays idle until the proxy is switched on here.</p>
          {!data.apacheCapability && <div className="banner banner-warning"><div><strong>Apache is not installed either.</strong><p>The reverse proxy fronts Apache; build a web stack with <Link to="/software/easyapache-4">EasyApache 4</Link> first.</p></div></div>}
          <div className="action-row"><Button variant="primary" loading={runner.busy} onClick={() => runner.start(() => api.post('/software/nginx/install'), 'Install NGINX')}>Install NGINX</Button></div>
          <ErrorBanner error={runner.error} />
        </Card>
      )}
      <JobPanel runner={runner} title="Install log" />
      {data?.stale && data.installed && (
        <div className="banner banner-warning">
          <div>
            <strong>The rendered proxy config is out of date</strong>
            <p>Domains or certificates changed since whm-proxy.conf was written ({data.domains} domains, {data.sslDomains} with HTTPS now). The hourly scheduled sync catches up on its own; re-sync now to apply it immediately.</p>
          </div>
          <Button size="sm" variant="primary" loading={busy === 'sync'} onClick={() => action('sync', () => api.post('/software/nginx/sync'))}>Re-sync now</Button>
        </div>
      )}
      {data?.backendExposed && (
        <div className="banner banner-warning">
          <div>
            <strong>Apache still listens on all interfaces</strong>
            <p>The backend ports are reachable from outside, so the proxy can be bypassed and X-Forwarded-For forged. Save the settings below once to pin Apache to 127.0.0.1.</p>
          </div>
        </div>
      )}
      {data && form && (
        <>
          <Card title="Status" actions={data.installed && <>
            <Button size="sm" loading={busy === 'configtest'} onClick={() => action('configtest', () => api.post('/software/nginx/configtest'))}>Config test</Button>
            <Button size="sm" loading={busy === 'reload'} onClick={() => action('reload', () => api.post('/software/nginx/reload'))}>Reload</Button>
            <Button size="sm" loading={busy === 'restart'} onClick={() => action('restart', () => api.post('/software/nginx/restart'))}>Restart</Button>
            <Button size="sm" onClick={viewConfig}>View config</Button>
          </>}>
            <KeyValue items={[
              ['NGINX', data.installed ? <span key="v">{data.version || 'installed'} <StatusPill status={data.active ? 'active' : data.active === false ? 'inactive' : 'unknown'}>{data.active ? 'running' : data.active === false ? 'stopped' : 'unknown'}</StatusPill></span> : <StatusPill key="n" status="not-installed">not installed</StatusPill>],
              ['Managed config', <span key="c"><code className="small">{data.configPath}</code> <StatusPill status={data.proxyConfigured ? 'ok' : 'disabled'}>{data.proxyConfigured ? 'present' : 'absent'}</StatusPill></span>],
              data.proxy && ['Rendered', <span key="r">{data.proxy.domains} domains · cache {data.proxy.cache ? 'on' : 'off'} · backend :{data.proxy.apachePort} · {formatDate(data.proxy.generatedAt)} {data.settings.enabled && <StatusPill status={data.stale ? 'warning' : 'ok'}>{data.stale ? 'out of date' : 'current'}</StatusPill>}</span>],
              ['Domains to proxy', `${data.domains} (${data.sslDomains} with an installed certificate; www. and parked names are routed with their vhost)`],
              ['HTTPS termination', `only for certificates this panel installed (${data.sslDomains} of ${data.domains} domains); a vhost whose certificate was configured outside the panel loses HTTPS behind the proxy until the certificate is imported in SSL/TLS`],
              ['Last sync', data.settings.lastSync ? `${formatDate(data.settings.lastSync)} · ${data.settings.enabled ? 'hourly scheduled check while the proxy is on' : 'scheduled check paused while the proxy is off'}` : 'never'],
              ['Apache port handling', data.webLinked ? `automatic (web server category loaded); Apache is pinned to 127.0.0.1 behind the proxy (currently: ${data.backendBind})` : `manual: set Apache to listen on 127.0.0.1:${data.settings.apachePort} and 127.0.0.1:${data.settings.apacheSslPort} in Apache Configuration`],
              data.installed && ['Unknown HTTPS names', data.catchAll === 'reject-handshake' ? 'TLS handshake rejected (ssl_reject_handshake)' : data.catchAll === 'self-signed' ? 'closed with a self-signed placeholder certificate (nginx < 1.19.4)' : 'no catch-all possible: install openssl or a newer nginx'],
              data.stockDefaults && ['Stock default site', `${data.stockDefaults.debianSite === 'disabled' ? 'sites-enabled/default disabled by the proxy' : data.stockDefaults.debianSite === 'enabled' ? 'sites-enabled/default present (disabled when the proxy is enabled)' : 'no Debian default site'}${data.stockDefaults.mainConf === 'disabled' ? ' · nginx.conf server block commented out' : ''}`],
              data.version && ['HTTP/2', data.http2Directive ? 'http2 directive (nginx ≥ 1.25.1)' : 'listen … http2 flag (nginx < 1.25.1)'],
            ]} />
          </Card>
          <Card title="Reverse proxy" subtitle="NGINX terminates HTTP/HTTPS on 80/443 and forwards to Apache on loopback with X-Forwarded-* headers; HTTPS server blocks are rendered for every domain with an installed certificate (plus its www. and parked names) and any other name is refused instead of served with a neighbour's certificate.">
            <Toggle checked={form.enabled} onChange={(v) => setForm({ ...form, enabled: v })} label="Enable reverse proxy" description={!data.installed ? 'Install NGINX first' : 'Renders the managed config and validates it with nginx -t before Apache is moved; a failure leaves the host untouched.'} disabled={!data.installed} />
            <div className="form-grid" style={{ marginTop: 12 }}>
              <Field label="Apache backend port (HTTP)" help="Apache listens on 127.0.0.1 at this port while the proxy is on; it is not reachable from outside."><NumberInput value={form.apachePort} onChange={(v) => setForm({ ...form, apachePort: v ?? 8080 })} min={1} max={65535} nullable={false} /></Field>
              <Field label="Apache backend port (HTTPS)" help="Apache's own TLS listener moves here (loopback only) so NGINX can take 443."><NumberInput value={form.apacheSslPort} onChange={(v) => setForm({ ...form, apacheSslPort: v ?? 8443 })} min={1} max={65535} nullable={false} /></Field>
            </div>
            <Toggle checked={form.cache} onChange={(v) => setForm({ ...form, cache: v })} label="Enable response caching" description="proxy_cache for anonymous GET responses; requests with cookies or Authorization bypass the cache. Adds an X-Cache-Status header." />
            {form.cache && (
              <div className="form-grid" style={{ marginTop: 12 }}>
                <Field label="Cache size (MB)"><NumberInput value={form.cacheMaxSizeMb} onChange={(v) => setForm({ ...form, cacheMaxSizeMb: v ?? 1024 })} min={64} nullable={false} /></Field>
                <Field label="Cache TTL for 200/301/302" help="e.g. 10m, 1h"><TextInput value={form.cacheTtl} onChange={(v) => setForm({ ...form, cacheTtl: v })} /></Field>
              </div>
            )}
            <ErrorBanner error={saveError} />
            <FormActions>
              <Button variant="primary" loading={busy === 'save'} disabled={!dirty} onClick={save}>Save and apply</Button>
              <Button disabled={!dirty} onClick={() => setForm({ ...data.settings })}>Reset</Button>
              {data.settings.enabled && data.installed && <Button loading={busy === 'sync'} onClick={() => action('sync', () => api.post('/software/nginx/sync'))}>Re-sync domains</Button>}
            </FormActions>
            {result && (
              <div className="action-result">
                {result.apache && <KeyValue items={[['Apache', `${result.apache.state}${result.apache.detail ? ` — ${result.apache.detail}` : ''}`], result.proxy && ['Proxy', result.proxy.skipped ? `skipped (${result.proxy.reason || 'nothing to do'})` : result.proxy.removed != null ? (result.proxy.removed ? 'config removed' : 'no config to remove') : `${result.proxy.domains} domains (${result.proxy.sslDomains} with HTTPS)${result.proxy.skipped ? `, ${result.proxy.skipped} skipped for missing certificate files` : ''}`], result.proxy?.unit && ['NGINX unit', result.proxy.unit.ok ? `${result.proxy.unit.verb} ok${result.proxy.unit.verb === 'stop' ? (result.proxy.unit.disabledAtBoot ? ' · disabled at boot' : ' · still enabled at boot') : ''}${result.proxy.unit.verb === 'start' && result.proxy.unit.enabledAtBoot === false ? ' · could not be enabled at boot' : ''}${result.proxy.unit.hint ? ` — ${result.proxy.unit.hint}` : ''}` : `${result.proxy.unit.verb} failed: ${result.proxy.unit.error}${result.proxy.unit.hint ? ` — ${result.proxy.unit.hint}` : ''}`], result.proxy?.stockDefaultsDisabled?.length && ['Stock default site', `disabled (${result.proxy.stockDefaultsDisabled.join(', ')})`], result.proxy?.stockDefaultsRestored?.length && ['Stock default site', `restored (${result.proxy.stockDefaultsRestored.join(', ')})`]]} />}
                {(result.configtest || result.sync?.configtest) && <pre className="log">{(result.configtest || result.sync.configtest).output}</pre>}
                {(result.reload || result.restart) && <StatusPill status="ok">{result.reload ? 'reloaded' : 'restarted'}</StatusPill>}
              </div>
            )}
          </Card>
        </>
      )}
      <Modal open={config != null} title="whm-proxy.conf" onClose={() => setConfig(null)} size="lg" footer={<Button variant="primary" onClick={() => setConfig(null)}>Close</Button>}>
        <pre className="log" style={{ maxHeight: '60vh' }}>{config}</pre>
      </Modal>
    </>
  );
}
