import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Info, RefreshCw } from 'lucide-react';
import { Card, StatusPill, EmptyState } from '../../../components/Common.jsx';
import { Button, Select } from '../../../components/Form.jsx';
import { useConfirm } from '../../../components/Modal.jsx';
import { useToast } from '../../../components/Toast.jsx';
import { PanelPage, PendingPill } from '../../../panel/PanelPage.jsx';
import { usePanelApi, panelApi } from '../../../panel/hooks/usePanel.js';
import { PanelRequestError, MutationError, useEmailT, tr } from './parts/Shared.jsx';
import { DelegationBanner, notDelegatedHere } from '../../../panel/DelegationBanner.jsx';

export const ROUTING_OPTIONS = [
  { value: 'auto', label: 'Automatic (deliver here)' },
  { value: 'local', label: 'Local mail exchanger (deliver here)' },
  { value: 'remote', label: 'Remote mail exchanger (another server)' },
];

export const ROUTING_HELP = {
  auto: 'Mail for this domain is accepted and delivered to the mailboxes on this server.',
  local: 'Same as automatic, pinned: this server is the final destination for the domain.',
  remote: 'This server does not accept mail for the domain; it is sent to whatever the public MX records name. Only possible while the domain has no mailboxes here.',
};

// What the MX column says about a domain's public MX records.
export function mxSummary(mx, hostname) {
  if (!mx) return { status: 'unknown', label: tr('panel.email.routing.mx_not_checked', 'Not checked'), detail: null };
  if (!mx.ok) return { status: 'warning', label: tr('panel.email.routing.mx_lookup_failed', 'Lookup failed'), detail: mx.error || null };
  if (!mx.records?.length) return { status: 'warning', label: tr('panel.email.routing.mx_none', 'No MX record'), detail: tr('panel.email.routing.mx_none_detail', 'Mail falls back to the A record of the domain; add an MX record pointing at {host}.', { host: hostname || tr('panel.email.routing.this_server', 'this server') }) };
  const first = mx.records[0].exchange;
  if (mx.pointsHere === true) return { status: 'ok', label: tr('panel.email.routing.mx_points_here', 'Points here'), detail: first };
  if (mx.pointsHere === false) return { status: 'warning', label: tr('panel.email.routing.mx_points_elsewhere', 'Points elsewhere'), detail: mx.exchanges?.join(', ') || first };
  return { status: 'unknown', label: tr('panel.email.routing.mx_unresolved', 'Unresolved'), detail: first };
}

// The MX record to add at the DNS provider when mail is to arrive here but the public MX does not point here yet.
export const mxRecords = (row) => (row?.effective !== 'remote' && row?.mx?.pointsHere !== true ? [{ name: row.domain, type: 'MX', value: `10 ${row.hostname || 'this server'}` }] : []);

function RoutingRow({ row, hostname, onSaved }) {
  const { t } = useEmailT();
  const toast = useToast();
  const confirm = useConfirm();
  const [value, setValue] = useState(row.routing);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [pending, setPending] = useState(null);
  const mx = mxSummary(row.mx, hostname);
  const options = ROUTING_OPTIONS.map((o) => {
    const label = t(`panel.email.routing.option_${o.value}`, o.label);
    return o.value === 'remote' && !row.canRemote ? { ...o, label: `${label} — ${t('panel.email.routing.not_while_mailboxes', 'not while mailboxes exist')}`, disabled: true } : { ...o, label };
  });
  const save = async () => {
    if (value === row.routing) return;
    if (value === 'remote' && !(await confirm({ title: t('panel.email.routing.remote_title', 'Route mail for {domain} elsewhere?', { domain: row.domain }), message: t('panel.email.routing.remote_text', 'This server stops accepting mail for the domain and hands it to the public MX records. Forwarders, autoresponders and the default address of the domain stop working here.'), confirmLabel: t('panel.email.routing.route_remotely', 'Route remotely') }))) return;
    setBusy(true); setError(null);
    try {
      const { data } = await panelApi.put(`/email/domains/${row.domain}/routing`, { routing: value });
      setPending(data.applied === false ? data : null);
      if (data.applied === false) toast.warning(t('panel.email.routing.toast_pending', 'Routing saved; {reason}', { reason: data.reason || t('panel.email.routing.exim_not_yet', 'Exim does not read it yet') }));
      else toast.success(data.effective === 'remote' ? t('panel.email.routing.toast_remote', 'Mail for {domain} is now routed to the remote mail exchanger', { domain: row.domain }) : t('panel.email.routing.toast_local', 'Mail for {domain} is now routed to this server', { domain: row.domain }));
      onSaved?.();
    } catch (err) { setError(err); } finally { setBusy(false); }
  };
  const mailboxNote = row.mailboxes ? ` · ${row.mailboxes === 1 ? t('panel.email.routing.mailboxes_one', '1 mailbox') : t('panel.email.routing.mailboxes_many', '{count} mailboxes', { count: row.mailboxes })}` : ` · ${t('panel.email.routing.no_mailboxes', 'no mailboxes')}`;
  return (
    <>
      <tr>
        <td><strong>{row.domain}</strong><div className="muted" style={{ fontSize: 12.5 }}>{row.type}{mailboxNote}</div></td>
        <td>
          <Select value={value} onChange={setValue} options={options} aria-label={t('panel.email.routing.routing_for', 'Routing for {domain}', { domain: row.domain })} />
          <div className="muted" style={{ fontSize: 12.5, marginTop: 4 }}>{t(`panel.email.routing.help_${value}`, ROUTING_HELP[value])}</div>
        </td>
        <td><StatusPill status={row.effective === 'remote' ? 'muted' : 'ok'}>{row.effective === 'remote' ? t('panel.email.routing.remote', 'Remote') : t('panel.email.routing.local', 'Local')}</StatusPill></td>
        <td><StatusPill status={mx.status}>{mx.label}</StatusPill>{mx.detail && <div className="muted" style={{ fontSize: 12.5, marginTop: 4, wordBreak: 'break-all' }}>{mx.detail}</div>}</td>
        <td className="actions-col"><Button size="sm" variant="primary" loading={busy} disabled={value === row.routing} onClick={save}>{t('panel.email.common.save', 'Save')}</Button>{pending && <div style={{ marginTop: 4 }}><PendingPill result={pending} /></div>}</td>
      </tr>
      {(error || row.hints?.length > 0 || notDelegatedHere(row.delegation)) && (
        <tr>
          <td colSpan={5} style={{ paddingTop: 0 }}>
            <MutationError error={error} />
            {row.hints?.map((h) => <div key={h} className="banner banner-info"><Info size={18} /><div>{h}</div></div>)}
            <DelegationBanner domain={row.domain} delegation={row.delegation} records={mxRecords({ ...row, hostname })} title={t('panel.email.routing.delegation_title', 'MX records are not managed here')} />
          </td>
        </tr>
      )}
    </>
  );
}

export default function Routing({ fn }) {
  const { t } = useEmailT();
  const { data, meta, error, loading, refetch } = usePanelApi('/email/routing');
  const rows = data || [];
  return (
    <PanelPage fn={fn} actions={<Button size="sm" icon={RefreshCw} onClick={() => refetch()} loading={loading && Boolean(data)}>{t('panel.email.routing.recheck_mx', 'Re-check MX')}</Button>}>
      <Card padded={false} title={t('panel.email.routing.title', 'Where mail for your domains is delivered')} subtitle={t('panel.email.routing.subtitle', 'Each domain is delivered on this server unless you route it to a remote mail exchanger; the MX column shows what the public DNS says today.')}>
        {(error || (loading && !data)) && (
          <div className="card-body">
            <PanelRequestError error={error} fn={fn} onRetry={refetch} />
            {loading && !data && !error && <p className="muted">{t('panel.email.common.loading', 'Loading…')}</p>}
          </div>
        )}
        {data && rows.length === 0 && <EmptyState title={t('panel.email.common.no_domains_title', 'No domains on this account yet')} />}
        {rows.length > 0 && (
          <div className="table-wrap">
            <table>
              <thead><tr><th>{t('panel.email.common.domain', 'Domain')}</th><th style={{ width: 320 }}>{t('panel.email.routing.routing', 'Routing')}</th><th style={{ width: 110 }}>{t('panel.email.routing.effective', 'Effective')}</th><th style={{ width: 220 }}>{t('panel.email.routing.public_mx', 'Public MX')}</th><th className="actions-col" /></tr></thead>
              <tbody>{rows.map((row) => <RoutingRow key={`${row.domain}:${row.routing}`} row={row} hostname={meta?.hostname} onSaved={() => refetch()} />)}</tbody>
            </table>
          </div>
        )}
      </Card>
      <p className="muted">{t('panel.email.routing.footer', 'A domain set to remote keeps its DNS zone and web site here; only mail changes. MX records are edited in the')} <Link to="/panel/dns/zone-editor">{t('panel.email.common.zone_editor', 'zone editor')}</Link> {t('panel.email.routing.footer_end', 'when the DNS of the domain is hosted on this server.')}</p>
    </PanelPage>
  );
}
