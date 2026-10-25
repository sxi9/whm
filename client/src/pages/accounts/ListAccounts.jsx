import { Link } from 'react-router-dom';
import { Plus } from 'lucide-react';
import { PageHeader, Card } from '../../components/Common.jsx';
import { AccountsTable } from './AccountsTable.jsx';

export default function ListAccounts({ fn }) {
  return (
    <>
      <PageHeader fn={fn} actions={<Link className="btn btn-primary" to="/account-functions/create-a-new-account"><Plus size={16} /> Create a New Account</Link>} />
      <Card padded={false}><AccountsTable /></Card>
    </>
  );
}
