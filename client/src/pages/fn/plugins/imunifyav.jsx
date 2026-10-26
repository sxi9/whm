import { BundledPluginShell } from '../../plugins/BundledPlugin.jsx';
import { ImunifyAvOverview } from '../../plugins/ImunifyAv.jsx';

export default function ImunifyAv({ fn }) {
  return <BundledPluginShell fn={fn} id="net.whm.imunifyav" overview={ImunifyAvOverview} tabs={['/findings', '/settings']} />;
}
