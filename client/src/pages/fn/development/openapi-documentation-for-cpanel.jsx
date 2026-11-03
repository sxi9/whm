import { Link } from 'react-router-dom';
import { Info } from 'lucide-react';
import { PageHeader } from '../../../components/Common.jsx';
import { ApiReference } from '../../development/Shared.jsx';

export default function OpenApiDocumentationForCpanel({ fn }) {
  return (
    <>
      <PageHeader fn={fn} description="The account-scoped subset of the API: what a reseller or an account user may call for the accounts they own." />
      <ApiReference scope="cpanel" note={(
        <div className="banner banner-info">
          <Info size={18} />
          <div>
            <strong>How this differs from the admin reference</strong>
            <p>Root-only endpoints (server configuration, other principals' data, service control) are filtered out. Everything listed here still re-checks ownership inside the service, so a reseller token only ever reaches its own accounts, domains, zones and certificates. The full surface is under <Link to="/development/openapi-documentation-for-whm">OpenAPI Documentation for the Admin Panel</Link>.</p>
          </div>
        </div>
      )} />
    </>
  );
}
