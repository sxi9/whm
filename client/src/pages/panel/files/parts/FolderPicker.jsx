import { useState } from 'react';
import { FolderOpen } from 'lucide-react';
import { TextInput, Button } from '../../../../components/Form.jsx';
import { useT } from '../../../../i18n/useT.js';
import { normalizeRel } from './paths.js';

// The folder a .htaccess screen works on: a path relative to the home, inside
// one of the document roots (public_html by default). The chosen path lives in
// ?path= so the file manager can link straight to it.
export const DEFAULT_FOLDER = 'public_html';

export function folderFromParams(params) {
  return normalizeRel(params.get('path') || '') || DEFAULT_FOLDER;
}

export function FolderPicker({ value, onChange, disabled }) {
  const { t } = useT();
  const [draft, setDraft] = useState(value);
  const apply = (e) => { e.preventDefault(); const next = normalizeRel(draft); if (next != null) onChange(next || DEFAULT_FOLDER); };
  return (
    <form onSubmit={apply} className="input-group" style={{ maxWidth: 640 }} aria-label={t('panel.files.folder', 'Folder')}>
      <span className="btn btn-ghost" aria-hidden="true"><FolderOpen size={16} /> ~/</span>
      <TextInput value={draft} onChange={setDraft} aria-label={t('panel.files.folder_path', 'Folder path')} placeholder={DEFAULT_FOLDER} spellCheck={false} disabled={disabled} />
      <Button type="submit" disabled={disabled || normalizeRel(draft) == null}>{t('panel.files.open', 'Open')}</Button>
    </form>
  );
}
