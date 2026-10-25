import { PageHeader, Card } from '../../components/Common.jsx';
import { ProcessTable } from './ProcessTable.jsx';

export default function RunningProcesses({ fn }) {
  return (
    <>
      <PageHeader fn={fn} description="Snapshot of running processes, refreshed every 10 seconds. Use Process Manager to kill or renice." />
      <Card padded={false}><ProcessTable /></Card>
    </>
  );
}
