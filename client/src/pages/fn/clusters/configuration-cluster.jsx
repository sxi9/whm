import { PageHeader } from '../../../components/Common.jsx';
import { ConfigurationCluster } from '../../clusters/ConfigurationCluster.jsx';

export default function ConfigurationClusterPage({ fn }) {
  return (
    <>
      <PageHeader fn={fn} description="Keep panel settings identical across servers: choose which groups are shared, push them to peers on demand or every six hours, or pull a peer's settings into this server after reviewing the differences. Host identity and secrets are never transferred." />
      <ConfigurationCluster />
    </>
  );
}
