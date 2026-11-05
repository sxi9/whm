import { useEffect, useRef, useState } from 'react';
import { Upload, AlertTriangle } from 'lucide-react';
import { formatBytes } from '../../../../components/Common.jsx';
import { Field, Toggle, Button } from '../../../../components/Form.jsx';
import { Modal } from '../../../../components/Modal.jsx';
import { PanelCapabilityState } from '../../../../panel/PanelPage.jsx';
import { api } from '../../../../api/client.js';
import { panelApi } from '../../../../panel/hooks/usePanel.js';
import { useT } from '../../../../i18n/useT.js';
import { fill, plural } from '../../../../i18n/fill.js';
import { RequestError } from './common.jsx';
import { joinRel } from './paths.js';

// Upload transport (contract §57): POST /files/uploads announces the file and
// pins chunkBytes; chunk i is PUT raw (application/octet-stream) to
// .../chunks/i; finish commits, abort removes the part. The server keeps the
// list of received chunks, so after a connection loss the client asks for it
// and sends only what is missing.
export const RESUME_DELAYS_MS = [1000, 2000, 5000, 10000, 20000, 30000, 30000, 30000];
const CANCELLED = () => Object.assign(new Error('Upload cancelled'), { code: 'cancelled' });

// A transport failure (fetch rejected, 502/503/504 from a proxy or the panel
// restarting, 408/429) is worth a resume; any other answer is final.
export function isTransient(err) {
  if (!err) return false;
  if (err.status == null) return err.name === 'TypeError' || err.code === 'error' || /fetch|network/i.test(String(err.message));
  return [408, 429, 502, 503, 504].includes(err.status);
}

// The chunk indices still to send: every index not in `received` (sorted or not).
export function missingChunks(chunkCount, received = []) {
  const have = new Set(received);
  const out = [];
  for (let i = 0; i < chunkCount; i += 1) if (!have.has(i)) out.push(i);
  return out;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function uploadFile(file, dir, { overwrite = false, onProgress, onStatus, isCancelled, delays = RESUME_DELAYS_MS } = {}) {
  if (file.size === 0) {
    const { data } = await panelApi.put('/files/write', { path: joinRel(dir, file.name), content: '' });
    onProgress?.(0);
    return { path: data.path, bytes: 0 };
  }
  const { data: u } = await panelApi.post('/files/uploads', { path: dir, name: file.name, size: file.size, overwrite });
  const chunk = Number(u.chunkBytes) > 0 ? Number(u.chunkBytes) : 1_310_720;
  const chunkCount = Number(u.chunkCount) || Math.ceil(file.size / chunk);
  let queue = missingChunks(chunkCount, u.receivedChunks);
  let received = Number(u.received) || 0;
  let retries = 0;
  const check = () => { if (isCancelled?.()) throw CANCELLED(); };
  try {
    while (queue.length) {
      check();
      const index = queue[0];
      try {
        const body = await file.slice(index * chunk, Math.min(file.size, (index + 1) * chunk)).arrayBuffer();
        const { data: st } = await api.putRaw(`/panel/files/uploads/${u.id}/chunks/${index}`, body, 'application/octet-stream');
        queue.shift();
        received = Number(st?.received) || received + body.byteLength;
        retries = 0;
        onStatus?.('running');
        onProgress?.(received);
      } catch (err) {
        if (!isTransient(err) || retries >= delays.length) throw err;
        onStatus?.('reconnecting');
        await sleep(delays[retries]);
        retries += 1;
        check();
        // The answer to the lost chunk may have been lost on the way back only:
        // the server's list decides what is still missing.
        const st = await panelApi.get(`/files/uploads/${u.id}`).then((r) => r.data).catch((e) => { if (isTransient(e)) return null; throw e; });
        if (st) { queue = missingChunks(chunkCount, st.receivedChunks); received = Number(st.received) || 0; onProgress?.(received); }
      }
    }
    const { data } = await panelApi.post(`/files/uploads/${u.id}/finish`);
    return data;
  } catch (err) {
    await panelApi.post(`/files/uploads/${u.id}/abort`).catch(() => {});
    throw err;
  }
}

// The files of a drop, without folders (a folder arrives as an entry whose
// isDirectory is set, or as a file without a type and with a 0/4096 size on
// browsers that lack webkitGetAsEntry; those are reported, never uploaded).
export function filesOfDrop(dataTransfer) {
  const items = dataTransfer?.items ? Array.from(dataTransfer.items) : null;
  const files = [];
  let folders = 0;
  if (items && items.some((it) => typeof it.webkitGetAsEntry === 'function')) {
    for (const it of items) {
      if (it.kind !== 'file') continue;
      const entry = it.webkitGetAsEntry?.();
      if (entry?.isDirectory) { folders += 1; continue; }
      const f = it.getAsFile?.();
      if (f) files.push(f);
    }
  } else {
    for (const f of Array.from(dataTransfer?.files || [])) {
      if (!f.type && (f.size === 0 || f.size % 4096 === 0) && !/\.[^.]+$/.test(f.name)) folders += 1; else files.push(f);
    }
  }
  return { files, folders };
}

export function UploadModal({ open, dir, initialFiles = null, onClose, onDone }) {
  const { t } = useT();
  const [files, setFiles] = useState([]);
  const [overwrite, setOverwrite] = useState(false);
  const [rows, setRows] = useState([]);
  const [running, setRunning] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [skippedFolders, setSkippedFolders] = useState(0);
  const cancelled = useRef(false);
  const inputRef = useRef(null);

  useEffect(() => { if (open && initialFiles?.length) { setFiles(initialFiles); setRows([]); } }, [open, initialFiles]);

  const reset = () => { setFiles([]); setRows([]); setSkippedFolders(0); cancelled.current = false; };
  const close = () => { if (running) cancelled.current = true; else { reset(); onClose?.(); } };
  const addFiles = (list) => setFiles((prev) => { const names = new Set(prev.map((f) => f.name)); return [...prev, ...list.filter((f) => !names.has(f.name))]; });
  const drop = (e) => {
    e.preventDefault(); setDragging(false);
    if (running) return;
    const { files: dropped, folders } = filesOfDrop(e.dataTransfer);
    setSkippedFolders(folders);
    if (dropped.length) addFiles(dropped);
  };

  const start = async () => {
    setRunning(true); cancelled.current = false;
    const list = files.map((f) => ({ name: f.name, size: f.size, sent: 0, status: 'queued', error: null }));
    setRows(list);
    let okCount = 0;
    for (let i = 0; i < files.length; i += 1) {
      if (cancelled.current) { setRows((r) => r.map((x, j) => (j >= i ? { ...x, status: 'cancelled' } : x))); break; }
      setRows((r) => r.map((x, j) => (j === i ? { ...x, status: 'running' } : x)));
      try {
        await uploadFile(files[i], dir, {
          overwrite,
          isCancelled: () => cancelled.current,
          onProgress: (sent) => setRows((r) => r.map((x, j) => (j === i ? { ...x, sent } : x))),
          onStatus: (status) => setRows((r) => r.map((x, j) => (j === i ? { ...x, status } : x))),
        });
        okCount += 1;
        setRows((r) => r.map((x, j) => (j === i ? { ...x, status: 'done', sent: x.size } : x)));
      } catch (error) {
        setRows((r) => r.map((x, j) => (j === i ? { ...x, status: error.code === 'cancelled' ? 'cancelled' : 'failed', error } : x)));
      }
    }
    setRunning(false);
    onDone?.(okCount);
  };

  const total = files.reduce((s, f) => s + f.size, 0);
  const finished = rows.length > 0 && !running;
  const statusText = { queued: t('panel.files.upload_queued', 'queued'), running: t('panel.files.upload_running', 'running'), reconnecting: t('panel.files.upload_reconnecting', 'connection lost, retrying'), done: t('panel.files.upload_done', 'done'), failed: t('panel.files.upload_failed', 'failed'), cancelled: t('panel.files.upload_cancelled', 'cancelled') };
  return (
    <Modal open={open} title={fill(t('panel.files.upload_to', 'Upload to {dir}'), { dir: dir ? `~/${dir}` : t('panel.files.the_home_directory', 'the home directory') })} onClose={close} size="md"
      footer={(
        <>
          <Button onClick={close}>{running ? t('panel.files.cancel', 'Cancel') : finished ? t('panel.files.done', 'Done') : t('panel.files.close', 'Close')}</Button>
          {!finished && <Button variant="primary" icon={Upload} loading={running} disabled={!files.length || running} onClick={start}>{files.length ? fill(plural(t, 'panel.files.upload_n_files', files.length, 'Upload {count} file ({size})', 'Upload {count} files ({size})'), { size: formatBytes(total) }) : t('panel.files.upload', 'Upload')}</Button>}
          {finished && <Button variant="primary" onClick={() => { reset(); inputRef.current?.click(); }}>{t('panel.files.upload_more', 'Upload more')}</Button>}
        </>
      )}>
      {!rows.length && (
        <>
          <div className={`fm-dropzone${dragging ? ' active' : ''}`} onDragOver={(e) => { e.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={drop}>
            <Field label={t('panel.files.files', 'Files')} help={t('panel.files.upload_files_help', 'Up to 20 GB per file; large files are sent in pieces so a slow connection still gets there')} htmlFor="upload-files">
              <input ref={inputRef} id="upload-files" className="input" type="file" multiple style={{ height: 'auto', padding: 8 }} onChange={(e) => addFiles(Array.from(e.target.files || []))} />
            </Field>
            <p className="muted small"><Upload size={12} style={{ verticalAlign: '-2px' }} /> {t('panel.files.drop_here', 'Or drop files here. An upload interrupted by a connection loss resumes where it stopped.')}</p>
          </div>
          {skippedFolders > 0 && <p className="small" style={{ marginTop: 8 }}><AlertTriangle size={12} style={{ verticalAlign: '-2px' }} /> {plural(t, 'panel.files.folders_skipped', skippedFolders, '{count} folder was skipped: compress it first and extract the archive here.', '{count} folders were skipped: compress them first and extract the archive here.')}</p>}
          <Toggle checked={overwrite} onChange={setOverwrite} label={t('panel.files.replace_existing', 'Replace files that already exist')} description={t('panel.files.replace_existing_help', 'Off: an upload with the name of an existing file is refused')} />
          {files.length > 0 && (
            <ul className="list-plain" style={{ marginTop: 12 }}>
              {files.map((f) => <li key={f.name} className="small" style={{ display: 'flex', justifyContent: 'space-between', gap: 12, padding: '4px 0' }}><code>{f.name}</code><span className="muted">{formatBytes(f.size)}</span></li>)}
            </ul>
          )}
        </>
      )}
      {rows.length > 0 && (
        <ul className="list-plain">
          {rows.map((r) => {
            const pct = r.size ? Math.min(100, Math.round((r.sent / r.size) * 100)) : 100;
            return (
              <li key={r.name} style={{ padding: '8px 0' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }} className="small">
                  <code>{r.name}</code>
                  <span className="muted">{r.status === 'done' ? formatBytes(r.size) : fill(t('panel.files.sent_of', '{sent} of {size}'), { sent: formatBytes(r.sent), size: formatBytes(r.size) })} · {statusText[r.status] || r.status}</span>
                </div>
                <div className={`meter ${r.status === 'failed' ? 'bad' : ''}`}><span style={{ width: `${pct}%` }} /></div>
                {r.error && r.error.code !== 'cancelled' && <div style={{ marginTop: 8 }}><PanelCapabilityState error={r.error} /><RequestError error={r.error} /></div>}
              </li>
            );
          })}
        </ul>
      )}
      {!rows.length && !files.length && <p className="muted small" style={{ marginTop: 8 }}><AlertTriangle size={12} style={{ verticalAlign: '-2px' }} /> {t('panel.files.folders_not_uploadable', 'Folders cannot be uploaded as such: compress them first and extract the archive here.')}</p>}
    </Modal>
  );
}
