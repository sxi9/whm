import { useState } from 'react';
import { api } from '../../../api/client.js';
import { useApi } from '../../../hooks/useApi.js';
import { PageHeader, Card, Loading, EmptyState, formatDate } from '../../../components/Common.jsx';
import { Button } from '../../../components/Form.jsx';
import { useToast } from '../../../components/Toast.jsx';
import { RequestError, GradePill, FixLink } from '../../security/Shared.jsx';

const ORDER = ['critical', 'warning', 'info', 'ok'];
const TITLES = { critical: 'Critical', warning: 'Warnings', info: 'Informational', ok: 'Passed checks' };

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
      <PageHeader fn={fn} actions={<Button variant="primary" loading={busy} onClick={scan}>{data ? 'Scan again' : 'Scan now'}</Button>} description="Read-only probes of SSH, firewall, cPHulk, ModSecurity, file permissions, package updates and panel settings, graded with links to the page that fixes each finding. A scheduled scan runs nightly." />
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
                      {rows.map((f) => (
                        <tr key={f.id}>
                          <td style={{ width: 90 }}><GradePill grade={f.grade} /></td>
                          <td><div>{f.title}</div>{f.detail && <small className="muted">{f.detail}</small>}</td>
                          <td style={{ width: 240, textAlign: 'right' }}><FixLink fix={f.fix} /></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Card>
            );
          })}
        </>
      )}
    </>
  );
}
