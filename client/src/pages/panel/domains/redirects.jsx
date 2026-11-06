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
import { useT } from '../../../i18n/useT.js';
import { fill } from '../../../i18n/fill.js';
import { useDomains, useFeatureGate, isFeatureDisabled, RequestError } from './parts/shared.jsx';

export function RedirectStatus({ redirect }) {
  const { t } = useT();
  if (!redirect) return <span className="muted">—</span>;
  const label = { applied: t('panel.domains.redirect_active', 'Active'), pending: t('panel.domains.redirect_pending', 'Pending'), failed: t('panel.domains.redirect_failed', 'Failed') }[redirect.status] || redirect.status;
  return <span title={redirect.lastError || ''}><StatusPill status={redirect.status === 'applied' ? 'ok' : redirect.status}>{label}</StatusPill></span>;
}

export function RedirectForm({ open, domains, domain, initial, onClose, onSaved }) {
  const { t } = useT();
  const [form, setForm] = useState({ domain: initial?.domain || domain || domains[0] || '', targetUrl: initial?.targetUrl || '', type: initial?.type || 'permanent', matchWww: initial?.matchWww ?? true, keepPath: initial?.keepPath ?? true });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const set = (k) => (v) => setForm((f) => ({ ...f, [k]: v }));
  const types = [{ value: 'permanent', label: t('panel.domains.type_permanent_long', 'Permanent (301) — search engines move to the new address') }, { value: 'temporary', label: t('panel.domains.type_temporary_long', 'Temporary (302) — the old address stays the canonical one') }];
  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await panelApi.put(`/domains/${encodeURIComponent(form.domain)}/redirect`, { targetUrl: form.targetUrl.trim(), type: form.type, matchWww: form.matchWww, keepPath: form.keepPath });
      onSaved(res.data);
    } catch (err) { setError(err); } finally { setBusy(false); }
  };
  const shownDomain = form.domain || t('panel.domains.placeholder_domain', 'domain');
  return (
    <Modal open={open} title={initial ? fill(t('panel.domains.edit_redirect_title', 'Edit the redirect of {domain}'), { domain: initial.domain }) : t('panel.domains.add_redirect_title', 'Add a redirect')} onClose={busy ? undefined : onClose}
      footer={<><Button onClick={onClose} disabled={busy}>{t('panel.domains.cancel', 'Cancel')}</Button><Button type="submit" form="redirect-form" variant="primary" loading={busy}>{initial ? t('panel.domains.save_redirect', 'Save redirect') : t('panel.domains.add_redirect', 'Add redirect')}</Button></>}>
      <form id="redirect-form" onSubmit={submit}>
        <RequestError error={error} />
        <Field label={t('panel.domains.col_domain', 'Domain')} required error={error?.fields?.domain}>
          <Select value={form.domain} onChange={set('domain')} options={initial ? [initial.domain] : domains} disabled={Boolean(initial)} />
        </Field>
        <Field label={t('panel.domains.redirects_to', 'Redirects to')} required help={t('panel.domains.target_help', 'An absolute address starting with http:// or https://')} error={error?.fields?.targetUrl}>
          <TextInput value={form.targetUrl} onChange={set('targetUrl')} placeholder="https://www.example.org/" autoFocus spellCheck={false} />
        </Field>
        <Field label={t('panel.domains.col_type', 'Type')} error={error?.fields?.type}>
          <Select value={form.type} onChange={set('type')} options={types} />
        </Field>
        <div style={{ display: 'grid', gap: 10 }}>
          <Toggle checked={form.matchWww} onChange={set('matchWww')} label={fill(t('panel.domains.also_www', 'Also redirect www.{domain}'), { domain: shownDomain })} />
          <Toggle checked={form.keepPath} onChange={set('keepPath')} label={t('panel.domains.keep_path', 'Keep the requested path')} description={`${shownDomain}/page → ${(form.targetUrl || t('panel.domains.placeholder_target', 'target')).replace(/\/$/, '')}/page`} />
        </div>
      </form>
    </Modal>
  );
}

// With a single domain the header's "Add redirect" is the one call to action, so
// the row does not repeat it; with several, each row offers its own.
export function RedirectsTable({ rows, loading, error, onEdit, onRemove, emptyText }) {
  const { t } = useT();
  const single = rows.length === 1;
  const columns = [
    { key: 'domain', label: t('panel.domains.col_domain', 'Domain'), render: (r) => <strong>{r.domain}</strong> },
    { key: 'targetUrl', label: t('panel.domains.redirects_to', 'Redirects to'), render: (r) => (r.redirect ? <a href={r.redirect.targetUrl} target="_blank" rel="noopener noreferrer">{r.redirect.targetUrl}</a> : <span className="muted">{t('panel.domains.no_redirect', 'No redirect')}</span>) },
    { key: 'type', label: t('panel.domains.col_type', 'Type'), render: (r) => (r.redirect ? (r.redirect.type === 'temporary' ? t('panel.domains.type_temporary', 'Temporary (302)') : t('panel.domains.type_permanent', 'Permanent (301)')) : <span className="muted">—</span>) },
    { key: 'options', label: t('panel.domains.col_options', 'Options'), render: (r) => (r.redirect ? [r.redirect.matchWww && 'www', r.redirect.keepPath && t('panel.domains.keeps_path', 'keeps path')].filter(Boolean).join(' · ') || <span className="muted">—</span> : <span className="muted">—</span>) },
    { key: 'status', label: t('panel.domains.col_status', 'Status'), render: (r) => <RedirectStatus redirect={r.redirect} /> },
    { key: 'updatedAt', label: t('panel.domains.col_updated', 'Updated'), render: (r) => (r.redirect ? formatDate(r.redirect.updatedAt) : <span className="muted">—</span>) },
  ];
  return (
    <DataTable columns={columns} rows={rows} loading={loading} error={error} emptyText={emptyText} rowKey={(r) => r.domain} collapseRow={(r) => (r.redirect ? null : t('panel.domains.no_redirect_yet', 'No redirect yet'))}
      rowActions={(r) => (r.redirect
        ? [{ label: t('panel.domains.edit', 'Edit'), primary: true, onClick: () => onEdit(r) }, { label: t('panel.domains.remove', 'Remove'), primary: true, danger: true, onClick: () => onRemove(r) }]
        : single ? [] : [{ label: t('panel.domains.add_redirect', 'Add redirect'), primary: true, onClick: () => onEdit(r) }])} />
  );
}

export default function Redirects({ fn }) {
  const { t } = useT();
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
  // The ?domain= deep link opens the form only once that domain's redirect has
  // been fetched, so an existing redirect lands in edit mode with its target.
  useEffect(() => {
    const wanted = params.get('domain');
    if (!wanted || editing) return;
    if (!domainsLoading && names.length && !names.includes(wanted)) { setParams({}, { replace: true }); return; }
    if (!Object.hasOwn(redirects.byDomain, wanted)) return;
    setEditing({ domain: wanted, ...(redirects.byDomain[wanted] || {}) });
    setParams({}, { replace: true });
  }, [params, names, domainsLoading, redirects.byDomain, editing, setParams]);

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
    if (r?.status === 'applied') toast.success(fill(t('panel.domains.now_redirects', '{domain} now redirects to {target}'), { domain: data.domain, target: r.targetUrl }));
    else if (r?.status === 'failed') toast.error(fill(t('panel.domains.redirect_rejected', 'The redirect was saved but the web server rejected it: {error}'), { error: r.lastError || t('panel.domains.unknown_error', 'unknown error') }));
    else toast.info(t('panel.domains.redirect_saved_pending', 'Redirect saved; it takes effect once the web server on this host applies it'));
  };
  const remove = async (r) => {
    if (!(await confirm({ title: fill(t('panel.domains.remove_redirect_title', 'Remove the redirect of {domain}?'), { domain: r.domain }), message: fill(t('panel.domains.remove_redirect_help', '{domain} stops sending visitors to {target} and serves its own files again.'), { domain: r.domain, target: r.redirect.targetUrl }), confirmLabel: t('panel.domains.remove', 'Remove'), danger: true }))) return;
    try {
      await panelApi.delete(`/domains/${encodeURIComponent(r.domain)}/redirect`);
      setRedirects((s) => ({ ...s, byDomain: { ...s.byDomain, [r.domain]: null } }));
      toast.success(fill(t('panel.domains.redirect_removed', 'Redirect of {domain} removed'), { domain: r.domain }));
    } catch (err) { toast.error(err); }
  };

  return (
    <PanelPage fn={fn} actions={<Button variant="primary" icon={Plus} onClick={() => setEditing({ domain: free[0] })} disabled={!free.length}>{t('panel.domains.add_redirect', 'Add redirect')}</Button>}>
      {!redirects.webSupported && (
        <div className="banner banner-info"><Info size={18} /><div><strong>{t('panel.domains.redirects_not_applied', 'Redirects are saved but not yet applied')}</strong><p>{t('panel.domains.redirects_not_applied_help', 'The web server on this host cannot apply them yet; they take effect as soon as it can.')}</p></div></div>
      )}
      <Card title={t('panel.domains.redirects', 'Redirects')} subtitle={fill(t('panel.domains.redirects_count', '{count} of {total} domains redirect somewhere else'), { count: withRedirect, total: names.length })} padded={false}
        actions={names.length > 1 && <Toggle checked={onlyRedirected} onChange={setOnlyRedirected} label={t('panel.domains.only_redirected', 'Only domains with a redirect')} />}>
        <PanelCapabilityState error={error} onRetry={() => { refetchDomains(); load(names); }} />
        <RedirectsTable rows={rows} loading={domainsLoading || redirects.loading} error={error && error.status !== 501 ? error : null}
          emptyText={onlyRedirected ? t('panel.domains.redirects_empty_filter', 'No domain redirects anywhere yet. Choose a domain and add a redirect to send its visitors to another address.') : t('panel.domains.redirects_empty', 'Your domains appear here once the account is provisioned')}
          onEdit={(r) => setEditing({ domain: r.domain, ...(r.redirect || {}) })} onRemove={remove} />
      </Card>
      {editing && <RedirectForm open domains={[...new Set([editing.domain, ...(free.length ? free : names)].filter(Boolean))]} domain={editing.domain} initial={editing.targetUrl ? editing : null} onClose={() => setEditing(null)} onSaved={onSaved} />}
    </PanelPage>
  );
}
