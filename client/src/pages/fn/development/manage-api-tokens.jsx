import { useState } from 'react';
import { KeyRound } from 'lucide-react';
import { api, queryString } from '../../../api/client.js';
import { useApi } from '../../../hooks/useApi.js';
import { useAuth } from '../../../auth/AuthContext.jsx';
import { PageHeader, Card, StatusPill, KeyValue, formatDate } from '../../../components/Common.jsx';
import { DataTable, useTableState } from '../../../components/DataTable.jsx';
import { Field, TextInput, Select, Button, ErrorBanner } from '../../../components/Form.jsx';
import { Modal, useConfirm } from '../../../components/Modal.jsx';
import { useToast } from '../../../components/Toast.jsx';
import { RequestError, ScopePills, CopyButton } from '../../development/Shared.jsx';

const EXPIRY = [{ value: '30', label: '30 days' }, { value: '90', label: '90 days' }, { value: '365', label: '1 year' }, { value: 'never', label: 'Never expires' }, { value: 'custom', label: 'Pick a date…' }];
const EMPTY = { name: '', description: '', scopes: [], expiry: '90', expiresAt: '', username: '' };

export default function ManageApiTokens({ fn }) {
  const toast = useToast();
  const confirm = useConfirm();
  const { user } = useAuth();
  const isRoot = user?.role === 'root';
  const table = useTableState({ pageSize: 25 });
  const list = useApi(`/development/tokens${queryString(table.state)}`);
  const scopes = useApi('/development/tokens/scopes');
  const [form, setForm] = useState(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(null);
  const [issued, setIssued] = useState(null);
  const [usage, setUsage] = useState(null);
  const [rename, setRename] = useState(null);

  const create = async () => {
    setSaving(true); setSaveError(null);
    try {
      const body = { name: form.name.trim(), scopes: form.scopes };
      if (form.description.trim()) body.description = form.description.trim();
      if (form.expiry === 'custom') body.expiresAt = new Date(form.expiresAt).toISOString();
      else if (form.expiry !== 'never') body.expiresInDays = Number(form.expiry);
      if (isRoot && form.username.trim()) body.username = form.username.trim();
      const { data } = await api.post('/development/tokens', body);
      setIssued(data); setForm(null); list.refetch();
    } catch (err) { setSaveError(err); } finally { setSaving(false); }
  };
  const revoke = async (t) => {
    if (!(await confirm({ title: `Revoke "${t.name}"?`, message: 'Any integration using this token stops authenticating immediately. This cannot be undone.', confirmLabel: 'Revoke', danger: true }))) return;
    try { await api.delete(`/development/tokens/${t.id}`); toast.success('Token revoked'); list.refetch(); } catch (err) { toast.error(err); }
  };
  const expire = async (t) => {
    if (!(await confirm({ title: `Expire "${t.name}" now?`, message: 'The token stays listed for your records but can no longer authenticate.', confirmLabel: 'Expire', danger: true }))) return;
    try { await api.post(`/development/tokens/${t.id}/expire`); toast.success('Token expired'); list.refetch(); } catch (err) { toast.error(err); }
  };
  const showUsage = async (t) => { try { const { data } = await api.get(`/development/tokens/${t.id}/usage`); setUsage(data); } catch (err) { toast.error(err); } };
  const saveRename = async () => {
    try { await api.patch(`/development/tokens/${rename.id}`, { name: rename.name.trim(), description: rename.description || null }); toast.success('Token updated'); setRename(null); list.refetch(); } catch (err) { toast.error(err); }
  };
  const toggleScope = (s) => setForm((f) => ({ ...f, scopes: f.scopes.includes(s) ? f.scopes.filter((x) => x !== s) : [...f.scopes, s] }));

  return (
    <>
      <PageHeader fn={fn} actions={<Button variant="primary" icon={KeyRound} onClick={() => setForm({ ...EMPTY })}>Create token</Button>} />
      <RequestError error={list.error} onRetry={list.refetch} />
      <Card padded={false} title="API tokens" subtitle={isRoot ? 'Every token on this server. Tokens authenticate with "Authorization: Bearer <token>" and are exempt from CSRF; only a SHA-256 hash is stored.' : 'Your API tokens. They act with your full permissions; scopes only narrow what they can do in the Development API.'}>
        <DataTable
          columns={[
            { key: 'name', label: 'Name', sortable: true, render: (t) => <><strong>{t.name}</strong>{t.description && <div className="small muted">{t.description}</div>}</> },
            isRoot ? { key: 'username', label: 'User', sortable: true, render: (t) => <>{t.username} <span className="small muted">({t.role})</span></> } : null,
            { key: 'prefix', label: 'Prefix', render: (t) => <code>{t.prefix}…</code> },
            { key: 'scopes', label: 'Scopes', render: (t) => <ScopePills scopes={t.scopes} /> },
            { key: 'expires_at', label: 'Expires', sortable: true, render: (t) => t.expiresAt ? <StatusPill status={t.expired ? 'failed' : 'ok'}>{t.expired ? 'expired ' : ''}{formatDate(t.expiresAt)}</StatusPill> : <StatusPill status="warning">never</StatusPill> },
            { key: 'last_used_at', label: 'Last used', sortable: true, render: (t) => formatDate(t.lastUsedAt) },
            { key: 'created_at', label: 'Created', sortable: true, render: (t) => formatDate(t.createdAt) },
          ].filter(Boolean)}
          rows={list.data || []} loading={list.loading} error={null} total={list.meta?.total} page={table.state.page} pageSize={table.state.pageSize} onPageChange={table.setPage}
          sort={table.state.sort} dir={table.state.dir} onSortChange={table.setSort} searchable q={table.state.q} onSearch={table.setSearch} searchPlaceholder="Search name, user or prefix…"
          emptyText="No API tokens yet. Create one to script the panel from billing systems, CI or monitoring."
          rowActions={(t) => [
            { label: 'Usage', primary: true, onClick: () => showUsage(t) },
            { label: 'Rename', onClick: () => setRename({ id: t.id, name: t.name, description: t.description || '' }) },
            !t.expired ? { label: 'Expire now', danger: true, onClick: () => expire(t) } : null,
            { label: 'Revoke', danger: true, onClick: () => revoke(t) },
          ]}
        />
      </Card>
      <Card title="Using a token">
        <pre className="log">{`curl -s https://${window.location.hostname}:2087/api/system/status \\\n  -H "Authorization: Bearer whm_…"`}</pre>
        <p className="small muted" style={{ marginTop: 8 }}>{scopes.data?.note}</p>
      </Card>

      <Modal open={Boolean(form)} title="Create API token" onClose={() => setForm(null)} size="lg"
        footer={<><Button onClick={() => setForm(null)}>Cancel</Button><Button variant="primary" loading={saving} disabled={!form?.name.trim() || (form?.expiry === 'custom' && !form.expiresAt)} onClick={create}>Create</Button></>}>
        {form && (
          <>
            <div className="form-grid">
              <Field label="Name" required help="Where this token is used, e.g. WHMCS, Zabbix, deploy script"><TextInput value={form.name} onChange={(v) => setForm({ ...form, name: v })} autoFocus /></Field>
              <Field label="Description"><TextInput value={form.description} onChange={(v) => setForm({ ...form, description: v })} /></Field>
              <Field label="Expiry"><Select value={form.expiry} onChange={(v) => setForm({ ...form, expiry: v })} options={EXPIRY} /></Field>
              {form.expiry === 'custom' && <Field label="Expires at"><TextInput type="datetime-local" value={form.expiresAt} onChange={(v) => setForm({ ...form, expiresAt: v })} /></Field>}
              {isRoot && <Field label="Issue for user" help="Leave empty for yourself (root)"><TextInput value={form.username} onChange={(v) => setForm({ ...form, username: v })} placeholder="root" /></Field>}
            </div>
            <div className="banner banner-warning">
              <div>
                <strong>Scopes only restrict the Development API.</strong>
                <p>Whatever you tick here, this token acts with {form.username.trim() && isRoot ? `${form.username.trim()}'s` : 'the user’s'} full role everywhere else ({(scopes.data?.unrestrictedAreas || []).join(', ') || 'accounts, DNS, mail, databases and the rest'}). Those areas are not scope-aware yet. To limit a token outside Development, issue it for a user with a narrower role.</p>
              </div>
            </div>
            <Field label="Development API scopes" help="Leave every box unticked to inherit the user's full role in the Development API as well. Tick development:read or development:write to narrow it there.">
              <div className="form-grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))' }}>
                {(scopes.data?.scopes || []).map((s) => <label key={s} className="radio"><input type="checkbox" checked={form.scopes.includes(s)} onChange={() => toggleScope(s)} /> <span><code>{s}</code>{s === '*' && <span className="small muted"> (no restriction)</span>}</span></label>)}
              </div>
            </Field>
            <ErrorBanner error={saveError} />
          </>
        )}
      </Modal>

      <Modal open={Boolean(issued)} title="Token created" onClose={() => setIssued(null)} footer={<Button variant="primary" onClick={() => setIssued(null)}>Done</Button>}>
        {issued && (
          <>
            <div className="banner banner-warning"><div><strong>Copy it now.</strong><p>This is the only time the token is shown; the panel keeps only a hash.</p></div></div>
            <pre className="log" style={{ wordBreak: 'break-all' }}>{issued.token}</pre>
            <div className="action-row"><CopyButton text={issued.token} label="Copy token" size={undefined} /></div>
            <KeyValue items={[['Name', issued.name], ['User', issued.username], ['Scopes', <ScopePills key="s" scopes={issued.scopes} />], ['Expires', issued.expiresAt ? formatDate(issued.expiresAt) : 'never']]} />
          </>
        )}
      </Modal>

      <Modal open={Boolean(usage)} title={usage ? `Usage: ${usage.token.name}` : ''} onClose={() => setUsage(null)} size="lg">
        {usage && (
          <>
            <KeyValue items={[['Prefix', <code key="p">{usage.token.prefix}…</code>], ['Last authenticated', formatDate(usage.token.lastUsedAt)], ['Created', `${formatDate(usage.token.createdAt)}${usage.token.createdIp ? ` from ${usage.token.createdIp}` : ''}`], ['Expires', usage.token.expiresAt ? formatDate(usage.token.expiresAt) : 'never'], ['Status', <StatusPill key="s" status={usage.token.expired ? 'failed' : 'ok'}>{usage.token.expired ? 'expired' : 'active'}</StatusPill>]]} />
            <p className="small muted" style={{ margin: '10px 0' }}>{usage.note}</p>
            <div className="table-wrap" style={{ maxHeight: 300, overflow: 'auto' }}>
              <table><thead><tr><th>When</th><th>Action</th><th>Target</th><th>Result</th><th>IP</th></tr></thead>
                <tbody>
                  {usage.activity.length === 0 && <tr><td colSpan={5} className="table-state">No audited activity since the token was issued</td></tr>}
                  {usage.activity.map((a, i) => <tr key={i}><td>{formatDate(a.ts)}</td><td><code>{a.action}</code></td><td>{a.target || '—'}</td><td><StatusPill status={a.result === 'ok' ? 'ok' : 'failed'}>{a.result}</StatusPill></td><td>{a.ip || '—'}</td></tr>)}
                </tbody></table>
            </div>
          </>
        )}
      </Modal>

      <Modal open={Boolean(rename)} title="Rename token" onClose={() => setRename(null)} size="sm" footer={<><Button onClick={() => setRename(null)}>Cancel</Button><Button variant="primary" disabled={!rename?.name.trim()} onClick={saveRename}>Save</Button></>}>
        {rename && <><Field label="Name" required><TextInput value={rename.name} onChange={(v) => setRename({ ...rename, name: v })} /></Field><Field label="Description"><TextInput value={rename.description} onChange={(v) => setRename({ ...rename, description: v })} /></Field></>}
      </Modal>
    </>
  );
}
