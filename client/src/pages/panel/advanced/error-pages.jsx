import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { RefreshCw, FileWarning, Globe } from 'lucide-react';
import { Card, StatusPill, EmptyState } from '../../../components/Common.jsx';
import { DataTable } from '../../../components/DataTable.jsx';
import { Field, Select, TextInput, Textarea, Button } from '../../../components/Form.jsx';
import { Modal, useConfirm } from '../../../components/Modal.jsx';
import { useToast } from '../../../components/Toast.jsx';
import { useT } from '../../../i18n/useT.js';
import { fill, untranslated } from '../../../i18n/fill.js';
import { PanelPage, PanelCapabilityState, FeatureDisabledState } from '../../../panel/PanelPage.jsx';
import { usePanelApi, panelApi } from '../../../panel/hooks/usePanel.js';
import { RequestError, isCapabilityError, isFeatureDisabled } from '../domains/parts/shared.jsx';

const WEB_TYPES = ['main', 'addon', 'sub'];
export const CODE_HELP = {
  400: 'The browser sent a request the server could not understand.',
  401: 'A protected folder was opened without signing in.',
  403: 'The visitor is not allowed to see the page (blocked address, hidden listing).',
  404: 'The address does not exist on your site.',
  500: 'A script on your site failed.',
  503: 'Your site is temporarily unavailable.',
};

// Catalogue key panel.advanced.code_help_<code>.
export const codeHelp = (code, t = untranslated) => (CODE_HELP[code] ? t(`panel.advanced.code_help_${code}`, CODE_HELP[code]) : undefined);

export function pageState(page, t = untranslated) {
  if (!page.exists) return { status: 'unknown', label: t('panel.advanced.state_default', 'Server default') };
  if (page.active && page.managed) return { status: 'ok', label: t('panel.advanced.state_custom', 'Custom page') };
  if (page.active) return { status: 'ok', label: t('panel.advanced.state_own', 'Your own file') };
  return { status: 'pending', label: t('panel.advanced.state_unused', 'File present, not used') };
}

export default function ErrorPages({ fn }) {
  const toast = useToast();
  const confirm = useConfirm();
  const { t } = useT();
  const [params, setParams] = useSearchParams();
  const domains = usePanelApi('/domains');
  const list = (domains.data || []).filter((d) => WEB_TYPES.includes(d.type));
  const [domain, setDomain] = useState(params.get('domain') || '');
  useEffect(() => { if (!domain && list.length) setDomain(list[0].domain); }, [list, domain]);
  useEffect(() => { setParams(domain ? { domain } : {}, { replace: true }); }, [domain, setParams]);
  const pages = usePanelApi(domain ? `/advanced/error-pages?domain=${encodeURIComponent(domain)}` : null);
  const [editing, setEditing] = useState(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(null);
  const capability = isCapabilityError(pages.error) || isCapabilityError(domains.error);

  if (isFeatureDisabled(pages.error) || isFeatureDisabled(domains.error)) return <PanelPage fn={fn}><FeatureDisabledState fn={fn} /></PanelPage>;

  const openEditor = (row) => { setSaveError(null); setEditing({ code: row.code, title: row.title || '', message: row.message || '' }); };

  const save = async () => {
    setSaving(true); setSaveError(null);
    try {
      const { data: res } = await panelApi.put(`/advanced/error-pages/${editing.code}`, { domain, title: editing.title.trim(), message: editing.message });
      toast.success(fill(t('panel.advanced.page_saved', '{code} page saved'), { code: res.code }) + (res.probe?.status ? ` · ${fill(t('panel.advanced.site_answered', 'site answered {status}'), { status: res.probe.status })}` : ''));
      setEditing(null);
      pages.refetch();
    } catch (err) { setSaveError(err); } finally { setSaving(false); }
  };

  const remove = async (row) => {
    const ok = await confirm({ title: fill(t('panel.advanced.use_default_title', 'Use the server\'s default {code} page?'), { code: row.code }), message: fill(t('panel.advanced.use_default_message', 'errors/{code}.html is deleted and the ErrorDocument line removed from .htaccess.'), { code: row.code }), confirmLabel: t('panel.advanced.remove_page', 'Remove page'), danger: true });
    if (!ok) return;
    try { await panelApi.delete(`/advanced/error-pages/${row.code}?${new URLSearchParams({ domain })}`); toast.success(fill(t('panel.advanced.page_removed', '{code} page removed'), { code: row.code })); pages.refetch(); } catch (err) { toast.error(err); }
  };

  const rows = pages.data?.pages || [];
  const typeSuffix = (d) => (d.type !== 'main' ? ` (${d.type === 'sub' ? t('panel.advanced.type_sub', 'subdomain') : t('panel.advanced.type_addon', 'addon')})` : '');

  return (
    <PanelPage fn={fn} actions={<Button icon={RefreshCw} onClick={() => { domains.refetch(); pages.refetch(); }}>{t('common.refresh', 'Refresh')}</Button>}>
      <Card title={t('panel.advanced.domain', 'Domain')} subtitle={t('panel.advanced.domain_subtitle', 'Each site has its own error pages, stored in its errors/ folder.')}>
        <RequestError error={domains.error} onRetry={domains.refetch} />
        <div className="form-grid">
          <Field label={t('panel.advanced.pages_for', 'Error pages for')}>
            <Select value={domain} onChange={setDomain} options={list.map((d) => ({ value: d.domain, label: `${d.domain}${typeSuffix(d)}` }))} placeholder={domains.loading ? t('common.loading', 'Loading…') : list.length ? t('panel.advanced.select_domain', 'Select a domain') : t('panel.advanced.no_domains', 'No domains on this account')} />
          </Field>
          {pages.data && <Field label={t('panel.advanced.folder', 'Folder')}><code className="small">~/{pages.data.docroot}/errors/</code></Field>}
        </div>
      </Card>

      {!domains.loading && domains.data && list.length === 0 && (
        <Card><EmptyState icon={Globe} title={t('panel.advanced.no_web_domains', 'No web domains yet')}><p>{t('panel.advanced.no_web_domains_text', 'Error pages appear here once the account has a domain.')}</p></EmptyState></Card>
      )}

      {domain && (
        <Card title={t('panel.advanced.responses_title', 'Error responses')} padded={false}>
          {capability && <div className="card-body"><PanelCapabilityState error={pages.error} onRetry={pages.refetch} /></div>}
          {!capability && pages.error && <div className="card-body"><RequestError error={pages.error} onRetry={pages.refetch} /></div>}
          {/* A failed read shows the banner alone; the table would otherwise sit under it saying "Loading…" forever. */}
          {!pages.error && <DataTable
            dense
            columns={[
              { key: 'code', label: t('panel.advanced.col_code', 'Code'), width: 90, render: (r) => <code>{r.code}</code> },
              { key: 'label', label: t('panel.advanced.col_response', 'Response'), render: (r) => <><strong>{r.label}</strong><div className="muted small">{codeHelp(r.code, t)}</div></> },
              { key: 'state', label: t('panel.advanced.col_page', 'Page'), render: (r) => { const s = pageState(r, t); return <StatusPill status={s.status}>{s.label}</StatusPill>; } },
              { key: 'title', label: t('panel.advanced.col_title', 'Title'), render: (r) => (r.managed && r.title ? r.title : <span className="muted">—</span>) },
            ]}
            rows={rows} loading={pages.loading} error={null} rowKey={(r) => r.code}
            rowActions={(r) => [
              { label: r.exists ? t('common.edit', 'Edit') : t('panel.advanced.create', 'Create'), primary: true, onClick: () => openEditor(r) },
              ...(r.exists || r.active ? [{ label: t('panel.advanced.use_default', 'Use default'), danger: true, onClick: () => remove(r) }] : []),
            ]}
            emptyText={t('panel.advanced.loading_pages', 'Loading the error pages of this domain…')}
          />}
        </Card>
      )}
      <p className="muted small"><FileWarning size={12} /> {t('panel.advanced.note_before', 'Pages are plain HTML with your text only (no scripts); a page you wrote yourself in')} <code>errors/</code> {t('panel.advanced.note_after', 'is kept as it is and only switched on.')}</p>

      <Modal open={Boolean(editing)} title={editing ? `${editing.code} · ${rows.find((r) => r.code === editing.code)?.label || t('panel.advanced.error_page', 'Error page')}` : ''} onClose={saving ? undefined : () => setEditing(null)}
        footer={editing && (
          <>
            <Button onClick={() => setEditing(null)} disabled={saving}>{t('common.cancel', 'Cancel')}</Button>
            <Button variant="primary" onClick={save} loading={saving}>{t('panel.advanced.save_page', 'Save page')}</Button>
          </>
        )}>
        {editing && (
          <>
            <RequestError error={saveError} />
            <Field label={t('panel.advanced.heading', 'Heading')} help={t('panel.advanced.heading_help', 'Leave empty for the standard wording.')} error={saveError?.fields?.title} htmlFor="ep-title">
              <TextInput id="ep-title" value={editing.title} onChange={(v) => setEditing({ ...editing, title: v })} maxLength={120} placeholder={rows.find((r) => r.code === editing.code)?.label} />
            </Field>
            <Field label={t('panel.advanced.message', 'Message')} help={t('panel.advanced.message_help', 'Plain text; a blank line starts a new paragraph.')} error={saveError?.fields?.message} htmlFor="ep-message">
              <Textarea id="ep-message" rows={6} value={editing.message} onChange={(v) => setEditing({ ...editing, message: v })} maxLength={4000} placeholder={codeHelp(editing.code, t)} />
            </Field>
          </>
        )}
      </Modal>
    </PanelPage>
  );
}
