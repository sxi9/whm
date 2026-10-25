import { PageHeader, Card } from '../../components/Common.jsx';
import { ProcessTable } from './ProcessTable.jsx';

export default function ProcessManager({ fn }) {
  return (
    <>
      <PageHeader fn={fn} />
      <Card padded={false}><ProcessTable manage /></Card>
    </>
  );
}
