import { PageHeader } from '../../../components/Common.jsx';
import { ResolverConfiguration } from '../../networking/ResolverConfiguration.jsx';

export default function ResolverConfigurationPage({ fn }) {
  return (
    <>
      <PageHeader fn={fn} description="The nameservers this server itself uses to resolve names (/etc/resolv.conf or systemd-resolved). Test them live before applying." />
      <ResolverConfiguration />
    </>
  );
}
