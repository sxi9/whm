import { useState } from 'react';
import { RefreshCw, Plus, Globe } from 'lucide-react';
import { Card, StatusPill, KeyValue, EmptyState, formatDate } from '../../../components/Common.jsx';
import { DataTable } from '../../../components/DataTable.jsx';
import { Field, TextInput, Button, FormActions } from '../../../components/Form.jsx';
import { useToast } from '../../../components/Toast.jsx';
import { useConfirm } from '../../../components/Modal.jsx';
import { useT } from '../../../i18n/useT.js';
import { fill, plural, untranslated } from '../../../i18n/fill.js';
import { PanelPage, PanelCapabilityState, FeatureDisabledState, PendingPill } from '../../../panel/PanelPage.jsx';
import { usePanelApi, usePanelMe, panelApi } from '../../../panel/hooks/usePanel.js';
import { RequestError, InfoNote, isCapabilityError, isFeatureDisabled } from './parts/shared.jsx';

// The CIDR suffix is for PostgreSQL (a pg_hba.conf network, contract §67).
const HOST_RE = /^[A-Za-z0-9.%:_-]{1,255}(\/\d{1,3})?$/;

export function describeHost(host, t = untranslated) {
  if (host === '%') return t('panel.databases.host_any', 'any host');
  if (host.includes('/')) return t('panel.databases.host_network', 'network');
  if (host.includes('%') || host.includes('_')) return t('panel.databases.host_pattern', 'pattern');
  if (/^[0-9.]+$/.test(host) || host.includes(':')) return t('panel.databases.host_ip', 'IP address');
  return t('panel.databases.host_name', 'host name');
}

export default function RemoteHosts({ fn }) {
  const toast = useToast();
  const confirm = useConfirm();
  const { t } = useT();
  const { me } = usePanelMe();
  const { data, meta, loading, error, refetch } = usePanelApi('/databases/access-hosts');
  const [host, setHost] = useState('');
  const [formError, setFormError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [lastResult, setLastResult] = useState(null);
  const capability = isCapabilityError(error);
  const unsupported = meta && meta.supported === false;
  const isPg = meta?.engine === 'postgres';

  if (isFeatureDisabled(error)) return <PanelPage fn={fn}><FeatureDisabledState fn={fn} /></PanelPage>;

  const add = async (e) => {
    e.preventDefault();
    const value = host.trim();
    if (!HOST_RE.test(value)) { setFormError({ message: t('panel.databases.host_invalid', 'Enter a host name, an IP address or a pattern with %'), fields: { host: [isPg ? t('panel.databases.host_invalid_chars_pg', 'An IP address, a network such as 203.0.113.0/24, a host name or a pattern such as 203.0.113.%') : t('panel.databases.host_invalid_chars', 'Letters, digits, dots, colons, "_", "-" and "%" only')] } }); return; }
    setBusy(true); setFormError(null);
    try {
      const { data: res } = await panelApi.post('/databases/access-hosts', { host: value });
      setLastResult(res);
      if (res.applied === false) toast.warning(fill(t('panel.databases.host_saved_pending', '{host} saved; it takes effect once the database server is available'), { host: res.host }));
      else if (res.failed?.length) toast.warning(fill(t('panel.databases.host_added_partial', '{host} added; {failed}'), { host: res.host, failed: plural(t, 'panel.databases.host_users_failed', res.failed.length, '{count} user could not be updated', '{count} users could not be updated') }));
      else toast.success(fill(t('panel.databases.host_added', '{host} can now connect'), { host: res.host }));
      setHost('');
      refetch();
    } catch (err) { setFormError(err); } finally { setBusy(false); }
  };

  const remove = async (row) => {
    const ok = await confirm({ title: fill(t('panel.databases.host_remove_title', 'Remove {host}?'), { host: row.host }), message: t('panel.databases.host_remove_message', 'Connections from this address are refused as soon as the change is applied. Connections from this server (localhost) keep working.'), confirmLabel: t('panel.databases.host_remove_confirm', 'Remove host'), danger: true });
    if (!ok) return;
    try { await panelApi.delete(`/databases/access-hosts/${row.id}`); toast.success(fill(t('panel.databases.host_removed', '{host} removed'), { host: row.host })); refetch(); } catch (err) { toast.error(err); }
  };

  return (
    <PanelPage fn={fn} actions={<Button icon={RefreshCw} onClick={() => refetch()}>{t('common.refresh', 'Refresh')}</Button>}>
      <div className="grid-2">
        <form onSubmit={add}>
          <Card title={t('panel.databases.host_allow_title', 'Allow a remote host')} subtitle={t('panel.databases.host_allow_subtitle', 'Lets a computer outside this server open your databases with your database users.')}>
            <PanelCapabilityState error={isCapabilityError(formError) ? formError : null} />
            <RequestError error={formError} />
            {unsupported ? (
              <EmptyState icon={Globe} title={t('panel.databases.host_pg_title', 'Not available for this PostgreSQL server')}><p>{t('panel.databases.host_pg_text', 'Remote access rules are written on the database server itself, and your PostgreSQL server runs on another machine. Ask your hosting provider if you need external access to a PostgreSQL database.')}</p></EmptyState>
            ) : (
              <>
                <Field label={t('panel.databases.host_label', 'Host name or IP address')} required error={formError?.fields?.host} help={isPg ? <>{t('panel.databases.host_help_pg_before', 'An IP address, a network such as')} <code>203.0.113.0/24</code> {t('panel.databases.host_help_pg_or', 'or')} <code>203.0.113.%</code>{t('panel.databases.host_help_pg_after', ', or a host name. The rule names your databases and users on the server (pg_hba.conf) and is updated when you add or remove them.')} <code>%</code> {t('panel.databases.host_help_alone', 'alone allows every host and is not recommended.')}</> : <>{t('panel.databases.host_help_use', 'Use')} <code>%</code> {t('panel.databases.host_help_wildcard', 'as a wildcard, for example')} <code>203.0.113.%</code> {t('panel.databases.host_help_network', 'for a whole network.')} <code>%</code> {t('panel.databases.host_help_alone', 'alone allows every host and is not recommended.')}</>} htmlFor="rh-host">
                  <TextInput id="rh-host" value={host} onChange={setHost} placeholder={isPg ? '203.0.113.5, 203.0.113.0/24 or office.example.com' : '203.0.113.5 or office.example.com'} autoCapitalize="none" spellCheck={false} />
                </Field>
                <FormActions>
                  <Button type="submit" variant="primary" icon={Plus} loading={busy} disabled={!host.trim()}>{t('panel.databases.host_allow_button', 'Allow host')}</Button>
                  {lastResult && <span className="muted small">{lastResult.host} <PendingPill result={lastResult} /></span>}
                </FormActions>
              </>
            )}
          </Card>
        </form>
        <Card title={t('panel.databases.connect_title', 'Connecting from outside')} subtitle={t('panel.databases.connect_subtitle', 'What to enter in a database client or an application running elsewhere.')}>
          <KeyValue items={[
            [t('panel.databases.connect_server', 'Server'), <code key="h">{me?.hostname || me?.account?.domain || '—'}</code>],
            [t('panel.databases.connect_port', 'Port'), <code key="p">{isPg ? 5432 : 3306}</code>],
            [t('panel.databases.connect_user', 'User'), t('panel.databases.connect_user_value', 'A database user of this account')],
            [t('panel.databases.connect_password', 'Password'), t('panel.databases.connect_password_value', 'That user\'s password')],
            [t('panel.databases.connect_database', 'Database'), <code key="d">{`${me?.account?.username || 'account'}_…`}</code>],
          ]} />
          <p className="muted small" style={{ marginTop: 10 }}>{t('panel.databases.connect_note_before', 'The client\'s public address must be listed here, and the server firewall must accept the database port. Your sites on this server connect through')} <code>localhost</code> {t('panel.databases.connect_note_after', 'without any rule.')}</p>
        </Card>
      </div>

      <Card title={t('panel.databases.hosts_title', 'Allowed hosts')} subtitle={data?.length ? fill(t('panel.databases.hosts_count', '{count} allowed'), { count: data.length }) : undefined} padded={false}>
        {capability && <div className="card-body"><PanelCapabilityState error={error} onRetry={refetch} /></div>}
        <DataTable
          columns={[
            { key: 'host', label: t('panel.databases.col_host', 'Host'), render: (r) => <code>{r.host}</code> },
            { key: 'kind', label: t('panel.databases.col_matches', 'Matches'), render: (r) => describeHost(r.host, t) },
            { key: 'scope', label: t('panel.databases.col_set_by', 'Set by'), render: (r) => (r.scope === 'global' ? <StatusPill status="info">{t('panel.databases.scope_global', 'server-wide')}</StatusPill> : <StatusPill status="ok">{t('panel.databases.scope_you', 'you')}</StatusPill>) },
            { key: 'created_at', label: t('panel.databases.col_added', 'Added'), render: (r) => (r.created_at ? formatDate(r.created_at) : <span className="muted">—</span>) },
          ]}
          rows={data || []} loading={loading} error={capability ? null : error} rowKey={(r) => r.id}
          rowActions={(r) => [r.editable ? { label: t('panel.databases.remove', 'Remove'), primary: true, danger: true, onClick: () => remove(r) } : null]}
          emptyText={capability ? t('panel.databases.hosts_empty_capability', 'Allowed hosts appear here once the database server is available.') : unsupported ? t('panel.databases.hosts_empty_pg', 'Remote hosts cannot be managed for a PostgreSQL server on another machine.') : t('panel.databases.hosts_empty', 'No remote host is allowed yet. Only this server can reach your databases; add an address above to connect from elsewhere.')}
        />
        {data?.some((r) => r.scope === 'global') && <div className="card-body"><InfoNote>{t('panel.databases.hosts_global_note', 'Server-wide hosts were allowed by your hosting provider for every account and cannot be removed here.')}</InfoNote></div>}
      </Card>
    </PanelPage>
  );
}
