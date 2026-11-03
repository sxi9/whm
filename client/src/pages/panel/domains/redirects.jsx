import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Plus, Info } from 'lucide-react';
import { Card, StatusPill, formatDate } from '../../../components/Common.jsx';
import { DataTable } from '../../../components/DataTable.jsx';
import { Field, TextInput, Select, Toggle, Button } from '../../../components/Form.jsx';
import { Modal, useConfirm } from '../../../components/Modal.jsx';
import { useToast } from '../../../components/Toast.jsx';
import { PanelPage, PanelCapabilityState, FeatureDisabledState } from '../../../panel/PanelPage.jsx';
import { panelApi } from '../../../panel/hooks/usePanel.js';
import { useDomains, useFeatureGate, isFeatureDisabled, RequestError } from './parts/shared.jsx';

const TYPES = [{ value: 'permanent', label: 'Permanent (301) — search engines move to the new address' }, { value: 'temporary', label: 'Temporary (302) — the old address stays the canonical one' }];

export function RedirectStatus({ redirect }) {
  if (!redirect) return <span className="muted">—</span>;
  const label = { applied: 'Active', pending: 'Pending', failed: 'Failed' }[redirect.status] || redirect.status;
  return <span title={redirect.lastError || ''}><StatusPill status={redirect.status === 'applied' ? 'ok' : redirect.status}>{label}</StatusPill></span>;
}

export function RedirectForm({ open, domains, domain, initial, onClose, onSaved }) {
  const [form, setForm] = useState({ domain: initial?.domain || domain || domains[0] || '', targetUrl: initial?.targetUrl || '', type: initial?.type || 'permanent', matchWww: initial?.matchWww ?? true, keepPath: initial?.keepPath ?? true });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const set = (k) => (v) => setForm((f) => ({ ...f, [k]: v }));
  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await panelApi.put(`/domains/${encodeURIComponent(form.domain)}/redirect`, { targetUrl: form.targetUrl.trim(), type: form.type, matchWww: form.matchWww, keepPath: form.keepPath });
      onSaved(res.data);
    } catch (err) { setError(err); } finally { setBusy(false); }
  };
  return (
    <Modal open={open} title={initial ? `Edit the redirect of ${initial.domain}` : 'Add a redirect'} onClose={busy ? undefined : onClose}
      footer={<><Button onClick={onClose} disabled={busy}>Cancel</Button><Button type="submit" form="redirect-form" variant="primary" loading={busy}>{initial ? 'Save redirect' : 'Add redirect'}</Button></>}>
      <form id="redirect-form" onSubmit={submit}>
        <RequestError error={error} />
        <Field label="Domain" required error={error?.fields?.domain}>
          <Select value={form.domain} onChange={set('domain')} options={initial ? [initial.domain] : domains} disabled={Boolean(initial)} />
        </Field>
        <Field label="Redirects to" required help="An absolute address starting with http:// or https://" error={error?.fields?.targetUrl}>
          <TextInput value={form.targetUrl} onChange={set('targetUrl')} placeholder="https://www.example.org/" autoFocus spellCheck={false} />
        </Field>
        <Field label="Type" error={error?.fields?.type}>
          <Select value={form.type} onChange={set('type')} options={TYPES} />
        </Field>
        <div style={{ display: 'grid', gap: 10 }}>
          <Toggle checked={form.matchWww} onChange={set('matchWww')} label={`Also redirect www.${form.domain || 'domain'}`} />
          <Toggle checked={form.keepPath} onChange={set('keepPath')} label="Keep the requested path" description={`${form.domain || 'domain'}/page → ${(form.targetUrl || 'target').replace(/\/$/, '')}/page`} />
        </div>
      </form>
    </Modal>
  );
}

export function RedirectsTable({ rows, loading, error, onEdit, onRemove, emptyText }) {
  const columns = [
    { key: 'domain', label: 'Domain', render: (r) => <strong>{r.domain}</strong> },
    { key: 'targetUrl', label: 'Redirects to', render: (r) => (r.redirect ? <a href={r.redirect.targetUrl} target="_blank" rel="noopener noreferrer">{r.redirect.targetUrl}</a> : <span className="muted">No redirect</span>) },
    { key: 'type', label: 'Type', render: (r) => (r.redirect ? (r.redirect.type === 'temporary' ? 'Temporary (302)' : 'Permanent (301)') : <span className="muted">—</span>) },
    { key: 'options', label: 'Options', render: (r) => (r.redirect ? [r.redirect.matchWww && 'www', r.redirect.keepPath && 'keeps path'].filter(Boolean).join(' · ') || <span className="muted">—</span> : <span className="muted">—</span>) },
    { key: 'status', label: 'Status', render: (r) => <RedirectStatus redirect={r.redirect} /> },
    { key: 'updatedAt', label: 'Updated', render: (r) => (r.redirect ? formatDate(r.redirect.updatedAt) : <span className="muted">—</span>) },
  ];
  return (
    <DataTable columns={columns} rows={rows} loading={loading} error={error} emptyText={emptyText} rowKey={(r) => r.domain}
      rowActions={(r) => (r.redirect
        ? [{ label: 'Edit', primary: true, onClick: () => onEdit(r) }, { label: 'Remove', primary: true, danger: true, onClick: () => onRemove(r) }]
        : [{ label: 'Add redirect', primary: true, onClick: () => onEdit(r) }])} />
  );
}

export default function Redirects({ fn }) {
  const toast = useToast();
  const confirm = useConfirm();
  const [params, setParams] = useSearchParams();
  const { rows: domains, error: domainsError, loading: domainsLoading, refetch: refetchDomains } = useDomains();
  const [redirects, setRedirects] = useState({ byDomain: {}, loading: false, error: null, webSupported: true });
  const [editing, setEditing] = useState(null);
  const [onlyRedirected, setOnlyRedirected] = useState(false);

  const load = useCallback(async (names) => {
    if (!names.length) return;
    setRedirects((s) => ({ ...s, loading: true, error: null }));
    try {
      const results = await Promise.all(names.map((d) => panelApi.get(`/domains/${encodeURIComponent(d)}/redirect`).then((r) => r.data)));
      setRedirects({ byDomain: Object.fromEntries(results.map((r) => [r.domain, r.redirect])), loading: false, error: null, webSupported: results.every((r) => r.webSupported !== false) });
    } catch (error) { setRedirects((s) => ({ ...s, loading: false, error })); }
  }, []);
  const names = useMemo(() => domains.map((d) => d.domain), [domains]);
  useEffect(() => { load(names); }, [names, load]);
  useEffect(() => {
    const wanted = params.get('domain');
    if (wanted && names.includes(wanted) && !editing) { setEditing({ domain: wanted, ...(redirects.byDomain[wanted] || {}) }); setParams({}, { replace: true }); }
  }, [params, names, redirects.byDomain, editing, setParams]);

  const disabled = useFeatureGate(fn, domainsError, redirects.error);
  if (disabled) return <PanelPage fn={fn}><FeatureDisabledState fn={fn} /></PanelPage>;

  const rows = names.map((domain) => ({ domain, redirect: redirects.byDomain[domain] || null })).filter((r) => !onlyRedirected || r.redirect);
  const withRedirect = rows.filter((r) => r.redirect).length;
  const free = names.filter((d) => !redirects.byDomain[d]);
  const error = domainsError || (isFeatureDisabled(redirects.error) ? null : redirects.error);

  const onSaved = (data) => {
    setEditing(null);
    setRedirects((s) => ({ ...s, byDomain: { ...s.byDomain, [data.domain]: data.redirect } }));
    const r = data.redirect;
    if (r?.status === 'applied') toast.success(`${data.domain} now redirects to ${r.targetUrl}`);
    else if (r?.status === 'failed') toast.error(`The redirect was saved but the web server rejected it: ${r.lastError || 'unknown error'}`);
    else toast.info(`Redirect saved; it takes effect once the web server on this host applies it`);
  };
  const remove = async (r) => {
    if (!(await confirm({ title: `Remove the redirect of ${r.domain}?`, message: `${r.domain} stops sending visitors to ${r.redirect.targetUrl} and serves its own files again.`, confirmLabel: 'Remove', danger: true }))) return;
    try {
      await panelApi.delete(`/domains/${encodeURIComponent(r.domain)}/redirect`);
      setRedirects((s) => ({ ...s, byDomain: { ...s.byDomain, [r.domain]: null } }));
      toast.success(`Redirect of ${r.domain} removed`);
    } catch (err) { toast.error(err); }
  };

  return (
    <PanelPage fn={fn} actions={<Button variant="primary" icon={Plus} onClick={() => setEditing({ domain: free[0] })} disabled={!free.length}>Add redirect</Button>}>
      {!redirects.webSupported && (
        <div className="banner banner-info"><Info size={18} /><div><strong>Redirects are saved but not yet applied</strong><p>The web server on this host cannot apply them yet; they take effect as soon as it can.</p></div></div>
      )}
      <Card title="Redirects" subtitle={`${withRedirect} of ${names.length} domains redirect somewhere else`} padded={false}
        actions={<Toggle checked={onlyRedirected} onChange={setOnlyRedirected} label="Only domains with a redirect" />}>
        <PanelCapabilityState error={error} onRetry={() => { refetchDomains(); load(names); }} />
        <RedirectsTable rows={rows} loading={domainsLoading || redirects.loading} error={error && error.status !== 501 ? error : null}
          emptyText={onlyRedirected ? 'No domain redirects anywhere yet. Choose a domain and add a redirect to send its visitors to another address.' : 'Your domains appear here once the account is provisioned'}
          onEdit={(r) => setEditing({ domain: r.domain, ...(r.redirect || {}) })} onRemove={remove} />
      </Card>
      {editing && <RedirectForm open domains={free.length ? free : names} domain={editing.domain} initial={editing.targetUrl ? editing : null} onClose={() => setEditing(null)} onSaved={onSaved} />}
    </PanelPage>
  );
}
