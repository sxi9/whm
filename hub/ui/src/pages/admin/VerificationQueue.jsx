import { useState } from 'react';
import { Link } from 'react-router-dom';
import { PageHeader, Card, StatusPill, formatDate, EmptyState } from '../../components/Common.jsx';
import { Button, ErrorBanner, Select } from '../../components/Form.jsx';
import { Modal } from '../../components/Modal.jsx';
import { api } from '../../api/client.js';
import { useApi } from '../../hooks/useApi.js';
import { useAction } from '../../hooks/useAction.js';
import { ReasonModal, KV } from '../../widgets/index.jsx';
import { decideVerification, VERIFICATION_REJECT_CODES } from './queues.js';

const STATUSES = ['pending', 'verified', 'rejected', 'suspended'];

export function EvidenceList({ verifications }) {
  if (!verifications?.length) return <p className="muted">No evidence submitted.</p>;
  return (
    <ul className="timeline">
      {verifications.map((v) => (
        <li key={v.id}>
          <time>{formatDate(v.checked_at || v.created_at)}</time>
          <span>
            <StatusPill status={v.result} /> <strong>{v.method}</strong>{v.ns && <> for <code>{v.ns}</code></>}
            {v.evidence?.domain && <> · {v.evidence.domain}</>}{v.evidence?.org && <> · github.com/{v.evidence.org}</>}
            {v.result_detail && <span className="muted"> — {typeof v.result_detail === 'string' ? v.result_detail : JSON.stringify(v.result_detail)}</span>}
            {v.reviewer_note && <span className="muted"> · note: {v.reviewer_note}</span>}
          </span>
        </li>
      ))}
    </ul>
  );
}

// The id_document evidence row (dvf_…) whose encrypted upload the admin route
// GET /admin/market/verifications/:id/document decrypts; the developer id is
// not a valid argument there.
export function idDocumentOf(verifications) {
  return (verifications || []).find((v) => v.method === 'id_document' && v.has_document !== false) || null;
}

// The route answers { content_type, data (base64) }, not a file.
export function documentDataUrl(doc) {
  if (!doc?.data) return null;
  return `data:${doc.content_type || 'application/octet-stream'};base64,${doc.data}`;
}

export function DocumentViewer({ verification, open, onClose }) {
  const { run, busy, error } = useAction();
  const [doc, setDoc] = useState(null);
  const load = () => run(() => api.get(`/admin/market/verifications/${verification.id}/document`), { silent: true, then: (r) => setDoc(r.data) });
  const url = documentDataUrl(doc);
  const type = doc?.content_type || '';
  const openTab = () => {
    const bytes = Uint8Array.from(atob(doc.data), (c) => c.charCodeAt(0));
    const blobUrl = URL.createObjectURL(new Blob([bytes], { type: type || 'application/octet-stream' }));
    window.open(blobUrl, '_blank', 'noopener');
    setTimeout(() => URL.revokeObjectURL(blobUrl), 60_000);
  };
  return (
    <Modal open={open} title="ID document" onClose={() => { setDoc(null); onClose(); }} size="lg"
      footer={<><Button onClick={() => { setDoc(null); onClose(); }}>Close</Button>{doc && <Button variant="primary" onClick={openTab}>Open in new tab</Button>}</>}>
      <ErrorBanner error={error} onRetry={load} />
      <p className="muted">Uploaded {formatDate(verification?.created_at)} · every view is audited (<code>developer.verification.document_view</code>) · purged 30 days after the decision.</p>
      {!doc && <Button variant="primary" loading={busy} onClick={load}>Load document</Button>}
      {doc && type.startsWith('image/') && <img src={url} alt="Uploaded ID document" style={{ maxWidth: '100%' }} />}
      {doc && type === 'application/pdf' && <object data={url} type="application/pdf" style={{ width: '100%', height: '70vh' }} aria-label="Uploaded ID document">PDF preview unavailable; open it in a new tab.</object>}
      {doc && !type.startsWith('image/') && type !== 'application/pdf' && <p>{type || 'unknown type'}: no inline preview; open it in a new tab.</p>}
    </Modal>
  );
}

function QueueEntry({ entry, onDecided }) {
  const { developer: d, namespaces, verifications, keys, rejections_90d } = entry;
  const { run, busy } = useAction();
  const [modal, setModal] = useState(null);
  const decide = (decision, payload) => run(() => decideVerification(api, d.id, decision, payload), { success: `Developer ${decision === 'approve' ? 'verified' : decision === 'reject' ? 'rejected' : 'asked for more evidence'}`, then: onDecided });
  const passed = (verifications || []).filter((v) => v.result === 'passed').length;
  const idDoc = idDocumentOf(verifications);
  return (
    <Card title={<>{d.display_name} <span className="muted">· {d.email}</span></>} subtitle={`${d.slug || 'no slug'} · registered ${formatDate(d.created_at)}${d.verified_at ? ` · previously verified ${formatDate(d.verified_at)}` : ''}`}
      actions={<><StatusPill status={d.status} />{rejections_90d > 0 && <span className="pill pill-warn">{rejections_90d} rejection(s) in 90 d</span>}{!d.email_verified && <span className="pill pill-bad">e-mail unverified</span>}</>}>
      <div className="two-col">
        <div>
          <KV items={[['Company', d.company], ['Website', d.website ? <a href={d.website} target="_blank" rel="noreferrer noopener">{d.website}</a> : null], ['Country', d.country], ['Support', d.support_email || d.support_url], ['2FA', d.totp_enabled ? 'enabled' : 'not enrolled'], ['Status reason', d.status_reason]]} />
          <p style={{ marginTop: 10 }}><strong>Namespaces</strong></p>
          <div className="inline-list">{(namespaces || []).map((n) => <span key={n.ns} className={`pill ${n.status === 'verified' ? 'pill-ok' : 'pill-muted'}`}>{n.ns} · {n.status}</span>)}{!(namespaces || []).length && <span className="muted">none claimed</span>}</div>
          <p style={{ marginTop: 10 }}><strong>Signing keys</strong></p>
          <div className="inline-list">{(keys || []).map((k) => <span key={k.kid} className={`pill ${k.status === 'active' ? 'pill-ok' : 'pill-muted'}`}>{k.kid} {k.label ? `· ${k.label}` : ''}</span>)}{!(keys || []).length && <span className="muted">none registered</span>}</div>
        </div>
        <div>
          <p><strong>Evidence</strong> <span className="muted">({passed} passed of {(verifications || []).length}) — automated results are inputs, the decision is yours</span></p>
          <EvidenceList verifications={verifications} />
          {idDoc && <p className="muted">An ID document was uploaded; it is purged 30 days after the decision. <Button size="sm" onClick={() => setModal('document')}>View document</Button></p>}
        </div>
      </div>
      <div className="inline-list" style={{ marginTop: 12 }}>
        <Button variant="primary" disabled={busy || d.status === 'verified'} onClick={() => setModal('approve')}>Approve</Button>
        <Button disabled={busy} onClick={() => setModal('request-evidence')}>Request more evidence</Button>
        <Button variant="danger" disabled={busy || d.status === 'rejected'} onClick={() => setModal('reject')}>Reject</Button>
        <Link className="btn" to={`/admin/market/developers/${d.id}`}>History</Link>
      </div>
      <ReasonModal open={modal === 'approve'} title={`Verify ${d.display_name}`} label="Note (optional)" required={false} danger={false} confirmLabel="Approve" onClose={() => setModal(null)} help="Sets verified_at and reverify_due_at (+12 months); the developer may publish."
        onConfirm={({ reason }) => decide('approve', { note: reason || undefined })} />
      <ReasonModal open={modal === 'reject'} title={`Reject ${d.display_name}`} options={VERIFICATION_REJECT_CODES} optionsLabel="Reason code" label="Details for the developer" required={false} confirmLabel="Reject" onClose={() => setModal(null)}
        onConfirm={({ reason, code }) => decide('reject', { code, text: reason || undefined })} />
      {idDoc && <DocumentViewer verification={idDoc} open={modal === 'document'} onClose={() => setModal(null)} />}
      <ReasonModal open={modal === 'request-evidence'} title="Request more evidence" label="What is missing?" danger={false} confirmLabel="Send" onClose={() => setModal(null)}
        onConfirm={({ reason }) => decide('request-evidence', { text: reason })} />
    </Card>
  );
}

export default function VerificationQueue() {
  const [status, setStatus] = useState('pending');
  const { data, loading, error, refetch } = useApi(`/admin/market/verifications?status=${status}`);
  const rows = data || [];
  return (
    <>
      <PageHeader title="Developer verification queue" description="No developer publishes before a human decision recorded here with evidence." home="/admin"
        actions={<Select value={status} onChange={setStatus} options={STATUSES} />} />
      <ErrorBanner error={error} onRetry={refetch} />
      {loading && !data && <p className="muted">Loading…</p>}
      {!loading && !rows.length && <EmptyState title={`No ${status} developers`}>The queue is empty.</EmptyState>}
      {rows.map((entry) => <QueueEntry key={entry.developer.id} entry={entry} onDecided={refetch} />)}
    </>
  );
}
