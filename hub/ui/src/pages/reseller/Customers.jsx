import { PageHeader, Card } from '../../components/Common.jsx';
import { CustomerTable } from '../admin/Customers.jsx';

export default function ResellerCustomers() {
  return (
    <>
      <PageHeader title="My customers" description="Customers you issue licenses to. Rows are scoped to your reseller account." home="/reseller" />
      <Card padded={false}><CustomerTable base="/reseller" licensesLink={(r) => `/reseller/licenses?q=${encodeURIComponent(r.email)}`} /></Card>
    </>
  );
}
