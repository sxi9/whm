import { useMemo, useState } from 'react';
import { RefreshCw, Download, ExternalLink, Copy } from 'lucide-react';
import { Card, StatusPill, KeyValue } from '../../../components/Common.jsx';
import { DataTable } from '../../../components/DataTable.jsx';
import { Field, TextInput, Select, PasswordInput, Toggle, Button, FormActions } from '../../../components/Form.jsx';
import { Modal, useConfirm } from '../../../components/Modal.jsx';
import { ProgressLog } from '../../../components/ProgressLog.jsx';
import { useToast } from '../../../components/Toast.jsx';
import { useT } from '../../../i18n/useT.js';
import { fill, untranslated } from '../../../i18n/fill.js';
import { PanelPage, PanelCapabilityState, FeatureDisabledState } from '../../../panel/PanelPage.jsx';
import { usePanelApi, usePanelMe, panelApi } from '../../../panel/hooks/usePanel.js';
import { RequestError, InfoNote, isCapabilityError, isFeatureDisabled } from '../databases/parts/shared.jsx';

// The account follows its own install/update jobs here (/api/system/jobs is reseller-only).
export const jobStreamPath = (id) => `/panel/software/wordpress/jobs/${id}/stream`;

const PATH_RE = /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/;

// A quick client-side shape check; the server pins the folder for real.
export function pathProblem(input, t = untranslated) {
  const s = String(input || '').trim().replace(/^\/+|\/+$/g, '');
  if (!s) return null;
  if (!PATH_RE.test(s)) return t('panel.software.path_chars', 'Use letters, digits, ".", "_" and "-", with "/" between folders');
  if (s.split('/').some((p) => p === '..' || p === '.')) return t('panel.software.path_dots', 'The folder cannot contain ".." or "."');
  if (s.length > 200) return t('panel.software.path_length', 'At most 200 characters');
  return null;
}

export function siteLabel(row) {
  return row.under ? `${row.domain}/${row.under}` : row.domain;
}

// What the host can do, from the list's meta: install at all, and update
// (WP-CLI only; without it the dashboard's own updater is the way).
export function hostState(meta) {
  const r = meta?.requirements || {};
  return { canInstall: Boolean(meta?.canInstall), canUpdate: Boolean(r.wpcli), hint: meta?.hint || null, method: r.wpcli ? 'wpcli' : 'web' };
}

const emptyForm = (me) => ({ domain: me?.account?.domain || '', path: '', title: '', adminUser: '', adminEmail: me?.account?.contactEmail || '', adminPassword: '', generate: true });

export default function WordPress({ fn }) {
  const toast = useToast();
  const confirm = useConfirm();
  const { t } = useT();
  const { me } = usePanelMe();
  const { data, meta, loading, error, refetch } = usePanelApi('/software/wordpress');
  const [form, setForm] = useState(() => emptyForm(me));
  const [formError, setFormError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [job, setJob] = useState(null);
  const [removing, setRemoving] = useState(null);
  const host = hostState(meta);
  const sites = meta?.sites || (me?.account?.domains || []).filter((d) => ['main', 'addon', 'sub'].includes(d.type)).map((d) => ({ domain: d.domain, type: d.type }));
  const mainSuffix = t('panel.software.domain_main', '(main domain)');
  const subSuffix = t('panel.software.domain_sub', '(subdomain)');
  const domainOptions = useMemo(() => {
    const list = sites.map((s) => ({ value: s.domain, label: `${s.domain}${s.type === 'main' ? ` ${mainSuffix}` : s.type === 'sub' ? ` ${subSuffix}` : ''}` }));
    if (me?.account?.domain && !list.some((o) => o.value === me.account.domain)) list.unshift({ value: me.account.domain, label: `${me.account.domain} ${mainSuffix}` });
    return list;
  }, [sites, me, mainSuffix, subSuffix]);
  const capability = isCapabilityError(error);
  const problem = pathProblem(form.path, t);
  const set = (k) => (v) => setForm((f) => ({ ...f, [k]: v }));

  if (isFeatureDisabled(error)) return <PanelPage fn={fn}><FeatureDisabledState fn={fn} /></PanelPage>;

  const install = async (e) => {
    e.preventDefault();
    if (problem) { setFormError({ message: t('panel.software.check_folder', 'Check the folder'), fields: { path: [problem] } }); return; }
    setBusy(true); setFormError(null);
    try {
      const body = { domain: form.domain || me?.account?.domain, path: form.path.trim().replace(/^\/+|\/+$/g, ''), title: form.title.trim(), adminUser: form.adminUser.trim(), adminEmail: form.adminEmail.trim() };
      if (!form.generate && form.adminPassword) body.adminPassword = form.adminPassword;
      const { data: res } = await panelApi.post('/software/wordpress', body);
      setJob({ id: res.job.id, kind: 'install', label: res.path || res.domain, url: res.url, adminUrl: res.adminUrl, adminUser: res.adminUser, adminPassword: res.adminPassword || null, database: res.database, method: res.method });
      setForm(emptyForm(me));
    } catch (err) { setFormError(err); } finally { setBusy(false); }
  };

  const update = async (row) => {
    const ok = await confirm({ title: fill(t('panel.software.update_title', 'Update {site}?'), { site: siteLabel(row) }), message: t('panel.software.update_message', 'WordPress core is updated to the latest release with WP-CLI (plugins and themes are left alone). Back up first if the site matters; the site is briefly in maintenance mode.'), confirmLabel: t('panel.software.update', 'Update') });
    if (!ok) return;
    try {
      const { data: res } = await panelApi.post(`/software/wordpress/${encodeURIComponent(row.id)}/update`, {});
      setJob({ id: res.job.id, kind: 'update', label: siteLabel(row), url: row.url });
    } catch (err) { toast.error(err); }
  };

  const remove = async () => {
    const row = removing?.row;
    if (!row) return;
    setBusy(true);
    try {
      const { data: res } = await panelApi.delete(`/software/wordpress/${encodeURIComponent(row.id)}?confirm=true&database=${removing.database ? 'true' : 'false'}`);
      toast.success(fill(t('panel.software.removed', '{site} removed'), { site: siteLabel(row) }) + (res.database ? ` ${fill(t('panel.software.removed_with_db', 'together with database {database}'), { database: res.database })}` : ''));
      setRemoving(null);
      refetch();
    } catch (err) { toast.error(err); } finally { setBusy(false); }
  };

  const onJobFinished = (event) => {
    if (event.type === 'done') {
      toast.success(job?.kind === 'update' ? fill(t('panel.software.updated', '{site} updated'), { site: job.label }) : fill(t('panel.software.ready_at', 'WordPress is ready at {url}'), { url: event.result?.url || job?.url }));
      setJob((j) => (j ? { ...j, result: event.result } : j));
      refetch();
    } else if (event.type === 'failed') toast.error(event.error || t('panel.software.job_failed', 'The job failed'));
  };

  const copy = async (text) => { try { await navigator.clipboard.writeText(text); toast.success(t('panel.software.copied', 'Copied')); } catch { toast.error(t('panel.software.copy_failed', 'Could not copy; select the text instead')); } };

  const installDisabled = busy || !host.canInstall || !form.title.trim() || !form.adminUser.trim() || !form.adminEmail.trim() || (!form.generate && !form.adminPassword);

  return (
    <PanelPage fn={fn} actions={<Button icon={RefreshCw} onClick={() => refetch()}>{t('common.refresh', 'Refresh')}</Button>}>
      {capability && <PanelCapabilityState card error={error} onRetry={refetch} />}

      <form onSubmit={install}>
        <Card title={t('panel.software.install_title', 'Install WordPress')} subtitle={t('panel.software.install_subtitle', 'A fresh copy of the current release, with its own database, on one of your domains.')}>
          <RequestError error={formError} />
          {!capability && meta && !host.canInstall && <InfoNote>{t('panel.software.cannot_install', 'WordPress cannot be installed on this server yet.')} {host.hint || t('panel.software.ask_provider', 'Ask your hosting provider.')}</InfoNote>}
          <div className="form-grid">
            <Field label={t('panel.software.domain', 'Domain')} required htmlFor="wp-domain" error={formError?.fields?.domain}>
              <Select id="wp-domain" value={form.domain} onChange={set('domain')} options={domainOptions} disabled={!host.canInstall} />
            </Field>
            <Field label={t('panel.software.folder', 'Folder')} htmlFor="wp-path" help={t('panel.software.folder_help', 'Leave empty to install at the domain itself, or give a folder such as blog')} error={formError?.fields?.path || (problem ? [problem] : undefined)}>
              <TextInput id="wp-path" value={form.path} onChange={set('path')} placeholder="blog" maxLength={200} disabled={!host.canInstall} autoCapitalize="none" spellCheck={false} />
            </Field>
            <Field label={t('panel.software.site_title', 'Site title')} required htmlFor="wp-title" error={formError?.fields?.title}>
              <TextInput id="wp-title" value={form.title} onChange={set('title')} placeholder={t('panel.software.site_title_placeholder', 'My site')} maxLength={120} disabled={!host.canInstall} />
            </Field>
            <Field label={t('panel.software.admin_user', 'Administrator user name')} required htmlFor="wp-admin-user" help={t('panel.software.admin_user_help', 'Not "admin": it is the first name every attacker tries')} error={formError?.fields?.adminUser}>
              <TextInput id="wp-admin-user" value={form.adminUser} onChange={set('adminUser')} placeholder="editor" maxLength={60} disabled={!host.canInstall} autoCapitalize="none" spellCheck={false} />
            </Field>
            <Field label={t('panel.software.admin_email', 'Administrator e-mail')} required htmlFor="wp-admin-email" error={formError?.fields?.adminEmail}>
              <TextInput id="wp-admin-email" type="email" value={form.adminEmail} onChange={set('adminEmail')} placeholder="you@example.com" maxLength={254} disabled={!host.canInstall} />
            </Field>
            <Field label={t('panel.software.admin_password', 'Administrator password')} htmlFor="wp-admin-password" error={formError?.fields?.adminPassword}>
              <Toggle checked={form.generate} onChange={set('generate')} label={t('panel.software.generate_password', 'Generate one for me')} description={t('panel.software.generate_password_help', 'Shown once when the install starts')} disabled={!host.canInstall} />
              {!form.generate && <PasswordInput id="wp-admin-password" value={form.adminPassword} onChange={set('adminPassword')} minLength={8} maxLength={128} disabled={!host.canInstall} />}
            </Field>
          </div>
          <FormActions>
            <Button type="submit" variant="primary" icon={Download} loading={busy} disabled={installDisabled}>{t('panel.software.install_title', 'Install WordPress')}</Button>
            <span className="muted small">{host.method === 'wpcli' ? t('panel.software.method_wpcli', 'Installed with WP-CLI.') : t('panel.software.method_web', 'Downloaded from wordpress.org, checked against its published checksum and set up through the WordPress installer.')} {t('panel.software.db_created', 'The database is created for you.')}</span>
          </FormActions>
        </Card>
      </form>

      <Card title={t('panel.software.sites_title', 'Your WordPress sites')} subtitle={data?.length ? fill(t('panel.software.sites_count', '{count} found under your document roots'), { count: data.length }) : undefined} padded={false}>
        {!capability && meta && !host.canUpdate && Boolean(data?.length) && <div className="card-body"><InfoNote>{t('panel.software.updates_need_wpcli', 'Updates from here need WP-CLI on the server; until your provider installs it, update from each site\'s dashboard')} (<em>{t('panel.software.dashboard_updates', 'Dashboard › Updates')}</em>).</InfoNote></div>}
        <DataTable
          columns={[
            { key: 'site', label: t('panel.software.col_site', 'Site'), render: (r) => <><a href={r.url} target="_blank" rel="noreferrer">{siteLabel(r)}</a><div className="muted small"><code>{r.path}</code></div></> },
            { key: 'version', label: t('panel.software.col_version', 'Version'), render: (r) => (r.version ? <code>{r.version}</code> : <span className="muted">{t('panel.software.version_unknown', 'unknown')}</span>) },
            { key: 'database', label: t('panel.software.col_database', 'Database'), render: (r) => (r.database ? <><code>{r.database}</code>{!r.databaseOwned && <div className="muted small">{t('panel.software.db_not_owned', 'not one of this account\'s databases')}</div>}</> : <span className="muted">—</span>) },
            { key: 'state', label: t('panel.software.col_state', 'State'), render: (r) => <StatusPill status={r.version ? 'ok' : 'unknown'}>{r.version ? t('panel.software.state_installed', 'installed') : t('panel.software.state_incomplete', 'incomplete')}</StatusPill> },
          ]}
          rows={data || []} loading={loading} error={capability ? null : error} rowKey={(r) => r.id}
          rowActions={(r) => [
            { label: t('panel.software.open_admin', 'Open admin'), primary: true, onClick: () => window.open(r.adminUrl, '_blank', 'noopener') },
            { label: host.canUpdate ? t('panel.software.update', 'Update') : t('panel.software.update_needs_wpcli', 'Update (needs WP-CLI)'), disabled: !host.canUpdate, onClick: () => update(r) },
            { label: t('panel.software.remove', 'Remove'), danger: true, onClick: () => setRemoving({ row: r, database: false }) },
          ]}
          emptyText={capability ? t('panel.software.sites_empty_capability', 'Your WordPress sites appear here once the server is ready.') : t('panel.software.sites_empty', 'No WordPress installation found. Install one above, or upload your own: anything with a wp-config.php under your document roots is listed here.')}
        />
      </Card>

      <Modal open={Boolean(job)} title={job?.kind === 'update' ? fill(t('panel.software.updating', 'Updating {site}'), { site: job.label }) : fill(t('panel.software.installing_at', 'Installing WordPress at {site}'), { site: job?.label || '' })} onClose={() => setJob(null)} size="lg" footer={<button className="btn btn-primary" onClick={() => setJob(null)}>{t('common.close', 'Close')}</button>}>
        {job?.kind === 'install' && (
          <>
            {job.adminPassword && (
              <div className="banner banner-warning">
                <div>
                  <strong>{t('panel.software.write_down_password', 'Write down the administrator password now; it is not shown again.')}</strong>
                  <KeyValue items={[
                    { label: t('panel.software.user_name', 'User name'), value: <code>{job.adminUser}</code> },
                    { label: t('panel.software.password', 'Password'), value: <><code data-testid="wp-admin-password">{job.adminPassword}</code> <button type="button" className="btn btn-sm btn-ghost" onClick={() => copy(job.adminPassword)} aria-label={t('panel.software.copy_password', 'Copy password')}><Copy size={14} /></button></> },
                    { label: t('panel.software.signin_page', 'Sign-in page'), value: <a href={job.adminUrl} target="_blank" rel="noreferrer">{job.adminUrl} <ExternalLink size={12} /></a> },
                  ]} />
                </div>
              </div>
            )}
            {!job.adminPassword && <p className="muted">{t('panel.software.signin_at', 'Sign in at')} <a href={job.adminUrl} target="_blank" rel="noreferrer">{job.adminUrl}</a> {t('panel.software.signin_with_chosen', 'with the password you chose once the install finishes.')} {t('panel.software.database_label', 'Database:')} <code>{job.database}</code>.</p>}
          </>
        )}
        {job && <ProgressLog jobId={job.id} onFinished={onJobFinished} streamPath={jobStreamPath} />}
        {job?.result?.url && <InfoNote>{t('panel.software.done', 'Done.')} <a href={job.result.url} target="_blank" rel="noreferrer">{t('panel.software.open_site', 'Open the site')}</a> {t('panel.software.or', 'or')} <a href={job.result.adminUrl} target="_blank" rel="noreferrer">{t('panel.software.the_dashboard', 'the dashboard')}</a>.</InfoNote>}
      </Modal>

      <Modal open={Boolean(removing)} title={removing ? fill(t('panel.software.remove_title', 'Remove {site}?'), { site: siteLabel(removing.row) }) : ''} onClose={() => setRemoving(null)} size="sm"
        footer={<><button className="btn" onClick={() => setRemoving(null)}>{t('common.cancel', 'Cancel')}</button><button className="btn btn-danger" disabled={busy} onClick={remove}>{t('panel.software.remove_button', 'Remove WordPress')}</button></>}>
        {removing && (
          <>
            <p>{removing.row.isDocroot ? <>{t('panel.software.remove_docroot_before', 'The WordPress files in')} <code>{removing.row.path}</code> {t('panel.software.remove_docroot_after', 'are deleted; other files in that folder stay.')}</> : <>{t('panel.software.remove_folder_before', 'The folder')} <code>{removing.row.path}</code> {t('panel.software.remove_folder_after', 'and everything in it is deleted.')}</>} {t('panel.software.cannot_undo', 'This cannot be undone.')}</p>
            {removing.row.database && removing.row.databaseOwned
              ? <Toggle checked={removing.database} onChange={(v) => setRemoving((s) => ({ ...s, database: v }))} label={fill(t('panel.software.also_delete_db', 'Also delete the database {database}'), { database: removing.row.database })} description={t('panel.software.also_delete_db_help', 'Every post, page and setting of this site is in it')} />
              : removing.row.database ? <p className="muted">{t('panel.software.db_left_before', 'The database')} <code>{removing.row.database}</code> {t('panel.software.db_left_after', 'is not one of this account\'s and is left alone.')}</p> : null}
          </>
        )}
      </Modal>
    </PanelPage>
  );
}
