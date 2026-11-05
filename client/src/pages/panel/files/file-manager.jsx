import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { RefreshCw, Upload, FolderPlus, FilePlus, ArrowUp, Folder, FileText, File, Link2, FileArchive, AlertTriangle, Trash2, Archive, Eye, EyeOff, HardDrive } from 'lucide-react';
import { Card, formatBytes, formatDate } from '../../../components/Common.jsx';
import { DataTable, RowActions } from '../../../components/DataTable.jsx';
import { Field, TextInput, Button } from '../../../components/Form.jsx';
import { useToast } from '../../../components/Toast.jsx';
import { useConfirm, Modal } from '../../../components/Modal.jsx';
import { api } from '../../../api/client.js';
import { PanelPage, PanelCapabilityState, FeatureDisabledState } from '../../../panel/PanelPage.jsx';
import { usePanelApi, usePanelMe, panelApi } from '../../../panel/hooks/usePanel.js';
import { useT, translate } from '../../../i18n/useT.js';
import { fill, plural } from '../../../i18n/fill.js';
import { RequestError, PathBar } from './parts/common.jsx';
import { FileEditor } from './parts/FileEditor.jsx';
import { UploadModal } from './parts/UploadModal.jsx';
import { PermissionsModal } from './parts/PermissionsModal.jsx';
import { CompressModal, ExtractModal } from './parts/ArchiveModals.jsx';
import { normalizeRel, joinRel, parentOf, listPath, downloadHref, diskUsageHref, isArchiveName, isEditable, looksLikeText, filterEntries, sortEntries, isCapabilityError, isFeatureDisabled, MAX_TEXT_BYTES } from './parts/paths.js';

const NAME_RE = /^(?!\.\.?$)[^\0/\n\r]{1,255}$/;

export function entryIcon(entry) {
  if (entry.type === 'dir') return Folder;
  if (entry.type === 'symlink') return Link2;
  if (isArchiveName(entry.name)) return FileArchive;
  if (looksLikeText(entry.name)) return FileText;
  return File;
}

export function typeText(entry) {
  if (entry.type === 'dir') return translate('panel.files.type_folder', 'Folder');
  if (entry.type === 'symlink') return translate('panel.files.type_link', 'Link');
  if (entry.type === 'file') return isArchiveName(entry.name) ? translate('panel.files.type_archive', 'Archive') : translate('panel.files.type_file', 'File');
  return translate('panel.files.type_other', 'Other');
}

export function deleteFiles(paths) {
  return api.request('DELETE', '/panel/files', { paths });
}

function NameModal({ open, title, label, initial = '', help, confirmLabel, busy, error, onClose, onSubmit, existing = [] }) {
  const { t } = useT();
  const [value, setValue] = useState(initial);
  useEffect(() => { if (open) setValue(initial); }, [open, initial]);
  const trimmed = value.trim();
  const clash = trimmed && trimmed !== initial && existing.includes(trimmed);
  const bad = trimmed && !NAME_RE.test(trimmed);
  const local = clash ? [fill(t('panel.files.name_exists', '{name} already exists in this folder'), { name: trimmed })] : bad ? [t('panel.files.name_rule', 'A name without "/"; "." and ".." are not allowed')] : null;
  return (
    <Modal open={open} title={title} onClose={onClose} size="sm"
      footer={<><Button onClick={onClose}>{t('panel.files.cancel', 'Cancel')}</Button><Button variant="primary" loading={busy} disabled={!trimmed || Boolean(local) || trimmed === initial} onClick={() => onSubmit(trimmed)}>{confirmLabel}</Button></>}>
      <PanelCapabilityState error={error} />
      <RequestError error={error} />
      <form onSubmit={(e) => { e.preventDefault(); if (trimmed && !local && trimmed !== initial) onSubmit(trimmed); }}>
        <Field label={label} required help={help} error={local || error?.fields?.path || error?.fields?.to || error?.fields?.from} htmlFor="name-modal-input">
          <TextInput id="name-modal-input" value={value} onChange={setValue} autoFocus spellCheck={false} autoCapitalize="none" />
        </Field>
      </form>
    </Modal>
  );
}

export default function FileManager({ fn }) {
  const { t } = useT();
  const toast = useToast();
  const confirm = useConfirm();
  const { me } = usePanelMe();
  const [params, setParams] = useSearchParams();
  const dir = normalizeRel(params.get('path') || '') ?? '';
  const { data, error, loading, refetch } = usePanelApi(listPath(dir));
  const [q, setQ] = useState('');
  const [showHidden, setShowHidden] = useState(true);
  const [sort, setSort] = useState({ key: 'name', dir: 'asc' });
  const [selected, setSelected] = useState([]);
  const [goTo, setGoTo] = useState(dir);
  const [modal, setModal] = useState(null);
  const [busy, setBusy] = useState(false);
  const [modalError, setModalError] = useState(null);
  const [editing, setEditing] = useState(null);
  const [permFor, setPermFor] = useState(null);
  const [compress, setCompress] = useState(null);
  const [extract, setExtract] = useState(null);
  const [uploading, setUploading] = useState(false);

  useEffect(() => { setSelected([]); setQ(''); setGoTo(dir); }, [dir]);

  const navigate = useCallback((to) => {
    const clean = normalizeRel(to);
    if (clean == null) { toast.error(t('panel.files.dotdot_paths', 'Paths with ".." are not allowed')); return; }
    setParams(clean ? { path: clean } : {});
  }, [setParams, toast, t]);

  // The hook keeps the previous listing while the next one loads; a click on
  // one of those rows (the second half of a double-click) would otherwise be
  // resolved against the folder just navigated to (public_html/public_html).
  const listingDir = data ? normalizeRel(data.path) ?? data.path : null;
  const listing = data && listingDir === dir ? data : null;
  const entries = listing?.entries || [];
  const names = useMemo(() => entries.map((e) => e.name), [entries]);
  const rows = useMemo(() => sortEntries(filterEntries(entries, q, showHidden), sort.key, sort.dir), [entries, q, showHidden, sort]);
  const hiddenCount = useMemo(() => entries.filter((e) => e.name.startsWith('.')).length, [entries]);
  const capability = isCapabilityError(error);
  const selectedRows = rows.filter((r) => selected.includes(r.name));
  const relOf = (entry) => joinRel(dir, entry.name);

  if (isFeatureDisabled(error)) return <PanelPage fn={fn}><FeatureDisabledState fn={fn} /></PanelPage>;

  const copyTo = modal?.copyTo ?? (modal?.entry ? relOf(modal.entry) : '');
  const openModal = (kind, entry = null) => { setModal({ kind, entry }); setModalError(null); };
  const closeModal = () => { setModal(null); setModalError(null); };
  const here = <code>{dir ? `~/${dir}` : '~'}</code>;

  const run = async (work, success) => {
    setBusy(true); setModalError(null);
    try {
      const res = await work();
      if (success) toast.success(typeof success === 'function' ? success(res) : success);
      closeModal();
      refetch();
    } catch (err) { setModalError(err); } finally { setBusy(false); }
  };

  const createFolder = (name) => run(() => panelApi.post('/files/mkdir', { path: joinRel(dir, name), mode: '0755' }), fill(t('panel.files.folder_created', 'Folder {name} created'), { name }));
  const createFile = (name) => run(() => panelApi.put('/files/write', { path: joinRel(dir, name), content: '' }), fill(t('panel.files.file_created', 'File {name} created'), { name }));
  const rename = (name) => run(() => panelApi.post('/files/rename', { from: relOf(modal.entry), to: joinRel(dir, name) }), fill(t('panel.files.renamed_to', '{from} renamed to {to}'), { from: modal.entry.name, to: name }));
  const copy = (to) => run(() => panelApi.post('/files/copy', { from: relOf(modal.entry), to: normalizeRel(to) ?? to }), fill(t('panel.files.copied', '{name} copied'), { name: modal.entry.name }));

  const open = (entry) => {
    if (entry.type === 'dir') navigate(relOf(entry));
    else if (isEditable(entry)) setEditing(relOf(entry));
    else if (entry.type === 'file') toast.info(fill(t('panel.files.too_large_to_open', '{name} is larger than {size}; download it to view it.'), { name: entry.name, size: formatBytes(MAX_TEXT_BYTES) }));
    else toast.info(fill(t('panel.files.cannot_open', '{name} is a {type} and cannot be opened here.'), { name: entry.name, type: typeText(entry).toLowerCase() }));
  };

  const download = (entry) => { if (typeof window !== 'undefined') window.location.assign(downloadHref(relOf(entry))); };

  const remove = async (targets) => {
    const list = targets.map((e) => e.name);
    const hasDir = targets.some((e) => e.type === 'dir');
    const ok = await confirm({
      title: list.length === 1 ? fill(t('panel.files.delete_name', 'Delete {name}?'), { name: list[0] }) : fill(t('panel.files.delete_n_items', 'Delete {count} items?'), { count: list.length }),
      message: `${list.length === 1 ? (hasDir ? t('panel.files.delete_one_dir_help', 'It is removed permanently, including everything inside the folders.') : t('panel.files.delete_one_help', 'It is removed permanently.')) : (hasDir ? t('panel.files.delete_many_dir_help', 'They are removed permanently, including everything inside the folders.') : t('panel.files.delete_many_help', 'They are removed permanently.'))} ${t('panel.files.no_trash', 'There is no trash to recover from.')}`,
      confirmLabel: t('panel.files.delete', 'Delete'), danger: true, typeToConfirm: list.length > 1 ? 'delete' : undefined,
    });
    if (!ok) return;
    try {
      const { data: res } = await deleteFiles(targets.map(relOf));
      toast.success(plural(t, 'panel.files.items_deleted', res?.removed?.length ?? list.length, '{count} item deleted', '{count} items deleted'));
      setSelected([]);
      refetch();
    } catch (err) { toast.error(err); }
  };

  const jobFinished = (ev, what) => {
    if (ev.type === 'done') toast.success(fill(t('panel.files.job_finished', '{what} finished'), { what })); else if (ev.type === 'failed') toast.error(ev.error || fill(t('panel.files.job_failed', '{what} failed'), { what }));
    refetch();
  };

  const toolbar = (
    <>
      <button type="button" className="btn btn-sm btn-ghost" onClick={() => setShowHidden((v) => !v)} aria-pressed={showHidden} title={showHidden ? t('panel.files.hide_dotfiles', 'Hide dotfiles') : t('panel.files.show_dotfiles', 'Show dotfiles')}>{showHidden ? <EyeOff size={14} /> : <Eye size={14} />} {showHidden ? t('panel.files.hide_hidden', 'Hide hidden') : `${t('panel.files.show_hidden', 'Show hidden')}${hiddenCount ? ` (${hiddenCount})` : ''}`}</button>
      {selected.length > 0 && (
        <>
          <span className="muted small">{fill(t('panel.files.n_selected', '{count} selected'), { count: selected.length })}</span>
          <span className="fm-actions-full">
            <Button size="sm" icon={Archive} onClick={() => setCompress(selectedRows.map(relOf))}>{t('panel.files.compress', 'Compress')}</Button>
            <Button size="sm" variant="danger-ghost" icon={Trash2} onClick={() => remove(selectedRows)}>{t('panel.files.delete', 'Delete')}</Button>
            <Button size="sm" variant="ghost" onClick={() => setSelected([])}>{t('panel.files.clear', 'Clear')}</Button>
          </span>
          <span className="fm-actions-compact">
            <RowActions actions={[
              { label: t('panel.files.compress', 'Compress'), primary: true, onClick: () => setCompress(selectedRows.map(relOf)) },
              { label: t('panel.files.delete', 'Delete'), danger: true, onClick: () => remove(selectedRows) },
              { label: t('panel.files.clear', 'Clear'), onClick: () => setSelected([]) },
            ]} />
          </span>
        </>
      )}
    </>
  );

  // Below 640px the header and selection actions collapse into the kit's row menu
  // (.fm-actions-compact); the full button rows stay for wider screens.
  return (
    <PanelPage fn={fn} actions={(
      <>
        <span className="fm-actions-full">
          <Button icon={FilePlus} onClick={() => openModal('new-file')}>{t('panel.files.new_file', 'New file')}</Button>
          <Button icon={FolderPlus} onClick={() => openModal('new-folder')}>{t('panel.files.new_folder', 'New folder')}</Button>
          <Button variant="primary" icon={Upload} onClick={() => setUploading(true)}>{t('panel.files.upload', 'Upload')}</Button>
        </span>
        <span className="fm-actions-compact">
          <RowActions actions={[
            { label: t('panel.files.upload', 'Upload'), primary: true, onClick: () => setUploading(true) },
            { label: t('panel.files.new_file', 'New file'), onClick: () => openModal('new-file') },
            { label: t('panel.files.new_folder', 'New folder'), onClick: () => openModal('new-folder') },
          ]} />
        </span>
      </>
    )}>
      <Card padded={false}>
        <div className="card-body" style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <Button size="sm" icon={ArrowUp} onClick={() => navigate(parentOf(dir))} disabled={!dir} aria-label={t('panel.files.up_one_level', 'Up one level')} title={t('panel.files.up_one_level', 'Up one level')} />
          <PathBar path={dir} onNavigate={navigate} homeDir={me?.account?.homeDir} />
          <form className="fm-path-form" onSubmit={(e) => { e.preventDefault(); navigate(goTo); }}>
            <div className="input-group fm-path-go">
              <span className="muted" aria-hidden="true"><code>~/</code></span>
              <TextInput value={goTo} onChange={setGoTo} placeholder={t('panel.files.go_to_placeholder', 'Go to a folder')} aria-label={t('panel.files.go_to_folder', 'Go to folder')} spellCheck={false} />
            </div>
            <Button size="sm" type="submit">{t('panel.files.go', 'Go')}</Button>
            <Button size="sm" icon={RefreshCw} onClick={() => refetch()} aria-label={t('panel.files.refresh', 'Refresh')} title={t('panel.files.refresh', 'Refresh')} />
          </form>
        </div>
        {capability && <div className="card-body"><PanelCapabilityState error={error} onRetry={refetch} /></div>}
        {!capability && error && <div className="card-body" style={{ paddingBottom: 0 }}><RequestError error={error} onRetry={refetch} /></div>}
        {listing?.truncated && <div className="card-body"><div className="banner banner-warning" style={{ marginBottom: 0 }}><AlertTriangle size={18} /><div><strong>{fill(t('panel.files.truncated_listing', 'Only the first {shown} of {total} entries are shown'), { shown: entries.length.toLocaleString(), total: listing.total.toLocaleString() })}</strong><p>{t('panel.files.truncated_listing_help', 'Use the search to find the rest, or split this folder up.')}</p></div></div></div>}
        <DataTable
          dense
          columns={[
            { key: 'name', label: t('panel.files.col_name', 'Name'), sortable: true, render: (r) => { const Icon = entryIcon(r); return <button type="button" className="link-button" onClick={() => open(r)} title={typeText(r)}><Icon size={16} className="muted" aria-hidden="true" /> {r.name}</button>; } },
            { key: 'size', label: t('panel.files.col_size', 'Size'), sortable: true, align: 'right', render: (r) => (r.type === 'dir' ? <span className="muted">—</span> : formatBytes(r.size)) },
            { key: 'mtime', label: t('panel.files.col_modified', 'Modified'), sortable: true, render: (r) => formatDate(r.mtime) },
            { key: 'mode', label: t('panel.files.col_permissions', 'Permissions'), render: (r) => <code>{r.mode}</code> },
          ]}
          rows={rows} loading={loading || (Boolean(data) && !listing && !error)} error={null} rowKey={(r) => r.name}
          sort={sort.key} dir={sort.dir} onSortChange={(key, d) => setSort({ key, dir: d })}
          selectable selected={selected} onSelectedChange={setSelected}
          searchable={entries.length > 0} q={q} onSearch={setQ} searchPlaceholder={t('panel.files.filter_folder', 'Filter this folder')}
          toolbar={toolbar}
          rowActions={(r) => [
            r.type === 'dir' ? { label: t('panel.files.open', 'Open'), primary: true, onClick: () => open(r) } : null,
            r.type === 'file' && isEditable(r) ? { label: t('panel.files.edit', 'Edit'), primary: true, onClick: () => open(r) } : null,
            r.type === 'file' ? { label: t('panel.files.download', 'Download'), primary: r.type === 'file' && !isEditable(r), onClick: () => download(r) } : null,
            { label: t('panel.files.rename', 'Rename'), onClick: () => openModal('rename', r) },
            { label: t('panel.files.copy_to', 'Copy to…'), onClick: () => openModal('copy', r) },
            { label: t('panel.files.permissions', 'Permissions'), onClick: () => setPermFor(r) },
            r.type !== 'symlink' ? { label: t('panel.files.compress', 'Compress'), onClick: () => setCompress([relOf(r)]) } : null,
            r.type === 'file' && isArchiveName(r.name) ? { label: t('panel.files.extract', 'Extract'), onClick: () => setExtract(relOf(r)) } : null,
            { label: t('panel.files.delete', 'Delete'), danger: true, onClick: () => remove([r]) },
          ]}
          emptyText={capability ? t('panel.files.empty_capability', 'Files appear here once the file manager is available on this server.') : error ? t('panel.files.empty_error', 'The folder could not be read.') : q ? t('panel.files.empty_filter', 'Nothing in this folder matches the filter.') : dir ? t('panel.files.empty_folder', 'This folder is empty. Upload files or create a new file or folder with the buttons above.') : t('panel.files.empty_home', 'Your home directory is empty. Upload files or create a folder with the buttons above; public_html is where your website lives.')}
        />
        <div className="card-body muted small" style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
          <span>{listing ? plural(t, 'panel.files.n_items', entries.length, '{shown} item', '{shown} items', { shown: rows.length === entries.length ? entries.length : fill(t('panel.files.n_of_m', '{shown} of {total}'), { shown: rows.length, total: entries.length }) }) : ''}{!showHidden && hiddenCount ? ` · ${fill(t('panel.files.n_hidden', '{count} hidden'), { count: hiddenCount })}` : ''}</span>
          <span><Link to={diskUsageHref(dir)}><HardDrive size={12} style={{ verticalAlign: '-2px' }} /> {t('panel.files.disk_usage_of_folder', 'Disk usage of this folder')}</Link></span>
        </div>
      </Card>

      <NameModal open={modal?.kind === 'new-folder'} title={t('panel.files.new_folder', 'New folder')} label={t('panel.files.folder_name', 'Folder name')} help={<>{t('panel.files.created_in', 'Created in')} {here} {t('panel.files.with_mode_0755', 'with mode 0755')}</>} confirmLabel={t('panel.files.create_folder', 'Create folder')} busy={busy} error={modalError} onClose={closeModal} onSubmit={createFolder} existing={names} />
      <NameModal open={modal?.kind === 'new-file'} title={t('panel.files.new_file', 'New file')} label={t('panel.files.file_name', 'File name')} help={<>{t('panel.files.empty_file_in', 'An empty file in')} {here}{t('panel.files.open_afterwards', '; open it afterwards to add content')}</>} confirmLabel={t('panel.files.create_file', 'Create file')} busy={busy} error={modalError} onClose={closeModal} onSubmit={createFile} existing={names} />
      <NameModal open={modal?.kind === 'rename'} title={fill(t('panel.files.rename_name', 'Rename {name}'), { name: modal?.entry?.name ?? '' })} label={t('panel.files.new_name', 'New name')} initial={modal?.entry?.name ?? ''} confirmLabel={t('panel.files.rename', 'Rename')} busy={busy} error={modalError} onClose={closeModal} onSubmit={rename} existing={names} />
      <Modal open={modal?.kind === 'copy'} title={fill(t('panel.files.copy_name', 'Copy {name}'), { name: modal?.entry?.name ?? '' })} onClose={closeModal} size="sm"
        footer={<><Button onClick={closeModal}>{t('panel.files.cancel', 'Cancel')}</Button><Button variant="primary" loading={busy} disabled={!copyTo.trim() || copyTo.trim() === (modal?.entry ? relOf(modal.entry) : '')} onClick={() => copy(copyTo.trim())}>{t('panel.files.copy', 'Copy')}</Button></>}>
        <PanelCapabilityState error={modalError} />
        <RequestError error={modalError} />
        <Field label={t('panel.files.copy_to_label', 'Copy to')} required help={t('panel.files.copy_to_help', 'The full destination path relative to your home directory, including the new name')} error={modalError?.fields?.to} htmlFor="copy-to">
          <div className="input-group" style={{ alignItems: 'center' }}>
            <span className="muted" aria-hidden="true"><code>~/</code></span>
            <TextInput id="copy-to" value={copyTo} onChange={(v) => setModal((m) => ({ ...m, copyTo: v }))} spellCheck={false} autoFocus />
          </div>
        </Field>
      </Modal>

      <FileEditor path={editing} open={Boolean(editing)} confirmDiscard={confirm} onClose={() => setEditing(null)} onSaved={(res) => { toast.success(fill(t('panel.files.saved_name', '{path} saved'), { path: res.path })); refetch(); }} />
      <UploadModal open={uploading} dir={dir} onClose={() => setUploading(false)} onDone={(n) => { if (n) toast.success(plural(t, 'panel.files.files_uploaded', n, '{count} file uploaded', '{count} files uploaded')); refetch(); }} />
      <PermissionsModal entry={permFor} path={permFor ? relOf(permFor) : ''} onClose={() => setPermFor(null)} onSaved={(res) => { toast.success(fill(t('panel.files.mode_now', '{name} is now {mode}'), { name: permFor.name, mode: res.mode })); setPermFor(null); refetch(); }} />
      <CompressModal paths={compress} dir={dir} onClose={() => setCompress(null)} onFinished={(ev) => jobFinished(ev, t('panel.files.compressing', 'Compressing'))} />
      <ExtractModal archive={extract} onClose={() => setExtract(null)} onFinished={(ev) => jobFinished(ev, t('panel.files.extracting', 'Extracting'))} />
    </PanelPage>
  );
}
