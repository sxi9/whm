import { useState } from 'react';
import { api, queryString } from '../../../api/client.js';
import { useApi } from '../../../hooks/useApi.js';
import { PageHeader, Card, StatusPill, KeyValue, CapabilityNotice, formatDate } from '../../../components/Common.jsx';
import { DataTable, useTableState } from '../../../components/DataTable.jsx';
import { Field, TextInput, Toggle, Button, FormActions, ErrorBanner } from '../../../components/Form.jsx';
import { useToast } from '../../../components/Toast.jsx';
import { useConfirm } from '../../../components/Modal.jsx';
import { AccountPicker } from '../../accounts/AccountPicker.jsx';

export default function ParkADomain({ fn }) {
  const toast = useToast();
  const confirm = useConfirm();
  const t = useTableState({ sort: 'domain' });
  const { data, meta, loading, error, refetch } = useApi(`/dns/parked${queryString(t.state)}`);
  const [form, setForm] = useState({ domain: '', account: '', ip: '', createZone: true });
  const [result, setResult] = useState(null);
  const [formError, setFormError] = useState(null);
  const [busy, setBusy] = useState(false);
  const set = (k) => (v) => setForm((f) => ({ ...f, [k]: v }));

  const park = async (e) => {
    e.preventDefault();
    setBusy(true); setFormError(null); setResult(null);
    try {
      const body = { domain: form.domain.trim().toLowerCase(), account: form.account, createZone: form.createZone };
      if (form.ip) body.ip = form.ip;
      const { data: res } = await api.post('/dns/parked', body);
      setResult(res);
      toast.success(`${res.domain} parked on ${res.account}`);
      setForm((f) => ({ ...f, domain: '' }));
      refetch();
    } catch (err) { setFormError(err); } finally { setBusy(false); }
  };
  const unpark = async (row) => {
    const ok = await confirm({ title: `Remove parked domain ${row.domain}?`, message: 'The alias is removed from the account and its DNS zone is deleted.', confirmLabel: 'Remove', danger: true });
    if (!ok) return;
    try { await api.delete(`/dns/parked/${row.domain}?removeZone=true`); toast.success(`${row.domain} removed`); refetch(); } catch (err) { toast.error(err); }
  };

  return (
    <>
      <PageHeader fn={fn} description="A parked (alias) domain shows the same site as an account's main domain. The panel records the alias, creates its DNS zone and asks the web server to add the alias to the vhost." />
      <form onSubmit={park}>
        <Card title="Park a domain">
          <CapabilityNotice error={formError} />
          <ErrorBanner error={formError && !formError.fields && formError.code !== 'capability_missing' ? formError : null} />
          <AccountPicker value={form.account} onChange={set('account')} label="Park onto account" />
          <div className="form-grid">
            <Field label="Domain to park" required error={formError?.fields?.domain}><TextInput value={form.domain} onChange={set('domain')} placeholder="example.net" /></Field>
            <Field label="IP address" help="Blank uses the account's IP" error={formError?.fields?.ip}><TextInput value={form.ip} onChange={set('ip')} /></Field>
          </div>
          <Field inline><Toggle checked={form.createZone} onChange={set('createZone')} label="Create a DNS zone for the domain" description="Turn off when DNS is hosted elsewhere" /></Field>
          <FormActions><Button type="submit" variant="primary" loading={busy} disabled={!form.account || !form.domain}>Park domain</Button></FormActions>
          {result && <KeyValue items={[['Parked', <code key="d">{result.domain}</code>], ['Serves', result.target], ['Document root', <code key="r">{result.docroot}</code>], ['DNS zone', result.zone ? <StatusPill key="z" status={result.zone.applied === false ? 'warning' : 'ok'}>{result.zone.applied === false ? 'saved, BIND missing' : 'created & published'}</StatusPill> : 'skipped'], ['Web server alias', <StatusPill key="w" status={result.web === 'applied' ? 'ok' : result.web === 'pending' ? 'pending' : 'failed'}>{result.web}</StatusPill>]]} />}
        </Card>
      </form>
      <Card title="Parked domains" padded={false}>
        <DataTable
          columns={[
            { key: 'domain', label: 'Parked domain', sortable: true, render: (r) => <code>{r.domain}</code> },
            { key: 'account', label: 'Account', sortable: true },
            { key: 'target', label: 'Serves', render: (r) => r.target },
            { key: 'has_zone', label: 'DNS zone', render: (r) => <StatusPill status={r.has_zone ? 'ok' : 'unknown'}>{r.has_zone ? 'here' : 'external'}</StatusPill> },
            { key: 'created_at', label: 'Added', sortable: true, render: (r) => formatDate(r.created_at) },
          ]}
          rows={data || []} loading={loading} error={error} rowKey={(r) => r.domain}
          total={meta?.total} page={t.state.page} pageSize={t.state.pageSize} onPageChange={t.setPage}
          sort={t.state.sort} dir={t.state.dir} onSortChange={t.setSort}
          searchable q={t.state.q} onSearch={t.setSearch}
          rowActions={(r) => [{ label: 'Remove', primary: true, danger: true, onClick: () => unpark(r) }]}
          emptyText="No parked domains."
        />
      </Card>
    </>
  );
}
