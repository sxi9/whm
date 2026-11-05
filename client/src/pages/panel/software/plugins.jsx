import { Link } from 'react-router-dom';
import { Puzzle, RefreshCw } from 'lucide-react';
import { Card, EmptyState, Loading } from '../../../components/Common.jsx';
import { ErrorBanner, Button } from '../../../components/Form.jsx';
import { useT } from '../../../i18n/useT.js';
import { fill } from '../../../i18n/fill.js';
import { PanelPage, FeatureDisabledState } from '../../../panel/PanelPage.jsx';
import { usePanelMe } from '../../../panel/hooks/usePanel.js';
import { usePanelPlugins, panelPluginPath } from '../../../panel/hooks/usePanelPlugins.js';

// Software › Plugins: every page a plugin exposes to account holders
// (audience 'panel'), grouped by plugin. The pages themselves open at
// /panel/plugins/<id>/<route> (panel/PanelPluginPage.jsx).
export default function Plugins({ fn }) {
  const { t } = useT();
  const { hasFeature } = usePanelMe();
  const { plugins, loading, error, reload } = usePanelPlugins();
  if (!hasFeature('plugins')) return <PanelPage fn={fn}><FeatureDisabledState fn={fn} /></PanelPage>;
  return (
    <PanelPage fn={fn} actions={<Button size="sm" onClick={reload}><RefreshCw size={14} /> {t('panel.plugins.refresh', 'Refresh')}</Button>}>
      <p className="muted">{t('panel.plugins.intro', 'Pages added by plugins your hosting provider installed. They open inside the account panel and only see this account.')}</p>
      <ErrorBanner error={error} onRetry={reload} />
      {loading && !plugins.length && <Loading text={t('common.loading', 'Loading…')} />}
      {!loading && !error && plugins.length === 0 && (
        <Card><EmptyState icon={Puzzle} title={t('panel.plugins.empty_title', 'No plugin pages')}><p>{t('panel.plugins.empty_text', 'Your hosting provider has not installed any plugin with a page for account holders.')}</p></EmptyState></Card>
      )}
      {plugins.map((p) => (
        <Card key={p.id} title={p.name} subtitle={fill(t('panel.plugins.by', '{name} {version}'), { name: p.id, version: p.version })}>
          <ul className="list-plain">
            {p.pages.map((page) => (
              <li key={page.route} style={{ padding: '6px 0' }}>
                <Link to={panelPluginPath(p, page)}>{page.title}</Link>
                {page.description && <span className="muted"> — {page.description}</span>}
              </li>
            ))}
          </ul>
        </Card>
      ))}
    </PanelPage>
  );
}
