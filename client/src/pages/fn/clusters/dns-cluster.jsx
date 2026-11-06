import { Info } from 'lucide-react';
import { PageHeader } from '../../../components/Common.jsx';
import { DnsCluster } from '../../clusters/DnsCluster.jsx';

export default function DnsClusterPage({ fn }) {
  return (
    <>
      <PageHeader fn={fn} description="Replicate this server's DNS zones to other servers running this panel." />
      <details className="banner banner-info" style={{ display: 'block' }}>
        <summary style={{ cursor: 'pointer', fontWeight: 600 }}><Info size={16} style={{ verticalAlign: '-3px', marginRight: 6 }} />How it works</summary>
        <p style={{ margin: '8px 0 0' }}>Each peer is reached over its own API with a token it issued; tokens issued here let peers push zones back and reach nothing but the cluster endpoints, so give each an expiry and revoke it when the peer goes away. Roles: write-only peers only receive, sync peers may also push, standalone peers are linked but never synchronised. A token is confined to ping, receiving zones and the zone import; every other API answers it with 403. Tokens issued before the split (marked legacy) keep pushing zones only.</p>
      </details>
      <DnsCluster />
    </>
  );
}
