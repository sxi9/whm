import { useMemo, useState } from 'react';
import { FileText } from 'lucide-react';
import { useApi } from '../../../hooks/useApi.js';
import { PageHeader, Card, Loading, EmptyState, StatusPill, KeyValue } from '../../../components/Common.jsx';
import { Button, ErrorBanner } from '../../../components/Form.jsx';
import { renderMarkdown } from '../../plugins/PluginPage.jsx';

export default function ChangeLog({ fn }) {
  const { data, loading, error, refetch } = useApi('/cpanel/changelog');
  const [selected, setSelected] = useState(null);
  const releases = data?.releases || [];
  const shown = useMemo(() => (selected ? releases.filter((r) => r.version === selected) : releases), [releases, selected]);

  return (
    <>
      <PageHeader fn={fn} actions={<Button onClick={refetch}>Refresh</Button>} />
      {loading && !data && <Loading />}
      <ErrorBanner error={error} onRetry={refetch} />
      {data && (
        <div className="home">
          <div className="home-main">
            {!data.exists && (
              <Card title="No change log on this server">
                <EmptyState icon={FileText} title="CHANGELOG.md is missing">
                  <p>The panel renders <code>CHANGELOG.md</code> from its install directory (<code className="mono">{data.path}</code>). Releases built from the official archives ship it; add the file to show release notes here.</p>
                </EmptyState>
              </Card>
            )}
            {data.exists && releases.length === 0 && (
              <Card title="Change log"><div className="markdown">{renderMarkdown(data.markdown)}</div></Card>
            )}
            {shown.map((r) => (
              <Card key={r.version} title={r.unreleased ? 'Unreleased' : `Version ${r.version}`} subtitle={r.date ? `Released ${r.date}` : r.unreleased ? 'Changes not yet in a tagged release' : undefined}
                actions={r.version === data.currentRelease ? <StatusPill status="ok">running</StatusPill> : r.unreleased ? <StatusPill status="pending">upcoming</StatusPill> : null}>
                <div className="markdown">{renderMarkdown(r.body || '_No notes for this release._')}</div>
              </Card>
            ))}
          </div>
          <aside className="home-side">
            <Card title="This server">
              <KeyValue items={[
                ['Running version', data.version],
                ['Release notes', data.currentRelease ? `found for ${data.currentRelease}` : 'none for the running version'],
                ['Source', <code key="p" className="small">{data.path}</code>],
              ]} />
            </Card>
            {releases.length > 0 && (
              <Card title="Releases" padded={false}>
                <ul className="service-dots">
                  <li><button className={`link-button ${selected ? '' : 'active'}`} onClick={() => setSelected(null)}>All releases</button></li>
                  {releases.map((r) => (
                    <li key={r.version}>
                      <button className="link-button" onClick={() => setSelected(r.version)}><strong>{r.unreleased ? 'Unreleased' : r.version}</strong></button>
                      <small className="muted">{r.date || ''}</small>
                    </li>
                  ))}
                </ul>
              </Card>
            )}
          </aside>
        </div>
      )}
    </>
  );
}
