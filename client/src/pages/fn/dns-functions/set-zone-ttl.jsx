import { useState } from 'react';
import { api, queryString } from '../../../api/client.js';
import { useApi } from '../../../hooks/useApi.js';
import { PageHeader, Card, StatusPill } from '../../../components/Common.jsx';
import { DataTable, useTableState } from '../../../components/DataTable.jsx';
import { Field, Select, NumberInput, Button } from '../../../components/Form.jsx';
import { useToast } from '../../../components/Toast.jsx';

const PRESETS = [{ value: '300', label: '5 minutes (300)' }, { value: '900', label: '15 minutes (900)' }, { value: '3600', label: '1 hour (3600)' }, { value: '14400', label: '4 hours (14400, default)' }, { value: '86400', label: '1 day (86400)' }, { value: 'custom', label: 'Custom…' }];

export default function SetZoneTtl({ fn }) {
  const toast = useToast();
  const t = useTableState({ sort: 'domain', pageSize: 100 });
  const { data, meta, loading, error, refetch } = useApi(`/dns/zones${queryString(t.state)}`);
  const [selected, setSelected] = useState([]);
  const [preset, setPreset] = useState('14400');
  const [custom, setCustom] = useState(14400);
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState(null);
  const ttl = preset === 'custom' ? custom : Number(preset);

  const apply = async (domains) => {
    setBusy(true);
    try {
      const { data: out } = await api.post('/dns/zones/ttl', { domains, ttl });
      setResults(out.results);
      const ok = out.results.filter((r) => !r.error).length;
      toast.success(`TTL set to ${ttl}s on ${ok} zone(s)${ok < out.results.length ? `, ${out.results.length - ok} failed` : ''}`);
      setSelected([]);
      refetch();
    } catch (err) { toast.error(err); } finally { setBusy(false); }
  };

  return (
    <>
      <PageHeader fn={fn} description="Sets the $TTL of selected zones (the default time-to-live for records without their own). Lower it before migrations, raise it afterwards." />
      <Card title="New TTL">
        <div className="form-grid">
          <Field label="TTL"><Select value={preset} onChange={setPreset} options={PRESETS} /></Field>
          {preset === 'custom' && <Field label="Seconds"><NumberInput value={custom} onChange={(v) => setCustom(v ?? 0)} nullable={false} min={0} /></Field>}
        </div>
      </Card>
      <Card padded={false}>
        <DataTable
          columns={[
            { key: 'domain', label: 'Zone', sortable: true, render: (z) => <code>{z.domain}</code> },
            { key: 'account', label: 'Account', sortable: true, render: (z) => z.account || <span className="muted">—</span> },
            { key: 'ttl', label: 'Current TTL', sortable: true, align: 'right', render: (z) => `${z.ttl}s` },
            { key: 'result', label: 'Last result', render: (z) => { const r = results?.find((x) => x.domain === z.domain); return r ? (r.error ? <StatusPill status="failed">{r.error}</StatusPill> : <StatusPill status={r.applied === false ? 'warning' : 'ok'}>{r.applied === false ? 'saved, BIND missing' : `published · ${r.serial}`}</StatusPill>) : ''; } },
          ]}
          rows={data || []} loading={loading} error={error} rowKey={(z) => z.domain}
          total={meta?.total} page={t.state.page} pageSize={t.state.pageSize} onPageChange={t.setPage}
          sort={t.state.sort} dir={t.state.dir} onSortChange={t.setSort}
          searchable q={t.state.q} onSearch={t.setSearch}
          selectable selected={selected} onSelectedChange={setSelected}
          rowActions={(z) => [{ label: `Set ${ttl}s`, primary: true, onClick: () => apply([z.domain]) }]}
          toolbar={<Button variant="primary" disabled={!selected.length} loading={busy} onClick={() => apply(selected)}>Apply to selected ({selected.length})</Button>}
          emptyText="No zones."
        />
      </Card>
    </>
  );
}
