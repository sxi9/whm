import { PageHeader, Card } from '../../../components/Common.jsx';
import { DomainsTable } from '../../account-info/DomainsTable.jsx';

export default function ListSubdomains({ fn }) {
  return (
    <>
      <PageHeader fn={fn} description="All subdomains across every account, with the main or addon domain each one hangs off and its document root." />
      <Card padded={false}><DomainsTable type="sub" parentLabel="Root domain" emptyText="No subdomains exist yet." /></Card>
    </>
  );
}
