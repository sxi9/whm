import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { PageHeader, Card, StatusPill, Loading, formatBytes } from '../../components/Common.jsx';
import { Field, TextInput, Textarea, Select, NumberInput, Button, ErrorBanner } from '../../components/Form.jsx';
import { useConfirm } from '../../components/Modal.jsx';
import { api } from '../../api/client.js';
import { useApi } from '../../hooks/useApi.js';
import { useAction } from '../../hooks/useAction.js';
import { pricingLabel } from './Plugins.jsx';

const TEXT = [['name', 'Name'], ['summary', 'Summary (≤ 200 chars)'], ['homepage', 'Homepage (https)'], ['support_url', 'Support URL (https)'], ['license_spdx', 'License (SPDX)'], ['keywords', 'Keywords (comma-separated, ≤ 10)']];

export function draftOf(p) {
  return { name: p.name || '', summary: p.summary || '', description_md: p.description_md || '', category_id: p.category_id || '', homepage: p.homepage || '', support_url: p.support_url || '', license_spdx: p.license_spdx || '', keywords: (p.keywords || []).join(', ') };
}
export function pricingOf(p) {
  return { model: p?.pricing?.model || 'free', cents: p?.pricing?.cents ?? 2900, currency: p?.pricing?.currency || 'USD', interval: p?.pricing?.interval || 'month', trial_days: p?.pricing?.trial_days ?? 0 };
}

function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1]);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

export default function PluginEdit() {
  const { id } = useParams();
  const { data: p, loading, error, refetch } = useApi(`/dev/plugins/${id}`);
  const categories = useApi('/market/categories');
  const { run, busy, error: saveError } = useAction();
  const confirm = useConfirm();
  const [draft, setDraft] = useState(() => (p ? draftOf(p) : null));
  const [pricing, setPricing] = useState(() => pricingOf(p));
  useEffect(() => { if (p) { setDraft(draftOf(p)); setPricing(pricingOf(p)); } }, [p]);
  if (loading && !p) return <Loading />;
  if (error) return <ErrorBanner error={error} onRetry={refetch} />;
  if (!p || !draft) return null;
  const save = () => run(() => api.patch(`/dev/plugins/${id}`, {
    name: draft.name, summary: draft.summary || undefined, description_md: draft.description_md || undefined, category_id: draft.category_id || undefined, homepage: draft.homepage || undefined, support_url: draft.support_url || undefined, license_spdx: draft.license_spdx || undefined,
    keywords: draft.keywords.split(',').map((s) => s.trim()).filter(Boolean),
    pricing: pricing.model === 'free' ? { model: 'free' } : pricing.model === 'one_time' ? { model: 'one_time', cents: Number(pricing.cents), currency: pricing.currency } : { model: 'subscription', cents: Number(pricing.cents), currency: pricing.currency, interval: pricing.interval, ...(pricing.trial_days ? { trial_days: Number(pricing.trial_days) } : {}) },
  }), { success: 'Listing saved', then: refetch });
  const upload = (kind) => async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const data = await readFileAsBase64(file);
    run(() => api.post(`/dev/plugins/${id}/assets`, { kind, content_type: file.type, data, position: (p.assets || []).filter((a) => a.kind === kind).length }), { success: `${kind} uploaded`, then: refetch });
    e.target.value = '';
  };
  return (
    <>
      <PageHeader title={p.name} description={`${p.id} · listing ${p.status} · ${pricingLabel(p.pricing)}`} home="/dev" crumbs={[{ to: '/dev/plugins', label: 'Plugins' }]}
        actions={<><Link className="btn" to={`/dev/plugins/${id}/versions`}>Versions</Link><Link className="btn btn-primary" to={`/dev/plugins/${id}/upload`}>Upload version</Link></>} />
      <ErrorBanner error={saveError} />
      <div className="two-col">
        <Card title="Listing">
          {TEXT.map(([k, label]) => <Field key={k} label={label} error={saveError?.fields?.[k]}><TextInput value={draft[k]} onChange={(v) => setDraft((d) => ({ ...d, [k]: v }))} /></Field>)}
          <Field label="Category"><Select value={draft.category_id} onChange={(v) => setDraft((d) => ({ ...d, category_id: v }))} options={(categories.data || []).map((c) => ({ value: c.id, label: c.name }))} placeholder="pick" /></Field>
          <Field label="Description (Markdown)"><Textarea value={draft.description_md} onChange={(v) => setDraft((d) => ({ ...d, description_md: v }))} rows={10} mono /></Field>
        </Card>
        <div>
          <Card title="Pricing" subtitle="Paid plugins are entitlements on a panel license; the vendor keeps the rest of the share.">
            <Field label="Model"><Select value={pricing.model} onChange={(v) => setPricing((x) => ({ ...x, model: v }))} options={['free', 'one_time', 'subscription']} /></Field>
            {pricing.model !== 'free' && (
              <>
                <Field label="Price (cents)"><NumberInput value={pricing.cents} nullable={false} onChange={(v) => setPricing((x) => ({ ...x, cents: v }))} min={100} /></Field>
                <Field label="Currency"><TextInput value={pricing.currency} onChange={(v) => setPricing((x) => ({ ...x, currency: v.toUpperCase() }))} maxLength={3} /></Field>
              </>
            )}
            {pricing.model === 'subscription' && (
              <>
                <Field label="Interval"><Select value={pricing.interval} onChange={(v) => setPricing((x) => ({ ...x, interval: v }))} options={['month', 'year']} /></Field>
                <Field label="Trial days"><NumberInput value={pricing.trial_days} nullable={false} onChange={(v) => setPricing((x) => ({ ...x, trial_days: v }))} min={0} max={90} /></Field>
              </>
            )}
            <Button variant="primary" loading={busy} onClick={save}>Save listing & pricing</Button>
          </Card>
          <Card title="Assets" subtitle="PNG, JPEG or SVG. The icon is shown in the catalog; screenshots on the detail page.">
            <div className="inline-list">
              {(p.assets || []).map((a) => <span key={a.id} className="pill pill-muted">{a.kind} #{a.position} · {formatBytes(a.bytes)} <button type="button" className="link-button" onClick={async () => { if (await confirm({ title: 'Delete asset', message: `${a.kind} #${a.position}`, danger: true })) run(() => api.delete(`/dev/plugins/${id}/assets/${a.id}`), { success: 'Asset deleted', then: refetch }); }}>×</button></span>)}
              {!(p.assets || []).length && <span className="muted">No assets.</span>}
            </div>
            <div className="form-grid" style={{ marginTop: 10 }}>
              <Field label="Upload icon"><input type="file" accept="image/png,image/jpeg,image/svg+xml" onChange={upload('icon')} /></Field>
              <Field label="Upload screenshot"><input type="file" accept="image/png,image/jpeg" onChange={upload('screenshot')} /></Field>
              <Field label="Upload banner"><input type="file" accept="image/png,image/jpeg" onChange={upload('banner')} /></Field>
            </div>
          </Card>
          <Card title="Versions">
            <ul className="timeline">{(p.versions || []).slice(0, 8).map((v) => <li key={v.id}><time>{v.version} · {v.channel}</time><span><Link to={`/dev/plugins/${id}/versions/${v.version}`}><StatusPill status={v.status} /></Link></span></li>)}{!(p.versions || []).length && <li><span className="muted">No versions uploaded.</span></li>}</ul>
          </Card>
        </div>
      </div>
    </>
  );
}
