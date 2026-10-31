import { Link } from 'react-router-dom';
import { PageHeader, Card } from '../../../components/Common.jsx';
import { DomainsTable } from '../../account-info/DomainsTable.jsx';

export default function ListSubdomains({ fn }) {
  return (
    <>
      <PageHeader fn={fn} description={<>All subdomains across every account, with the main or addon domain each one hangs off and its document root. A row's <em>Modify account</em> action opens <Link to="/account-functions/modify-an-account">Modify an Account › Domains</Link>, where the account's subdomains are added and removed.</>} />
      <Card padded={false}><DomainsTable type="sub" parentLabel="Root domain" emptyText="No subdomains exist yet. Add one from Modify an Account › Domains." /></Card>
    </>
  );
}
