import { useSearchParams } from 'react-router-dom';
import InstallerCatalog from './parts/InstallerCatalog.jsx';
import { DEFAULT_INSTALLER, resolveInstaller } from './parts/catalog.js';
import { usePanelMe } from '../../../panel/hooks/usePanel.js';

// The one-click installer catalog (WordPress, Joomla, Drupal) as one page;
// the tab follows `?app=` and falls back to the first app the plan allows.
export default function Installers({ fn }) {
  const [params, setParams] = useSearchParams();
  const { hasFeature } = usePanelMe();
  const current = resolveInstaller(params.get('app') || DEFAULT_INSTALLER, hasFeature).id;
  const onPick = (id) => setParams(id === DEFAULT_INSTALLER ? {} : { app: id });
  return <InstallerCatalog fn={fn} current={current} onPick={onPick} />;
}
