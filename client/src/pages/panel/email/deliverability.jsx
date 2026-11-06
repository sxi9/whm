import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Info, RefreshCw, Copy } from 'lucide-react';
import { Card, StatusPill, KeyValue, formatDate } from '../../../components/Common.jsx';
import { Button } from '../../../components/Form.jsx';
import { useConfirm } from '../../../components/Modal.jsx';
import { useToast } from '../../../components/Toast.jsx';
import { PanelPage, PendingPill } from '../../../panel/PanelPage.jsx';
import { usePanelApi, panelApi } from '../../../panel/hooks/usePanel.js';
import { PanelRequestError, MutationError, useAccountDomains, useEmailT } from './parts/Shared.jsx';
import { DelegationBanner, managedAt, notDelegatedHere } from '../../../panel/DelegationBanner.jsx';

// The records a report says are still to be published: what the banner lists
// when the domain's DNS is managed elsewhere.
export const pendingRecords = (report) => (report?.records || []).filter((r) => r.status !== 'ok');

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

const RECORD_STYLE = { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', wordBreak: 'normal' };

export function DeliverabilityTable({ report, onFix, busy, pending }) {
  const { t } = useEmailT();
  const toast = useToast();
  const elsewhere = notDelegatedHere(report.delegation);
  const copyRecord = async (value) => {
    try { await navigator.clipboard.writeText(value); toast.success(t('panel.email.deliverability.record_copied', 'Record copied')); } catch { toast.error(t('panel.email.deliverability.copy_failed', 'Copy failed; select the record and copy it by hand')); }
  };
  return (
    <div className="table-wrap">
      <table>
        <thead><tr><th style={{ width: 180 }}>{t('panel.email.deliverability.check', 'Check')}</th><th style={{ width: 140 }}>{t('panel.email.common.status', 'Status')}</th><th>{t('panel.email.deliverability.published_record', 'Published record')}</th><th>{t('panel.email.deliverability.suggested_record', 'Suggested record')}</th><th className="actions-col" /></tr></thead>
        <tbody>
          {report.items.map((i) => (
            <tr key={i.id}>
              <td><strong>{i.label}</strong><div className="muted" style={{ fontSize: 12.5 }}>{EXPLAIN[i.id] ? t(`panel.email.deliverability.explain_${i.id}`, EXPLAIN[i.id]) : null}{i.selector ? ` ${t('panel.email.deliverability.selector_note', 'Selector {selector}.', { selector: i.selector })}` : ''}</div></td>
              <td>
                <StatusPill status={TONE[i.status] || 'unknown'}>{STATUS_TEXT[i.status] ? t(`panel.email.deliverability.status_${i.status}`, STATUS_TEXT[i.status]) : i.status}</StatusPill>
                {i.id === 'dkim' && i.signing != null && <div style={{ marginTop: 4 }}><StatusPill status={i.signing ? 'ok' : 'warning'}>{i.signing ? t('panel.email.deliverability.signing', 'Signing') : t('panel.email.deliverability.not_signing', 'Not signing')}</StatusPill></div>}
                {pending?.[i.id] && <div style={{ marginTop: 4 }}><PendingPill result={pending[i.id]} /></div>}
              </td>
              <td>{i.current.length ? i.current.map((c) => <div key={c}><code style={RECORD_STYLE}>{c}</code></div>) : <span className="muted">{t('panel.email.common.none', 'None')}</span>}{i.detail && <div className="muted" style={{ marginTop: 4 }}>{i.detail}</div>}{i.signing === false && i.signingHint && <div className="muted" style={{ marginTop: 4 }}>{i.signingHint}</div>}</td>
              <td>{i.expected ? <code style={RECORD_STYLE}>{i.expected}</code> : <span className="muted">—</span>}</td>
              <td className="actions-col">
                {i.fixable && i.status !== 'ok' && report.zone && !elsewhere && <Button size="sm" variant="primary" loading={busy} onClick={() => onFix([i.id])}>{t('panel.email.deliverability.fix', 'Fix')}</Button>}
                {i.fixable && i.status !== 'ok' && report.zone && elsewhere && (i.expected ? <div style={{ display: 'grid', gap: 4, justifyItems: 'end' }}><Button size="sm" icon={Copy} onClick={() => copyRecord(i.expected)}>{t('panel.email.deliverability.copy_record', 'Copy record')}</Button><small className="muted" style={{ whiteSpace: 'normal' }}>{t('panel.email.deliverability.copy_to', 'Copy to {at}', { at: managedAt(report.delegation) })}</small></div> : i.id === 'dkim' ? <Button size="sm" loading={busy} onClick={() => onFix([i.id])}>{t('panel.email.deliverability.prepare_record', 'Prepare record')}</Button> : null)}
                {i.id === 'ptr' && i.status !== 'ok' && <span className="muted">{t('panel.email.common.ask_your_provider', 'Ask your provider')}</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function DkimCard({ domain, zone, onChanged }) {
  const { t } = useEmailT();
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
  const generate = () => run(t('panel.email.deliverability.toast_dkim_generated', 'DKIM key generated and its record published'), () => panelApi.post(`/email/dkim/${domain}`, { rotate: false }));
  const rotate = async () => {
    if (!(await confirm({ title: t('panel.email.deliverability.rotate_title', 'Rotate the DKIM key for {domain}?', { domain }), message: t('panel.email.deliverability.rotate_text', 'A new key replaces the current one and the DNS record is updated. Mail signed with the old key may fail verification for a short while until caches expire.'), confirmLabel: t('panel.email.deliverability.rotate_key', 'Rotate key') }))) return;
    run(t('panel.email.deliverability.toast_dkim_rotated', 'DKIM key rotated'), () => panelApi.post(`/email/dkim/${domain}`, { rotate: true }));
  };
  const remove = async () => {
    if (!(await confirm({ title: t('panel.email.deliverability.remove_title', 'Remove the DKIM key for {domain}?', { domain }), message: t('panel.email.deliverability.remove_text', 'Outgoing mail is no longer signed and the DNS record is removed. Receivers that require DKIM may reject your mail.'), confirmLabel: t('panel.email.deliverability.remove_key', 'Remove key'), danger: true }))) return;
    run(t('panel.email.deliverability.toast_dkim_removed', 'DKIM key removed'), () => panelApi.delete(`/email/dkim/${domain}`));
  };
  return (
    <Card title={t('panel.email.deliverability.dkim_title', 'DKIM signing key')} subtitle={t('panel.email.deliverability.dkim_subtitle', 'The key this server signs outgoing mail with; its public half is published in DNS.')} actions={data && <StatusPill status={data.key ? 'ok' : 'warning'}>{data.key ? t('panel.email.deliverability.key_installed', 'Key installed') : t('panel.email.deliverability.no_key', 'No key')}</StatusPill>}>
      <PanelRequestError error={error} onRetry={refetch} />
      <MutationError error={mutationError} />
      {loading && !data && !error && <p className="muted">{t('panel.email.common.loading', 'Loading…')}</p>}
      {data && (
        <>
          <KeyValue items={[
            [t('panel.email.common.domain', 'Domain'), <code key="d">{data.domain}</code>],
            [t('panel.email.deliverability.selector', 'Selector'), data.key ? <code key="s">{data.key.selector}</code> : null],
            [t('panel.email.deliverability.generated', 'Generated'), data.key ? formatDate(data.key.createdAt) : null],
            [t('panel.email.deliverability.dns_hosted_here', 'DNS hosted here'), <StatusPill key="z" status={data.zone ? 'ok' : 'unknown'}>{data.zone ? t('panel.email.common.yes', 'Yes') : t('panel.email.common.no', 'No')}</StatusPill>],
          ]} />
          <div className="form-actions" style={{ marginTop: 12 }}>
            {!data.key && <Button variant="primary" loading={busy} disabled={!zone} onClick={generate}>{t('panel.email.deliverability.generate_key', 'Generate key')}</Button>}
            {data.key && <Button loading={busy} disabled={!zone} onClick={rotate}>{t('panel.email.deliverability.rotate_key', 'Rotate key')}</Button>}
            {data.key && <Button variant="danger-ghost" loading={busy} disabled={!zone} onClick={remove}>{t('panel.email.deliverability.remove_key', 'Remove key')}</Button>}
            <PendingPill result={pending} />
          </div>
          {!zone && <p className="muted" style={{ marginTop: 8 }}>{t('panel.email.deliverability.keys_need_zone', 'Keys can only be managed for domains whose DNS is hosted on this server.')}</p>}
        </>
      )}
    </Card>
  );
}

function DomainReport({ domain }) {
  const { t } = useEmailT();
  const toast = useToast();
  const confirm = useConfirm();
  const { data, error, loading, refetch, setData } = usePanelApi(`/email/deliverability/${domain}`);
  const [busy, setBusy] = useState(false);
  const [mutationError, setMutationError] = useState(null);
  const [pending, setPending] = useState({});
  const [dkimKey, setDkimKey] = useState(0);
  const elsewhere = notDelegatedHere(data?.delegation);
  const fix = async (items) => {
    const names = items.map((i) => i.toUpperCase()).join(', ');
    const many = items.length > 1;
    const question = elsewhere
      ? { title: many ? t('panel.email.deliverability.prepare_title_many', 'Prepare the {names} records?', { names }) : t('panel.email.deliverability.prepare_title', 'Prepare the {names} record?', { names }), message: many ? t('panel.email.deliverability.prepare_text_many', 'DNS for {domain} is managed at {at}, so nothing is written here: the records are shown for you to add there. DKIM generates a key when none exists.', { domain, at: managedAt(data.delegation) }) : t('panel.email.deliverability.prepare_text', 'DNS for {domain} is managed at {at}, so nothing is written here: the record is shown for you to add there. DKIM generates a key when none exists.', { domain, at: managedAt(data.delegation) }), confirmLabel: t('panel.email.deliverability.prepare', 'Prepare') }
      : { title: many ? t('panel.email.deliverability.create_title_many', 'Create the {names} records?', { names }) : t('panel.email.deliverability.create_title', 'Create the {names} record?', { names }), message: many ? t('panel.email.deliverability.create_text_many', 'The suggested records are written into the DNS zone of {domain} and published. An existing SPF or DMARC record is replaced; DKIM generates a key when none exists.', { domain }) : t('panel.email.deliverability.create_text', 'The suggested record is written into the DNS zone of {domain} and published. An existing SPF or DMARC record is replaced; DKIM generates a key when none exists.', { domain }), confirmLabel: t('panel.email.deliverability.fix', 'Fix') };
    if (!(await confirm(question))) return;
    setBusy(true); setMutationError(null);
    try {
      const { data: res } = await panelApi.post(`/email/deliverability/${domain}/fix`, { items });
      const failed = Object.entries(res.results).filter(([, r]) => !r.ok);
      const copy = Object.entries(res.results).filter(([, r]) => r.ok && r.reason === 'not_delegated');
      const waiting = Object.entries(res.results).filter(([, r]) => r.ok && r.applied === false && r.reason !== 'not_delegated');
      if (failed.length) toast.warning(failed.map(([k, r]) => `${k.toUpperCase()}: ${r.error}`).join('; '));
      else if (copy.length) toast.warning(copy.length > 1 ? t('panel.email.deliverability.toast_copy_many', '{names}: not published from here — add the records at {at}', { names: copy.map(([k]) => k.toUpperCase()).join(', '), at: managedAt(res.delegation) }) : t('panel.email.deliverability.toast_copy', '{names}: not published from here — add the record at {at}', { names: copy.map(([k]) => k.toUpperCase()).join(', '), at: managedAt(res.delegation) }));
      else if (waiting.length) toast.info(t('panel.email.deliverability.toast_waiting', '{names} saved; publishing waits for the DNS server', { names: waiting.map(([k]) => k.toUpperCase()).join(', ') }));
      else toast.success(t('panel.email.deliverability.toast_created', '{names} created and published', { names }));
      setPending((p) => ({ ...p, ...Object.fromEntries(waiting.map(([k, r]) => [k, r])) }));
      setData(res.status);
      setDkimKey((k) => k + 1);
    } catch (err) { setMutationError(err); } finally { setBusy(false); }
  };
  const fixable = data?.items.filter((i) => i.fixable && i.status !== 'ok').map((i) => i.id) || [];
  const okCount = data?.items.filter((i) => i.status === 'ok').length ?? 0;
  return (
    <>
      <Card title={domain} subtitle={data ? t('panel.email.deliverability.checked_at', 'Checked {date}', { date: formatDate(data.checkedAt) }) : t('panel.email.deliverability.looking_up', 'Looking up SPF, DKIM, DMARC, MX and reverse DNS…')} padded={false}
        actions={<><Button size="sm" icon={RefreshCw} onClick={() => refetch()} loading={loading && Boolean(data)}>{t('panel.email.common.recheck', 'Re-check')}</Button>{fixable.length > 0 && data?.zone && !elsewhere && <Button size="sm" variant="primary" loading={busy} onClick={() => fix(fixable)}>{t('panel.email.deliverability.fix_all', 'Fix all ({names})', { names: fixable.map((f) => f.toUpperCase()).join(', ') })}</Button>}</>}>
        <div className="card-body">
          <PanelRequestError error={error} onRetry={refetch} />
          <MutationError error={mutationError} />
          {loading && !data && !error && <p className="muted">{t('panel.email.common.loading', 'Loading…')}</p>}
          {data && (
            <>
              <div className="stat-grid" style={{ marginBottom: 4 }}>
                <div className="stat"><div className="label">{t('panel.email.deliverability.score', 'Deliverability score')}</div><div className="value">{data.score}<span className="muted" style={{ fontSize: 14, fontWeight: 500 }}> / 100</span></div><div className={`meter ${scoreTone(data.score)}`}><span style={{ width: `${data.score}%` }} /></div></div>
                <div className="stat"><div className="label">{t('panel.email.deliverability.checks_passing', 'Checks passing')}</div><div className="value">{t('panel.email.common.n_of_m', '{n} of {m}', { n: okCount, m: data.items.length })}</div></div>
                <div className="stat"><div className="label">{t('panel.email.deliverability.dns_hosted_here', 'DNS hosted here')}</div><div className="value" style={{ fontSize: 17 }}>{data.zone ? t('panel.email.common.yes', 'Yes') : t('panel.email.common.no', 'No')}</div></div>
              </div>
              {!data.zone && <div className="banner banner-info" style={{ marginTop: 12 }}><Info size={18} /><div>{t('panel.email.deliverability.no_zone', 'The DNS of this domain is not hosted on this server, so records can only be suggested here. Add them at your DNS provider.')}</div></div>}
              <div style={{ marginTop: 12 }}><DelegationBanner domain={domain} delegation={data.delegation} records={pendingRecords(data)} title={t('panel.email.deliverability.delegation_title', 'Mail records are not published from here')} /></div>
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
  const { t } = useEmailT();
  const domains = useAccountDomains();
  const [domain, setDomain] = useState('');
  const current = domain || domains[0] || '';
  return (
    <PanelPage fn={fn} actions={domains.length > 1 && <select className="input select" value={current} onChange={(e) => setDomain(e.target.value)} aria-label={t('panel.email.common.domain', 'Domain')}>{domains.map((d) => <option key={d} value={d}>{d}</option>)}</select>}>
      {current ? <DomainReport key={current} domain={current} /> : <Card><p className="muted">{t('panel.email.common.no_domains', 'No domains on this account yet.')}</p></Card>}
      <p className="muted">{t('panel.email.deliverability.footer', 'Records are checked as the rest of the internet sees them, so a change can take a few minutes to show. Individual records can be edited in the')} <Link to="/panel/dns/zone-editor">{t('panel.email.common.zone_editor', 'zone editor')}</Link>.</p>
    </PanelPage>
  );
}
