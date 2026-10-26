import { PageHeader } from '../../../components/Common.jsx';
import { DnsCluster } from '../../clusters/DnsCluster.jsx';

export default function DnsClusterPage({ fn }) {
  return (
    <>
      <PageHeader fn={fn} description="Replicate this server's DNS zones to other servers running this panel. Each peer is reached over its own API with a token it issued; tokens issued here let peers push zones back. Roles follow WHM: write-only peers only receive, sync peers may also push, standalone peers are linked but never synchronised." />
      <DnsCluster />
    </>
  );
}
