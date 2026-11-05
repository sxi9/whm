import { useEffect, useState } from 'react';
import { Archive, PackageOpen } from 'lucide-react';
import { Field, TextInput, Select, Button } from '../../../../components/Form.jsx';
import { Modal } from '../../../../components/Modal.jsx';
import { PanelCapabilityState } from '../../../../panel/PanelPage.jsx';
import { panelApi } from '../../../../panel/hooks/usePanel.js';
import { useT } from '../../../../i18n/useT.js';
import { fill, plural } from '../../../../i18n/fill.js';
import { RequestError } from './common.jsx';
import { JobProgress } from './JobProgress.jsx';
import { joinRel, normalizeRel, archiveNameFor, parentOf } from './paths.js';

// Both dialogs enqueue a 202 job and follow it on the panel's own job stream;
// the caller refreshes the listing when the job finishes.
export function CompressModal({ paths, dir, onClose, onFinished }) {
  const { t } = useT();
  const open = Boolean(paths?.length);
  const [format, setFormat] = useState('zip');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [job, setJob] = useState(null);
  useEffect(() => { if (open) { setFormat('zip'); setName(archiveNameFor(paths, 'zip')); setError(null); setJob(null); } }, [open, paths]);
  const changeFormat = (f) => { setFormat(f); setName((n) => n.replace(/\.(zip|tar\.gz|tgz)$/i, '') + `.${f}`); };
  const formats = [{ value: 'zip', label: t('panel.files.format_zip', 'Zip (.zip)') }, { value: 'tar.gz', label: t('panel.files.format_targz', 'Gzipped tar (.tar.gz)') }];

  const start = async () => {
    setBusy(true); setError(null);
    try {
      const { data } = await panelApi.post('/files/archive', { paths, dest: joinRel(dir, name.trim()), format });
      setJob(data.job);
    } catch (err) { setError(err); } finally { setBusy(false); }
  };

  return (
    <Modal open={open} title={paths?.length === 1 ? fill(t('panel.files.compress_name', 'Compress {name}'), { name: paths[0].split('/').pop() }) : fill(t('panel.files.compress_n_items', 'Compress {count} items'), { count: paths?.length || 0 })} onClose={onClose} size="md"
      footer={<><Button onClick={onClose}>{job ? t('panel.files.close', 'Close') : t('panel.files.cancel', 'Cancel')}</Button>{!job && <Button variant="primary" icon={Archive} loading={busy} disabled={!name.trim()} onClick={start}>{t('panel.files.create_archive', 'Create archive')}</Button>}</>}>
      <PanelCapabilityState error={error} />
      <RequestError error={error} />
      {!job && (
        <>
          <Field label={t('panel.files.format', 'Format')} htmlFor="archive-format"><Select id="archive-format" value={format} onChange={changeFormat} options={formats} /></Field>
          <Field label={t('panel.files.archive_name', 'Archive name')} required help={<>{t('panel.files.created_in', 'Created in')} <code>{dir ? `~/${dir}` : '~'}</code>{fill(t('panel.files.must_end_in', '; it must end in .{format}'), { format })}</>} error={error?.fields?.dest} htmlFor="archive-name">
            <TextInput id="archive-name" value={name} onChange={setName} spellCheck={false} />
          </Field>
          <p className="muted small">{plural(t, 'panel.files.items_included', paths?.length, '{count} item will be included.', '{count} items will be included.')} {t('panel.files.archives_never_overwritten', 'Existing archives are never overwritten.')}</p>
        </>
      )}
      {job && <JobProgress jobId={job.id} onFinished={(ev) => onFinished?.(ev)} />}
    </Modal>
  );
}

export function ExtractModal({ archive, onClose, onFinished }) {
  const { t } = useT();
  const open = Boolean(archive);
  const [dest, setDest] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [job, setJob] = useState(null);
  useEffect(() => { if (open) { setDest(parentOf(archive)); setError(null); setJob(null); } }, [open, archive]);

  const start = async () => {
    const clean = normalizeRel(dest);
    if (clean == null) { setError({ message: t('panel.files.choose_folder_in_home', 'Choose a folder inside your home directory'), fields: { dest: [t('panel.files.dotdot_not_allowed', '".." is not allowed')] } }); return; }
    setBusy(true); setError(null);
    try {
      const { data } = await panelApi.post('/files/extract', { archive, dest: clean });
      setJob(data.job);
    } catch (err) { setError(err); } finally { setBusy(false); }
  };

  return (
    <Modal open={open} title={archive ? fill(t('panel.files.extract_name', 'Extract {name}'), { name: archive.split('/').pop() }) : ''} onClose={onClose} size="md"
      footer={<><Button onClick={onClose}>{job ? t('panel.files.close', 'Close') : t('panel.files.cancel', 'Cancel')}</Button>{!job && <Button variant="primary" icon={PackageOpen} loading={busy} onClick={start}>{t('panel.files.extract', 'Extract')}</Button>}</>}>
      <PanelCapabilityState error={error} />
      <RequestError error={error} />
      {!job && (
        <Field label={t('panel.files.extract_into', 'Extract into')} help={t('panel.files.extract_into_help', 'A folder relative to your home directory; leave empty for the home directory itself. It is created if missing.')} error={error?.fields?.dest || error?.fields?.archive} htmlFor="extract-dest">
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
