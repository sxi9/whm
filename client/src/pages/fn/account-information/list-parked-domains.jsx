import { Link } from 'react-router-dom';
import { Plus } from 'lucide-react';
import { PageHeader, Card } from '../../../components/Common.jsx';
import { DomainsTable } from '../../account-info/DomainsTable.jsx';

export default function ListParkedDomains({ fn }) {
  return (
    <>
      <PageHeader fn={fn} description={<>Every parked (alias) domain on this server, the account it points at and the document root it shares. A row's <em>Modify account</em> action opens <Link to="/account-functions/modify-an-account">Modify an Account › Domains</Link>, where an account's parked domains are added and removed alongside its addon domains and subdomains.</>} actions={<Link className="btn btn-primary" to="/dns-functions/park-a-domain"><Plus size={16} /> Park a Domain</Link>} />
      <Card padded={false}><DomainsTable type="parked" parentLabel="Points at" emptyText="No parked domains. Use Park a Domain, or Modify an Account › Domains, to alias a domain onto an existing site." /></Card>
    </>
  );
}
