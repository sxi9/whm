import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Info, RefreshCw } from 'lucide-react';
import { Card, StatusPill, KeyValue, formatDate } from '../../../components/Common.jsx';
import { Button } from '../../../components/Form.jsx';
import { useConfirm } from '../../../components/Modal.jsx';
import { useToast } from '../../../components/Toast.jsx';
import { PanelPage, PendingPill } from '../../../panel/PanelPage.jsx';
import { usePanelApi, panelApi } from '../../../panel/hooks/usePanel.js';
import { PanelRequestError, MutationError, useAccountDomains } from './parts/Shared.jsx';

const TONE = { ok: 'ok', warning: 'warning', missing: 'failed', unknown: 'unknown' };
const STATUS_TEXT = { ok: 'OK', warning: 'Needs attention', missing: 'Missing', unknown: 'Unknown' };
const EXPLAIN = {
  spf: 'Tells receivers which servers may send mail for your domain.',
  dkim: 'Signs outgoing mail so receivers can verify it was not altered.',
  dmarc: 'Tells receivers what to do when SPF or DKIM fail, and where to report.',
  mx: 'Where mail for your domain is delivered.',
  ptr: 'The reverse name of the server address. Set by the hosting provider.',
};

export function scoreTone(score) {
  if (score == null) return '';
  return score >= 80 ? '' : score >= 50 ? 'warn' : 'bad';
}

export function DeliverabilityTable({ report, onFix, busy, pending }) {
  return (
    <div className="table-wrap">
      <table>
        <thead><tr><th style={{ width: 180 }}>Check</th><th style={{ width: 140 }}>Status</th><th>Published record</th><th>Suggested record</th><th className="actions-col" /></tr></thead>
        <tbody>
          {report.items.map((i) => (
            <tr key={i.id}>
              <td><strong>{i.label}</strong><div className="muted" style={{ fontSize: 12.5 }}>{EXPLAIN[i.id]}{i.selector ? ` Selector ${i.selector}.` : ''}</div></td>
              <td>
                <StatusPill status={TONE[i.status] || 'unknown'}>{STATUS_TEXT[i.status] || i.status}</StatusPill>
                {i.id === 'dkim' && i.signing != null && <div style={{ marginTop: 4 }}><StatusPill status={i.signing ? 'ok' : 'warning'}>{i.signing ? 'Signing' : 'Not signing'}</StatusPill></div>}
                {pending?.[i.id] && <div style={{ marginTop: 4 }}><PendingPill result={pending[i.id]} /></div>}
              </td>
              <td>{i.current.length ? i.current.map((c) => <div key={c}><code style={{ wordBreak: 'break-all' }}>{c}</code></div>) : <span className="muted">None</span>}{i.detail && <div className="muted" style={{ marginTop: 4 }}>{i.detail}</div>}{i.signing === false && i.signingHint && <div className="muted" style={{ marginTop: 4 }}>{i.signingHint}</div>}</td>
              <td>{i.expected ? <code style={{ wordBreak: 'break-all' }}>{i.expected}</code> : <span className="muted">—</span>}</td>
              <td className="actions-col">
                {i.fixable && i.status !== 'ok' && report.zone && <Button size="sm" variant="primary" loading={busy} onClick={() => onFix([i.id])}>Fix</Button>}
                {i.id === 'ptr' && i.status !== 'ok' && <span className="muted">Ask your provider</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function DkimCard({ domain, zone, onChanged }) {
  const toast = useToast();
  const confirm = useConfirm();
  const { data, error, loading, refetch } = usePanelApi(`/email/dkim/${domain}`);
  const [busy, setBusy] = useState(false);
  const [mutationError, setMutationError] = useState(null);
  const [pending, setPending] = useState(null);
  const run = async (label, fnc) => {
    setBusy(true); setMutationError(null);
    try {
      const res = await fnc();
      setPending(res?.data?.applied === false ? res.data : null);
      toast.success(label);
      refetch(); onChanged?.();
    } catch (err) { setMutationError(err); } finally { setBusy(false); }
  };
  const generate = () => run('DKIM key generated and its record published', () => panelApi.post(`/email/dkim/${domain}`, { rotate: false }));
  const rotate = async () => {
    if (!(await confirm({ title: `Rotate the DKIM key for ${domain}?`, message: 'A new key replaces the current one and the DNS record is updated. Mail signed with the old key may fail verification for a short while until caches expire.', confirmLabel: 'Rotate key' }))) return;
    run('DKIM key rotated', () => panelApi.post(`/email/dkim/${domain}`, { rotate: true }));
  };
  const remove = async () => {
    if (!(await confirm({ title: `Remove the DKIM key for ${domain}?`, message: 'Outgoing mail is no longer signed and the DNS record is removed. Receivers that require DKIM may reject your mail.', confirmLabel: 'Remove key', danger: true }))) return;
    run('DKIM key removed', () => panelApi.delete(`/email/dkim/${domain}`));
  };
  return (
    <Card title="DKIM signing key" subtitle="The key this server signs outgoing mail with; its public half is published in DNS." actions={data && <StatusPill status={data.key ? 'ok' : 'warning'}>{data.key ? 'Key installed' : 'No key'}</StatusPill>}>
      <PanelRequestError error={error} onRetry={refetch} />
      <MutationError error={mutationError} />
      {loading && !data && !error && <p className="muted">Loading…</p>}
      {data && (
        <>
          <KeyValue items={[
            ['Domain', <code key="d">{data.domain}</code>],
            ['Selector', data.key ? <code key="s">{data.key.selector}</code> : null],
            ['Generated', data.key ? formatDate(data.key.createdAt) : null],
            ['DNS hosted here', <StatusPill key="z" status={data.zone ? 'ok' : 'unknown'}>{data.zone ? 'Yes' : 'No'}</StatusPill>],
          ]} />
          <div className="form-actions" style={{ marginTop: 12 }}>
            {!data.key && <Button variant="primary" loading={busy} disabled={!zone} onClick={generate}>Generate key</Button>}
            {data.key && <Button loading={busy} disabled={!zone} onClick={rotate}>Rotate key</Button>}
            {data.key && <Button variant="danger-ghost" loading={busy} disabled={!zone} onClick={remove}>Remove key</Button>}
            <PendingPill result={pending} />
          </div>
          {!zone && <p className="muted" style={{ marginTop: 8 }}>Keys can only be managed for domains whose DNS is hosted on this server.</p>}
        </>
      )}
    </Card>
  );
}

function DomainReport({ domain }) {
  const toast = useToast();
  const confirm = useConfirm();
  const { data, error, loading, refetch, setData } = usePanelApi(`/email/deliverability/${domain}`);
  const [busy, setBusy] = useState(false);
  const [mutationError, setMutationError] = useState(null);
  const [pending, setPending] = useState({});
  const [dkimKey, setDkimKey] = useState(0);
  const fix = async (items) => {
    const names = items.map((i) => i.toUpperCase()).join(', ');
    if (!(await confirm({ title: `Create the ${names} record${items.length > 1 ? 's' : ''}?`, message: `The suggested record${items.length > 1 ? 's are' : ' is'} written into the DNS zone of ${domain} and published. An existing SPF or DMARC record is replaced; DKIM generates a key when none exists.`, confirmLabel: 'Fix' }))) return;
    setBusy(true); setMutationError(null);
    try {
      const { data: res } = await panelApi.post(`/email/deliverability/${domain}/fix`, { items });
      const failed = Object.entries(res.results).filter(([, r]) => !r.ok);
      const waiting = Object.entries(res.results).filter(([, r]) => r.ok && r.applied === false);
      if (failed.length) toast.warning(failed.map(([k, r]) => `${k.toUpperCase()}: ${r.error}`).join('; '));
      else if (waiting.length) toast.info(`${waiting.map(([k]) => k.toUpperCase()).join(', ')} saved; publishing waits for the DNS server`);
      else toast.success(`${names} created and published`);
      setPending((p) => ({ ...p, ...Object.fromEntries(waiting.map(([k, r]) => [k, r])) }));
      setData(res.status);
      setDkimKey((k) => k + 1);
    } catch (err) { setMutationError(err); } finally { setBusy(false); }
  };
  const fixable = data?.items.filter((i) => i.fixable && i.status !== 'ok').map((i) => i.id) || [];
  const okCount = data?.items.filter((i) => i.status === 'ok').length ?? 0;
  return (
    <>
      <Card title={domain} subtitle={data ? `Checked ${formatDate(data.checkedAt)}` : 'Looking up SPF, DKIM, DMARC, MX and reverse DNS…'} padded={false}
        actions={<><Button size="sm" icon={RefreshCw} onClick={() => refetch()} loading={loading && Boolean(data)}>Re-check</Button>{fixable.length > 0 && data?.zone && <Button size="sm" variant="primary" loading={busy} onClick={() => fix(fixable)}>Fix all ({fixable.map((f) => f.toUpperCase()).join(', ')})</Button>}</>}>
        <div className="card-body">
          <PanelRequestError error={error} onRetry={refetch} />
          <MutationError error={mutationError} />
          {loading && !data && !error && <p className="muted">Loading…</p>}
          {data && (
            <>
              <div className="stat-grid" style={{ marginBottom: 4 }}>
                <div className="stat"><div className="label">Deliverability score</div><div className="value">{data.score}<span className="muted" style={{ fontSize: 14, fontWeight: 500 }}> / 100</span></div><div className={`meter ${scoreTone(data.score)}`}><span style={{ width: `${data.score}%` }} /></div></div>
                <div className="stat"><div className="label">Checks passing</div><div className="value">{okCount} of {data.items.length}</div></div>
                <div className="stat"><div className="label">DNS hosted here</div><div className="value" style={{ fontSize: 17 }}>{data.zone ? 'Yes' : 'No'}</div></div>
              </div>
              {!data.zone && <div className="banner banner-info" style={{ marginTop: 12 }}><Info size={18} /><div>The DNS of this domain is not hosted on this server, so records can only be suggested here. Add them at your DNS provider.</div></div>}
            </>
          )}
        </div>
        {data && <DeliverabilityTable report={data} onFix={fix} busy={busy} pending={pending} />}
      </Card>
      <DkimCard key={dkimKey} domain={domain} zone={Boolean(data?.zone)} onChanged={() => refetch()} />
    </>
  );
}

export default function Deliverability({ fn }) {
  const domains = useAccountDomains();
  const [domain, setDomain] = useState('');
  const current = domain || domains[0] || '';
  return (
    <PanelPage fn={fn} actions={domains.length > 1 && <select className="input select" value={current} onChange={(e) => setDomain(e.target.value)} aria-label="Domain">{domains.map((d) => <option key={d} value={d}>{d}</option>)}</select>}>
      {current ? <DomainReport key={current} domain={current} /> : <Card><p className="muted">No domains on this account yet.</p></Card>}
      <p className="muted">Records are checked as the rest of the internet sees them, so a change can take a few minutes to show. Individual records can be edited in the <Link to="/panel/dns/zone-editor">zone editor</Link>.</p>
    </PanelPage>
  );
}
