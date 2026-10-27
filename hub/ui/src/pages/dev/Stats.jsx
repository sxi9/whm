import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { PageHeader, Card } from '../../components/Common.jsx';
import { Field, Select, TextInput, ErrorBanner } from '../../components/Form.jsx';
import { useApi } from '../../hooks/useApi.js';
import { Stat, StatGrid, MiniBars, money } from '../../widgets/index.jsx';

export default function Stats() {
  const { id: routeId } = useParams();
  const plugins = useApi(routeId ? null : '/dev/plugins?pageSize=100');
  const [pluginId, setPluginId] = useState(routeId || '');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const qs = [from && `from=${new Date(from).toISOString()}`, to && `to=${new Date(to).toISOString()}`].filter(Boolean).join('&');
  const stats = useApi(pluginId ? `/dev/plugins/${pluginId}/stats${qs ? `?${qs}` : ''}` : null);
  const s = stats.data;
  const revenue = (s?.revenue || []).reduce((a, r) => a + (r.developer_cents || 0), 0);
  return (
    <>
      <PageHeader title="Stats" description="Installs (last 30 days), downloads, ratings and your share of revenue." home="/dev" />
      <Card>
        <div className="form-grid">
          {!routeId && <Field label="Plugin"><Select value={pluginId} onChange={setPluginId} options={(plugins.data || []).map((p) => ({ value: p.id, label: p.name }))} placeholder="pick" /></Field>}
          <Field label="From"><TextInput type="date" value={from} onChange={setFrom} /></Field>
          <Field label="To"><TextInput type="date" value={to} onChange={setTo} /></Field>
        </div>
      </Card>
      <ErrorBanner error={stats.error} onRetry={stats.refetch} />
      {s && (
        <>
          <StatGrid>
            <Stat label="Install count" value={s.install_count} hint={Object.entries(s.installs_by_state || {}).map(([k, v]) => `${k}: ${v}`).join(' · ') || 'no installs seen'} />
            <Stat label="Downloads" value={(s.downloads || []).reduce((a, d) => a + d.n, 0)} hint={`${s.from.slice(0, 10)} → ${s.to.slice(0, 10)}`} />
            <Stat label="Rating" value={s.rating_count ? `${s.rating_avg} ★` : '—'} hint={`${s.rating_count || 0} reviews`} />
            <Stat label="Your revenue" value={money(revenue)} hint={`${(s.revenue || []).reduce((a, r) => a + (r.n || 0), 0)} purchases`} />
          </StatGrid>
          <div className="two-col">
            <Card title="Downloads per day"><MiniBars points={s.downloads} /></Card>
            <Card title="Revenue per day (developer share, cents)"><MiniBars points={s.revenue} valueKey="developer_cents" /></Card>
          </div>
          <Card title="Ratings"><dl className="kv">{[5, 4, 3, 2, 1].map((r) => <div key={r}><dt>{'★'.repeat(r)}</dt><dd>{s.ratings?.[r] || 0}</dd></div>)}</dl></Card>
        </>
      )}
    </>
  );
}
