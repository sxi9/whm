import { useState } from 'react';
import { RefreshCw, Plus, Ban } from 'lucide-react';
import { Card, KeyValue, EmptyState } from '../../../components/Common.jsx';
import { DataTable } from '../../../components/DataTable.jsx';
import { Field, TextInput, Button, FormActions } from '../../../components/Form.jsx';
import { useToast } from '../../../components/Toast.jsx';
import { useConfirm } from '../../../components/Modal.jsx';
import { useT } from '../../../i18n/useT.js';
import { fill, untranslated } from '../../../i18n/fill.js';
import { PanelPage, PanelCapabilityState, FeatureDisabledState } from '../../../panel/PanelPage.jsx';
import { usePanelApi, usePanelMe, panelApi } from '../../../panel/hooks/usePanel.js';
import { RequestError, isCapabilityError, isFeatureDisabled } from './parts/shared.jsx';

const V4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
const V6 = /^[0-9a-f:]{2,39}$/i;

// A quick client-side shape check; the server validates the address for real.
export function ipProblem(input, t = untranslated) {
  const s = String(input || '').trim();
  if (!s) return null;
  const [addr, bits, extra] = s.split('/');
  if (extra != null) return t('panel.security.ip_one_entry', 'Use one address or one range such as 203.0.113.0/24');
  const v4 = V4.test(addr);
  const v6 = !v4 && V6.test(addr) && addr.includes(':');
  if (!v4 && !v6) return t('panel.security.ip_invalid', 'Enter an IPv4 or IPv6 address, optionally with a /prefix');
  if (bits != null && (!/^\d{1,3}$/.test(bits) || Number(bits) > (v4 ? 32 : 128))) return fill(t('panel.security.ip_prefix_range', 'The prefix must be between 0 and {max}'), { max: v4 ? 32 : 128 });
  return null;
}

export function describeEntry(entry, t = untranslated) {
  const [addr, bits] = String(entry).split('/');
  const v4 = V4.test(addr);
  if (bits == null) return v4 ? t('panel.security.ip_one_v4', 'One IPv4 address') : t('panel.security.ip_one_v6', 'One IPv6 address');
  return fill(v4 ? t('panel.security.ip_range_v4', 'IPv4 range · /{bits}') : t('panel.security.ip_range_v6', 'IPv6 range · /{bits}'), { bits });
}

export default function IpBlocker({ fn }) {
  const toast = useToast();
  const confirm = useConfirm();
  const { t } = useT();
  const { me } = usePanelMe();
  const { data, error, loading, refetch } = usePanelApi('/security/ip-blocker');
  const [ip, setIp] = useState('');
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState(null);
  const [probe, setProbe] = useState(null);
  const capability = isCapabilityError(error);
  const noHome = error?.code === 'no_home';
  const problem = ipProblem(ip, t);
  const rows = (data?.denyIps || []).map((entry) => ({ entry }));

  if (isFeatureDisabled(error)) return <PanelPage fn={fn}><FeatureDisabledState fn={fn} /></PanelPage>;

  const add = async (e) => {
    e.preventDefault();
    if (problem) { setFormError({ message: t('panel.security.ip_check', 'Check the address'), fields: { ip: [problem] } }); return; }
    setBusy(true); setFormError(null);
    try {
      const { data: res } = await panelApi.post('/security/ip-blocker', { ip: ip.trim() });
      toast.success(fill(t('panel.security.ip_blocked', '{ip} is now blocked'), { ip: res.ip }));
      setProbe(res.probe);
      setIp('');
      refetch();
    } catch (err) { setFormError(err); } finally { setBusy(false); }
  };

  const remove = async (row) => {
    const ok = await confirm({ title: fill(t('panel.security.ip_unblock_title', 'Unblock {entry}?'), { entry: row.entry }), message: t('panel.security.ip_unblock_message', 'Visitors from this address can reach your sites again straight away.'), confirmLabel: t('panel.security.ip_unblock', 'Unblock'), danger: true });
    if (!ok) return;
    try { const { data: res } = await panelApi.delete(`/security/ip-blocker?${new URLSearchParams({ ip: row.entry })}`); setProbe(res?.probe ?? null); toast.success(fill(t('panel.security.ip_unblocked', '{entry} unblocked'), { entry: row.entry })); refetch(); } catch (err) { toast.error(err); }
  };

  const lastCheck = probe ? (probe.status ? fill(t('panel.security.ip_probe_status', 'The site answered {status} after the change'), { status: probe.status }) : `${t('panel.security.ip_probe_failed', 'The site could not be probed')}${probe.error ? ` (${probe.error})` : ''}`) : '—';

  return (
    <PanelPage fn={fn} actions={<Button icon={RefreshCw} onClick={() => refetch()}>{t('common.refresh', 'Refresh')}</Button>}>
      <div className="grid-2">
        <form onSubmit={add}>
          <Card title={t('panel.security.ip_block_title', 'Block an address')} subtitle={t('panel.security.ip_block_subtitle', 'Requests from a blocked address get a 403 on every site of this account.')}>
            <PanelCapabilityState error={isCapabilityError(formError) ? formError : null} />
            <RequestError error={formError} />
            <Field label={t('panel.security.ip_label', 'IP address or range')} required error={formError?.fields?.ip} help={ip && !problem ? describeEntry(ip.trim(), t) : t('panel.security.ip_help', 'An address such as 203.0.113.9, or a range in CIDR form such as 203.0.113.0/24 or 2001:db8::/32')} htmlFor="ip-entry">
              <TextInput id="ip-entry" value={ip} onChange={setIp} placeholder="203.0.113.0/24" spellCheck={false} disabled={capability || noHome} />
            </Field>
            <FormActions>
              <Button type="submit" variant="primary" icon={Ban} loading={busy} disabled={busy || !ip.trim() || Boolean(problem) || capability || noHome}>{t('panel.security.ip_block', 'Block')}</Button>
            </FormActions>
          </Card>
        </form>
        <Card title={t('panel.security.how_it_works', 'How it works')}>
          <KeyValue items={[
            [t('panel.security.ip_where', 'Where'), <code key="w">~/{data?.path || 'public_html'}/.htaccess</code>],
            [t('panel.security.ip_applies_to', 'Applies to'), fill(t('panel.security.ip_applies_to_value', '{domain} and every site served from inside that folder'), { domain: data?.domain || me?.account?.domain || t('panel.security.ip_main_domain', 'your main domain') })],
            [t('panel.security.ip_response', 'Response'), 'HTTP 403 Forbidden'],
            [t('panel.security.ip_your_address', 'Your address'), <code key="y">{me?.user?.lastIp || me?.user?.ip || t('panel.security.ip_shown_in_sessions', 'shown in Sessions')}</code>],
            [t('panel.security.ip_last_check', 'Last check'), lastCheck],
          ]} />
          <p className="muted small" style={{ marginTop: 10 }}>{t('panel.security.ip_markers_before', 'The panel keeps its rules between')} <code># BEGIN Keel</code> {t('panel.security.ip_markers_and', 'and')} <code># END Keel</code>{t('panel.security.ip_markers_after', '; anything else in the file stays as it is. Blocking your own address locks you out of the website, not out of this panel.')}</p>
        </Card>
      </div>

      <Card title={t('panel.security.ip_blocked_title', 'Blocked addresses')} subtitle={rows.length ? fill(t('panel.security.ip_entries', '{count} of {max} entries'), { count: rows.length, max: data?.max || 500 }) : undefined} padded={false}>
        {capability && <div className="card-body"><PanelCapabilityState error={error} onRetry={refetch} /></div>}
        {noHome && <div className="card-body"><EmptyState icon={Ban} title={t('panel.security.no_home_title', 'No home directory yet')}><p>{error.message}</p></EmptyState></div>}
        {!capability && !noHome && <div className="card-body" style={{ paddingBottom: 0 }}><RequestError error={error} onRetry={refetch} /></div>}
        <DataTable
          columns={[
            { key: 'entry', label: t('panel.security.ip_col_entry', 'Address or range'), render: (r) => <code>{r.entry}</code> },
            { key: 'kind', label: t('panel.security.ip_col_kind', 'Kind'), render: (r) => describeEntry(r.entry, t) },
          ]}
          rows={rows} loading={loading} error={null} rowKey={(r) => r.entry} dense
          rowActions={(r) => [{ label: t('panel.security.ip_unblock', 'Unblock'), danger: true, primary: true, onClick: () => remove(r) }]}
          emptyText={capability ? t('panel.security.ip_empty_capability', 'Blocked addresses appear here once the file manager is available on this server.') : t('panel.security.ip_empty', 'Nothing is blocked. Add an address or a range above; it takes effect on the next request.')}
        />
      </Card>
      <p className="muted small"><Plus size={12} /> {t('panel.security.ip_cidr_note', 'Ranges use CIDR notation: /24 covers 256 IPv4 addresses, /64 one typical IPv6 subnet.')}</p>
    </PanelPage>
  );
}
