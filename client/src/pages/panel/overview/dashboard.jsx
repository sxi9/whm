import { PanelPageHeader } from '../../../panel/PanelPage.jsx';
import { PanelHome } from '../../../panel/PanelHome.jsx';

export default function Dashboard({ fn }) {
  return <PanelHome header={<PanelPageHeader fn={fn} />} />;
}
