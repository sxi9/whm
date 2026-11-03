import { useEffect, useState } from 'react';
import { AlertTriangle, Save } from 'lucide-react';
import { Loading, formatBytes, formatDate } from '../../../../components/Common.jsx';
import { Textarea, Button } from '../../../../components/Form.jsx';
import { Modal } from '../../../../components/Modal.jsx';
import { PanelCapabilityState } from '../../../../panel/PanelPage.jsx';
import { panelApi } from '../../../../panel/hooks/usePanel.js';
import { RequestError } from './common.jsx';
import { MAX_TEXT_BYTES } from './paths.js';

// Text editor for one file under the 4 MiB limit. A truncated read cannot be
// saved back: writing it would cut the file to what the editor received.
export function FileEditor({ path, open, onClose, onSaved, confirmDiscard }) {
  const [state, setState] = useState({ loading: false, error: null, file: null });
  const [content, setContent] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(null);

  useEffect(() => {
    if (!open || !path) return undefined;
    let alive = true;
    setState({ loading: true, error: null, file: null });
    setContent('');
    setSaveError(null);
    panelApi.get(`/files/read?path=${encodeURIComponent(path)}&maxBytes=${MAX_TEXT_BYTES}`)
      .then((res) => { if (alive) { setState({ loading: false, error: null, file: res.data }); setContent(res.data?.content ?? ''); } })
      .catch((error) => { if (alive) setState({ loading: false, error, file: null }); });
    return () => { alive = false; };
  }, [open, path]);

  const dirty = state.file && content !== (state.file.content ?? '');
  const bytes = typeof TextEncoder === 'undefined' ? content.length : new TextEncoder().encode(content).length;
  const tooLarge = bytes > MAX_TEXT_BYTES;
  const canSave = Boolean(state.file) && !state.file.truncated && !tooLarge && !saving;

  const save = async () => {
    setSaving(true); setSaveError(null);
    try {
      const { data } = await panelApi.put('/files/write', { path, content });
      setState((s) => ({ ...s, file: { ...s.file, content, size: data.bytes, mode: data.mode } }));
      onSaved?.(data);
    } catch (err) { setSaveError(err); } finally { setSaving(false); }
  };

  const close = async () => {
    if (dirty && confirmDiscard && !(await confirmDiscard({ title: 'Discard the changes?', message: 'Everything typed since the last save is lost.', confirmLabel: 'Discard', danger: true }))) return;
    onClose?.();
  };

  return (
    <Modal open={open} title={path ? `Edit ${path}` : 'Edit file'} onClose={close} size="lg"
      footer={(
        <>
          <span className="muted small" style={{ marginRight: 'auto' }}>
            {state.file && <>{formatBytes(bytes)}{state.file.mode && <> · <code>{state.file.mode}</code></>}{state.file.mtime && <> · saved {formatDate(state.file.mtime)}</>}{dirty && ' · unsaved changes'}</>}
          </span>
          <Button onClick={close}>{dirty ? 'Discard' : 'Close'}</Button>
          <Button variant="primary" icon={Save} loading={saving} disabled={!canSave || !dirty} onClick={save}>Save</Button>
        </>
      )}>
      {state.loading && <Loading text="Opening file…" />}
      <PanelCapabilityState error={state.error} />
      {state.error?.code === 'binary' && <div className="banner banner-warning"><AlertTriangle size={18} /><div><strong>Not a text file</strong><p>{state.error.message}</p><p className="muted">Download it instead, or upload a replacement.</p></div></div>}
      {state.error?.code !== 'binary' && <RequestError error={state.error} />}
      <RequestError error={saveError} />
      {state.file?.truncated && <div className="banner banner-warning"><AlertTriangle size={18} /><div><strong>Only the first {formatBytes(MAX_TEXT_BYTES)} are shown</strong><p>The file is {formatBytes(state.file.size)}; saving is disabled so nothing is cut off. Download it to edit the whole file.</p></div></div>}
      {tooLarge && <div className="banner banner-error" role="alert"><AlertTriangle size={18} /><div>The content is larger than {formatBytes(MAX_TEXT_BYTES)}, the most the editor can save.</div></div>}
      {state.file && <Textarea value={content} onChange={setContent} rows={24} mono spellCheck={false} aria-label="File content" />}
    </Modal>
  );
}
