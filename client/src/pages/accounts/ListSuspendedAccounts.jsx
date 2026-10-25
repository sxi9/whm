import { PageHeader, Card } from '../../components/Common.jsx';
import { AccountsTable } from './AccountsTable.jsx';

export default function ListSuspendedAccounts({ fn }) {
  return (
    <>
      <PageHeader fn={fn} />
      <Card padded={false}><AccountsTable suspendedOnly /></Card>
    </>
  );
}
