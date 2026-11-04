import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { RefreshCw, Upload, FolderPlus, FilePlus, ArrowUp, Folder, FileText, File, Link2, FileArchive, AlertTriangle, Trash2, Archive, Eye, EyeOff, HardDrive } from 'lucide-react';
import { Card, formatBytes, formatDate } from '../../../components/Common.jsx';
import { DataTable } from '../../../components/DataTable.jsx';
import { Field, TextInput, Button } from '../../../components/Form.jsx';
import { useToast } from '../../../components/Toast.jsx';
import { useConfirm, Modal } from '../../../components/Modal.jsx';
import { api } from '../../../api/client.js';
import { PanelPage, PanelCapabilityState, FeatureDisabledState } from '../../../panel/PanelPage.jsx';
import { usePanelApi, usePanelMe, panelApi } from '../../../panel/hooks/usePanel.js';
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
  if (entry.type === 'dir') return 'Folder';
  if (entry.type === 'symlink') return 'Link';
  if (entry.type === 'file') return isArchiveName(entry.name) ? 'Archive' : 'File';
  return 'Other';
}

export function deleteFiles(paths) {
  return api.request('DELETE', '/panel/files', { paths });
}

function NameModal({ open, title, label, initial = '', help, confirmLabel, busy, error, onClose, onSubmit, existing = [] }) {
  const [value, setValue] = useState(initial);
  useEffect(() => { if (open) setValue(initial); }, [open, initial]);
  const trimmed = value.trim();
  const clash = trimmed && trimmed !== initial && existing.includes(trimmed);
  const bad = trimmed && !NAME_RE.test(trimmed);
  const local = clash ? [`${trimmed} already exists in this folder`] : bad ? ['A name without "/"; "." and ".." are not allowed'] : null;
  return (
    <Modal open={open} title={title} onClose={onClose} size="sm"
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} disabled={!trimmed || Boolean(local) || trimmed === initial} onClick={() => onSubmit(trimmed)}>{confirmLabel}</Button></>}>
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
    if (clean == null) { toast.error('Paths with ".." are not allowed'); return; }
    setParams(clean ? { path: clean } : {});
  }, [setParams, toast]);

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

  const run = async (work, success) => {
    setBusy(true); setModalError(null);
    try {
      const res = await work();
      if (success) toast.success(typeof success === 'function' ? success(res) : success);
      closeModal();
      refetch();
    } catch (err) { setModalError(err); } finally { setBusy(false); }
  };

  const createFolder = (name) => run(() => panelApi.post('/files/mkdir', { path: joinRel(dir, name), mode: '0755' }), `Folder ${name} created`);
  const createFile = (name) => run(() => panelApi.put('/files/write', { path: joinRel(dir, name), content: '' }), `File ${name} created`);
  const rename = (name) => run(() => panelApi.post('/files/rename', { from: relOf(modal.entry), to: joinRel(dir, name) }), `${modal.entry.name} renamed to ${name}`);
  const copy = (to) => run(() => panelApi.post('/files/copy', { from: relOf(modal.entry), to: normalizeRel(to) ?? to }), `${modal.entry.name} copied`);

  const open = (entry) => {
    if (entry.type === 'dir') navigate(relOf(entry));
    else if (isEditable(entry)) setEditing(relOf(entry));
    else if (entry.type === 'file') toast.info(`${entry.name} is larger than ${formatBytes(MAX_TEXT_BYTES)}; download it to view it.`);
    else toast.info(`${entry.name} is a ${typeText(entry).toLowerCase()} and cannot be opened here.`);
  };

  const download = (entry) => { if (typeof window !== 'undefined') window.location.assign(downloadHref(relOf(entry))); };

  const remove = async (targets) => {
    const list = targets.map((e) => e.name);
    const ok = await confirm({
      title: list.length === 1 ? `Delete ${list[0]}?` : `Delete ${list.length} items?`,
      message: `${list.length === 1 ? 'It is' : 'They are'} removed permanently${targets.some((e) => e.type === 'dir') ? ', including everything inside the folders' : ''}. There is no trash to recover from.`,
      confirmLabel: 'Delete', danger: true, typeToConfirm: list.length > 1 ? 'delete' : undefined,
    });
    if (!ok) return;
    try {
      const { data: res } = await deleteFiles(targets.map(relOf));
      toast.success(`${res?.removed?.length ?? list.length} item${(res?.removed?.length ?? list.length) === 1 ? '' : 's'} deleted`);
      setSelected([]);
      refetch();
    } catch (err) { toast.error(err); }
  };

  const jobFinished = (ev, what) => {
    if (ev.type === 'done') toast.success(`${what} finished`); else if (ev.type === 'failed') toast.error(ev.error || `${what} failed`);
    refetch();
  };

  const toolbar = (
    <>
      <button type="button" className="btn btn-sm btn-ghost" onClick={() => setShowHidden((v) => !v)} aria-pressed={showHidden} title={showHidden ? 'Hide dotfiles' : 'Show dotfiles'}>{showHidden ? <EyeOff size={14} /> : <Eye size={14} />} {showHidden ? 'Hide hidden' : `Show hidden${hiddenCount ? ` (${hiddenCount})` : ''}`}</button>
      {selected.length > 0 && (
        <>
          <span className="muted small">{selected.length} selected</span>
          <Button size="sm" icon={Archive} onClick={() => setCompress(selectedRows.map(relOf))}>Compress</Button>
          <Button size="sm" variant="danger-ghost" icon={Trash2} onClick={() => remove(selectedRows)}>Delete</Button>
          <Button size="sm" variant="ghost" onClick={() => setSelected([])}>Clear</Button>
        </>
      )}
    </>
  );

  return (
    <PanelPage fn={fn} actions={(
      <>
        <Button icon={FilePlus} onClick={() => openModal('new-file')}>New file</Button>
        <Button icon={FolderPlus} onClick={() => openModal('new-folder')}>New folder</Button>
        <Button variant="primary" icon={Upload} onClick={() => setUploading(true)}>Upload</Button>
      </>
    )}>
      <Card padded={false}>
        <div className="card-body" style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <Button size="sm" icon={ArrowUp} onClick={() => navigate(parentOf(dir))} disabled={!dir} aria-label="Up one level" title="Up one level" />
          <PathBar path={dir} onNavigate={navigate} homeDir={me?.account?.homeDir} />
          <form style={{ marginLeft: 'auto', display: 'flex', gap: 6, alignItems: 'center' }} onSubmit={(e) => { e.preventDefault(); navigate(goTo); }}>
            <div className="input-group" style={{ width: 300, alignItems: 'center' }}>
              <span className="muted" aria-hidden="true"><code>~/</code></span>
              <TextInput value={goTo} onChange={setGoTo} placeholder="Go to a folder" aria-label="Go to folder" spellCheck={false} />
            </div>
            <Button size="sm" type="submit">Go</Button>
            <Button size="sm" icon={RefreshCw} onClick={() => refetch()} aria-label="Refresh" title="Refresh" />
          </form>
        </div>
        {capability && <div className="card-body"><PanelCapabilityState error={error} onRetry={refetch} /></div>}
        {!capability && error && <div className="card-body" style={{ paddingBottom: 0 }}><RequestError error={error} onRetry={refetch} /></div>}
        {listing?.truncated && <div className="card-body"><div className="banner banner-warning" style={{ marginBottom: 0 }}><AlertTriangle size={18} /><div><strong>Only the first {entries.length.toLocaleString()} of {listing.total.toLocaleString()} entries are shown</strong><p>Use the search to find the rest, or split this folder up.</p></div></div></div>}
        <DataTable
          dense
          columns={[
            { key: 'name', label: 'Name', sortable: true, render: (r) => { const Icon = entryIcon(r); return <button type="button" className="link-button" onClick={() => open(r)} title={typeText(r)}><Icon size={16} className="muted" aria-hidden="true" /> {r.name}</button>; } },
            { key: 'size', label: 'Size', sortable: true, align: 'right', render: (r) => (r.type === 'dir' ? <span className="muted">—</span> : formatBytes(r.size)) },
            { key: 'mtime', label: 'Modified', sortable: true, render: (r) => formatDate(r.mtime) },
            { key: 'mode', label: 'Permissions', render: (r) => <code>{r.mode}</code> },
          ]}
          rows={rows} loading={loading || (Boolean(data) && !listing && !error)} error={null} rowKey={(r) => r.name}
          sort={sort.key} dir={sort.dir} onSortChange={(key, d) => setSort({ key, dir: d })}
          selectable selected={selected} onSelectedChange={setSelected}
          searchable={entries.length > 0} q={q} onSearch={setQ} searchPlaceholder="Filter this folder"
          toolbar={toolbar}
          rowActions={(r) => [
            r.type === 'dir' ? { label: 'Open', primary: true, onClick: () => open(r) } : null,
            r.type === 'file' && isEditable(r) ? { label: 'Edit', primary: true, onClick: () => open(r) } : null,
            r.type === 'file' ? { label: 'Download', primary: r.type === 'file' && !isEditable(r), onClick: () => download(r) } : null,
            { label: 'Rename', onClick: () => openModal('rename', r) },
            { label: 'Copy to…', onClick: () => openModal('copy', r) },
            { label: 'Permissions', onClick: () => setPermFor(r) },
            r.type !== 'symlink' ? { label: 'Compress', onClick: () => setCompress([relOf(r)]) } : null,
            r.type === 'file' && isArchiveName(r.name) ? { label: 'Extract', onClick: () => setExtract(relOf(r)) } : null,
            { label: 'Delete', danger: true, onClick: () => remove([r]) },
          ]}
          emptyText={capability ? 'Files appear here once the file manager is available on this server.' : error ? 'The folder could not be read.' : q ? 'Nothing in this folder matches the filter.' : dir ? 'This folder is empty. Upload files or create a new file or folder with the buttons above.' : 'Your home directory is empty. Upload files or create a folder with the buttons above; public_html is where your website lives.'}
        />
        <div className="card-body muted small" style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
          <span>{listing ? `${rows.length === entries.length ? entries.length : `${rows.length} of ${entries.length}`} item${entries.length === 1 ? '' : 's'}` : ''}{!showHidden && hiddenCount ? ` · ${hiddenCount} hidden` : ''}</span>
          <span><Link to={diskUsageHref(dir)}><HardDrive size={12} style={{ verticalAlign: '-2px' }} /> Disk usage of this folder</Link></span>
        </div>
      </Card>

      <NameModal open={modal?.kind === 'new-folder'} title="New folder" label="Folder name" help={<>Created in <code>{dir ? `~/${dir}` : '~'}</code> with mode 0755</>} confirmLabel="Create folder" busy={busy} error={modalError} onClose={closeModal} onSubmit={createFolder} existing={names} />
      <NameModal open={modal?.kind === 'new-file'} title="New file" label="File name" help={<>An empty file in <code>{dir ? `~/${dir}` : '~'}</code>; open it afterwards to add content</>} confirmLabel="Create file" busy={busy} error={modalError} onClose={closeModal} onSubmit={createFile} existing={names} />
      <NameModal open={modal?.kind === 'rename'} title={`Rename ${modal?.entry?.name ?? ''}`} label="New name" initial={modal?.entry?.name ?? ''} confirmLabel="Rename" busy={busy} error={modalError} onClose={closeModal} onSubmit={rename} existing={names} />
      <Modal open={modal?.kind === 'copy'} title={`Copy ${modal?.entry?.name ?? ''}`} onClose={closeModal} size="sm"
        footer={<><Button onClick={closeModal}>Cancel</Button><Button variant="primary" loading={busy} disabled={!copyTo.trim() || copyTo.trim() === (modal?.entry ? relOf(modal.entry) : '')} onClick={() => copy(copyTo.trim())}>Copy</Button></>}>
        <PanelCapabilityState error={modalError} />
        <RequestError error={modalError} />
        <Field label="Copy to" required help="The full destination path relative to your home directory, including the new name" error={modalError?.fields?.to} htmlFor="copy-to">
          <div className="input-group" style={{ alignItems: 'center' }}>
            <span className="muted" aria-hidden="true"><code>~/</code></span>
            <TextInput id="copy-to" value={copyTo} onChange={(v) => setModal((m) => ({ ...m, copyTo: v }))} spellCheck={false} autoFocus />
          </div>
        </Field>
      </Modal>

      <FileEditor path={editing} open={Boolean(editing)} confirmDiscard={confirm} onClose={() => setEditing(null)} onSaved={(res) => { toast.success(`${res.path} saved`); refetch(); }} />
      <UploadModal open={uploading} dir={dir} onClose={() => setUploading(false)} onDone={(n) => { if (n) toast.success(`${n} file${n === 1 ? '' : 's'} uploaded`); refetch(); }} />
      <PermissionsModal entry={permFor} path={permFor ? relOf(permFor) : ''} onClose={() => setPermFor(null)} onSaved={(res) => { toast.success(`${permFor.name} is now ${res.mode}`); setPermFor(null); refetch(); }} />
      <CompressModal paths={compress} dir={dir} onClose={() => setCompress(null)} onFinished={(ev) => jobFinished(ev, 'Compressing')} />
      <ExtractModal archive={extract} onClose={() => setExtract(null)} onFinished={(ev) => jobFinished(ev, 'Extracting')} />
    </PanelPage>
  );
}
