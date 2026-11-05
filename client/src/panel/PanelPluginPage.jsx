import { Link, useParams } from 'react-router-dom';
import { Puzzle } from 'lucide-react';
import { Card, Loading, EmptyState } from '../components/Common.jsx';
import { ErrorBanner } from '../components/Form.jsx';
import { useT } from '../i18n/useT.js';
import { fill } from '../i18n/fill.js';
import { PluginPageView } from '../pages/plugins/PluginPage.jsx';
import { PanelPageHeader } from './PanelPage.jsx';
import { PANEL_PATHS } from './nav.js';
import { usePanelPlugins, panelPluginPath } from './hooks/usePanelPlugins.js';

// Only what the SDK allows as a panel page (PANEL_PAGE_KINDS): settings and
// action pages drive root-only manage routes and never reach the panel catalog.
export const PANEL_PAGE_KINDS = ['table', 'form', 'markdown', 'html'];

// /panel/plugins/:pluginId/* — renders one plugin page with the generic
// renderer, pointed at the panel's own endpoints: data from
// /api/panel/plugins/<id>/<source>, page files from /api/panel/plugins/ui/<id>/file.
export function PanelPluginPage() {
  const { pluginId, '*': rest } = useParams();
  const { plugins, loading, error, reload } = usePanelPlugins();
  const { t } = useT();
  const route = `/${(rest || '').replace(/\/+$/, '')}`.replace(/^\/\//, '/');
  const plugin = plugins.find((p) => p.id === pluginId);
  const page = plugin?.pages?.find((p) => p.route === route);
  if (loading && !plugin) return <Loading text={t('common.loading', 'Loading…')} />;
  if (error) return <><PanelPageHeader title={t('panel.plugins.plugin_pages', 'Plugin pages')} /><Card><ErrorBanner error={error} onRetry={reload} /></Card></>;
  if (plugin && !page && route === '/' && plugin.pages?.length) {
    return (
      <>
        <PanelPageHeader title={plugin.name} description={fill(t('panel.plugins.by', '{name} {version}'), { name: plugin.name, version: plugin.version })} />
        <Card title={t('panel.plugins.pages', 'Pages')}>
          <ul className="list-plain">{plugin.pages.map((p) => <li key={p.route} style={{ padding: '6px 0' }}><Link to={panelPluginPath(plugin, p)}>{p.title}</Link></li>)}</ul>
        </Card>
      </>
    );
  }
  if (!plugin || !page || !PANEL_PAGE_KINDS.includes(page.kind)) {
    return (
      <>
        <PanelPageHeader title={t('panel.plugins.not_found_title', 'Plugin page not found')} />
        <Card>
          <EmptyState icon={Puzzle} title={t('panel.plugins.not_found_text', 'There is no such plugin page')}>
            <p>{!plugin ? fill(t('panel.plugins.not_found_plugin', 'No installed plugin has the id {id}.'), { id: pluginId }) : page ? t('panel.plugins.unsupported', 'This page kind is not available in the account panel.') : `${plugin.name}: ${route}`}</p>
            <p><Link to={PANEL_PATHS.home}>{t('panel.common.home', 'Home')}</Link></p>
          </EmptyState>
        </Card>
      </>
    );
  }
  return (
    <>
      <PanelPageHeader title={page.title} description={page.description || fill(t('panel.plugins.by', '{name} {version}'), { name: plugin.name, version: plugin.version })} />
      <PluginPageView plugin={plugin} page={page} header={false} baseUrl={`/panel/plugins/${plugin.id}`} uiBase="/panel/plugins/ui" />
    </>
  );
}
