import { useState } from 'react';
import { api } from '../../../api/client.js';
import { useApi } from '../../../hooks/useApi.js';
import { PageHeader, Card, StatusPill, Loading, formatDate } from '../../../components/Common.jsx';
import { DataTable } from '../../../components/DataTable.jsx';
import { Field, TextInput, Select, Textarea, Button, FormActions, ErrorBanner } from '../../../components/Form.jsx';
import { useToast } from '../../../components/Toast.jsx';
import { useConfirm } from '../../../components/Modal.jsx';
import { Modal } from '../../../components/Modal.jsx';
import { RequestError, EximNotice, ApplyBadge, IncludeHint, applyMessage, useMailStatus } from '../../email/Shared.jsx';

function CidrModal({ code, onClose }) {
  const [page, setPage] = useState(1);
  const { data, meta, loading, error } = useApi(code ? `/email/filters/country/${code}/cidrs?page=${page}&pageSize=100` : null, { enabled: Boolean(code) });
  return (
    <Modal open={Boolean(code)} title={`CIDR networks for ${code?.toUpperCase() || ''}`} onClose={onClose}>
      <ErrorBanner error={error} />
      <DataTable columns={[{ key: 'cidr', label: 'Network', render: (r) => <code>{r.cidr}</code> }]} rows={data || []} loading={loading} total={meta?.total ?? null} page={page} pageSize={100} onPageChange={setPage} rowKey={(r) => r.cidr} dense emptyText="No networks uploaded yet." />
    </Modal>
  );
}

export default function FilterIncomingEmailsByCountry({ fn }) {
  const toast = useToast();
  const confirm = useConfirm();
  const { data: status, refetch: refetchStatus } = useMailStatus();
  const { data, loading, error, refetch } = useApi('/email/filters/country');
  const [form, setForm] = useState({ code: '', name: '', action: 'block' });
  const [upload, setUpload] = useState({ code: '', text: '', replace: true });
  const [busy, setBusy] = useState(false);
  const [viewing, setViewing] = useState(null);
  const [lastApply, setLastApply] = useState(null);
  const set = (k) => (v) => setForm((f) => ({ ...f, [k]: v }));
  const done = (res, verb) => { setLastApply(res.apply); toast[res.apply?.applied ? 'success' : 'warning'](applyMessage(res.apply, verb)); refetch(); };

  const add = async () => {
    setBusy(true);
    try { const { data: res } = await api.put(`/email/filters/country/${form.code.trim().toLowerCase()}`, { action: form.action, ...(form.name.trim() ? { name: form.name.trim() } : {}) }); done(res, `${form.code.toUpperCase()} saved`); setUpload((u) => ({ ...u, code: form.code.trim().toLowerCase() })); setForm({ code: '', name: '', action: 'block' }); } catch (err) { toast.error(err); } finally { setBusy(false); }
  };
  const toggle = async (c, patch) => {
    setBusy(true);
    try { const { data: res } = await api.put(`/email/filters/country/${c.code}`, { action: patch.action ?? c.action, enabled: patch.enabled ?? c.enabled, name: c.name || undefined }); done(res, `${c.code.toUpperCase()} updated`); } catch (err) { toast.error(err); } finally { setBusy(false); }
  };
  const remove = async (c) => {
    if (!(await confirm({ title: `Remove the ${c.code.toUpperCase()} filter?`, message: `Deletes ${c.cidrs} network(s) and rewrites the Exim lists.`, confirmLabel: 'Remove', danger: true }))) return;
    setBusy(true);
    try { const { data: res } = await api.delete(`/email/filters/country/${c.code}`); done(res, `${c.code.toUpperCase()} removed`); } catch (err) { toast.error(err); } finally { setBusy(false); }
  };
  const fetchList = async (c) => {
    setBusy(true);
    try { const { data: res } = await api.post(`/email/filters/country/${c.code}/fetch`); done(res, `${res.imported} network(s) downloaded for ${c.code.toUpperCase()}`); } catch (err) { toast.error(err); } finally { setBusy(false); }
  };
  // Pasted/uploaded lists travel in the JSON body (2 MB app limit); bigger
  // country lists go through "Download list" instead.
  const MAX_UPLOAD_BYTES = 1_900_000;
  const uploadBytes = new TextEncoder().encode(upload.text).length;
  const uploadList = async () => {
    if (uploadBytes > MAX_UPLOAD_BYTES) { toast.error(new Error(`This list is ${Math.round(uploadBytes / 1024)} KB; the upload limit is ${Math.round(MAX_UPLOAD_BYTES / 1024)} KB. Use "Download list" for large country lists.`)); return; }
    setBusy(true);
    try { const { data: res } = await api.post(`/email/filters/country/${upload.code}/cidrs`, { text: upload.text, replace: upload.replace }); done(res, `${res.imported} network(s) imported${res.invalidCount ? `, ${res.invalidCount} invalid line(s) skipped` : ''}`); setUpload((u) => ({ ...u, text: '' })); } catch (err) { toast.error(err); } finally { setBusy(false); }
  };
  const onFile = (e) => { const file = e.target.files?.[0]; if (!file) return; file.text().then((text) => setUpload((u) => ({ ...u, text }))); };

  const countries = data?.countries || [];
  return (
    <>
      <PageHeader fn={fn} description="Rejects (or exclusively allows) SMTP connections by the sender's country. Countries map to CIDR lists you upload or download (ipdeny.com by default); the lists become Exim host lists in acl_check_rcpt. Authenticated users are never filtered." />
      <EximNotice status={status} onRetry={refetchStatus} />
      <RequestError error={error} onRetry={refetch} />
      {loading && !data && <Loading />}
      {data && (
        <>
          <Card title="Filtered countries" subtitle={<>Default list source: <code>{data.sourceUrl}</code> (change <code>mail.country_filter.source_url</code> in Tweak Settings)</>} padded={false}
            actions={<><ApplyBadge apply={lastApply || data.lastApply} /><Button size="sm" loading={busy} onClick={async () => { try { const { data: res } = await api.post('/email/filters/apply'); setLastApply(res); toast.success(applyMessage(res, 'Filters re-applied')); refetch(); } catch (err) { toast.error(err); } }}>Apply to Exim</Button></>}>
            <DataTable
              columns={[
                { key: 'code', label: 'Country', render: (c) => <><strong>{c.code.toUpperCase()}</strong>{c.name && <span className="muted"> {c.name}</span>}</> },
                { key: 'action', label: 'Action', render: (c) => <StatusPill status={c.action === 'block' ? 'failed' : 'ok'}>{c.action === 'block' ? 'block' : 'allow only'}</StatusPill> },
                { key: 'enabled', label: 'Enabled', render: (c) => <StatusPill status={c.enabled ? 'enabled' : 'disabled'} /> },
                { key: 'cidrs', label: 'Networks', render: (c) => c.cidrs ? <button className="link-button" onClick={() => setViewing(c.code)}>{c.cidrs}</button> : <span className="text-warn">none — upload or download a list</span> },
                { key: 'source', label: 'Source', render: (c) => c.source ? <code style={{ wordBreak: 'break-all' }}>{c.source}</code> : <span className="muted">—</span> },
                { key: 'updatedAt', label: 'Updated', render: (c) => formatDate(c.updatedAt) },
              ]}
              rows={countries} loading={loading} rowKey={(c) => c.code} dense emptyText="No country filters. Add a country below."
              rowActions={(c) => [
                { label: 'Download list', primary: true, onClick: () => fetchList(c), disabled: busy },
                { label: c.enabled ? 'Disable' : 'Enable', onClick: () => toggle(c, { enabled: !c.enabled }) },
                { label: c.action === 'block' ? 'Switch to allow-only' : 'Switch to block', onClick: () => toggle(c, { action: c.action === 'block' ? 'allow' : 'block' }) },
                { label: 'Remove', danger: true, onClick: () => remove(c) },
              ]}
            />
          </Card>
          <IncludeHint apply={lastApply || data.lastApply} />
          <div className="form-grid">
            <Card title="Add a country">
              <div className="form-grid">
                <Field label="ISO code" help="Two letters, e.g. ru, cn, br"><TextInput value={form.code} onChange={set('code')} placeholder="ru" maxLength={2} /></Field>
                <Field label="Name (optional)"><TextInput value={form.name} onChange={set('name')} placeholder="Russia" /></Field>
                <Field label="Action" help="Block: reject mail from these networks. Allow only: reject everything not in an allowed country"><Select value={form.action} onChange={set('action')} options={[{ value: 'block', label: 'Block' }, { value: 'allow', label: 'Allow only' }]} /></Field>
              </div>
              <FormActions><Button variant="primary" loading={busy} disabled={!/^[a-zA-Z]{2}$/.test(form.code.trim())} onClick={add}>Add country</Button></FormActions>
            </Card>
            <Card title="Upload a CIDR list" subtitle={`One network per line (ipdeny .zone format); # and ; start comments. Up to ${Math.round(MAX_UPLOAD_BYTES / 1024)} KB here; use "Download list" for larger lists.`}>
              <Field label="Country"><Select value={upload.code} onChange={(v) => setUpload((u) => ({ ...u, code: v }))} options={countries.map((c) => ({ value: c.code, label: c.code.toUpperCase() }))} placeholder="Select a country" /></Field>
              <Field label="File" help={upload.text ? `${Math.round(uploadBytes / 1024)} KB loaded${uploadBytes > MAX_UPLOAD_BYTES ? ' — too large to upload' : ''}` : undefined}><input type="file" accept=".zone,.txt,.lst,.csv,text/plain" onChange={onFile} /></Field>
              <Field label="Or paste networks"><Textarea value={upload.text} onChange={(v) => setUpload((u) => ({ ...u, text: v }))} rows={6} mono placeholder={'203.0.113.0/24\n2001:db8::/32'} /></Field>
              <Field label="Mode"><Select value={upload.replace ? 'replace' : 'append'} onChange={(v) => setUpload((u) => ({ ...u, replace: v === 'replace' }))} options={[{ value: 'replace', label: 'Replace the existing list' }, { value: 'append', label: 'Append to the existing list' }]} /></Field>
              <FormActions><Button variant="primary" loading={busy} disabled={!upload.code || !upload.text.trim()} onClick={uploadList}>Import</Button></FormActions>
            </Card>
          </div>
        </>
      )}
      <CidrModal code={viewing} onClose={() => setViewing(null)} />
    </>
  );
}
