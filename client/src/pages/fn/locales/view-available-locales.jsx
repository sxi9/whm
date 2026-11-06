import { Link, useNavigate } from 'react-router-dom';
import { useApi } from '../../../hooks/useApi.js';
import { PageHeader, Card, KeyValue, StatusPill, formatDate } from '../../../components/Common.jsx';
import { DataTable } from '../../../components/DataTable.jsx';
import { Button } from '../../../components/Form.jsx';
import { useAuth } from '../../../auth/AuthContext.jsx';
import { InstallPackages } from '../../../components/InstallPackages.jsx';
import { RequestError, useLocales, LocalePills, TranslationProgress } from '../../locales/Shared.jsx';

export const localePackages = (family) => (family === 'rhel' ? ['glibc-langpack-en'] : ['locales']);

export default function ViewAvailableLocales({ fn }) {
  const { user } = useAuth();
  const navigate = useNavigate();
  const isRoot = user?.role === 'root';
  const { locales, loading, error, refetch, defaultCode, baseKeys } = useLocales();
  const system = useApi('/locales/system', { enabled: isRoot });
  const pkg = useApi('/software/pkg/detect', { enabled: Boolean(isRoot && system.data && !system.data.capability && !system.data.family) });

  return (
    <>
      <PageHeader fn={fn} actions={<><Button onClick={() => refetch()}>Refresh</Button>{isRoot && <Link className="btn btn-primary" to="/locales/configure-application-locales">Configure</Link>}</>} />
      <RequestError error={error} onRetry={refetch} />
      <Card title="Installed locales" subtitle={`${locales.length} locale(s) · default "${defaultCode}" · ${baseKeys} base strings in the English catalog. Disabled locales are kept but not offered to users.`} padded={false}>
        <DataTable loading={loading} rows={locales} rowKey={(l) => l.code} emptyText="No locales are installed yet. Installed locales appear here with their translation coverage once the English catalog has loaded."
          columns={[
            { key: 'code', label: 'Code', width: 110, render: (l) => <code>{l.code}</code> },
            { key: 'name', label: 'Name', render: (l) => <strong>{l.name}</strong> },
            { key: 'state', label: 'State', render: (l) => <LocalePills locale={l} /> },
            { key: 'progress', label: 'Translated', render: (l) => <TranslationProgress stats={l.stats} /> },
            { key: 'source', label: 'Source', render: (l) => <span className="small">{l.source}{l.copiedFrom ? ` of ${l.copiedFrom}` : ''}</span> },
            { key: 'updated', label: 'Updated', render: (l) => <span className="small" style={{ whiteSpace: 'nowrap' }}>{formatDate(l.updatedAt)}</span> },
          ]}
          rowActions={(l) => (isRoot ? [
            { label: 'Edit', primary: true, onClick: () => navigate(`/locales/edit-a-locale?code=${l.code}`) },
            { label: 'Copy', onClick: () => navigate(`/locales/copy-a-locale?from=${l.code}`) },
            { label: 'Download XML', onClick: () => navigate(`/locales/locale-xml-download?code=${l.code}`) },
          ] : [{ label: 'Download XML', primary: true, onClick: () => navigate(`/locales/locale-xml-download?code=${l.code}`) }])} />
      </Card>
      {isRoot && (
        <Card title="Operating system locale" subtitle="What the host itself runs with (LANG and LC_* from the system locale file). Separate from the panel's interface language." actions={<Button size="sm" onClick={() => system.refetch()}>Re-read</Button>}>
          <RequestError error={system.error} onRetry={system.refetch} />
          {system.data && (
            <>
              <KeyValue items={[
                ['Locale tools (glibc)', <StatusPill key="c" status={system.data.capability ? 'installed' : 'not-installed'}>{system.data.capability ? 'Installed' : 'Not installed'}</StatusPill>],
                ['System language', system.data.lang ? <code key="l">{system.data.lang}</code> : <span key="l" className="muted">Not set</span>],
                ['Config file', system.data.config ? <code key="f">{system.data.config.path}</code> : <span key="f" className="muted">None of {system.data.files.join(', ')} is readable</span>],
                ['Panel default locale', <code key="p">{system.data.panelDefault}</code>],
              ]} />
              {system.data.config && Object.keys(system.data.config.vars).length > 1 && (
                <div className="table-wrap" style={{ marginTop: 10 }}>
                  <table><thead><tr><th>Variable</th><th>Value</th></tr></thead>
                    <tbody>{Object.entries(system.data.config.vars).map(([k, v]) => <tr key={k}><td><code>{k}</code></td><td><code>{v}</code></td></tr>)}</tbody></table>
                </div>
              )}
              {!system.data.capability && (
                <div style={{ marginTop: 10 }}>
                  <p className="muted small">Install the <code>{localePackages(system.data.family ?? pkg.data?.family)[0]}</code> package to generate additional system locales. The panel's own interface languages do not depend on it.</p>
                  {(system.data.family ?? pkg.data?.family) && <InstallPackages packages={localePackages(system.data.family ?? pkg.data?.family)} onFinished={() => system.refetch()} />}
                </div>
              )}
            </>
          )}
        </Card>
      )}
    </>
  );
}
