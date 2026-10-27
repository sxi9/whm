import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, Download, RefreshCw, ShieldCheck, Store } from 'lucide-react';
import { api, queryString } from '../../api/client.js';
import { useApi } from '../../hooks/useApi.js';
import { Card, StatusPill, Loading, EmptyState, KeyValue, formatDate, formatBytes } from '../../components/Common.jsx';
import { Button, TextInput, Select, Textarea, Field, ErrorBanner, FormActions } from '../../components/Form.jsx';
import { Modal, useConfirm } from '../../components/Modal.jsx';
import { useToast } from '../../components/Toast.jsx';
import { ProgressLog } from '../../components/ProgressLog.jsx';
import { renderMarkdown } from '../plugins/PluginPage.jsx';
import { LICENSE_PATH } from '../server-configuration/LicenseTab.jsx';
import { ConsentModal, PermissionList, TrustNotice } from './ConsentModal.jsx';

export const PROVIDER_PATH = '/market/market-provider-manager';
export const MANAGE_PLUGINS_PATH = '/cpanel/manage-plugins';

// Catalog links come from the public, unsigned catalog: only https:// reaches an anchor.
export function safeHref(url) {
  try { return new URL(url).protocol === 'https:' ? url : null; } catch { return null; }
}

export function priceLabel(pricing) {
  if (!pricing || pricing.model === 'free' || !pricing.model) return 'Free';
  const amount = Number.isFinite(pricing.amount_cents) ? `${(pricing.amount_cents / 100).toFixed(2)} ${pricing.currency || 'USD'}` : 'Paid';
  return pricing.model === 'subscription' ? `${amount} / ${pricing.interval || 'month'}` : amount;
}

export function MarketplaceDisabledNotice() {
  return (
    <div className="banner banner-info" data-testid="marketplace-disabled">
      <Store size={18} />
      <div>
        <strong>The WHM marketplace hub is not enabled</strong>
        <p>Enable the <code>whm-hub</code> provider in <Link to={PROVIDER_PATH}>Market Provider Manager</Link> to browse and install plugins from the hub. The license key itself is entered under <Link to={LICENSE_PATH}>Basic Setup → License</Link>.</p>
      </div>
    </div>
  );
}

export function HubMismatchNotice({ status }) {
  return (
    <div className="banner banner-error" role="alert" data-testid="hub-mismatch">
      <AlertTriangle size={18} />
      <div>
        <strong>Hub mismatch</strong>
        <p>The <code>whm-hub</code> provider points at <code>{status.url || 'no URL'}</code> but this panel's license was issued by <code>{status.hubUrl || 'no hub'}</code>. Packages are only installed from the hub that issued the license: fix the provider URL in <Link to={PROVIDER_PATH}>Market Provider Manager</Link> or the license under <Link to={LICENSE_PATH}>Basic Setup → License</Link>.</p>
      </div>
    </div>
  );
}

// A link whose URL is not https:// is shown as text, never as an anchor.
function ExternalLinks({ links }) {
  const items = links.filter(([, url]) => typeof url === 'string' && url);
  if (!items.length) return <span>—</span>;
  return (
    <span>
      {items.map(([label, url], i) => {
        const href = safeHref(url);
        return <span key={label}>{i > 0 ? ' · ' : ''}{href ? <a href={href} target="_blank" rel="noreferrer">{label}</a> : <span title={`${label}: not an https:// link`}>{label}: <code>{url}</code></span>}</span>;
      })}
    </span>
  );
}

function InstalledPill({ installed }) {
  if (!installed) return null;
  if (installed.update) return <StatusPill status="warning">update {installed.update.latest}</StatusPill>;
  if (installed.consentState === 'pending') return <StatusPill status="pending">awaiting consent</StatusPill>;
  return <StatusPill status={installed.state}>{installed.marketplace || !installed.source ? installed.state : `${installed.source} · ${installed.state}`}</StatusPill>;
}

function PluginCard({ entry, manage, onDetails, onInstall, onUpdate, onUninstall }) {
  const inst = entry.installed;
  return (
    <section className="card" style={{ margin: 0 }} data-testid={`catalog-${entry.id}`}>
      <div className="card-body">
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'flex-start' }}>
          <div>
            <h3 style={{ margin: 0 }}>{entry.name}</h3>
            <small className="muted">{entry.developer?.display_name || 'unknown developer'}{entry.developer?.verified ? <span title="Verified developer"> <ShieldCheck size={12} /></span> : null}{entry.category?.name ? ` · ${entry.category.name}` : ''}</small>
          </div>
          <InstalledPill installed={inst} />
        </div>
        <p style={{ margin: '8px 0' }}>{entry.summary}</p>
        <div className="muted" style={{ fontSize: 12 }}>
          {priceLabel(entry.pricing)} · v{entry.latest?.version || '—'} · {entry.install_count ?? 0} installs{entry.rating_count ? ` · ${Number(entry.rating_avg).toFixed(1)} ★ (${entry.rating_count})` : ''}
        </div>
        <div className="row-actions" style={{ marginTop: 10, flexWrap: 'wrap' }}>
          <Button size="sm" onClick={() => onDetails(entry)}>Details</Button>
          {manage && !inst && <Button size="sm" variant="primary" icon={Download} onClick={() => onInstall(entry)}>Install</Button>}
          {manage && inst?.marketplace && inst.update && <Button size="sm" variant="primary" icon={RefreshCw} onClick={() => onUpdate(entry)}>Update to {inst.update.latest}</Button>}
          {manage && inst?.marketplace && <Button size="sm" onClick={() => onUninstall(entry)}>Uninstall</Button>}
          {inst && !inst.marketplace && <Link className="btn btn-sm" to={MANAGE_PLUGINS_PATH}>{inst.source === 'bundled' ? 'Bundled' : 'Sideloaded'}</Link>}
        </div>
      </div>
    </section>
  );
}

// The catalog's own permission list with the developer's justifications; the
// install request carries exactly these scopes as consent, and the job re-checks
// them against the installed package.
function InstallModal({ entry, detail, loading, onClose, onConfirm, busy }) {
  const scopes = (detail?.permissions || []).map((p) => p.scope);
  const justifications = Object.fromEntries((detail?.permissions || []).filter((p) => p.justification).map((p) => [p.scope, p.justification]));
  return (
    <Modal open={Boolean(entry)} title={`Install ${entry?.name || ''}`} onClose={onClose} size="lg"
      footer={<><Button onClick={onClose} disabled={busy}>Cancel</Button><Button variant="primary" loading={busy} disabled={loading} onClick={() => onConfirm(scopes)} data-testid="install-confirm">Install {detail?.latest?.version ? `v${detail.latest.version}` : ''}</Button></>}>
      {loading && !detail ? <Loading /> : (
        <>
          <p>{entry?.summary}</p>
          <KeyValue items={[['Developer', `${detail?.developer?.display_name || entry?.developer?.display_name || '—'}${detail?.developer?.verified ? ' (verified)' : ''}`], ['Price', priceLabel(detail?.pricing || entry?.pricing)], ['Requires WHM', detail?.compatibility?.engines_whm || entry?.latest?.engines_whm || '—'], ['Signed by', 'the marketplace signing key pinned from your license activation']]} />
          <h3>Permissions requested</h3>
          <PermissionList scopes={scopes} justifications={justifications} />
          <TrustNotice />
        </>
      )}
    </Modal>
  );
}

function ReviewForm({ pluginId }) {
  const toast = useToast();
  const [rating, setRating] = useState('5');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post(`/marketplace/plugins/${pluginId}/reviews`, { rating: Number(rating), ...(title ? { title } : {}), ...(body ? { body } : {}) });
      toast.success('Review submitted; it appears once the marketplace moderates it');
      setTitle('');
      setBody('');
    } catch (err) { setError(err); } finally { setBusy(false); }
  };
  return (
    <form onSubmit={submit}>
      <div className="form-grid">
        <Field label="Rating"><Select value={rating} onChange={setRating} options={['5', '4', '3', '2', '1']} /></Field>
        <Field label="Title"><TextInput value={title} onChange={setTitle} maxLength={120} /></Field>
      </div>
      <Field label="Review"><Textarea value={body} onChange={setBody} rows={3} maxLength={4000} /></Field>
      <ErrorBanner error={error} />
      <FormActions><Button type="submit" loading={busy}>Submit review</Button></FormActions>
    </form>
  );
}

export function PluginDetailDrawer({ id, manage, onClose, onInstall, onUpdate, onUninstall }) {
  const { data, loading, error, refetch } = useApi(`/marketplace/plugins/${id}`);
  if (loading && !data) return <Card title={id}><Loading /></Card>;
  if (error) return <Card title={id}><ErrorBanner error={error} onRetry={refetch} /></Card>;
  if (!data) return null;
  const inst = data.installed;
  const scopes = (data.permissions || []).map((p) => p.scope);
  const justifications = Object.fromEntries((data.permissions || []).filter((p) => p.justification).map((p) => [p.scope, p.justification]));
  const versions = data.versions?.all || [];
  return (
    <Card title={`${data.name} ${data.latest?.version ? `v${data.latest.version}` : ''}`} subtitle={data.summary} actions={<><Button onClick={refetch}>Refresh</Button><Button onClick={onClose}>Close</Button></>}>
      <KeyValue items={[
        ['Plugin id', <code key="id">{data.id}</code>],
        ['Developer', `${data.developer?.display_name || '—'}${data.developer?.verified ? ' (verified)' : ''}`],
        ['Category', data.category?.name || '—'],
        ['Price', priceLabel(data.pricing)],
        ['Compatibility', data.compatibility ? `requires WHM ${data.compatibility.engines_whm}${data.compatibility.compatible === false ? ' — not compatible with this host' : data.compatibility.compatible ? ' — compatible' : ''}` : '—'],
        ['Installed', inst ? `${inst.version ? `${inst.version} ` : ''}(${inst.state}${inst.consentState === 'pending' ? ', awaiting consent' : ''})` : 'no'],
        ['Rating', data.rating_count ? `${Number(data.rating_avg).toFixed(1)} ★ from ${data.rating_count} review${data.rating_count === 1 ? '' : 's'}` : 'no reviews yet'],
        ['Links', <ExternalLinks key="l" links={[['Homepage', data.homepage], ['Support', data.support_url]]} />],
      ]} />
      {manage && (
        <div className="row-actions" style={{ marginTop: 10, flexWrap: 'wrap' }}>
          {!inst && <Button variant="primary" icon={Download} onClick={() => onInstall(data)} disabled={data.compatibility?.compatible === false}>Install</Button>}
          {inst?.marketplace && inst.update && <Button variant="primary" icon={RefreshCw} onClick={() => onUpdate(data)}>Update to {inst.update.latest}</Button>}
          {inst?.marketplace && <Button onClick={() => onUninstall(data, false)}>Uninstall (keep data)</Button>}
          {inst?.marketplace && <Button variant="danger" onClick={() => onUninstall(data, true)}>Uninstall and purge</Button>}
        </div>
      )}
      {data.description_md && <div className="markdown" style={{ marginTop: 12 }}>{renderMarkdown(data.description_md)}</div>}
      <h3>Permissions</h3>
      <PermissionList scopes={scopes} justifications={justifications} />
      <h3>Versions</h3>
      {versions.length === 0 ? <p className="muted">No published versions.</p> : (
        <div className="table-wrap">
          <table>
            <thead><tr><th>Version</th><th>Channel</th><th>Published</th><th>Requires</th><th>Size</th><th>Signing key</th></tr></thead>
            <tbody>{versions.map((v) => <tr key={v.version}><td><code>{v.version}</code></td><td>{v.channel}</td><td>{v.published_at ? formatDate(v.published_at) : '—'}</td><td>{v.engines_whm}</td><td>{v.package_bytes ? formatBytes(v.package_bytes) : '—'}</td><td><code>{v.kid || '—'}</code></td></tr>)}</tbody>
          </table>
        </div>
      )}
      {data.changelog?.length > 0 && (
        <>
          <h3>Changelog</h3>
          {data.changelog.filter((c) => c.changelog_md).slice(0, 5).map((c) => <div key={c.version} className="markdown"><strong>{c.version}</strong>{renderMarkdown(c.changelog_md)}</div>)}
        </>
      )}
      <h3>Reviews</h3>
      {!data.reviews?.length ? <p className="muted">No published reviews.</p> : (
        <ul>{data.reviews.map((r) => <li key={r.id}><strong>{'★'.repeat(r.rating || 0)}</strong> {r.title ? <strong>{r.title}</strong> : null} <span className="muted small">{r.created_at ? formatDate(r.created_at) : ''}</span>{r.body ? <div className="small">{r.body}</div> : null}{r.developer_reply ? <div className="small muted">Developer: {r.developer_reply}</div> : null}</li>)}</ul>
      )}
      {manage && inst?.marketplace && <ReviewForm pluginId={data.id} />}
    </Card>
  );
}

// Catalog grid, search and category filter, detail drawer and the install /
// update / uninstall actions (root only; resellers get the read-only view on
// WHM Marketplace). Installs run as jobs; a `pending_consent` result opens the
// consent screen with the scopes of the installed package.
export function MarketplaceTab({ manage = true, status: statusProp = null }) {
  const toast = useToast();
  const confirm = useConfirm();
  const [q, setQ] = useState('');
  const [category, setCategory] = useState('');
  const ownStatus = useApi('/marketplace/status', { enabled: !statusProp });
  const status = statusProp || ownStatus.data;
  const ready = Boolean(status?.enabled && !status.hubMismatch);
  const categories = useApi('/marketplace/categories', { enabled: ready });
  const catalog = useApi(`/marketplace/catalog${queryString({ q, category })}`, { enabled: ready });
  const [selected, setSelected] = useState(null);
  const [installing, setInstalling] = useState(null);
  const [installDetail, setInstallDetail] = useState(null);
  const [busy, setBusy] = useState(false);
  const [job, setJob] = useState(null);
  const [consent, setConsent] = useState(null);

  const refreshAll = useCallback(() => { catalog.refetch(); ownStatus.refetch(); }, [catalog, ownStatus]);

  useEffect(() => {
    if (!installing) { setInstallDetail(null); return undefined; }
    let alive = true;
    api.get(`/marketplace/plugins/${installing.id}`).then((res) => { if (alive) setInstallDetail(res.data); }).catch((err) => { if (alive) toast.error(err); });
    return () => { alive = false; };
  }, [installing, toast]);

  const startJob = async (label, run) => {
    setBusy(true);
    try {
      const res = await run();
      setJob({ id: res.data.job.id, label });
    } catch (err) { toast.error(err); } finally { setBusy(false); }
  };
  const onJobFinished = useCallback((event) => {
    if (event.type === 'done' && event.result?.status === 'pending_consent') {
      setConsent({ pluginId: event.result.pluginId, version: event.result.version, required: event.result.required || [], added: event.result.added || [], justifications: event.result.justifications || {} });
    } else if (event.type === 'done') {
      toast.success(`${event.result?.pluginId || 'Plugin'} ${event.result?.version || ''} installed`);
    } else if (event.type === 'failed') {
      toast.error(`${job?.label || 'Install'} failed: ${event.error || event.code || 'unknown error'}`);
    }
    refreshAll();
  }, [job, refreshAll, toast]);

  const install = (entry) => setInstalling(entry);
  const confirmInstall = (scopes) => {
    const entry = installing;
    setInstalling(null);
    startJob(`Install ${entry.name}`, () => api.post('/marketplace/install', { pluginId: entry.id, consent: { permissions: scopes } }));
  };
  const update = (entry) => startJob(`Update ${entry.name}`, () => api.post(`/marketplace/update/${entry.id}`));
  const uninstall = async (entry, purge = false) => {
    const ok = await confirm({
      title: purge ? `Uninstall and purge ${entry.name}?` : `Uninstall ${entry.name}?`,
      message: purge ? 'Removes the plugin code and deletes its settings, stored data, logs and data directory. This cannot be undone.' : 'Removes the plugin code; its settings, stored data and logs are kept for a later re-install.',
      confirmLabel: purge ? 'Uninstall and purge' : 'Uninstall', danger: true,
    });
    if (!ok) return;
    try { await api.delete(`/marketplace/${entry.id}?purge=${purge ? 'true' : 'false'}`); toast.success(`${entry.name} uninstalled`); if (selected === entry.id) setSelected(null); refreshAll(); } catch (err) { toast.error(err); }
  };
  const checkUpdates = async () => {
    try { const res = await api.post('/marketplace/updates/check'); toast.success(res.data.length ? `${res.data.length} update${res.data.length === 1 ? '' : 's'} available` : 'Every marketplace plugin is up to date'); refreshAll(); } catch (err) { toast.error(err); }
  };

  if (ownStatus.error && !statusProp) return <ErrorBanner error={ownStatus.error} onRetry={ownStatus.refetch} />;
  if (!status) return <Loading />;
  if (!status.enabled) return <MarketplaceDisabledNotice />;
  if (status.hubMismatch) return <HubMismatchNotice status={status} />;

  const pending = status.pendingUpdates || [];
  const rows = catalog.data || [];
  return (
    <>
      {status.licenseDegraded && (
        <div className="banner banner-warning" role="alert">
          <AlertTriangle size={18} />
          <div><strong>License {status.licenseStatus}</strong><p>Browsing works, but installs and updates resume once a valid license is active. <Link to={LICENSE_PATH}>Open the License tab</Link></p></div>
        </div>
      )}
      {manage && pending.length > 0 && (
        <div className="banner banner-info" data-testid="pending-updates">
          <RefreshCw size={18} />
          <div>
            <strong>{pending.length} marketplace update{pending.length === 1 ? '' : 's'} available</strong>
            <ul>{pending.map((u) => <li key={u.id}><code>{u.id}</code> {u.current} → {u.latest}{u.security ? <span className="pill pill-bad" style={{ marginLeft: 8 }}>security</span> : null} <Button size="sm" disabled={busy} onClick={() => update({ id: u.id, name: u.id })}>Update</Button></li>)}</ul>
          </div>
        </div>
      )}
      {job && (
        <Card title={job.label} actions={<Button size="sm" onClick={() => setJob(null)}>Dismiss</Button>}>
          <ProgressLog jobId={job.id} onFinished={onJobFinished} />
        </Card>
      )}
      <Card padded={false}>
        <div className="datatable-toolbar" style={{ padding: 12, flexWrap: 'wrap', gap: 8 }}>
          <TextInput value={q} onChange={setQ} placeholder="Search plugins…" style={{ maxWidth: 280 }} />
          <Select value={category} onChange={setCategory} options={(categories.data || []).map((c) => ({ value: c.slug, label: `${c.name}${c.count != null ? ` (${c.count})` : ''}` }))} placeholder="All categories" style={{ maxWidth: 240 }} />
          <span className="muted">{catalog.meta?.total ?? rows.length} plugin{(catalog.meta?.total ?? rows.length) === 1 ? '' : 's'} · hub {status.hubUrl?.replace(/^https:\/\//, '')}{Array.isArray(status.hubKids) ? ` · ${status.hubKids.length} signing key${status.hubKids.length === 1 ? '' : 's'} pinned` : ''}</span>
          {manage && <Button size="sm" icon={RefreshCw} onClick={checkUpdates}>Check for updates</Button>}
          <Button size="sm" onClick={refreshAll}>Refresh</Button>
        </div>
        <ErrorBanner error={catalog.error} onRetry={catalog.refetch} />
        {catalog.loading && !catalog.data && <Loading />}
        {catalog.data && rows.length === 0 && <EmptyState icon={Store} title="No plugins match">Try a different search or category.</EmptyState>}
        {rows.length > 0 && (
          <div className="stat-grid" style={{ padding: 12 }}>
            {rows.map((entry) => <PluginCard key={entry.id} entry={entry} manage={manage} onDetails={(e) => setSelected(e.id)} onInstall={install} onUpdate={update} onUninstall={(e) => uninstall(e, false)} />)}
          </div>
        )}
      </Card>
      {selected && <PluginDetailDrawer id={selected} manage={manage} onClose={() => setSelected(null)} onInstall={install} onUpdate={update} onUninstall={uninstall} />}
      <InstallModal entry={installing} detail={installDetail} loading={Boolean(installing) && !installDetail} busy={busy} onClose={() => setInstalling(null)} onConfirm={confirmInstall} />
      <ConsentModal open={Boolean(consent)} pluginId={consent?.pluginId} version={consent?.version} required={consent?.required} added={consent?.added} justifications={consent?.justifications}
        onClose={() => setConsent(null)} onConsented={(data) => { setConsent(null); toast.success(`${data.plugin?.name || consent?.pluginId} enabled`); refreshAll(); }} />
    </>
  );
}

export default MarketplaceTab;
