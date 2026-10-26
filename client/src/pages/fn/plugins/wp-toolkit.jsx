import { BundledPluginShell } from '../../plugins/BundledPlugin.jsx';
import { WpToolkitOverview } from '../../plugins/WpToolkit.jsx';

export default function WpToolkit({ fn }) {
  return <BundledPluginShell fn={fn} id="net.whm.wp-toolkit" overview={WpToolkitOverview} tabs={['/discover', '/settings']} />;
}
