import { useCallback, useState } from 'react';
import { Link } from 'react-router-dom';
import { Puzzle, AlertTriangle, Lock } from 'lucide-react';
import { api } from '../../api/client.js';
import { useApi, useMutation } from '../../hooks/useApi.js';
import { usePluginNav } from '../../hooks/usePluginNav.js';
import { PageHeader, Card, StatusPill, Loading, EmptyState, CapabilityNotice } from '../../components/Common.jsx';
import { Button, ErrorBanner } from '../../components/Form.jsx';
import { useToast } from '../../components/Toast.jsx';
import { PluginPageView } from './PluginPage.jsx';

// The three Plugins-category functions are bundled plugins on the SDK. Each
// function page is a thin shell around the generic plugin renderer: it checks
// that the plugin is enabled (offering to enable or repair it when it is not),
// draws its own overview tab and hands every other tab to PluginPageView with
// the page descriptor the plugin's manifest declares.

export const PLUGIN_IDS = { 'plugins/server-monitoring': 'net.whm.server-monitoring', 'plugins/imunifyav': 'net.whm.imunifyav', 'plugins/wp-toolkit': 'net.whm.wp-toolkit' };

export function pluginBase(id) {
  return `/plugins/${id}`;
}

export function useBundledPlugin(id) {
  const nav = usePluginNav();
  const status = useApi(`/bundled-plugins/${id}`);
  const plugin = nav.plugins.find((p) => p.id === id) || null;
  const reload = useCallback(() => { nav.reload(); status.refetch(); }, [nav, status]);
  // The status call only feeds the enable prompt; an enabled plugin renders as
  // soon as the plugin catalog is known.
  return { plugin, status: status.data, error: status.error, loading: nav.loading && !plugin, checking: status.loading && !status.data, reload };
}

export function EnablePrompt({ fn, id, status, error, checking, onChanged }) {
  const toast = useToast();
  const action = useMutation(useCallback(async (kind) => {
    const res = await api.post(`/bundled-plugins/${id}/${kind}`, {});
    toast.success(`${res.data.label} ${kind === 'reinstall' ? 'repaired and enabled' : 'enabled'}`);
    onChanged?.();
    return res.data;
  }, [id, toast, onChanged]));
  const state = status?.state || 'unknown';
  const canManage = Boolean(status?.canManage);
  return (
    <>
      <PageHeader fn={fn} />
      <Card title={status?.label || fn.label} actions={checking ? <Loading text="Checking…" /> : <StatusPill status={state === 'not-installed' ? 'not-installed' : state} />}>
        {error && error.status !== 404 && <ErrorBanner error={error} />}
        <EmptyState icon={state === 'errored' ? AlertTriangle : Puzzle} title={state === 'errored' ? 'The plugin failed to start' : state === 'not-installed' ? 'The bundled plugin is not installed' : 'The plugin is not enabled'}>
          <p>{status?.description || fn.description}</p>
          {status?.lastError && <p className="banner banner-error" style={{ display: 'block' }}><strong>{status.lastError.code || 'error'}</strong>: {status.lastError.message}</p>}
          {checking ? null : canManage ? (
            <div className="action-row" style={{ display: 'flex', gap: 8, justifyContent: 'center' }}>
              {state !== 'not-installed' && <Button variant="primary" loading={action.loading} onClick={() => action.mutate('enable').catch(() => {})}>Enable plugin</Button>}
              <Button loading={action.loading} onClick={() => action.mutate('reinstall').catch(() => {})}>{state === 'not-installed' ? 'Install bundled plugin' : 'Repair (reinstall and enable)'}</Button>
            </div>
          ) : null}
          <p className="muted">{canManage ? 'The plugin is also managed under' : 'Ask the server administrator to enable this plugin under'} <Link to="/cpanel/manage-plugins">Manage Plugins</Link>.</p>
          <ErrorBanner error={action.error} />
          {status?.bundledVersion && <p className="muted">Bundled version {status.bundledVersion}{status.installedVersion ? ` · installed ${status.installedVersion}` : ''}</p>}
        </EmptyState>
      </Card>
    </>
  );
}

// A plugin whose routes are registered for root only (status.roles) is not
// rendered for a reseller at all: the page would only fill with 403 banners.
export function RootOnlyNotice({ fn, status }) {
  return (
    <>
      <PageHeader fn={fn} />
      <Card title={status?.label || fn.label}>
        <EmptyState icon={Lock} title="This plugin is only available to the server administrator">
          <p>{status?.description || fn.description}</p>
          <p className="muted">Its routes are registered for the {(status?.roles || ['root']).join(' and ')} role{(status?.roles || []).length === 1 ? '' : 's'} only.</p>
        </EmptyState>
      </Card>
    </>
  );
}

// Tabs: the overview is the function's own React UI; every other tab is a page
// the plugin manifest declares, rendered by the generic PluginPage renderer.
// The Settings tab talks to the root-only /plugins/manage API, so it is shown
// to root alone.
export function BundledPluginShell({ fn, id, overview: Overview, tabs = [] }) {
  const { plugin, status, error, loading, checking, reload } = useBundledPlugin(id);
  const [tab, setTab] = useState('overview');
  if (loading) return <><PageHeader fn={fn} /><Loading /></>;
  if (!plugin) return <EnablePrompt fn={fn} id={id} status={status} error={error} checking={checking} onChanged={reload} />;
  if (status && status.canUse === false) return <RootOnlyNotice fn={fn} status={status} />;
  const canManage = Boolean(status?.canManage);
  const pages = (plugin.pages || []).filter((p) => tabs.includes(p.route) && (canManage || p.route !== '/settings'));
  const active = tab === 'overview' ? null : pages.find((p) => p.route === tab);
  const nav = (
    <div className="action-row" style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }} role="tablist">
      <Button size="sm" variant={tab === 'overview' ? 'primary' : 'default'} onClick={() => setTab('overview')}>Overview</Button>
      {pages.map((p) => <Button key={p.route} size="sm" variant={tab === p.route ? 'primary' : 'default'} onClick={() => setTab(p.route)}>{p.title}</Button>)}
      <Link className="btn btn-sm btn-ghost" to={`/cpanel/manage-plugins`}>Manage Plugins</Link>
    </div>
  );
  if (active) return <>{nav}<PluginPageView plugin={plugin} page={active} /></>;
  return (
    <>
      <PageHeader fn={fn} description={`${fn.description} ${plugin.name} ${plugin.version}.`} />
      {nav}
      <Overview plugin={plugin} status={status} base={pluginBase(id)} reload={reload} />
    </>
  );
}

// Plugin routes answer 501 CAPABILITY_MISSING with install instructions in
// error.details.install; the generic notice gets those steps appended.
export function PluginCapabilityNotice({ error, install, onRetry }) {
  if (!error) return null;
  const missing = error.status === 501 || error.code === 'CAPABILITY_MISSING' || error.code === 'capability_missing' || error.code === 'BINARY_NOT_FOUND';
  if (!missing) return <ErrorBanner error={error} onRetry={onRetry} />;
  const steps = install?.steps || error.details?.install?.steps || [];
  return (
    <>
      <CapabilityNotice error={{ ...error, code: 'capability_missing' }} onRetry={onRetry} />
      {steps.length > 0 && <InstallSteps steps={steps} url={install?.url || error.details?.install?.url} />}
    </>
  );
}

export function InstallSteps({ title = 'Install it on this server (as root)', steps = [], url }) {
  return (
    <div>
      <p><strong>{title}</strong>{url && <> — <a href={url} target="_blank" rel="noopener noreferrer">vendor documentation</a></>}</p>
      <pre className="log">{steps.join('\n')}</pre>
    </div>
  );
}

export function formatRate(bytesPerSec) {
  if (bytesPerSec == null) return '—';
  const units = ['B/s', 'KB/s', 'MB/s', 'GB/s'];
  let v = Number(bytesPerSec); let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}
