import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { KeyRound, RefreshCw, ShieldOff, Clock } from 'lucide-react';
import { api, queryString } from '../../api/client.js';
import { useApi, useMutation } from '../../hooks/useApi.js';
import { Card, KeyValue, Loading, StatusPill, formatDate } from '../../components/Common.jsx';
import { DataTable, useTableState } from '../../components/DataTable.jsx';
import { Field, TextInput, NumberInput, Select, Toggle, Button, FormActions, ErrorBanner } from '../../components/Form.jsx';
import { Modal, useConfirm } from '../../components/Modal.jsx';
import { useToast } from '../../components/Toast.jsx';
import { RequestError, isCapabilityError, Remaining, SecretBlock, CopyButton } from './Shared.jsx';

const SCOPE_OPTIONS = [
  { value: '', label: 'Full access as root (every API area)' },
  { value: 'development:read', label: 'Development API read-only (other areas still act as root)' },
  { value: 'development:write', label: 'Development API read/write (other areas still act as root)' },
];
const GRANT_TONE = { active: 'active', expired: 'done', revoked: 'cancelled' };

export function GrantResult({ result, onClose }) {
  const g = result?.grant;
  return (
    <Modal open={Boolean(result)} title={g ? `Access granted: ${g.label}` : ''} onClose={onClose} size="lg" footer={<Button variant="primary" onClick={onClose}>I have saved these</Button>}>
      {g && (
        <>
          <div className="banner banner-warning"><div><strong>Shown once.</strong><p>The private key is not stored on this server and the token is kept only as a hash. Hand them to the support engineer now; both stop working at {formatDate(g.expiresAt)} or as soon as you revoke the grant.</p></div></div>
          <KeyValue items={[['Expires', formatDate(g.expiresAt)], ['Granted by', g.grantedBy], result.ssh && ['Key fingerprint', <code>{result.ssh.fingerprint}</code>], result.apiToken && ['Token prefix', <code>{result.apiToken.prefix}…</code>]]} />
          {result.ssh && (
            <>
              <SecretBlock label="SSH private key (give to support)" value={result.ssh.privateKey} filename={`support-${g.label}.key`} help="Save as a file with mode 0600, then connect with the command below." />
              <SecretBlock label="Login command" value={result.ssh.command} mono />
              <SecretBlock label="Public key (now in /root/.ssh/authorized_keys)" value={result.ssh.publicKey} />
            </>
          )}
          {result.apiToken && (
            <>
              <SecretBlock label="API token (give to support)" value={result.apiToken.token} filename={`support-${g.label}.token`} help={result.apiToken.scopes?.length ? `Scopes: ${result.apiToken.scopes.join(', ')} (enforced on the Development API only).` : 'No scope restriction: the token acts as root everywhere.'} />
              <SecretBlock label="Example request" value={result.apiToken.example} />
            </>
          )}
        </>
      )}
    </Modal>
  );
}

export function GrantForm({ status, onGranted }) {
  const toast = useToast();
  const [form, setForm] = useState({ label: '', hours: null, ssh: true, apiToken: true, scope: '', note: '' });
  const { mutate, loading, error, fieldErrors } = useMutation((body) => api.post('/support/access', body));
  const set = (k) => (v) => setForm((f) => ({ ...f, [k]: v }));
  const sshdMissing = status && !status.sshd;
  const defaultHours = status?.settings?.defaultHours ?? 24;
  const maxHours = status?.settings?.maxHours ?? 168;

  const submit = async (e) => {
    e.preventDefault();
    try {
      const body = { label: form.label.trim(), ssh: form.ssh && !sshdMissing, apiToken: form.apiToken };
      if (form.hours) body.hours = form.hours;
      if (form.scope && form.apiToken) body.tokenScopes = [form.scope];
      if (form.note.trim()) body.note = form.note.trim();
      const res = await mutate(body);
      toast.success(`Access granted until ${formatDate(res.data.grant.expiresAt)}`);
      setForm({ label: '', hours: null, ssh: !sshdMissing, apiToken: true, scope: '', note: '' });
      onGranted?.(res.data);
    } catch (err) { if (!err.fields) toast.error(err); }
  };

  return (
    <Card title="Grant access" subtitle="Creates a fresh SSH key authorized for root and an API token, both removed automatically when the time box ends.">
      {sshdMissing && <div className="banner banner-info"><div><strong>sshd is not installed</strong><p>{status.sshdDetail} Only an API token can be issued until <Link to="/software/install-distro-packages">openssh-server</Link> is installed.</p></div></div>}
      <form onSubmit={submit}>
        <ErrorBanner error={error && isCapabilityError(error) ? null : error && !fieldErrors ? error : null} />
        <RequestError error={isCapabilityError(error) ? error : null} />
        <Field label="Label" required error={fieldErrors?.label} help="Usually the support ticket or case number. Becomes the key comment and the token name."><TextInput value={form.label} onChange={set('label')} placeholder="case-1234567" maxLength={48} /></Field>
        <Field label="Duration (hours)" error={fieldErrors?.hours} help={`Default ${defaultHours} h, at most ${maxHours} h. Change the limits under Support Center → Settings.`}><NumberInput value={form.hours} onChange={set('hours')} min={1} max={maxHours} placeholder={String(defaultHours)} /></Field>
        <Field error={fieldErrors?.ssh}><Toggle checked={form.ssh && !sshdMissing} disabled={Boolean(sshdMissing)} onChange={set('ssh')} label="SSH access as root" description="A new ed25519 key pair; the public half is appended to /root/.ssh/authorized_keys." /></Field>
        <Field error={fieldErrors?.apiToken}><Toggle checked={form.apiToken} onChange={set('apiToken')} label="API token" description="A bearer token for this panel's API with the same expiry, listed under Development → Manage API Tokens." /></Field>
        {form.apiToken && <Field label="Token scope" error={fieldErrors?.tokenScopes}><Select value={form.scope} onChange={set('scope')} options={SCOPE_OPTIONS} /></Field>}
        <Field label="Note" error={fieldErrors?.note}><TextInput value={form.note} onChange={set('note')} placeholder="Why access is being granted" maxLength={500} /></Field>
        {fieldErrors?._ && <div className="field-message">{fieldErrors._.join(' ')}</div>}
        <FormActions><Button type="submit" variant="primary" icon={KeyRound} loading={loading} disabled={!form.label.trim() || (!form.apiToken && (!form.ssh || sshdMissing))}>Grant access</Button></FormActions>
      </form>
    </Card>
  );
}

export function GrantList({ refreshKey = 0, onChanged }) {
  const toast = useToast();
  const confirm = useConfirm();
  const table = useTableState({ pageSize: 25 });
  const [status, setStatus] = useState('');
  const [open, setOpen] = useState(null);
  const [busy, setBusy] = useState(false);
  const { data, meta, loading, error, refetch } = useApi(`/support/access${queryString({ ...table.state, status: status || undefined, r: refreshKey })}`);
  const loadedAt = useMemo(() => Date.now(), [data]);

  const revoke = async (g) => {
    if (!await confirm({ title: 'Revoke support access', message: `End "${g.label}" now? The SSH key is removed from root's authorized_keys and the API token stops working immediately.`, danger: true, confirmLabel: 'Revoke' })) return;
    setBusy(true);
    try {
      const res = await api.delete(`/support/access/${g.id}`);
      const c = res.data.cleanup || {};
      if (c.ok === false) toast.warning(`Access revoked, but cleanup was incomplete: ${c.ssh?.error || c.api?.error || 'see the audit log'}`, { timeout: 10_000 });
      else toast.success(`Access "${g.label}" revoked`);
      refetch(); onChanged?.();
    } catch (err) { toast.error(err); } finally { setBusy(false); }
  };
  const expireDue = async () => {
    setBusy(true);
    try { const res = await api.post('/support/access/expire-due'); toast.success(res.data.expired ? `${res.data.expired} grant(s) expired` : 'Nothing was due'); refetch(); onChanged?.(); } catch (err) { toast.error(err); } finally { setBusy(false); }
  };

  const columns = [
    { key: 'label', label: 'Label', sortable: true, render: (g) => <button className="link-button" onClick={() => setOpen(g)}>{g.label}</button> },
    { key: 'status', label: 'Status', sortable: true, render: (g) => <StatusPill status={GRANT_TONE[g.status]}>{g.status}</StatusPill> },
    { key: 'what', label: 'Grants', render: (g) => [g.ssh && 'SSH', g.apiToken && 'API token'].filter(Boolean).join(' + ') || '—' },
    { key: 'expires_at', label: 'Expires', sortable: true, render: (g) => <span>{formatDate(g.expiresAt)}{g.status === 'active' && <> · <Remaining seconds={g.remainingSeconds} at={loadedAt} /></>}</span> },
    { key: 'grantedBy', label: 'Granted by' },
    { key: 'created_at', label: 'Created', sortable: true, render: (g) => formatDate(g.createdAt) },
  ];
  return (
    <>
      <Card title="Grants" subtitle="Active grants are checked every five minutes and ended the moment they are overdue." actions={<><Button size="sm" icon={Clock} loading={busy} onClick={expireDue}>Expire overdue now</Button><Button size="sm" icon={RefreshCw} onClick={() => refetch()}>Refresh</Button></>}>
        <RequestError error={error} onRetry={refetch} />
        <DataTable columns={columns} rows={data || []} loading={loading} total={meta?.total} page={table.state.page} pageSize={table.state.pageSize} onPageChange={table.setPage}
          sort={table.state.sort} dir={table.state.dir} onSortChange={table.setSort} searchable q={table.state.q} onSearch={table.setSearch} searchPlaceholder="Search label or fingerprint…"
          emptyText="No support access has been granted"
          toolbar={<Select value={status} onChange={(v) => { setStatus(v); table.setPage(1); }} options={[{ value: '', label: 'All' }, { value: 'active', label: 'Active' }, { value: 'expired', label: 'Expired' }, { value: 'revoked', label: 'Revoked' }]} />}
          rowActions={(g) => [g.status === 'active' && { label: 'Revoke', primary: true, danger: true, disabled: busy, onClick: () => revoke(g) }, { label: 'Details', onClick: () => setOpen(g) }]} />
      </Card>
      <Modal open={Boolean(open)} title={open ? `Grant: ${open.label}` : ''} onClose={() => setOpen(null)} footer={<>{open?.status === 'active' && <Button variant="danger" icon={ShieldOff} onClick={() => { revoke(open); setOpen(null); }}>Revoke</Button>}<Button onClick={() => setOpen(null)}>Close</Button></>}>
        {open && (
          <KeyValue items={[
            ['Status', <StatusPill status={GRANT_TONE[open.status]}>{open.status}</StatusPill>],
            ['Expires', formatDate(open.expiresAt)],
            ['Granted', `${formatDate(open.createdAt)} by ${open.grantedBy || '—'}${open.grantedIp ? ` from ${open.grantedIp}` : ''}`],
            open.note && ['Note', open.note],
            ['SSH key', open.ssh ? <span><code className="small">{open.ssh.fingerprint}</code> <CopyButton text={open.ssh.fingerprint} /></span> : 'not granted'],
            ['API token', open.apiToken ? <span><code>{open.apiToken.prefix}…</code> (<Link to="/development/manage-api-tokens">token #{open.apiToken.id}</Link>)</span> : 'not granted'],
            open.endedAt && ['Ended', `${formatDate(open.endedAt)} by ${open.endedBy || '—'}`],
            open.cleanup && ['Cleanup', <span>{open.cleanup.ssh ? `key ${open.cleanup.ssh.error ? `not removed (${open.cleanup.ssh.error})` : `removed (${open.cleanup.ssh.removed})`}` : ''}{open.cleanup.ssh && open.cleanup.api ? '; ' : ''}{open.cleanup.api ? `token ${open.cleanup.api.expired ? 'expired' : `not expired (${open.cleanup.api.error})`}` : ''}</span>],
          ]} />
        )}
      </Modal>
    </>
  );
}

export function AccessGrants() {
  const [result, setResult] = useState(null);
  const [tick, setTick] = useState(0);
  const status = useApi('/support/access/status');
  return (
    <>
      <RequestError error={status.error} onRetry={status.refetch} />
      {status.loading && !status.data && <Loading />}
      {status.data?.active?.length > 0 && (
        <div className="banner banner-warning"><div><strong>{status.data.active.length} active support grant{status.data.active.length > 1 ? 's' : ''}</strong><p>{status.data.active.map((g) => `${g.label} (until ${formatDate(g.expiresAt)})`).join(', ')}. Revoke below as soon as the engineer is done.</p></div></div>
      )}
      <GrantForm status={status.data} onGranted={(r) => { setResult(r); setTick((t) => t + 1); status.refetch(); }} />
      <GrantList refreshKey={tick} onChanged={() => status.refetch()} />
      <GrantResult result={result} onClose={() => setResult(null)} />
    </>
  );
}
