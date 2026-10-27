import { useState } from 'react';
import { PageHeader, Card, StatusPill, CapabilityNotice, formatDate } from '../../components/Common.jsx';
import { Field, TextInput, Select, Button, ErrorBanner } from '../../components/Form.jsx';
import { useConfirm } from '../../components/Modal.jsx';
import { api, queryString } from '../../api/client.js';
import { useApi } from '../../hooks/useApi.js';
import { useAction } from '../../hooks/useAction.js';
import { useAuth } from '../../auth/AuthContext.jsx';

// Namespace ↔ domain rule: net.acme ↔ acme.net; evidence on that domain or
// its registrable parent (§18.2).
// The GitHub OAuth start URL is hub-generated (routes/developer.js), but the
// browser is only ever sent to github.com: any other origin is refused.
export function githubAuthorizeUrl(url) {
  return typeof url === 'string' && /^https:\/\/github\.com\//.test(url) ? url : null;
}

export function domainOfNamespace(ns) {
  return String(ns || '').trim().toLowerCase().split('.').filter(Boolean).reverse().join('.');
}

export default function Verification() {
  const { session } = useAuth();
  const namespaces = useApi('/dev/namespaces');
  const verifications = useApi('/dev/verification');
  const { run, busy, error } = useAction();
  const confirm = useConfirm();
  const [ns, setNs] = useState('');
  const [method, setMethod] = useState('dns_txt');
  const [target, setTarget] = useState('');
  const [org, setOrg] = useState('');
  const [submitted, setSubmitted] = useState(null);
  const refresh = () => { namespaces.refetch(); verifications.refetch(); };
  const claimed = namespaces.data || [];
  const nsOptions = claimed.map((n) => n.ns);
  return (
    <>
      <PageHeader title="Verification" description="Claim reverse-DNS namespaces and prove you control their domains. A vendor reviewer makes the final decision." home="/dev" />
      {!session?.totpEnabled && <div className="banner banner-warning"><div>Enable two-factor authentication under Security before claiming a namespace.</div></div>}
      <ErrorBanner error={error} />
      <div className="two-col">
        <Card title="Namespaces" subtitle="Plugin ids must start with a claimed namespace, e.g. net.acme → net.acme.cache-boost">
          <ul className="timeline">
            {claimed.map((n) => <li key={n.ns}><time>{formatDate(n.verified_at || n.last_check_at)}</time><span><code>{n.ns}</code> <StatusPill status={n.status} /> <span className="muted">{n.domain}</span> <Button size="sm" variant="ghost" onClick={async () => { if (await confirm({ title: 'Release namespace', message: n.ns, danger: true })) run(() => api.delete(`/dev/namespaces/${encodeURIComponent(n.ns)}`), { success: 'Namespace released', then: refresh }); }}>Release</Button></span></li>)}
            {!claimed.length && <li><span className="muted">No namespaces claimed.</span></li>}
          </ul>
          <Field label="Claim a namespace" help={ns ? `Domain: ${domainOfNamespace(ns)} (must not be a public suffix; reserved: net.whm, com.cpanel, …)` : 'Reverse-DNS prefix of ≥ 2 segments, lower-case'}>
            <div className="input-group"><TextInput value={ns} onChange={setNs} placeholder="net.acme" /><Button variant="primary" loading={busy} disabled={!ns.includes('.')} onClick={() => run(() => api.post('/dev/namespaces', { ns: ns.trim().toLowerCase() }), { success: 'Namespace claimed; now submit evidence', then: () => { setNs(''); refresh(); } })}>Claim</Button></div>
          </Field>
        </Card>
        <Card title="Submit evidence">
          <Field label="Namespace"><Select value={target} onChange={setTarget} options={nsOptions} placeholder="pick a claimed namespace" /></Field>
          <Field label="Method"><Select value={method} onChange={setMethod} options={[{ value: 'dns_txt', label: 'DNS TXT record' }, { value: 'well_known', label: 'https://<domain>/.well-known/whm-developer.txt' }, { value: 'github_org', label: 'GitHub organisation (com.github.<org> only)' }, { value: 'id_document', label: 'ID document (optional, purged after 30 days)' }]} /></Field>
          {method === 'github_org' && <Field label="GitHub organisation"><TextInput value={org} onChange={setOrg} placeholder="acme" /></Field>}
          <Button variant="primary" loading={busy} disabled={!target || (method === 'github_org' && !org)} onClick={() => run(() => api.post('/dev/verification', { method, ns: target, ...(method === 'github_org' ? { org } : {}) }), { success: 'Evidence request created', then: (r) => { setSubmitted(r.data); refresh(); } })}>Create evidence request</Button>
          {submitted?.instructions && (
            <div className="banner banner-info" style={{ marginTop: 12 }}><div>
              <strong>Publish this token, then re-check.</strong>
              {submitted.instructions.record && <pre className="code-block">{submitted.instructions.record}  IN  {submitted.instructions.type}  "{submitted.instructions.value}"</pre>}
              {submitted.instructions.url && <pre className="code-block">{submitted.instructions.url}{'\n'}{submitted.instructions.content}</pre>}
            </div></div>
          )}
        </Card>
      </div>
      <Card title="Evidence & checks" subtitle="Automated checks (SSRF-safe, 5/h) set passed/failed; they are inputs to the reviewer, not the decision.">
        <ErrorBanner error={verifications.error} onRetry={verifications.refetch} />
        <div className="table-wrap">
          <table>
            <thead><tr><th>Created</th><th>Namespace</th><th>Method</th><th>Result</th><th>Detail</th><th /></tr></thead>
            <tbody>
              {(verifications.data || []).map((v) => (
                <tr key={v.id}><td>{formatDate(v.created_at)}</td><td><code>{v.ns || '—'}</code></td><td>{v.method}</td><td><StatusPill status={v.result} /></td>
                  <td>{v.evidence?.token && <code className="small">whm-dev-verify={v.evidence.token}</code>}{v.result_detail && <span className="muted"> {typeof v.result_detail === 'string' ? v.result_detail : JSON.stringify(v.result_detail)}</span>}{v.reviewer_note && <span className="muted"> · reviewer: {v.reviewer_note}</span>}</td>
                  <td className="inline-list">
                    {['dns_txt', 'well_known'].includes(v.method) && <Button size="sm" loading={busy} onClick={() => run(() => api.post(`/dev/verification/${v.id}/recheck`), { success: (r) => `Check result: ${r.data?.result}`, then: refresh })}>Re-check</Button>}
                    {v.method === 'github_org' && <Button size="sm" onClick={() => run(() => api.get(`/dev/verification/github/start${queryString({ id: v.id })}`), { then: (r) => { const url = githubAuthorizeUrl(r.data?.url); if (url) window.location.assign(url); else throw Object.assign(new Error('The hub returned an unexpected GitHub authorisation URL'), { code: 'invalid_redirect' }); } })}>Connect GitHub</Button>}
                  </td></tr>
              ))}
              {!(verifications.data || []).length && <tr><td colSpan={6} className="muted">No evidence submitted yet.</td></tr>}
            </tbody>
          </table>
        </div>
        <CapabilityNotice error={error} />
      </Card>
    </>
  );
}
