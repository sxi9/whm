import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { RefreshCw, GitBranch, Plus, Download, Rocket, Trash2, FolderOpen } from 'lucide-react';
import { Card, StatusPill, KeyValue, EmptyState, formatDate } from '../../../components/Common.jsx';
import { DataTable } from '../../../components/DataTable.jsx';
import { Field, TextInput, Toggle, Button, FormActions } from '../../../components/Form.jsx';
import { Modal, useConfirm } from '../../../components/Modal.jsx';
import { ProgressLog } from '../../../components/ProgressLog.jsx';
import { useToast } from '../../../components/Toast.jsx';
import { useT } from '../../../i18n/useT.js';
import { fill, untranslated } from '../../../i18n/fill.js';
import { PanelPage, PanelCapabilityState, FeatureDisabledState } from '../../../panel/PanelPage.jsx';
import { usePanelApi, panelApi } from '../../../panel/hooks/usePanel.js';
import { RequestError, InfoNote, isCapabilityError, isFeatureDisabled } from '../databases/parts/shared.jsx';
import { normalizeRel, managerHref } from './parts/paths.js';

// The account follows its own clone/pull/deploy jobs here (/api/system/jobs is reseller-only).
export const jobStreamPath = (id) => `/panel/git/jobs/${id}/stream`;
export const DEFAULT_ROOT = 'repositories';
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const URL_RE = /^(?:https:\/\/[^@\s/]+\/\S+|ssh:\/\/git@[^@\s/]+\/\S+|git@[^@\s:]+:\S+)$/;

// Quick client-side shape checks; the server pins everything for real.
export function nameProblem(input, t = untranslated) {
  const s = String(input || '').trim();
  if (!s) return null;
  if (!NAME_RE.test(s) || s.endsWith('.git')) return t('panel.git.name_chars', 'Letters, digits, ".", "_" and "-", up to 64 characters, no ".git" ending');
  return null;
}

export function urlProblem(input, t = untranslated) {
  const s = String(input || '').trim();
  if (!s) return null;
  if (/^(file:|ext::)/i.test(s)) return t('panel.git.url_transport', 'Only https:// and ssh (git@host:path) repositories can be cloned');
  if (/^https?:\/\/[^/]*@/.test(s) || /^ssh:\/\/(?!git@)/.test(s) || /^(?!git@)[^/:@]+@[^/:]+:/.test(s)) return t('panel.git.url_userinfo', 'Leave the user name and password out of the URL; use an ssh:// URL with a deploy key for private repositories');
  if (!URL_RE.test(s)) return t('panel.git.url_shape', 'An https:// URL, an ssh://git@host/path URL or git@host:path');
  return null;
}

export function dirProblem(input, t = untranslated) {
  const s = String(input || '').trim();
  if (!s) return null;
  if (s.startsWith('/') || s.startsWith('-')) return t('panel.git.dir_relative', 'A folder relative to your home directory, such as repositories/site');
  if (normalizeRel(s) == null) return t('panel.git.dir_dots', 'The folder cannot contain ".."');
  return null;
}

export const KEEL_EXAMPLE = `deployment:
  tasks:
    - mkdir -p ~/public_html/site
    - rsync -a --delete dist/ ~/public_html/site/
    - chmod 644 ~/public_html/site/index.html`;

const emptyForm = () => ({ name: '', url: '', dir: '', adopt: false });

export default function Git({ fn }) {
  const toast = useToast();
  const confirm = useConfirm();
  const { t } = useT();
  const [params, setParams] = useSearchParams();
  const selectedId = params.get('repo');
  const { data, meta, loading, error, refetch } = usePanelApi('/git');
  const detail = usePanelApi(selectedId ? `/git/${encodeURIComponent(selectedId)}` : null);
  const [sheet, setSheet] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [formError, setFormError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [job, setJob] = useState(null);
  const capability = isCapabilityError(error);
  const set = (k) => (v) => setForm((f) => ({ ...f, [k]: v }));
  const problems = { name: nameProblem(form.name, t), url: form.adopt ? null : urlProblem(form.url, t), dir: dirProblem(form.dir, t) };
  const repo = detail.data;
  const select = (id) => setParams(id ? { repo: String(id) } : {});

  useEffect(() => { if (!sheet) { setForm(emptyForm()); setFormError(null); } }, [sheet]);

  if (isFeatureDisabled(error)) return <PanelPage fn={fn}><FeatureDisabledState fn={fn} /></PanelPage>;

  const create = async (e) => {
    e.preventDefault();
    const bad = Object.entries(problems).find(([, v]) => v);
    if (bad) { setFormError({ message: t('panel.git.check_form', 'Check the form'), fields: { [bad[0]]: [bad[1]] } }); return; }
    setBusy(true); setFormError(null);
    try {
      const body = { name: form.name.trim() };
      const dir = normalizeRel(form.dir);
      if (dir) body.dir = dir;
      if (form.adopt) body.adopt = true; else if (form.url.trim()) body.url = form.url.trim();
      const { data: res } = await panelApi.post('/git', body);
      setSheet(false);
      if (res.job) setJob({ id: res.job.id, kind: 'clone', label: res.name });
      else { toast.success(fill(t('panel.git.created', 'Repository {name} created'), { name: res.name })); refetch(); select(res.id); }
    } catch (err) { setFormError(err); } finally { setBusy(false); }
  };

  const pull = async (row) => {
    try {
      const { data: res } = await panelApi.post(`/git/${encodeURIComponent(row.id)}/pull`, {});
      setJob({ id: res.job.id, kind: 'pull', label: row.name });
    } catch (err) { toast.error(err); }
  };

  const deploy = async (row, dryRun = false) => {
    if (!dryRun) {
      const ok = await confirm({ title: fill(t('panel.git.deploy_title', 'Deploy {name}?'), { name: row.name }), message: t('panel.git.deploy_message', 'The tasks listed in .keel.yml run one by one as your account. Files they copy over are replaced; run "Check tasks" first to see the plan.'), confirmLabel: t('panel.git.deploy', 'Deploy') });
      if (!ok) return;
    }
    try {
      const { data: res } = await panelApi.post(`/git/${encodeURIComponent(row.id)}/deploy`, dryRun ? { dryRun: true } : {});
      setJob({ id: res.job.id, kind: dryRun ? 'check' : 'deploy', label: row.name });
    } catch (err) { toast.error(err); }
  };

  const remove = async (row) => {
    const ok = await confirm({ title: fill(t('panel.git.remove_title', 'Remove {name}?'), { name: row.name }), message: fill(t('panel.git.remove_message', 'The folder {dir} and everything in it is deleted from your account. Files a deployment copied elsewhere stay. This cannot be undone.'), { dir: `~/${row.dir}` }), confirmLabel: t('panel.git.remove_button', 'Remove repository'), danger: true });
    if (!ok) return;
    try {
      await panelApi.delete(`/git/${encodeURIComponent(row.id)}?confirm=true&files=true`);
      toast.success(fill(t('panel.git.removed', '{name} removed'), { name: row.name }));
      if (String(row.id) === selectedId) select(null);
      refetch();
    } catch (err) { toast.error(err); }
  };

  const unregister = async (row) => {
    const ok = await confirm({ title: fill(t('panel.git.unregister_title', 'Forget {name}?'), { name: row.name }), message: t('panel.git.unregister_message', 'The repository disappears from this list; its folder and files stay in your account.'), confirmLabel: t('panel.git.unregister', 'Forget') });
    if (!ok) return;
    try {
      await panelApi.delete(`/git/${encodeURIComponent(row.id)}?confirm=true&files=false`);
      if (String(row.id) === selectedId) select(null);
      refetch();
    } catch (err) { toast.error(err); }
  };

  const onJobFinished = (event) => {
    if (event.type === 'done') {
      const messages = { clone: t('panel.git.cloned', '{name} cloned'), pull: t('panel.git.pulled', '{name} pulled'), deploy: t('panel.git.deployed', '{name} deployed'), check: t('panel.git.checked', 'Tasks of {name} checked') };
      toast.success(fill(messages[job?.kind] || messages.pull, { name: job?.label || '' }));
      refetch();
      if (job?.kind === 'clone' && event.result?.id) select(event.result.id); else detail.refetch?.();
    } else if (event.type === 'failed') toast.error(event.error || t('panel.git.job_failed', 'The job failed'));
  };

  const jobTitle = { clone: t('panel.git.cloning', 'Cloning {name}'), pull: t('panel.git.pulling', 'Pulling {name}'), deploy: t('panel.git.deploying', 'Deploying {name}'), check: t('panel.git.checking', 'Checking the tasks of {name}') };
  const rows = data || [];
  const unregistered = meta?.unregistered || [];

  return (
    <PanelPage fn={fn} actions={<><Button icon={RefreshCw} onClick={() => refetch()}>{t('common.refresh', 'Refresh')}</Button><Button variant="primary" icon={Plus} onClick={() => setSheet(true)} disabled={capability}>{t('panel.git.new', 'New repository')}</Button></>}>
      {capability && <Card><PanelCapabilityState error={error} onRetry={refetch} /></Card>}

      <Card title={t('panel.git.list_title', 'Your repositories')} subtitle={meta ? fill(t('panel.git.list_count', '{count} of {max}'), { count: rows.length, max: meta.max }) : undefined} padded={false}>
        <DataTable
          columns={[
            { key: 'name', label: t('panel.git.col_name', 'Repository'), render: (r) => <><button type="button" className="btn btn-sm btn-ghost" onClick={() => select(r.id)}><GitBranch size={14} /> {r.name}</button><div className="muted small"><code>~/{r.dir}</code></div></> },
            { key: 'url', label: t('panel.git.col_remote', 'Remote'), render: (r) => (r.url ? <code className="small">{r.url}</code> : <span className="muted">{t('panel.git.no_remote', 'none (local only)')}</span>) },
            { key: 'lastPullAt', label: t('panel.git.col_pull', 'Last pull'), render: (r) => (r.lastPullAt ? formatDate(r.lastPullAt) : <span className="muted">—</span>) },
            { key: 'lastDeployAt', label: t('panel.git.col_deploy', 'Last deploy'), render: (r) => (r.lastDeployAt ? formatDate(r.lastDeployAt) : <span className="muted">—</span>) },
            { key: 'state', label: t('panel.git.col_state', 'State'), render: (r) => (r.present === false ? <StatusPill status="error">{t('panel.git.state_missing', 'folder missing')}</StatusPill> : <StatusPill status="ok">{t('panel.git.state_ok', 'ready')}</StatusPill>) },
          ]}
          rows={rows} loading={loading} error={capability ? null : error} rowKey={(r) => r.id}
          rowActions={(r) => [
            { label: t('panel.git.open', 'Open'), primary: true, onClick: () => select(r.id) },
            { label: t('panel.git.pull', 'Pull'), disabled: !r.url, onClick: () => pull(r) },
            { label: t('panel.git.deploy', 'Deploy'), onClick: () => deploy(r) },
            { label: t('panel.git.unregister', 'Forget'), onClick: () => unregister(r) },
            { label: t('panel.git.remove', 'Remove'), danger: true, onClick: () => remove(r) },
          ]}
          emptyText={capability ? t('panel.git.empty_capability', 'Your repositories appear here once git is installed on the server.') : t('panel.git.empty', 'No repository yet. Create an empty one or clone a public repository with "New repository".')}
        />
        {unregistered.length > 0 && (
          <div className="card-body">
            <InfoNote>
              {fill(t('panel.git.unregistered', '{count} repository folder(s) under ~/{root} are not listed yet:'), { count: unregistered.length, root: meta?.defaultRoot || DEFAULT_ROOT })} {unregistered.map((u) => <code key={u.dir}>{u.name}</code>).reduce((acc, el, i) => (i ? [...acc, ', ', el] : [el]), [])}. {t('panel.git.unregistered_hint', 'Add one with "New repository", the same name and "Use the existing folder".')}
            </InfoNote>
          </div>
        )}
      </Card>

      {selectedId && (
        <Card title={repo ? repo.name : t('panel.git.detail_title', 'Repository')} subtitle={repo ? `~/${repo.dir}` : undefined}
          actions={repo && <><Button icon={Download} disabled={!repo.url} onClick={() => pull(repo)}>{t('panel.git.pull', 'Pull')}</Button><Button onClick={() => deploy(repo, true)} disabled={!repo.info?.hasKeelYml}>{t('panel.git.check_tasks', 'Check tasks')}</Button><Button variant="primary" icon={Rocket} onClick={() => deploy(repo)} disabled={!repo.info?.hasKeelYml}>{t('panel.git.deploy', 'Deploy')}</Button><Button variant="danger" icon={Trash2} onClick={() => remove(repo)}>{t('panel.git.remove', 'Remove')}</Button></>}>
          <RequestError error={detail.error} onRetry={detail.refetch} />
          {repo?.missing && <InfoNote>{t('panel.git.missing_note', 'The folder is gone or no longer holds a git repository. Forget the entry, or restore the folder.')}</InfoNote>}
          {repo?.info && (
            <KeyValue items={[
              [t('panel.git.branch', 'Branch'), repo.info.branch ? <code>{repo.info.branch}</code> : <span className="muted">{t('panel.git.no_commits', 'no commits yet')}</span>],
              [t('panel.git.head', 'Latest commit'), repo.info.head ? <><code>{repo.info.head.short}</code> {repo.info.head.subject} <span className="muted small">{repo.info.head.date ? formatDate(repo.info.head.date) : ''}</span></> : <span className="muted">—</span>],
              [t('panel.git.remotes', 'Remotes'), repo.info.remotes.length ? repo.info.remotes.map((r) => <div key={r.name}><code>{r.name}</code> {r.url}</div>) : <span className="muted">{t('panel.git.no_remote', 'none (local only)')}</span>],
              [t('panel.git.changes', 'Uncommitted changes'), repo.info.dirty == null ? '—' : repo.info.dirty === 0 ? t('panel.git.clean', 'none') : fill(t('panel.git.dirty_count', '{count} file(s)'), { count: repo.info.dirty })],
              [t('panel.git.last_pull', 'Last pull'), repo.lastPullAt ? formatDate(repo.lastPullAt) : <span className="muted">{t('panel.git.never', 'never')}</span>],
              [t('panel.git.last_deploy', 'Last deploy'), repo.lastDeployAt ? formatDate(repo.lastDeployAt) : <span className="muted">{t('panel.git.never', 'never')}</span>],
              [t('panel.git.keel_yml', 'Deployment file'), repo.info.hasKeelYml ? <StatusPill status="ok">.keel.yml {t('panel.git.found', 'found')}</StatusPill> : <span className="muted">{t('panel.git.keel_missing', '.keel.yml not found; see the guide below')}</span>],
              [t('panel.git.files', 'Files'), <Link to={managerHref(repo.dir)}><FolderOpen size={14} /> {t('panel.git.open_in_manager', 'Open in the file manager')}</Link>],
            ]} />
          )}
          {!repo && !detail.error && <p className="muted">{t('common.loading', 'Loading…')}</p>}
        </Card>
      )}

      <Card title={t('panel.git.guide_title', 'Deployment guide')} subtitle={t('panel.git.guide_subtitle', 'How "Deploy" moves files from a repository into a website folder.')}>
        <p>{t('panel.git.guide_1', 'Commit a file named .keel.yml at the top of the repository. It lists the tasks Deploy runs, in order, as your account:')}</p>
        <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}><code>{KEEL_EXAMPLE}</code></pre>
        <p>{t('panel.git.guide_2', 'Allowed programs: cp, rsync, mkdir, rm and chmod, with a few of their usual options. Each task is one program with its arguments — no shell, variables, pipes or ";" chains. A path is read relative to the repository; "~/" means your home directory. Every path must stay inside your home.')}</p>
        <p>{t('panel.git.guide_3', 'Pull first to fetch the latest commit (fast-forward only: a repository with local changes that conflict is left alone), then Deploy. "Check tasks" shows the plan without changing anything. Private repositories need an ssh:// URL and a deploy key in the account\'s ~/.ssh; the panel never asks for a password.')}</p>
      </Card>

      <Modal open={sheet} title={t('panel.git.new', 'New repository')} onClose={() => setSheet(false)} size="md"
        footer={<><button className="btn" onClick={() => setSheet(false)}>{t('common.cancel', 'Cancel')}</button><button className="btn btn-primary" form="git-create" type="submit" disabled={busy || !form.name.trim() || Boolean(problems.name || problems.url || problems.dir)}>{form.adopt ? t('panel.git.add_existing', 'Add repository') : form.url.trim() ? t('panel.git.clone', 'Clone') : t('panel.git.create', 'Create')}</button></>}>
        <form id="git-create" onSubmit={create}>
          <RequestError error={formError} />
          <div className="form-grid">
            <Field label={t('panel.git.name', 'Name')} required htmlFor="git-name" help={t('panel.git.name_help', 'Also the folder name under ~/repositories unless you choose another folder')} error={formError?.fields?.name || (problems.name ? [problems.name] : undefined)}>
              <TextInput id="git-name" value={form.name} onChange={set('name')} placeholder="my-site" maxLength={64} autoCapitalize="none" spellCheck={false} />
            </Field>
            <Field label={t('panel.git.url', 'Clone URL')} htmlFor="git-url" help={t('panel.git.url_help', 'Leave empty to create an empty repository. Public https:// repositories clone right away; ssh:// ones need a deploy key')} error={formError?.fields?.url || (problems.url ? [problems.url] : undefined)}>
              <TextInput id="git-url" value={form.url} onChange={set('url')} placeholder="https://github.com/org/project.git" maxLength={512} disabled={form.adopt} autoCapitalize="none" spellCheck={false} />
            </Field>
            <Field label={t('panel.git.dir', 'Folder')} htmlFor="git-dir" help={fill(t('panel.git.dir_help', 'Relative to your home; default {dir}'), { dir: `${DEFAULT_ROOT}/${form.name.trim() || '<name>'}` })} error={formError?.fields?.dir || (problems.dir ? [problems.dir] : undefined)}>
              <div className="input-group"><span className="btn btn-ghost" aria-hidden="true"><FolderOpen size={16} /> ~/</span><TextInput id="git-dir" value={form.dir} onChange={set('dir')} placeholder={`${DEFAULT_ROOT}/${form.name.trim() || 'my-site'}`} maxLength={512} spellCheck={false} /></div>
            </Field>
            <Field label={t('panel.git.adopt', 'Existing folder')} htmlFor="git-adopt">
              <Toggle checked={form.adopt} onChange={set('adopt')} label={t('panel.git.adopt_label', 'Use the existing folder')} description={t('panel.git.adopt_help', 'The folder already holds a git repository (uploaded or cloned by hand); register it instead of creating one')} />
            </Field>
          </div>
          <FormActions><span className="muted small">{t('panel.git.runs_as_account', 'Everything runs as your own account; no password is stored.')}</span></FormActions>
        </form>
      </Modal>

      <Modal open={Boolean(job)} title={job ? fill(jobTitle[job.kind] || jobTitle.pull, { name: job.label }) : ''} onClose={() => setJob(null)} size="lg" footer={<button className="btn btn-primary" onClick={() => setJob(null)}>{t('common.close', 'Close')}</button>}>
        {job && <ProgressLog jobId={job.id} onFinished={onJobFinished} streamPath={jobStreamPath} />}
      </Modal>

      {!rows.length && !loading && !capability && !error && <EmptyState title={t('panel.git.empty_title', 'Nothing deployed yet')} icon={GitBranch}>{t('panel.git.empty_body', 'Clone a repository, add a .keel.yml and press Deploy: your site is updated from git in two clicks.')}</EmptyState>}
    </PanelPage>
  );
}
