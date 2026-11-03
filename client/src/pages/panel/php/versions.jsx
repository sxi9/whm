import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Globe, Code2 } from 'lucide-react';
import { Card, StatusPill, EmptyState, KeyValue } from '../../../components/Common.jsx';
import { DataTable } from '../../../components/DataTable.jsx';
import { Select, Button } from '../../../components/Form.jsx';
import { useToast } from '../../../components/Toast.jsx';
import { PanelPage, PendingPill } from '../../../panel/PanelPage.jsx';
import { usePanelApi, panelApi } from '../../../panel/hooks/usePanel.js';
import { PANEL_FUNCTION_BY_KEY } from '../../../panel/nav.js';
import { RequestError, TypePill, AdvisoryPill, webResult, isCapabilityError } from './parts/Shared.jsx';

const INI_PATH = PANEL_FUNCTION_BY_KEY['panel:php/ini']?.path || '/panel/php/ini';
export const INHERIT = '__inherit';

export function versionLabel(versions, id) {
  const v = (versions || []).find((x) => x.id === id);
  return v ? `${v.label || `PHP ${v.id}`}${v.version ? ` (${v.version})` : ''}` : id ? `PHP ${id}` : '—';
}

// Options for the per-domain dropdown: "inherit the server default" plus every
// version the plan offers.
export function versionOptions(data, systemDefault) {
  const list = data?.versions || [];
  const def = data?.defaultId || systemDefault;
  return [{ value: INHERIT, label: `Server default${def ? ` (${versionLabel(list, def)})` : ''}` }, ...list.map((v) => ({ value: v.id, label: versionLabel(list, v.id) }))];
}

export default function PhpVersions({ fn }) {
  const toast = useToast();
  const versions = usePanelApi('/php/versions');
  const domains = usePanelApi('/php/domains');
  const [drafts, setDrafts] = useState({});
  const [busy, setBusy] = useState(null);
  const [pending, setPending] = useState({});
  const [q, setQ] = useState('');

  const rows = useMemo(() => {
    const list = domains.data?.domains || [];
    const needle = q.trim().toLowerCase();
    return needle ? list.filter((d) => d.domain.includes(needle)) : list;
  }, [domains.data, q]);
  const options = useMemo(() => versionOptions(versions.data, domains.data?.systemDefault), [versions.data, domains.data]);
  const current = (d) => d.phpVersion || INHERIT;
  const draftOf = (d) => drafts[d.domain] ?? current(d);

  const save = async (d) => {
    const chosen = draftOf(d);
    const version = chosen === INHERIT ? null : chosen;
    setBusy(d.domain);
    try {
      const { data } = await panelApi.put(`/php/domains/${encodeURIComponent(d.domain)}`, { version });
      const w = webResult(data.web);
      setPending((p) => ({ ...p, [d.domain]: w.applied ? null : w }));
      setDrafts((s) => { const n = { ...s }; delete n[d.domain]; return n; });
      toast.success(w.applied ? `${d.domain} now runs ${version ? versionLabel(versions.data?.versions, version) : 'the server default'}` : `${d.domain} is set to ${version ? versionLabel(versions.data?.versions, version) : 'the server default'}; the web server applies it once it is available`);
      domains.refetch();
    } catch (err) {
      toast.error(err.fields?.version ? `${err.message}: ${err.fields.version.join(', ')}` : err);
    } finally { setBusy(null); }
  };

  const pageError = [versions.error, domains.error].find((e) => e && (e.status === 403 || isCapabilityError(e))) || null;
  const defaultVersion = versions.data?.defaultId || domains.data?.systemDefault || null;

  const columns = [
    { key: 'domain', label: 'Domain', render: (d) => <><strong>{d.domain}</strong> <TypePill type={d.type} /></> },
    { key: 'docroot', label: 'Document root', render: (d) => <code className="small">{d.docroot}</code> },
    { key: 'effective', label: 'Runs', render: (d) => <>{versionLabel(versions.data?.versions, d.effective)}{d.inherited && <span className="muted small"> · server default</span>}{pending[d.domain] && <> <PendingPill result={pending[d.domain]} /></>}</> },
    { key: 'version', label: 'PHP version', width: 300, render: (d) => (
      <span className="input-group" style={{ alignItems: 'center' }}>
        <Select value={draftOf(d)} onChange={(v) => setDrafts((s) => ({ ...s, [d.domain]: v }))} options={options} aria-label={`PHP version for ${d.domain}`} disabled={busy === d.domain || !versions.data} />
        {draftOf(d) !== current(d) && <Button variant="primary" size="sm" loading={busy === d.domain} onClick={() => save(d)}>Save</Button>}
      </span>
    ) },
  ];

  return (
    <PanelPage fn={fn} actions={<Link className="btn" to={INI_PATH}><Code2 size={16} /> PHP settings</Link>}>
      {pageError && <RequestError error={pageError} fn={fn} onRetry={() => { versions.refetch(); domains.refetch(); }} />}
      {!pageError && (
        <>
          <RequestError error={versions.error || domains.error} onRetry={() => { versions.refetch(); domains.refetch(); }} />
          <Card title="Available versions" subtitle={versions.data?.restricted ? 'Your plan limits which versions you can pick.' : 'Installed on this server and available to your domains.'} padded={false}>
            <div className="table-wrap">
              <table>
                <thead><tr><th>Version</th><th>Release</th><th>Status</th></tr></thead>
                <tbody>
                  {versions.loading && !versions.data && <tr><td colSpan={3} className="table-state"><span className="spinner" /> Loading…</td></tr>}
                  {versions.data && versions.data.versions.length === 0 && <tr><td colSpan={3} className="table-state">No PHP version is installed on this server yet</td></tr>}
                  {(versions.data?.versions || []).map((v) => (
                    <tr key={v.id}>
                      <td><strong>{v.label || `PHP ${v.id}`}</strong></td>
                      <td>{v.version || '—'}</td>
                      <td className="row-actions" style={{ justifyContent: 'flex-start' }}>
                        {(v.isDefault || v.id === defaultVersion) && <StatusPill status="pending">server default</StatusPill>}
                        <AdvisoryPill advisories={v.advisories} />
                        {v.advisories?.[0]?.fixedIn && <span className="muted small">fixed in {v.advisories[0].fixedIn}</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>

          <Card title="Domains" subtitle="Each domain can run its own version; the server default applies otherwise." padded={false}>
            {!domains.loading && domains.data && domains.data.domains.length === 0 ? (
              <EmptyState icon={Globe} title="No web domains yet">
                <p>Your domains appear here with the PHP version each one runs.</p>
                <p className="muted">Add a domain under Domains first.</p>
              </EmptyState>
            ) : (
              <DataTable columns={columns} rows={rows} loading={domains.loading} rowKey={(d) => d.domain} searchable q={q} onSearch={setQ} searchPlaceholder="Search domains…" emptyText="No domain matches that search" />
            )}
          </Card>
          <Card title="How it works">
            <KeyValue items={[
              ['Server default', defaultVersion ? versionLabel(versions.data?.versions, defaultVersion) : 'Not set'],
              versions.data?.planDefault && ['Plan default', versions.data.planDefault],
              ['Per-domain settings', <Link key="l" to={INI_PATH}>Edit .user.ini directives</Link>],
            ]} />
            <p className="muted small" style={{ marginTop: 8 }}>A changed version is applied to the domain's web server configuration right away; existing visitors may need a page reload.</p>
          </Card>
        </>
      )}
    </PanelPage>
  );
}
