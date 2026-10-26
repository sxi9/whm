import { PageHeader } from '../../../components/Common.jsx';
import { ChangeHostname } from '../../networking/ChangeHostname.jsx';

export default function ChangeHostnamePage({ fn }) {
  return (
    <>
      <PageHeader fn={fn} description="Sets the kernel hostname with hostnamectl, maps it in /etc/hosts, updates the panel's hostname setting and can publish the matching A record." />
      <ChangeHostname />
    </>
  );
}
