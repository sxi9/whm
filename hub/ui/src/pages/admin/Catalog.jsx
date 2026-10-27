import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { PageHeader, Card, StatusPill, formatDate } from '../../components/Common.jsx';
import { DataTable } from '../../components/DataTable.jsx';
import { Button, ErrorBanner, Select, Toggle, Field } from '../../components/Form.jsx';
import { Modal } from '../../components/Modal.jsx';
import { api } from '../../api/client.js';
import { useApi } from '../../hooks/useApi.js';
import { useListQuery } from '../../hooks/useListQuery.js';
import { useAction } from '../../hooks/useAction.js';
import { ReasonModal, FormModal, KV } from '../../widgets/index.jsx';
import { EDITIONS } from './Licenses.jsx';

const PLUGIN_STATUSES = ['draft', 'listed', 'unlisted', 'removed'];

function PluginDrawer({ id, categories, onClose, onChanged }) {
  const { data: p, loading, error, refetch } = useApi(id ? `/admin/market/plugins/${id}` : null);
  const { run, busy } = useAction();
  const [modal, setModal] = useState(null);
  const [target, setTarget] = useState(null);
  const changed = async () => { await refetch(); onChanged?.(); };
  const patch = (body, success) => run(() => api.patch(`/admin/market/plugins/${id}`, body), { success, then: changed });
  return (
    <Modal open={Boolean(id)} title={p ? `${p.name} · ${p.id}` : 'Plugin'} onClose={onClose} size="lg">
      <ErrorBanner error={error} onRetry={refetch} />
      {loading && !p && <p className="muted">Loading…</p>}
      {p && (
        <>
          <div className="two-col">
            <div>
              <KV items={[['Status', <StatusPill status={p.status} />], ['Developer', `${p.developer?.display_name} (${p.developer?.status})`], ['Category', categories.find((c) => c.id === p.category_id)?.name || p.category_id], ['Pricing', JSON.stringify(p.pricing)], ['Installs', p.install_count], ['Rating', p.rating_count ? `${p.rating_avg} (${p.rating_count})` : '—'], ['Latest stable', p.latest_stable_version], ['Latest beta', p.latest_beta_version], ['Bundled with', (p.bundled_editions || []).join(', ') || 'no edition']]} />
            </div>
            <div>
              <Field label="Listing status"><Select value={p.status} onChange={(v) => patch({ status: v }, `Status: ${v}`)} options={PLUGIN_STATUSES} /></Field>
              <Field label="Category"><Select value={p.category_id || ''} onChange={(v) => patch({ category_id: v }, 'Category saved')} options={categories.map((c) => ({ value: c.id, label: c.name }))} placeholder="pick" /></Field>
              <Field inline><Toggle checked={p.featured} onChange={(v) => patch({ featured: v }, v ? 'Featured' : 'Not featured')} label="Featured on the marketplace" /></Field>
              <Field label="Bundled with editions" help="Licenses of these editions get an admin-sourced entitlement">
                <div className="inline-list">{EDITIONS.map((e) => <button key={e} type="button" className={`btn btn-sm ${(p.bundled_editions || []).includes(e) ? 'btn-primary' : ''}`} disabled={busy} onClick={() => patch({ bundled_editions: (p.bundled_editions || []).includes(e) ? p.bundled_editions.filter((x) => x !== e) : [...(p.bundled_editions || []), e] }, 'Bundles saved')}>{e}</button>)}</div>
              </Field>
              <Button variant="danger" disabled={busy || p.status === 'removed'} onClick={() => setModal('takedown')}>Takedown</Button>
            </div>
          </div>
          <h3 style={{ marginTop: 12 }}>Versions</h3>
          <div className="table-wrap">
            <table>
              <thead><tr><th>Version</th><th>Channel</th><th>Status</th><th>Risk</th><th>Hub key</th><th>Published</th><th /></tr></thead>
              <tbody>
                {(p.versions || []).map((v) => (
                  <tr key={v.id}><td>{v.version}</td><td>{v.channel}</td><td><StatusPill status={v.status} /></td><td>{v.risk}</td><td>{v.mkt_kid || '—'}</td><td>{formatDate(v.published_at)}</td>
                    <td className="inline-list">
                      {v.status === 'approved' && <Button size="sm" variant="primary" disabled={busy} onClick={() => run(() => api.post(`/admin/market/plugins/${id}/versions/${v.version}/publish`, {}), { success: 'Published', then: changed })}>Publish</Button>}
                      {v.status === 'published' && <Button size="sm" disabled={busy} onClick={() => { setTarget(v); setModal('yank'); }}>Yank</Button>}
                    </td></tr>
                ))}
                {!(p.versions || []).length && <tr><td colSpan={7} className="muted">No versions uploaded.</td></tr>}
              </tbody>
            </table>
          </div>
          <ReasonModal open={modal === 'takedown'} title={`Take down ${p.name}`} help="Removes the plugin, revokes every version through the feed and suspends the developer pending review." confirmLabel="Take down" onClose={() => setModal(null)} onConfirm={({ reason }) => run(() => api.post(`/admin/market/plugins/${id}/takedown`, { reason }), { success: 'Plugin taken down', then: changed })} />
          <ReasonModal open={modal === 'yank'} title={`Yank ${target?.version || ''}`} help="Hidden from the catalog, no new installs; licenses that already installed it may re-download." required={false} confirmLabel="Yank" onClose={() => setModal(null)} onConfirm={({ reason }) => run(() => api.post(`/admin/market/plugins/${id}/versions/${target.version}/yank`, reason ? { reason } : {}), { success: 'Version yanked', then: changed })} />
        </>
      )}
    </Modal>
  );
}

export default function Catalog() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [status, setStatus] = useState('');
  const list = useListQuery('/admin/market/plugins', { filters: { status } });
  const categories = useApi('/admin/market/categories');
  const [newCat, setNewCat] = useState(false);
  const cats = categories.data || [];
  const columns = [
    { key: 'name', label: 'Plugin', sortable: true, render: (p) => <><strong>{p.name}</strong>{p.featured && <span className="pill pill-info" style={{ marginLeft: 6 }}>featured</span>}<br /><code className="small">{p.id}</code></> },
    { key: 'status', label: 'Status', render: (p) => <StatusPill status={p.status} /> },
    { key: 'category_id', label: 'Category', render: (p) => cats.find((c) => c.id === p.category_id)?.name || p.category_id || '—' },
    { key: 'pricing', label: 'Pricing', render: (p) => (p.pricing?.model === 'free' ? 'free' : `${p.pricing?.model} ${p.pricing?.cents != null ? (p.pricing.cents / 100).toFixed(2) : ''} ${p.pricing?.currency || ''}`) },
    { key: 'latest_stable_version', label: 'Stable / beta', render: (p) => `${p.latest_stable_version || '—'} / ${p.latest_beta_version || '—'}` },
    { key: 'install_count', label: 'Installs', sortable: true },
    { key: 'created_at', label: 'Created', sortable: true, render: (p) => formatDate(p.created_at) },
  ];
  return (
    <>
      <PageHeader title="Catalog" description="Listed, unlisted and featured plugins, categories and per-edition bundles." home="/admin" actions={<Button onClick={() => setNewCat(true)}>New category</Button>} />
      <Card padded={false}>
        <div className="filter-row" style={{ padding: '12px 16px 0' }}><Select value={status} onChange={setStatus} options={PLUGIN_STATUSES} placeholder="Any status" /><span className="muted">Categories: {cats.map((c) => `${c.name} (${c.count ?? 0})`).join(' · ') || 'none'}</span></div>
        <DataTable columns={columns} {...list.tableProps} searchable searchPlaceholder="Plugin id or name" emptyText="No plugins" rowActions={(p) => [{ label: 'Manage', primary: true, onClick: () => navigate(`/admin/market/catalog/${p.id}`) }]} />
      </Card>
      <FormModal open={newCat} title="New category" fields={[{ key: 'slug', label: 'Slug', required: true, help: 'lower-case, digits, dashes' }, { key: 'name', label: 'Name', required: true }, { key: 'position', label: 'Position', type: 'number', min: 0 }]} onClose={() => setNewCat(false)} submitLabel="Create"
        onSubmit={async (d) => { await api.post('/admin/market/categories', { slug: d.slug, name: d.name, ...(d.position != null ? { position: Number(d.position) } : {}) }); categories.refetch(); }} />
      <PluginDrawer id={id || null} categories={cats} onClose={() => navigate('/admin/market/catalog')} onChanged={list.refetch} />
    </>
  );
}
