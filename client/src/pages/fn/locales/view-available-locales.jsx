import { Link } from 'react-router-dom';
import { useApi } from '../../../hooks/useApi.js';
import { PageHeader, Card, KeyValue, StatusPill, formatDate } from '../../../components/Common.jsx';
import { DataTable } from '../../../components/DataTable.jsx';
import { Button } from '../../../components/Form.jsx';
import { useAuth } from '../../../auth/AuthContext.jsx';
import { RequestError, useLocales, LocalePills, TranslationProgress, LocaleLinks } from '../../locales/Shared.jsx';

export default function ViewAvailableLocales({ fn }) {
  const { user } = useAuth();
  const isRoot = user?.role === 'root';
  const { locales, loading, error, refetch, defaultCode, baseKeys } = useLocales();
  const system = useApi('/locales/system', { enabled: isRoot });

  return (
    <>
      <PageHeader fn={fn} actions={<><Button onClick={() => refetch()}>Refresh</Button>{isRoot && <Link className="btn btn-primary" to="/locales/configure-application-locales">Configure</Link>}</>} />
      <RequestError error={error} onRetry={refetch} />
      <Card title="Installed locales" subtitle={`${locales.length} locale(s) · default "${defaultCode}" · ${baseKeys} base strings in the English catalog. Disabled locales are kept but not offered to users.`} padded={false}>
        <DataTable loading={loading} rows={locales} rowKey={(l) => l.code} emptyText="No locales installed"
          columns={[
            { key: 'code', label: 'Code', width: 110, render: (l) => <code>{l.code}</code> },
            { key: 'name', label: 'Name', render: (l) => <strong>{l.name}</strong> },
            { key: 'state', label: 'State', render: (l) => <LocalePills locale={l} /> },
            { key: 'progress', label: 'Translated', render: (l) => <TranslationProgress stats={l.stats} /> },
            { key: 'source', label: 'Source', render: (l) => <span className="small">{l.source}{l.copiedFrom ? ` of ${l.copiedFrom}` : ''}</span> },
            { key: 'updated', label: 'Updated', render: (l) => <span className="small">{formatDate(l.updatedAt)}</span> },
            { key: 'actions', label: '', render: (l) => (isRoot ? <LocaleLinks code={l.code} /> : <Link className="btn btn-sm" to={`/locales/locale-xml-download?code=${l.code}`}>Download XML</Link>) },
          ]} />
      </Card>
      {isRoot && (
        <Card title="Operating system locale" subtitle="What the host itself runs with (LANG and LC_* from the system locale file). Separate from the panel's interface language." actions={<Button size="sm" onClick={() => system.refetch()}>Re-read</Button>}>
          <RequestError error={system.error} onRetry={system.refetch} />
          {system.data && (
            <>
              <KeyValue items={[
                ['Locale tools (glibc)', <StatusPill key="c" status={system.data.capability ? 'installed' : 'not-installed'}>{system.data.capability ? 'locale / localedef present' : 'locale command not found'}</StatusPill>],
                ['System language', system.data.lang ? <code>{system.data.lang}</code> : <span className="muted">not set</span>],
                ['Config file', system.data.config ? <code>{system.data.config.path}</code> : <span className="muted">none of {system.data.files.join(', ')} is readable</span>],
                ['Panel default locale', <code key="p">{system.data.panelDefault}</code>],
              ]} />
              {system.data.config && Object.keys(system.data.config.vars).length > 1 && (
                <div className="table-wrap" style={{ marginTop: 10 }}>
                  <table><thead><tr><th>Variable</th><th>Value</th></tr></thead>
                    <tbody>{Object.entries(system.data.config.vars).map(([k, v]) => <tr key={k}><td><code>{k}</code></td><td><code>{v}</code></td></tr>)}</tbody></table>
                </div>
              )}
              {!system.data.capability && <p className="muted small" style={{ marginTop: 10 }}>Install the <code>locales</code> (Debian/Ubuntu) or <code>glibc-langpack-*</code> (RHEL family) package via <Link to="/software/install-distro-packages">Install Distro Packages</Link> to generate additional system locales. The panel's own interface languages do not depend on it.</p>}
            </>
          )}
        </Card>
      )}
    </>
  );
}
