import InstallerCatalog from './parts/InstallerCatalog.jsx';

// The WordPress function is the WordPress tab of the installer catalog page
// (software/installers); the route stays for the plan feature and old links.
export { pathProblem, siteLabel, hostState, jobStreamPath } from './parts/InstallerCatalog.jsx';

export default function WordPress({ fn }) {
  return <InstallerCatalog fn={fn} app="wordpress" />;
}
