import { useRef, useState } from 'react';
import { Upload, AlertTriangle } from 'lucide-react';
import { formatBytes } from '../../../../components/Common.jsx';
import { Field, Toggle, Button } from '../../../../components/Form.jsx';
import { Modal } from '../../../../components/Modal.jsx';
import { PanelCapabilityState } from '../../../../panel/PanelPage.jsx';
import { panelApi } from '../../../../panel/hooks/usePanel.js';
import { useT } from '../../../../i18n/useT.js';
import { fill, plural } from '../../../../i18n/fill.js';
import { RequestError } from './common.jsx';
import { bytesToBase64, joinRel } from './paths.js';

// Chunked upload protocol: POST /files/uploads announces the file, every PUT
// .../chunks carries chunkBytes of base64, finish commits, abort removes the part.
export async function uploadFile(file, dir, { overwrite = false, onProgress, isCancelled } = {}) {
  if (file.size === 0) {
    const { data } = await panelApi.put('/files/write', { path: joinRel(dir, file.name), content: '' });
    onProgress?.(0);
    return { path: data.path, bytes: 0 };
  }
  const { data: u } = await panelApi.post('/files/uploads', { path: dir, name: file.name, size: file.size, overwrite });
  const chunk = Math.max(1024, Number(u.chunkBytes) || 1_310_720);
  let offset = 0;
  try {
    while (offset < file.size) {
      if (isCancelled?.()) throw Object.assign(new Error('Upload cancelled'), { code: 'cancelled' });
      const bytes = new Uint8Array(await file.slice(offset, offset + chunk).arrayBuffer());
      const { data: st } = await panelApi.put(`/files/uploads/${u.id}/chunks`, { data: bytesToBase64(bytes) });
      offset += bytes.length;
      onProgress?.(st?.received ?? offset);
    }
    const { data } = await panelApi.post(`/files/uploads/${u.id}/finish`);
    return data;
  } catch (err) {
    await panelApi.post(`/files/uploads/${u.id}/abort`).catch(() => {});
    throw err;
  }
}

export function UploadModal({ open, dir, onClose, onDone }) {
  const { t } = useT();
  const [files, setFiles] = useState([]);
  const [overwrite, setOverwrite] = useState(false);
  const [rows, setRows] = useState([]);
  const [running, setRunning] = useState(false);
  const cancelled = useRef(false);
  const inputRef = useRef(null);

  const reset = () => { setFiles([]); setRows([]); cancelled.current = false; };
  const close = () => { if (running) cancelled.current = true; else { reset(); onClose?.(); } };

  const start = async () => {
    setRunning(true); cancelled.current = false;
    const list = files.map((f) => ({ name: f.name, size: f.size, sent: 0, status: 'queued', error: null }));
    setRows(list);
    let okCount = 0;
    for (let i = 0; i < files.length; i += 1) {
      if (cancelled.current) { setRows((r) => r.map((x, j) => (j >= i ? { ...x, status: 'cancelled' } : x))); break; }
      setRows((r) => r.map((x, j) => (j === i ? { ...x, status: 'running' } : x)));
      try {
        await uploadFile(files[i], dir, { overwrite, isCancelled: () => cancelled.current, onProgress: (sent) => setRows((r) => r.map((x, j) => (j === i ? { ...x, sent } : x))) });
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
  const statusText = { queued: t('panel.files.upload_queued', 'queued'), running: t('panel.files.upload_running', 'running'), done: t('panel.files.upload_done', 'done'), failed: t('panel.files.upload_failed', 'failed'), cancelled: t('panel.files.upload_cancelled', 'cancelled') };
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
          <Field label={t('panel.files.files', 'Files')} help={t('panel.files.upload_files_help', 'Up to 20 GB per file; large files are sent in pieces so a slow connection still gets there')} htmlFor="upload-files">
            <input ref={inputRef} id="upload-files" className="input" type="file" multiple style={{ height: 'auto', padding: 8 }} onChange={(e) => setFiles(Array.from(e.target.files || []))} />
          </Field>
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
