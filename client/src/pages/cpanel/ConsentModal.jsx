import { useState } from 'react';
import { ShieldAlert } from 'lucide-react';
import { api } from '../../api/client.js';
import { Modal } from '../../components/Modal.jsx';
import { Button, ErrorBanner } from '../../components/Form.jsx';
import { describePermission } from './pluginPermissions.js';

// In-process plugins share the panel process, so the permission list is a
// record of what a plugin declares and uses, not a boundary the host can
// enforce against hostile code. The same wording ships in the install response
// (warnings: ['in-process']) and the design of record.
export function TrustNotice() {
  return (
    <div className="banner banner-info">
      <ShieldAlert size={18} />
      <div>
        <strong>Plugins run inside the panel process</strong>
        <p>An enabled plugin executes with the panel's own privileges (root in monolithic mode). Declared permissions are checked and recorded for review, but they are not a security boundary against malicious code: install only plugins you trust, and prefer signed packages. Process isolation arrives with the marketplace.</p>
      </div>
    </div>
  );
}

// One scope line: the SDK description, the developer's justification and a
// flag for scopes that reach outside the plugin.
export function PermissionList({ scopes, added = [], justifications = {} }) {
  if (!scopes?.length) return <p className="muted">This plugin declares no permissions.</p>;
  return (
    <ul className="permission-list">
      {scopes.map((scope) => {
        const d = describePermission(scope);
        const justification = justifications?.[scope];
        return (
          <li key={scope}>
            <code>{scope}</code>
            {added.includes(scope) ? <span className="pill pill-info" style={{ marginLeft: 8 }}>new</span> : null}
            {d.sensitive ? <span className="pill pill-warn" style={{ marginLeft: 8 }}>reaches outside the plugin</span> : null}
            <div className="muted small">{d.text}</div>
            {justification ? <div className="small"><em>Developer:</em> {justification}</div> : null}
          </li>
        );
      })}
    </ul>
  );
}

// Consent screen for a marketplace install that stopped at `pending_consent`:
// the scopes come from the installed, signature-verified package (the job
// result), never from the catalog, and the grant posts exactly that list.
export function ConsentModal({ open, pluginId, pluginName, version, required = [], added = [], justifications = {}, onClose, onConsented }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const grant = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await api.post(`/marketplace/consent/${pluginId}`, { permissions: required });
      onConsented?.(res.data);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  const isUpdate = added.length > 0 && added.length < required.length;
  return (
    <Modal open={open} title={`${pluginName || pluginId} ${version || ''}: permissions`} onClose={onClose} size="lg"
      footer={<><Button onClick={onClose} disabled={busy}>Keep disabled</Button><Button variant="primary" loading={busy} onClick={grant} data-testid="consent-grant">Grant and enable</Button></>}>
      <p>
        {isUpdate
          ? `The new version was installed but is held disabled: it asks for ${added.length} permission${added.length === 1 ? '' : 's'} the previous version did not have. Nothing of the new code runs until you grant them.`
          : 'The package was installed and verified but is held disabled until you grant the permissions it declares.'}
      </p>
      <PermissionList scopes={required} added={added} justifications={justifications} />
      <TrustNotice />
      <ErrorBanner error={error} />
    </Modal>
  );
}

export default ConsentModal;
