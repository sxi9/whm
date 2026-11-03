import { useEffect, useState } from 'react';
import { Archive, PackageOpen } from 'lucide-react';
import { Field, TextInput, Select, Button } from '../../../../components/Form.jsx';
import { Modal } from '../../../../components/Modal.jsx';
import { PanelCapabilityState } from '../../../../panel/PanelPage.jsx';
import { panelApi } from '../../../../panel/hooks/usePanel.js';
import { RequestError } from './common.jsx';
import { JobProgress } from './JobProgress.jsx';
import { joinRel, normalizeRel, archiveNameFor, parentOf } from './paths.js';

const FORMATS = [{ value: 'zip', label: 'Zip (.zip)' }, { value: 'tar.gz', label: 'Gzipped tar (.tar.gz)' }];

// Both dialogs enqueue a 202 job and follow it on the panel's own job stream;
// the caller refreshes the listing when the job finishes.
export function CompressModal({ paths, dir, onClose, onFinished }) {
  const open = Boolean(paths?.length);
  const [format, setFormat] = useState('zip');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [job, setJob] = useState(null);
  useEffect(() => { if (open) { setFormat('zip'); setName(archiveNameFor(paths, 'zip')); setError(null); setJob(null); } }, [open, paths]);
  const changeFormat = (f) => { setFormat(f); setName((n) => n.replace(/\.(zip|tar\.gz|tgz)$/i, '') + `.${f}`); };

  const start = async () => {
    setBusy(true); setError(null);
    try {
      const { data } = await panelApi.post('/files/archive', { paths, dest: joinRel(dir, name.trim()), format });
      setJob(data.job);
    } catch (err) { setError(err); } finally { setBusy(false); }
  };

  return (
    <Modal open={open} title={paths?.length === 1 ? `Compress ${paths[0].split('/').pop()}` : `Compress ${paths?.length || 0} items`} onClose={onClose} size="md"
      footer={<><Button onClick={onClose}>{job ? 'Close' : 'Cancel'}</Button>{!job && <Button variant="primary" icon={Archive} loading={busy} disabled={!name.trim()} onClick={start}>Create archive</Button>}</>}>
      <PanelCapabilityState error={error} />
      <RequestError error={error} />
      {!job && (
        <>
          <Field label="Format" htmlFor="archive-format"><Select id="archive-format" value={format} onChange={changeFormat} options={FORMATS} /></Field>
          <Field label="Archive name" required help={<>Created in <code>{dir ? `~/${dir}` : '~'}</code>; it must end in .{format}</>} error={error?.fields?.dest} htmlFor="archive-name">
            <TextInput id="archive-name" value={name} onChange={setName} spellCheck={false} />
          </Field>
          <p className="muted small">{paths?.length} item{paths?.length === 1 ? '' : 's'} will be included. Existing archives are never overwritten.</p>
        </>
      )}
      {job && <JobProgress jobId={job.id} onFinished={(ev) => onFinished?.(ev)} />}
    </Modal>
  );
}

export function ExtractModal({ archive, onClose, onFinished }) {
  const open = Boolean(archive);
  const [dest, setDest] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [job, setJob] = useState(null);
  useEffect(() => { if (open) { setDest(parentOf(archive)); setError(null); setJob(null); } }, [open, archive]);

  const start = async () => {
    const clean = normalizeRel(dest);
    if (clean == null) { setError({ message: 'Choose a folder inside your home directory', fields: { dest: ['".." is not allowed'] } }); return; }
    setBusy(true); setError(null);
    try {
      const { data } = await panelApi.post('/files/extract', { archive, dest: clean });
      setJob(data.job);
    } catch (err) { setError(err); } finally { setBusy(false); }
  };

  return (
    <Modal open={open} title={archive ? `Extract ${archive.split('/').pop()}` : ''} onClose={onClose} size="md"
      footer={<><Button onClick={onClose}>{job ? 'Close' : 'Cancel'}</Button>{!job && <Button variant="primary" icon={PackageOpen} loading={busy} onClick={start}>Extract</Button>}</>}>
      <PanelCapabilityState error={error} />
      <RequestError error={error} />
      {!job && (
        <Field label="Extract into" help="A folder relative to your home directory; leave empty for the home directory itself. It is created if missing." error={error?.fields?.dest || error?.fields?.archive} htmlFor="extract-dest">
          <div className="input-group" style={{ alignItems: 'center' }}>
            <span className="muted" aria-hidden="true"><code>~/</code></span>
            <TextInput id="extract-dest" value={dest} onChange={setDest} placeholder="public_html" spellCheck={false} />
          </div>
        </Field>
      )}
      {job && <JobProgress jobId={job.id} onFinished={(ev) => onFinished?.(ev)} />}
    </Modal>
  );
}
