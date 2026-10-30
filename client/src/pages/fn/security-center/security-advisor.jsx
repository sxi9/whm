import { useEffect, useState } from 'react';
import { api } from '../../../api/client.js';
import { useApi } from '../../../hooks/useApi.js';
import { PageHeader, Card, Loading, EmptyState, StatusPill, formatDate } from '../../../components/Common.jsx';
import { Button, Textarea, ErrorBanner } from '../../../components/Form.jsx';
import { useToast } from '../../../components/Toast.jsx';
import { RequestError, GradePill, FixLink } from '../../security/Shared.jsx';
import { AlertsPanel } from '../../contacts/SecurityAlerts.jsx';

const ORDER = ['critical', 'warning', 'info', 'ok'];
const TITLES = { critical: 'Critical', warning: 'Warnings', info: 'Informational', ok: 'Passed checks' };

// One graded finding. Advisory findings (PHP CVEs) carry the affected versions
// and a link to the upstream advisory next to the in-panel fix link.
export function FindingRow({ finding: f }) {
  return (
    <tr>
      <td style={{ width: 90 }}><GradePill grade={f.grade} /></td>
      <td>
        <div>{f.title}</div>
        {f.detail && <small className="muted" style={{ whiteSpace: 'pre-line' }}>{f.detail}</small>}
        {Array.isArray(f.versions) && f.versions.length > 0 && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 4 }}>
            {f.versions.map((v) => <StatusPill key={v.id || v.version} status={v.unknown ? 'unknown' : 'failed'}>{v.version || `${v.minor}.x`}{v.fixedIn ? ` → ${v.fixedIn}` : ' · no fix for this branch'}</StatusPill>)}
          </div>
        )}
      </td>
      <td style={{ width: 240, textAlign: 'right' }}>
        {f.url && <a className="btn btn-sm" href={f.url} target="_blank" rel="noreferrer noopener" style={{ marginRight: 6 }}>{f.advisory || 'Advisory'}</a>}
        <FixLink fix={f.fix} />
      </td>
    </tr>
  );
}

export const ADVISORIES_SETTING = 'security.advisories';

// The PHP advisory list the advisor and MultiPHP Manager check against. Stored
// as one JSON setting so operators can add a new php.net advisory without a
// panel release; entries without an "id" are skipped by the scanner.
export function AdvisoryListEditor({ value, onSave, saving = false }) {
  const [text, setText] = useState(() => JSON.stringify(value ?? [], null, 2));
  const [error, setError] = useState(null);
  useEffect(() => { setText(JSON.stringify(value ?? [], null, 2)); }, [value]);
  const count = Array.isArray(value) ? value.length : 0;
  const save = () => {
    let parsed;
    try { parsed = JSON.parse(text); } catch (err) { setError(new Error(`Not valid JSON: ${err.message}`)); return; }
    if (!Array.isArray(parsed)) { setError(new Error('The advisory list must be a JSON array of { id, title, severity, published, url, affected, fixedIn, note } entries')); return; }
    setError(null);
    onSave(parsed);
  };
  return (
    <Card title="PHP advisory list" subtitle={`${count} advisor${count === 1 ? 'y' : 'ies'} on file. Each entry: id, title, severity (critical, high, medium, low), published, url, affected ({ "8.3": "<8.3.36" }, "*" for a whole branch), fixedIn ({ "8.3": "8.3.36" }), note. Seeded from php.net's advisories of 21 and 23 October 2026.`} actions={<Button variant="primary" loading={saving} onClick={save}>Save list</Button>}>
      <div id="advisories" />
      <Textarea mono rows={12} value={text} onChange={setText} aria-label="Advisory list JSON" />
      <ErrorBanner error={error} />
    </Card>
  );
}

function AdvisoryListCard() {
  const toast = useToast();
  const settings = useApi(`/system/settings?prefix=${ADVISORIES_SETTING}`);
  const [saving, setSaving] = useState(false);
  const save = async (list) => {
    setSaving(true);
    try { await api.put('/system/settings', { [ADVISORIES_SETTING]: list }); toast.success('Advisory list saved; run a scan to apply it'); settings.refetch(); } catch (err) { toast.error(err); } finally { setSaving(false); }
  };
  if (!settings.data) return null;
  return <AdvisoryListEditor value={settings.data[ADVISORIES_SETTING] ?? []} onSave={save} saving={saving} />;
}

export default function SecurityAdvisor({ fn }) {
  const toast = useToast();
  const { data, loading, error, refetch, setData } = useApi('/security/advisor');
  const [busy, setBusy] = useState(false);
  const scan = async () => {
    setBusy(true);
    try { const { data: run } = await api.post('/security/advisor/scan'); setData(run); toast.success(`Scan complete: ${run.summary.critical} critical, ${run.summary.warning} warnings`); } catch (err) { toast.error(err); } finally { setBusy(false); }
  };
  const findings = data?.findings || [];

  return (
    <>
      <PageHeader fn={fn} actions={<Button variant="primary" loading={busy} onClick={scan}>{data ? 'Scan again' : 'Scan now'}</Button>} description="Read-only probes of SSH, firewall, cPHulk, ModSecurity, file permissions, package updates, PHP advisories and panel settings, graded with links to the page that fixes each finding. A scheduled scan runs nightly." />
      <RequestError error={error} onRetry={refetch} />
      {loading && !data && <Loading />}
      {!loading && !data && !error && <Card><EmptyState title="No scan has run yet">Run a scan to grade this server. Scans never change anything.</EmptyState></Card>}
      {data && (
        <>
          <div className="stat-grid" style={{ marginBottom: 14 }}>
            {ORDER.map((g) => <div key={g} className="stat"><div className="label">{TITLES[g]}</div><div className="value">{data.summary[g] ?? 0}</div></div>)}
            <div className="stat"><div className="label">Last scan</div><div className="value" style={{ fontSize: 14 }}>{formatDate(data.finishedAt)} <span className="muted">({data.trigger})</span></div></div>
          </div>
          {ORDER.map((grade) => {
            const rows = findings.filter((f) => f.grade === grade);
            if (!rows.length) return null;
            return (
              <Card key={grade} title={TITLES[grade]} padded={false}>
                <div className="table-wrap">
                  <table>
                    <tbody>
                      {rows.map((f) => <FindingRow key={f.id} finding={f} />)}
                    </tbody>
                  </table>
                </div>
              </Card>
            );
          })}
        </>
      )}
      <AlertsPanel />
      <AdvisoryListCard />
    </>
  );
}
