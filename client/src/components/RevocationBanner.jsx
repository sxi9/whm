import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ShieldAlert } from 'lucide-react';
import { api } from '../api/client.js';
import { useApi } from '../hooks/useApi.js';
import { useAuth } from '../auth/AuthContext.jsx';
import { Button } from './Form.jsx';
import { useToast } from './Toast.jsx';

export const MANAGE_PLUGINS_PATH = '/cpanel/manage-plugins';

export function describeRevocation(r) {
  const what = `${r.pluginId}${r.version ? ` ${r.version}` : ''}`;
  const did = r.action === 'uninstall' ? 'uninstalled' : 'disabled';
  const affected = (r.appliedTo || []).map((a) => `${a.id} ${a.version}${a.source && a.source !== 'marketplace' ? ` (${a.source})` : ''}`).join(', ');
  return `${what} was revoked by the marketplace (${r.severity}) and ${did} on this server${affected ? `: ${affected}` : ''}. ${r.reason ? `Reason: ${r.reason}.` : ''}`;
}

// Red banner for every applied, unacknowledged marketplace revocation (§18.6).
// It stays until root acknowledges it; the plugin cannot be re-enabled before.
export function RevocationBanner() {
  const { user } = useAuth();
  const toast = useToast();
  const isRoot = user?.role === 'root';
  const { data, refetch } = useApi('/marketplace/revocations?unacknowledged=true', { enabled: isRoot, refreshMs: 5 * 60 * 1000 });
  const [busy, setBusy] = useState(null);
  if (!isRoot || !data?.length) return null;
  const ack = async (r) => {
    setBusy(r.id);
    try { await api.post(`/marketplace/revocations/${r.id}/ack`); toast.success(`Revocation of ${r.pluginId} acknowledged`); refetch(); } catch (err) { toast.error(err); } finally { setBusy(null); }
  };
  return (
    <div className="revocation-banners">
      {data.map((r) => (
        <div key={r.id} className="banner banner-error" role="alert" data-testid="revocation-banner">
          <ShieldAlert size={18} />
          <div style={{ flex: 1 }}>
            <strong>Plugin revoked: {r.pluginId}{r.version ? ` ${r.version}` : ''}</strong>
            <p>{describeRevocation(r)} {r.severity === 'critical' && (r.appliedTo || []).some((a) => !a.signer) ? 'Because the revocation is critical, a same-id plugin that was not signed by the marketplace was switched off too.' : ''}</p>
            <small>Acknowledge once you have reviewed it; until then the plugin cannot be enabled again. <Link to={MANAGE_PLUGINS_PATH}>Manage Plugins</Link></small>
          </div>
          <Button size="sm" loading={busy === r.id} onClick={() => ack(r)}>Acknowledge</Button>
        </div>
      ))}
    </div>
  );
}

export default RevocationBanner;
