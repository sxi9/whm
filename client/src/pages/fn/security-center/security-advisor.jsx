import { useEffect, useState } from 'react';
import { api } from '../../../api/client.js';
import { useApi } from '../../../hooks/useApi.js';
import { PageHeader, Card, Loading, EmptyState, StatusPill, formatDate } from '../../../components/Common.jsx';
import { Button, Textarea, ErrorBanner, FormActions } from '../../../components/Form.jsx';
import { useConfirm } from '../../../components/Modal.jsx';
import { useToast } from '../../../components/Toast.jsx';
import { RequestError, GradePill, FixLink } from '../../security/Shared.jsx';
import { useJobRunner, JobPanel } from '../../software/Shared.jsx';

const ORDER = ['critical', 'warning', 'info', 'ok'];
const TITLES = { critical: 'Critical', warning: 'Warnings', info: 'Informational', ok: 'Passed checks' };

// One graded finding. Advisory findings (PHP CVEs) carry the affected versions
// and a link to the upstream advisory next to the in-panel fix link. A finding
// with `actions` (contract §63: { label, path, body }) renders one button per
// action; the page runs it through `onAction`.
export function FindingRow({ finding: f, onAction, busy = false }) {
  const actions = Array.isArray(f.actions) ? f.actions.filter((a) => a && typeof a.path === 'string' && a.label) : [];
  return (
    <tr>
      <td style={{ width: 90 }}><GradePill grade={f.grade} /></td>
      <td>
        <div>{f.title}</div>
        {f.detail && <small className="muted" style={{ whiteSpace: 'pre-line' }}>{f.detail}</small>}
        {Array.isArray(f.versions) && f.versions.length > 0 && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 4 }}>
            {f.versions.map((v) => <StatusPill key={v.id || v.version} status={v.unknown ? 'unknown' : 'failed'}>{v.version || `${v.minor}.x`}{v.candidate ? ` → ${v.candidate} available` : v.fixedIn ? ` → ${v.fixedIn}` : ' · no fix for this branch'}</StatusPill>)}
          </div>
        )}
      </td>
      <td className="actions-col">
        <div className="row-actions">
          {actions.map((a) => <Button key={`${a.path}:${a.label}`} size="sm" variant={f.grade === 'critical' ? 'danger' : 'primary'} loading={busy} onClick={() => onAction?.(a, f)}>{a.label}</Button>)}
          {f.url && <a className="btn btn-sm" href={f.url} target="_blank" rel="noreferrer noopener">{f.advisory || 'Advisory'}</a>}
          <FixLink fix={f.fix} />
        </div>
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
  const dirty = text !== JSON.stringify(value ?? [], null, 2);
  const save = () => {
    let parsed;
    try { parsed = JSON.parse(text); } catch (err) { setError(new Error(`Not valid JSON: ${err.message}`)); return; }
    if (!Array.isArray(parsed)) { setError(new Error('The advisory list must be a JSON array of { id, title, severity, published, url, affected, fixedIn, note } entries')); return; }
    setError(null);
    onSave(parsed);
  };
  return (
    <Card title="PHP advisory list" subtitle={`${count} advisor${count === 1 ? 'y' : 'ies'} on file, seeded from php.net.`}>
      <div id="advisories" />
      <Textarea mono rows={12} value={text} onChange={setText} aria-label="Advisory list JSON" />
      <details className="small muted" style={{ marginTop: 8 }}>
        <summary>Format</summary>
        <p>A JSON array; each entry has <code>id</code>, <code>title</code>, <code>severity</code> (critical, high, medium, low), <code>published</code>, <code>url</code>, <code>affected</code> (<code>{'{ "8.3": "<8.3.36" }'}</code>, <code>"*"</code> for a whole branch), <code>fixedIn</code> (<code>{'{ "8.3": "8.3.36" }'}</code>) and <code>note</code>. Entries without an id are skipped by the scanner.</p>
      </details>
      <ErrorBanner error={error} />
      <FormActions><Button loading={saving} disabled={!dirty} onClick={save}>Save list</Button></FormActions>
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
  const confirm = useConfirm();
  const { data, loading, error, refetch, setData } = useApi('/security/advisor');
  const [busy, setBusy] = useState(false);
  const scan = async () => {
    setBusy(true);
    try { const { data: run } = await api.post('/security/advisor/scan'); setData(run); toast.success(`Scan complete: ${run.summary.critical} critical, ${run.summary.warning} warnings`); } catch (err) { toast.error(err); } finally { setBusy(false); }
  };
  // A finding's action is a POST the server named (contract §63); the job it
  // starts streams below and the scan is repeated when it finishes.
  const runner = useJobRunner({ onFinished: scan });
  const act = async (action, finding) => {
    if (!(await confirm({ title: `${action.label}?`, message: `Runs ${action.label.toLowerCase()} as a background job (${finding.title}). The advisor scans again when it finishes.`, confirmLabel: action.label, danger: finding.grade === 'critical' }))) return;
    runner.start(() => api.post(action.path, action.body ?? {}), action.label);
  };
  const findings = data?.findings || [];

  return (
    <>
      <PageHeader fn={fn} actions={<Button variant="primary" loading={busy} onClick={scan}>{data ? 'Scan again' : 'Scan now'}</Button>} description="Read-only probes of SSH, firewall, cPHulk, ModSecurity, file permissions, package updates, PHP advisories and panel settings, graded with links to the page that fixes each finding. A scheduled scan runs nightly." />
      <RequestError error={error} onRetry={refetch} />
      {loading && !data && <Loading />}
      {!loading && !data && !error && <Card><EmptyState title="No scan has run yet">Graded findings appear here after the first scan. Scans only read; they never change anything.</EmptyState></Card>}
      {data && (
        <>
          <div className="stat-grid">
            {ORDER.map((g) => <div key={g} className="stat"><div className="label">{TITLES[g]}</div><div className="value">{data.summary[g] ?? 0}</div></div>)}
          </div>
          <p className="muted" style={{ margin: '10px 0 18px' }}>Last scan {formatDate(data.finishedAt)} ({data.trigger}).</p>
          {ORDER.map((grade) => {
            const rows = findings.filter((f) => f.grade === grade);
            if (!rows.length) return null;
            return (
              <Card key={grade} title={TITLES[grade]} padded={false}>
                <div className="table-wrap">
                  <table>
                    <tbody>
                      {rows.map((f) => <FindingRow key={f.id} finding={f} onAction={act} busy={runner.busy} />)}
                    </tbody>
                  </table>
                </div>
              </Card>
            );
          })}
          <ErrorBanner error={runner.error} />
          <JobPanel runner={runner} title="Update progress" />
        </>
      )}
      <AdvisoryListCard />
    </>
  );
}
