import { BundledPluginShell } from '../../plugins/BundledPlugin.jsx';
import { ServerMonitoringOverview } from '../../plugins/ServerMonitoring.jsx';

export default function ServerMonitoring({ fn }) {
  return <BundledPluginShell fn={fn} id="net.whm.server-monitoring" overview={ServerMonitoringOverview} tabs={['/alerts', '/settings']} />;
}
