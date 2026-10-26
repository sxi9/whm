import { PageHeader, Card } from '../../../components/Common.jsx';
import { ProcessTable } from '../../server/ProcessTable.jsx';

export default function ProcessManager({ fn }) {
  return (
    <>
      <PageHeader fn={fn} description="Live process table. Kill sends SIGTERM, Force kill sends SIGKILL; Renice changes the scheduling priority. PID 1 and the panel itself are protected." />
      <Card padded={false}><ProcessTable manage base="/system-health" /></Card>
    </>
  );
}
