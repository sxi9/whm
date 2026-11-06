import { PageHeader } from '../../../components/Common.jsx';
import { ProcessTable } from '../../server/ProcessTable.jsx';

export default function RunningProcesses({ fn }) {
  return (
    <>
      <PageHeader fn={fn} description="Snapshot of running processes, refreshed every 10 seconds. Use Process Manager to kill or renice." />
      <ProcessTable base="/system-health" />
    </>
  );
}
