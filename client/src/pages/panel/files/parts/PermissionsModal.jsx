import { useEffect, useState } from 'react';
import { Field, TextInput, Toggle, Button } from '../../../../components/Form.jsx';
import { Modal } from '../../../../components/Modal.jsx';
import { PanelCapabilityState } from '../../../../panel/PanelPage.jsx';
import { panelApi } from '../../../../panel/hooks/usePanel.js';
import { RequestError } from './common.jsx';
import { modeToBits, bitsToMode, isValidMode, modeText } from './paths.js';

const WHO = [['owner', 'Owner (you)'], ['group', 'Group'], ['others', 'Everyone else']];
const PERMS = [['r', 'Read'], ['w', 'Write'], ['x', 'Execute']];

export function PermissionsModal({ entry, path, onClose, onSaved }) {
  const [mode, setMode] = useState('0644');
  const [recursive, setRecursive] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  useEffect(() => { if (entry) { setMode(entry.mode || (entry.type === 'dir' ? '0755' : '0644')); setRecursive(false); setError(null); } }, [entry]);

  const bits = modeToBits(mode);
  const setBit = (who, k, on) => setMode(bitsToMode({ ...bits, [who]: { ...bits[who], [k]: on } }));
  const valid = isValidMode(mode);

  const save = async () => {
    setBusy(true); setError(null);
    try {
      const { data } = await panelApi.post('/files/chmod', { path, mode: mode.length === 3 ? `0${mode}` : mode, recursive: entry?.type === 'dir' && recursive });
      onSaved?.(data);
    } catch (err) { setError(err); } finally { setBusy(false); }
  };

  return (
    <Modal open={Boolean(entry)} title={entry ? `Permissions of ${entry.name}` : ''} onClose={onClose} size="sm"
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} disabled={!valid} onClick={save}>Save permissions</Button></>}>
      <PanelCapabilityState error={error} />
      <RequestError error={error} />
      <div className="table-wrap" style={{ marginBottom: 12 }}>
        <table>
          <thead><tr><th /> {PERMS.map(([k, label]) => <th key={k} className="align-right">{label}</th>)}</tr></thead>
          <tbody>
            {WHO.map(([who, label]) => (
              <tr key={who}>
                <td>{label}</td>
                {PERMS.map(([k]) => <td key={k} className="align-right"><input type="checkbox" checked={bits[who][k]} onChange={(e) => setBit(who, k, e.target.checked)} aria-label={`${label} ${k === 'r' ? 'read' : k === 'w' ? 'write' : 'execute'}`} /></td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Field label="Mode" help={valid ? <>Shown as <code>{modeText(mode)}</code></> : undefined} error={valid ? error?.fields?.mode : ['Three or four octal digits, such as 0644; setuid and setgid are never granted']} htmlFor="chmod-mode">
        <TextInput id="chmod-mode" value={mode} onChange={(v) => setMode(v.replace(/[^0-7]/g, '').slice(0, 4))} style={{ maxWidth: 120 }} spellCheck={false} />
      </Field>
      {entry?.type === 'dir' && <Toggle checked={recursive} onChange={setRecursive} label="Apply to everything inside" description="Files and folders below get the same mode" />}
      <p className="muted small" style={{ marginTop: 12 }}>Web files are usually 0644 and folders 0755. Making a file world-writable (0666 or 0777) is unsafe on a shared server.</p>
    </Modal>
  );
}
