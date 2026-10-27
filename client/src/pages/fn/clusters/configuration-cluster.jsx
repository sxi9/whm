import { PageHeader } from '../../../components/Common.jsx';
import { ConfigurationCluster } from '../../clusters/ConfigurationCluster.jsx';

export default function ConfigurationClusterPage({ fn }) {
  return (
    <>
      <PageHeader fn={fn} description="Keep panel settings identical across servers: choose which groups are shared, push them to peers on demand or every six hours, or pull a peer's settings into this server after reviewing the differences. Inbound pushes are off until you turn them on, and a receiving server only takes the groups it shares itself. Only an explicit list of keys per group travels; the receiving server validates every value and applies it through the module that owns it (Apache, Exim, Dovecot, backups, ...), reporting per key whether it reached the host or is only stored until the daemon is installed. Host identity, addresses, daemon selection, per-host paths and secrets never leave a server." />
      <ConfigurationCluster />
    </>
  );
}
