import { Info } from 'lucide-react';
import { PageHeader } from '../../../components/Common.jsx';
import { ConfigurationCluster } from '../../clusters/ConfigurationCluster.jsx';

export default function ConfigurationClusterPage({ fn }) {
  return (
    <>
      <PageHeader fn={fn} description="Keep panel settings identical across servers: share chosen setting groups with peers, push them on demand or every six hours, or pull a peer's settings after reviewing the differences. Inbound pushes stay off until you turn them on under Shared settings." />
      <div className="banner banner-info">
        <Info size={18} />
        <div>
          <strong>What travels</strong>
          <p>Only an explicit list of keys per group; a receiving server takes just the groups it shares itself, validates every value and applies it through the module that owns it (Apache, Exim, Dovecot, backups), reporting per key whether it reached the host or is stored until the daemon is installed. Host identity, addresses, daemon selection, per-host paths and secrets never leave a server.</p>
        </div>
      </div>
      <ConfigurationCluster />
    </>
  );
}
