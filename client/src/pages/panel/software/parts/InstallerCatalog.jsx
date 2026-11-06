import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { RefreshCw, Download, ExternalLink, Copy } from 'lucide-react';
import { Card, StatusPill, KeyValue } from '../../../../components/Common.jsx';
import { DataTable } from '../../../../components/DataTable.jsx';
import { Field, TextInput, Select, PasswordInput, Toggle, Button, FormActions } from '../../../../components/Form.jsx';
import { Modal, useConfirm } from '../../../../components/Modal.jsx';
import { ProgressLog } from '../../../../components/ProgressLog.jsx';
import { useToast } from '../../../../components/Toast.jsx';
import { useT } from '../../../../i18n/useT.js';
import { fill, untranslated } from '../../../../i18n/fill.js';
import { PanelPage, PanelCapabilityState, FeatureDisabledState } from '../../../../panel/PanelPage.jsx';
import { usePanelApi, usePanelMe, panelApi } from '../../../../panel/hooks/usePanel.js';
import { RequestError, InfoNote, isCapabilityError, isFeatureDisabled } from '../../databases/parts/shared.jsx';
import { INSTALLER_BY_ID, installerPath, visibleInstallers, appSlice } from './catalog.js';

// The account follows its own install/update jobs here (/api/system/jobs is reseller-only).
export const jobStreamPath = (id, app = 'wordpress') => (INSTALLER_BY_ID[app] || INSTALLER_BY_ID.wordpress).api.stream(id);

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
// (through the app's CLI when the catalog names one; without it the
// dashboard's own updater is the way).
export function hostState(meta, app = INSTALLER_BY_ID.wordpress) {
  const { state } = appSlice(app, [], meta);
  const cli = app?.cli ? Boolean(state?.requirements?.[app.cli]) : false;
  return { canInstall: Boolean(state?.canInstall), canUpdate: cli, hint: state?.hint || null, version: state?.version || null, method: cli ? 'cli' : 'web' };
}

const emptyForm = (me) => ({ domain: me?.account?.domain || '', path: '', title: '', adminUser: '', adminEmail: me?.account?.contactEmail || '', adminPassword: '', generate: true });

function InstallerTabs({ apps, current, onPick, t }) {
  if (apps.length < 2) return null;
  return (
    <div className="segmented" role="tablist" aria-label={t('panel.software.tabs_label', 'Application')}>
      {apps.map((a) => <button key={a.id} id={`installer-tab-${a.id}`} type="button" role="tab" aria-selected={a.id === current} className={a.id === current ? 'active' : ''} onClick={() => onPick(a.id)}>{a.label}</button>)}
    </div>
  );
}

// One page for the whole catalog: `app` pins the tab (the WordPress function
// renders it pinned); without it the tab follows `?app=` on the installers page.
export default function InstallerCatalog({ fn, app: pinned, current, onPick }) {
  const toast = useToast();
  const confirm = useConfirm();
  const navigate = useNavigate();
  const { t } = useT();
  const { me, hasFeature } = usePanelMe();
  const apps = visibleInstallers(hasFeature);
  const app = (pinned ? INSTALLER_BY_ID[pinned] : apps.find((a) => a.id === current)) || apps[0] || INSTALLER_BY_ID.wordpress;
  const vars = { app: app.label, vendor: app.vendor, cli: app.cliLabel || 'CLI', config: app.configFile };
  const { data, meta, loading, error, refetch } = usePanelApi(app.api.list);
  const rows = useMemo(() => appSlice(app, data, meta).rows, [app, data, meta]);
  const [form, setForm] = useState(() => emptyForm(me));
  const [formError, setFormError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [job, setJob] = useState(null);
  const [removing, setRemoving] = useState(null);
  const host = hostState(meta, app);
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
  const has = (field) => app.fields.includes(field);
  const pick = (id) => { if (id === app.id) return; if (onPick && !pinned) onPick(id); else navigate(installerPath(id)); };
  const tabs = <InstallerTabs apps={apps} current={app.id} onPick={pick} t={t} />;

  if (isFeatureDisabled(error)) return <PanelPage fn={fn}><FeatureDisabledState fn={fn} /></PanelPage>;

  const install = async (e) => {
    e.preventDefault();
    if (problem) { setFormError({ message: t('panel.software.check_folder', 'Check the folder'), fields: { path: [problem] } }); return; }
    setBusy(true); setFormError(null);
    try {
      const body = { domain: form.domain || me?.account?.domain, path: form.path.trim().replace(/^\/+|\/+$/g, '') };
      if (has('title')) body.title = form.title.trim();
      if (has('adminUser')) body.adminUser = form.adminUser.trim();
      if (has('adminEmail')) body.adminEmail = form.adminEmail.trim();
      if (has('adminPassword') && !form.generate && form.adminPassword) body.adminPassword = form.adminPassword;
      const { data: res } = await panelApi.post(app.api.install, body);
      setJob({ id: res.job.id, kind: 'install', label: res.path || res.domain, url: res.url, adminUrl: res.adminUrl, installUrl: res.installUrl || null, adminUser: res.adminUser, adminPassword: res.adminPassword || null, database: res.database, method: res.method });
      setForm(emptyForm(me));
    } catch (err) { setFormError(err); } finally { setBusy(false); }
  };

  const update = async (row) => {
    const ok = await confirm({ title: fill(t('panel.software.update_title', 'Update {site}?'), { site: siteLabel(row) }), message: fill(t('panel.software.update_message', '{app} core is updated to the latest release with {cli} (extensions and themes are left alone). Back up first if the site matters; the site is briefly in maintenance mode.'), vars), confirmLabel: t('panel.software.update', 'Update') });
    if (!ok) return;
    try {
      const { data: res } = await panelApi.post(app.api.update(row.id), {});
      setJob({ id: res.job.id, kind: 'update', label: siteLabel(row), url: row.url });
    } catch (err) { toast.error(err); }
  };

  const remove = async () => {
    const row = removing?.row;
    if (!row) return;
    setBusy(true);
    try {
      const { data: res } = await panelApi.delete(`${app.api.remove(row.id)}?confirm=true&database=${removing.database ? 'true' : 'false'}`);
      toast.success(fill(t('panel.software.removed', '{site} removed'), { site: siteLabel(row) }) + (res.database ? ` ${fill(t('panel.software.removed_with_db', 'together with database {database}'), { database: res.database })}` : ''));
      setRemoving(null);
      refetch();
    } catch (err) { toast.error(err); } finally { setBusy(false); }
  };

  const onJobFinished = (event) => {
    if (event.type === 'done') {
      toast.success(job?.kind === 'update' ? fill(t('panel.software.updated', '{site} updated'), { site: job.label }) : fill(t('panel.software.ready_at', '{app} is ready at {url}'), { ...vars, url: event.result?.url || job?.url }));
      setJob((j) => (j ? { ...j, result: event.result } : j));
      refetch();
    } else if (event.type === 'failed') toast.error(event.error || t('panel.software.job_failed', 'The job failed'));
  };

  const copy = async (text) => { try { await navigator.clipboard.writeText(text); toast.success(t('panel.software.copied', 'Copied')); } catch { toast.error(t('panel.software.copy_failed', 'Could not copy; select the text instead')); } };

  const installDisabled = busy || !host.canInstall || (has('title') && !form.title.trim()) || (has('adminUser') && !form.adminUser.trim()) || (has('adminEmail') && !form.adminEmail.trim()) || (has('adminPassword') && !form.generate && !form.adminPassword);
  const idp = app.idPrefix || app.id;
  const webSetup = app.setup === 'web';
  const installUrl = job?.result?.installUrl || (job?.kind === 'install' && webSetup ? job.installUrl : null) || null;

  return (
    <PanelPage fn={fn} actions={<>{tabs}<Button icon={RefreshCw} onClick={() => refetch()}>{t('common.refresh', 'Refresh')}</Button></>}>
      {capability && <PanelCapabilityState card error={error} onRetry={refetch} />}

      <form onSubmit={install}>
        <Card title={fill(t('panel.software.install_title', 'Install {app}'), vars)} subtitle={`${t('panel.software.install_subtitle', 'A fresh copy of the current release, with its own database, on one of your domains.')}${host.version ? ` ${fill(t('panel.software.latest_release', 'Latest release: {version}.'), { version: host.version })}` : ''}`}>
          <RequestError error={formError} />
          {!capability && meta && !host.canInstall && <InfoNote>{fill(t('panel.software.cannot_install', '{app} cannot be installed on this server yet.'), vars)} {host.hint || t('panel.software.ask_provider', 'Ask your hosting provider.')}</InfoNote>}
          <div className="form-grid">
            <Field label={t('panel.software.domain', 'Domain')} required htmlFor={`${idp}-domain`} error={formError?.fields?.domain}>
              <Select id={`${idp}-domain`} value={form.domain} onChange={set('domain')} options={domainOptions} disabled={!host.canInstall} />
            </Field>
            <Field label={t('panel.software.folder', 'Folder')} htmlFor={`${idp}-path`} help={t('panel.software.folder_help', 'Leave empty to install at the domain itself, or give a folder such as blog')} error={formError?.fields?.path || (problem ? [problem] : undefined)}>
              <TextInput id={`${idp}-path`} value={form.path} onChange={set('path')} placeholder="blog" maxLength={200} disabled={!host.canInstall} autoCapitalize="none" spellCheck={false} />
            </Field>
            {has('title') && <Field label={t('panel.software.site_title', 'Site title')} required htmlFor={`${idp}-title`} error={formError?.fields?.title}>
              <TextInput id={`${idp}-title`} value={form.title} onChange={set('title')} placeholder={t('panel.software.site_title_placeholder', 'My site')} maxLength={120} disabled={!host.canInstall} />
            </Field>}
            {has('adminUser') && <Field label={t('panel.software.admin_user', 'Administrator user name')} required htmlFor={`${idp}-admin-user`} help={t('panel.software.admin_user_help', 'Not "admin": it is the first name every attacker tries')} error={formError?.fields?.adminUser}>
              <TextInput id={`${idp}-admin-user`} value={form.adminUser} onChange={set('adminUser')} placeholder="editor" maxLength={60} disabled={!host.canInstall} autoCapitalize="none" spellCheck={false} />
            </Field>}
            {has('adminEmail') && <Field label={t('panel.software.admin_email', 'Administrator e-mail')} required htmlFor={`${idp}-admin-email`} error={formError?.fields?.adminEmail}>
              <TextInput id={`${idp}-admin-email`} type="email" value={form.adminEmail} onChange={set('adminEmail')} placeholder="you@example.com" maxLength={254} disabled={!host.canInstall} />
            </Field>}
            {has('adminPassword') && <Field label={t('panel.software.admin_password', 'Administrator password')} htmlFor={`${idp}-admin-password`} error={formError?.fields?.adminPassword}>
              <Toggle checked={form.generate} onChange={set('generate')} label={t('panel.software.generate_password', 'Generate one for me')} description={t('panel.software.generate_password_help', 'Shown once when the install starts')} disabled={!host.canInstall} />
              {!form.generate && <PasswordInput id={`${idp}-admin-password`} value={form.adminPassword} onChange={set('adminPassword')} minLength={app.passwordMin || 8} maxLength={128} disabled={!host.canInstall} />}
            </Field>}
          </div>
          {webSetup && <InfoNote>{fill(t('panel.software.web_setup_note', 'The site name, language and administrator are chosen in the {app} installer, which opens when the files and the database are in place.'), vars)}</InfoNote>}
          <FormActions>
            <Button type="submit" variant="primary" icon={Download} loading={busy} disabled={installDisabled}>{fill(t('panel.software.install_title', 'Install {app}'), vars)}</Button>
            <span className="muted small">{host.method === 'cli' ? fill(t('panel.software.method_cli', 'Installed with {cli}.'), vars) : webSetup ? fill(t('panel.software.method_files', 'Downloaded from {vendor}, checked against its published checksum and unpacked with its database configured; you finish the setup in the {app} installer.'), vars) : fill(t('panel.software.method_web', 'Downloaded from {vendor}, checked against its published checksum and set up through the {app} installer.'), vars)} {t('panel.software.db_created', 'The database is created for you.')}</span>
          </FormActions>
        </Card>
      </form>

      <Card title={fill(t('panel.software.sites_title', 'Your {app} sites'), vars)} subtitle={rows.length ? fill(t('panel.software.sites_count', '{count} found under your document roots'), { count: rows.length }) : undefined} padded={false}>
        {!capability && meta && app.cli && !host.canUpdate && Boolean(rows.length) && <div className="card-body"><InfoNote>{fill(t('panel.software.updates_need_cli', 'Updates from here need {cli} on the server; until your provider installs it, update from each site\'s dashboard'), vars)} (<em>{t('panel.software.dashboard_updates', 'Dashboard › Updates')}</em>).</InfoNote></div>}
        {!capability && meta && !app.cli && Boolean(rows.length) && <div className="card-body"><InfoNote>{fill(t('panel.software.updates_from_dashboard', '{app} updates itself from its own administration pages.'), vars)}</InfoNote></div>}
        <DataTable
          columns={[
            { key: 'site', label: t('panel.software.col_site', 'Site'), render: (r) => <><a href={r.url} target="_blank" rel="noreferrer">{siteLabel(r)}</a><div className="muted small"><code>{r.path}</code></div></> },
            { key: 'version', label: t('panel.software.col_version', 'Version'), render: (r) => (r.version ? <code>{r.version}</code> : <span className="muted">{t('panel.software.version_unknown', 'unknown')}</span>) },
            { key: 'database', label: t('panel.software.col_database', 'Database'), render: (r) => (r.database ? <><code>{r.database}</code>{!r.databaseOwned && <div className="muted small">{t('panel.software.db_not_owned', 'not one of this account\'s databases')}</div>}</> : <span className="muted">—</span>) },
            { key: 'state', label: t('panel.software.col_state', 'State'), render: (r) => (r.installUrl ? <StatusPill status="warn">{t('panel.software.state_pending', 'setup pending')}</StatusPill> : <StatusPill status={r.version ? 'ok' : 'unknown'}>{r.version ? t('panel.software.state_installed', 'installed') : t('panel.software.state_incomplete', 'incomplete')}</StatusPill>) },
          ]}
          rows={rows} loading={loading} error={capability ? null : error} rowKey={(r) => r.id}
          rowActions={(r) => [
            r.installUrl && { label: t('panel.software.finish_setup', 'Finish setup'), primary: true, onClick: () => window.open(r.installUrl, '_blank', 'noopener') },
            { label: t('panel.software.open_admin', 'Open admin'), primary: !r.installUrl, onClick: () => window.open(r.adminUrl, '_blank', 'noopener') },
            app.cli && { label: host.canUpdate ? t('panel.software.update', 'Update') : fill(t('panel.software.update_needs_cli', 'Update (needs {cli})'), vars), disabled: !host.canUpdate, onClick: () => update(r) },
            { label: t('panel.software.remove', 'Remove'), danger: true, onClick: () => setRemoving({ row: r, database: false }) },
          ].filter(Boolean)}
          emptyText={capability ? fill(t('panel.software.sites_empty_capability', 'Your {app} sites appear here once the server is ready.'), vars) : fill(t('panel.software.sites_empty', 'No {app} installation found. Install one above, or upload your own: anything with a {config} under your document roots is listed here.'), vars)}
        />
      </Card>

      <Modal open={Boolean(job)} title={job?.kind === 'update' ? fill(t('panel.software.updating', 'Updating {site}'), { site: job.label }) : fill(t('panel.software.installing_at', 'Installing {app} at {site}'), { ...vars, site: job?.label || '' })} onClose={() => setJob(null)} size="lg" footer={<button className="btn btn-primary" onClick={() => setJob(null)}>{t('common.close', 'Close')}</button>}>
        {job?.kind === 'install' && (
          <>
            {job.adminPassword && (
              <div className="banner banner-warning">
                <div>
                  <strong>{t('panel.software.write_down_password', 'Write down the administrator password now; it is not shown again.')}</strong>
                  <KeyValue items={[
                    { label: t('panel.software.user_name', 'User name'), value: <code>{job.adminUser}</code> },
                    { label: t('panel.software.password', 'Password'), value: <><code data-testid={`${idp}-admin-password`}>{job.adminPassword}</code> <button type="button" className="btn btn-sm btn-ghost" onClick={() => copy(job.adminPassword)} aria-label={t('panel.software.copy_password', 'Copy password')}><Copy size={14} /></button></> },
                    { label: t('panel.software.signin_page', 'Sign-in page'), value: <a href={job.adminUrl} target="_blank" rel="noreferrer">{job.adminUrl} <ExternalLink size={12} /></a> },
                  ]} />
                </div>
              </div>
            )}
            {!job.adminPassword && !webSetup && <p className="muted">{t('panel.software.signin_at', 'Sign in at')} <a href={job.adminUrl} target="_blank" rel="noreferrer">{job.adminUrl}</a> {t('panel.software.signin_with_chosen', 'with the password you chose once the install finishes.')} {t('panel.software.database_label', 'Database:')} <code>{job.database}</code>.</p>}
          </>
        )}
        {job && <ProgressLog jobId={job.id} onFinished={onJobFinished} streamPath={app.api.stream} />}
        {job?.result?.url && !installUrl && <InfoNote>{t('panel.software.done', 'Done.')} <a href={job.result.url} target="_blank" rel="noreferrer">{t('panel.software.open_site', 'Open the site')}</a> {t('panel.software.or', 'or')} <a href={job.result.adminUrl} target="_blank" rel="noreferrer">{t('panel.software.the_dashboard', 'the dashboard')}</a>.</InfoNote>}
        {job?.result && installUrl && <InfoNote>{t('panel.software.files_ready', 'The files and the database are in place.')} <a href={installUrl} target="_blank" rel="noreferrer">{fill(t('panel.software.open_web_installer', 'Finish the setup in the {app} installer'), vars)} <ExternalLink size={12} /></a>.</InfoNote>}
      </Modal>

      <Modal open={Boolean(removing)} title={removing ? fill(t('panel.software.remove_title', 'Remove {site}?'), { site: siteLabel(removing.row) }) : ''} onClose={() => setRemoving(null)} size="sm"
        footer={<><button className="btn" onClick={() => setRemoving(null)}>{t('common.cancel', 'Cancel')}</button><button className="btn btn-danger" disabled={busy} onClick={remove}>{fill(t('panel.software.remove_button', 'Remove {app}'), vars)}</button></>}>
        {removing && (
          <>
            <p>{removing.row.isDocroot ? <>{fill(t('panel.software.remove_docroot_before', 'The {app} files in'), vars)} <code>{removing.row.path}</code> {t('panel.software.remove_docroot_after', 'are deleted; other files in that folder stay.')}</> : <>{t('panel.software.remove_folder_before', 'The folder')} <code>{removing.row.path}</code> {t('panel.software.remove_folder_after', 'and everything in it is deleted.')}</>} {t('panel.software.cannot_undo', 'This cannot be undone.')}</p>
            {removing.row.database && removing.row.databaseOwned
              ? <Toggle checked={removing.database} onChange={(v) => setRemoving((s) => ({ ...s, database: v }))} label={fill(t('panel.software.also_delete_db', 'Also delete the database {database}'), { database: removing.row.database })} description={t('panel.software.also_delete_db_help', 'Every post, page and setting of this site is in it')} />
              : removing.row.database ? <p className="muted">{t('panel.software.db_left_before', 'The database')} <code>{removing.row.database}</code> {t('panel.software.db_left_after', 'is not one of this account\'s and is left alone.')}</p> : null}
          </>
        )}
      </Modal>
    </PanelPage>
  );
}
