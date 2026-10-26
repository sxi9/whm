import { useEffect, useState } from 'react';
import { api, queryString } from '../../api/client.js';
import { useApi } from '../../hooks/useApi.js';
import { Card, StatusPill, formatDate } from '../../components/Common.jsx';
import { DataTable, useTableState } from '../../components/DataTable.jsx';
import { Field, TextInput, NumberInput, Toggle, Select, Button, FormActions } from '../../components/Form.jsx';
import { useToast } from '../../components/Toast.jsx';
import { useConfirm } from '../../components/Modal.jsx';

export function CphulkStatus({ overview, refetch }) {
  const toast = useToast();
  const [draft, setDraft] = useState(overview.settings);
  const [busy, setBusy] = useState(false);
  // The overview polls; only reset the form when the stored values actually change.
  const stored = JSON.stringify(overview.settings);
  useEffect(() => setDraft(JSON.parse(stored)), [stored]);
  const dirty = JSON.stringify(draft) !== JSON.stringify(overview.settings);
  const save = async () => {
    setBusy(true);
    try { await api.put('/security/cphulk/settings', draft); toast.success('cPHulk settings saved'); refetch(); } catch (err) { toast.error(err); } finally { setBusy(false); }
  };
  const s = overview.stats;
  return (
    <>
      <div className="stat-grid" style={{ marginBottom: 14 }}>
        <div className="stat"><div className="label">Protection</div><div className="value"><StatusPill status={overview.settings.enabled ? 'enabled' : 'disabled'} /></div></div>
        <div className="stat"><div className="label">Active blocks</div><div className="value">{s.activeBlocks}</div></div>
        <div className="stat"><div className="label">Failed logins (24h)</div><div className="value">{s.failures24h}</div></div>
        <div className="stat"><div className="label">Login attempts (24h)</div><div className="value">{s.attempts24h}</div></div>
      </div>
      <Card title="Settings">
        <Field inline><Toggle checked={draft.enabled} onChange={(v) => setDraft({ ...draft, enabled: v })} label="Enable cPHulk brute force protection" description="Blocks an address after too many failed panel logins within the lockout window." /></Field>
        <div className="form-grid">
          <Field label="Failures per IP before blocking"><NumberInput value={draft.maxFailuresPerIp} onChange={(v) => setDraft({ ...draft, maxFailuresPerIp: v })} min={1} nullable={false} /></Field>
          <Field label="Block duration (minutes)" help="Also the window in which failures are counted."><NumberInput value={draft.lockoutMinutes} onChange={(v) => setDraft({ ...draft, lockoutMinutes: v })} min={1} nullable={false} /></Field>
          <Field label="Keep login history (days)"><NumberInput value={draft.historyRetentionDays} onChange={(v) => setDraft({ ...draft, historyRetentionDays: v })} min={1} nullable={false} /></Field>
        </div>
        <Field inline><Toggle checked={draft.firewallSync} onChange={(v) => setDraft({ ...draft, firewallSync: v })} label="Also drop blocked addresses in the firewall" description="Adds blocks to the WHM_BLOCK iptables/nft chain so they cannot reach any service; synced hourly by the maintenance job." /></Field>
        <Field inline><Toggle checked={draft.blockDenylistPermanently} onChange={(v) => setDraft({ ...draft, blockDenylistPermanently: v })} label="Denylist entries create permanent blocks" /></Field>
        <FormActions><Button variant="primary" loading={busy} disabled={!dirty} onClick={save}>Save</Button></FormActions>
      </Card>
      {s.topOffenders?.length > 0 && (
        <Card title="Top offending addresses (24h)" padded={false}>
          <DataTable dense columns={[{ key: 'ip', label: 'Address', render: (r) => <code>{r.ip}</code> }, { key: 'failures', label: 'Failures', align: 'right' }, { key: 'last_seen', label: 'Last seen', render: (r) => formatDate(r.last_seen) }]} rows={s.topOffenders} rowKey={(r) => r.ip} />
        </Card>
      )}
    </>
  );
}

export function CphulkBlocks({ blocks, refetch }) {
  const toast = useToast();
  const confirm = useConfirm();
  const [form, setForm] = useState({ ip: '', minutes: 1440, reason: '', permanent: false });
  const [busy, setBusy] = useState(false);
  const block = async () => {
    setBusy(true);
    try {
      await api.post('/security/cphulk/blocks', { ip: form.ip.trim(), minutes: form.permanent ? null : form.minutes, ...(form.reason ? { reason: form.reason } : {}) });
      toast.success(`${form.ip} blocked`); setForm({ ...form, ip: '', reason: '' }); refetch();
    } catch (err) { toast.error(err); } finally { setBusy(false); }
  };
  const unblock = async (b) => { try { await api.delete(`/security/cphulk/blocks/${b.id}`); toast.success(`${b.ip} unblocked`); refetch(); } catch (err) { toast.error(err); } };
  const flush = async () => {
    if (!(await confirm({ title: 'Remove every block?', message: 'All currently blocked addresses will be able to log in again.', confirmLabel: 'Remove all', danger: true }))) return;
    try { const { data } = await api.delete('/security/cphulk/blocks'); toast.success(`${data.cleared} block(s) removed`); refetch(); } catch (err) { toast.error(err); }
  };
  return (
    <>
      <Card title="Block an address">
        <div className="form-grid">
          <Field label="IP address or CIDR" required help="Panel logins are matched per address; a network (CIDR) is only blocked in the firewall and needs firewall sync."><TextInput value={form.ip} onChange={(v) => setForm({ ...form, ip: v })} placeholder="203.0.113.5" /></Field>
          <Field label="Duration (minutes)"><NumberInput value={form.minutes} onChange={(v) => setForm({ ...form, minutes: v })} min={1} nullable={false} disabled={form.permanent} /></Field>
          <Field label="Reason"><TextInput value={form.reason} onChange={(v) => setForm({ ...form, reason: v })} placeholder="optional" /></Field>
        </div>
        <Field inline><Toggle checked={form.permanent} onChange={(v) => setForm({ ...form, permanent: v })} label="Permanent (one-day blocks and longer belong on the denylist)" /></Field>
        <FormActions><Button variant="primary" loading={busy} disabled={!form.ip.trim()} onClick={block}>Block</Button></FormActions>
      </Card>
      <Card title="Currently blocked" padded={false} actions={blocks.length > 0 && <Button size="sm" variant="danger" onClick={flush}>Remove all</Button>}>
        <DataTable dense columns={[
          { key: 'ip', label: 'Address', render: (b) => <code>{b.ip}</code> },
          { key: 'reason', label: 'Reason' },
          { key: 'created_at', label: 'Blocked', render: (b) => formatDate(b.created_at) },
          { key: 'expires_at', label: 'Expires', render: (b) => (b.permanent ? <StatusPill status="warning">permanent</StatusPill> : formatDate(b.expires_at)) },
        ]} rows={blocks} rowKey={(b) => b.id} emptyText="No address is blocked right now." rowActions={(b) => [{ label: 'Unblock', primary: true, onClick: () => unblock(b) }]} />
      </Card>
    </>
  );
}

export function CphulkHistory() {
  const t = useTableState({ sort: 'created_at', dir: 'desc' });
  const [failedOnly, setFailedOnly] = useState(true);
  const { data, meta, loading, error } = useApi(`/security/cphulk/history${queryString({ ...t.state, failed: failedOnly ? 'true' : undefined })}`);
  return (
    <Card padded={false}>
      <DataTable columns={[
        { key: 'created_at', label: 'When', sortable: true, render: (r) => formatDate(r.created_at) },
        { key: 'ip', label: 'Address', sortable: true, render: (r) => <code>{r.ip}</code> },
        { key: 'username', label: 'User', sortable: true },
        { key: 'ok', label: 'Result', render: (r) => <StatusPill status={r.ok ? 'ok' : 'failed'}>{r.ok ? 'success' : 'failed'}</StatusPill> },
      ]} rows={data || []} loading={loading} error={error} rowKey={(r) => r.id}
        total={meta?.total} page={t.state.page} pageSize={t.state.pageSize} onPageChange={t.setPage} sort={t.state.sort} dir={t.state.dir} onSortChange={t.setSort}
        searchable q={t.state.q} onSearch={t.setSearch} searchPlaceholder="Search address or user…"
        toolbar={<Toggle checked={failedOnly} onChange={(v) => { setFailedOnly(v); t.setPage(1); }} label="Failures only" />} emptyText="No login attempts recorded." dense />
    </Card>
  );
}

export function CphulkLists() {
  const toast = useToast();
  const confirm = useConfirm();
  const { data, loading, error, refetch } = useApi('/security/cphulk/lists');
  const [form, setForm] = useState({ kind: 'allow', ip: '', comment: '' });
  const add = async () => {
    try { await api.post('/security/cphulk/lists', { kind: form.kind, ip: form.ip.trim(), ...(form.comment ? { comment: form.comment } : {}) }); toast.success(`${form.ip} added to the ${form.kind} list`); setForm({ ...form, ip: '', comment: '' }); refetch(); } catch (err) { toast.error(err); }
  };
  const remove = async (e) => {
    if (!(await confirm({ title: `Remove ${e.ip} from the ${e.kind} list?`, confirmLabel: 'Remove', danger: true }))) return;
    try { await api.delete(`/security/cphulk/lists/${e.id}`); refetch(); } catch (err) { toast.error(err); }
  };
  const table = (kind, empty) => (
    <Card title={kind === 'allow' ? 'Allowlist' : 'Denylist'} subtitle={kind === 'allow' ? 'Exact addresses are never blocked by the login path. Addresses inside an allowlisted network can still be auto-blocked after failed logins; those blocks are released by the hourly maintenance job.' : 'Exact addresses are blocked permanently in the panel. Networks are blocked in the firewall when sync is on.'} padded={false}>
      <DataTable dense columns={[{ key: 'ip', label: 'Address / network', render: (e) => <code>{e.ip}</code> }, { key: 'comment', label: 'Comment' }, { key: 'created_at', label: 'Added', render: (e) => formatDate(e.created_at) }]}
        rows={(data || []).filter((e) => e.kind === kind)} loading={loading} error={error} rowKey={(e) => e.id} emptyText={empty} rowActions={(e) => [{ label: 'Remove', danger: true, primary: true, onClick: () => remove(e) }]} />
    </Card>
  );
  return (
    <>
      <Card title="Add to a list">
        <div className="form-grid">
          <Field label="List"><Select value={form.kind} onChange={(v) => setForm({ ...form, kind: v })} options={[{ value: 'allow', label: 'Allowlist' }, { value: 'deny', label: 'Denylist' }]} /></Field>
          <Field label="IP address or CIDR" required><TextInput value={form.ip} onChange={(v) => setForm({ ...form, ip: v })} placeholder="192.0.2.0/24" /></Field>
          <Field label="Comment"><TextInput value={form.comment} onChange={(v) => setForm({ ...form, comment: v })} placeholder="office network" /></Field>
        </div>
        <FormActions><Button variant="primary" disabled={!form.ip.trim()} onClick={add}>Add</Button></FormActions>
      </Card>
      {table('allow', 'Add your office or VPN addresses so a typo never locks you out.')}
      {table('deny', 'No denylisted addresses or networks.')}
    </>
  );
}
