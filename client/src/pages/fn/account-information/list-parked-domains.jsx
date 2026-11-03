import { Link } from 'react-router-dom';
import { Plus } from 'lucide-react';
import { PageHeader, Card } from '../../../components/Common.jsx';
import { DomainsTable } from '../../account-info/DomainsTable.jsx';

export default function ListParkedDomains({ fn }) {
  return (
    <>
      <PageHeader fn={fn} description="Every parked (alias) domain on this server, the account it points at and the document root it shares." actions={<Link className="btn btn-primary" to="/dns-functions/park-a-domain"><Plus size={16} /> Park a Domain</Link>} />
      <Card padded={false}><DomainsTable type="parked" parentLabel="Points at" emptyText="No parked domains yet. Domains aliased onto a site with Park a Domain appear here." /></Card>
    </>
  );
}
