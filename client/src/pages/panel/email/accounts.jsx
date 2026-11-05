import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Plus, Mail } from 'lucide-react';
import { queryString } from '../../../api/client.js';
import { Card, KeyValue, StatusPill, formatBytes, formatDate } from '../../../components/Common.jsx';
import { DataTable, useTableState } from '../../../components/DataTable.jsx';
import { Field, NumberInput, PasswordInput, Toggle, Button, FormActions } from '../../../components/Form.jsx';
import { Modal, useConfirm } from '../../../components/Modal.jsx';
import { useToast } from '../../../components/Toast.jsx';
import { PanelPage, PendingPill } from '../../../panel/PanelPage.jsx';
import { usePanelApi, panelApi, percentOf, meterTone } from '../../../panel/hooks/usePanel.js';
import { PanelRequestError, MutationError, AddressInput, useAccountDomains, fieldError, quotaText, useEmailT, tr } from './parts/Shared.jsx';
import { WebmailOpenButton } from './webmail.jsx';

export function usageOf(row) {
  const u = row.usage;
  const limitBytes = u?.limitBytes ?? (row.quotaMb ? row.quotaMb * 1024 * 1024 : null);
  const bytes = u?.bytes ?? null;
  const percent = percentOf(bytes, limitBytes);
  const text = bytes == null
    ? (limitBytes ? tr('panel.email.accounts.usage_up_to', 'Up to {limit}', { limit: formatBytes(limitBytes) }) : tr('panel.email.common.unlimited', 'Unlimited'))
    : limitBytes ? tr('panel.email.accounts.usage_of', '{used} of {limit}', { used: formatBytes(bytes), limit: formatBytes(limitBytes) }) : tr('panel.email.accounts.usage_unlimited', '{used} · unlimited', { used: formatBytes(bytes) });
  return { bytes, limitBytes, percent, text, messages: u?.messages ?? null };
}

export function QuotaMeter({ row }) {
  const { t } = useEmailT();
  const u = usageOf(row);
  return (
    <div style={{ minWidth: 160 }}>
      <div style={{ fontSize: 13 }}>{u.text}{u.messages != null && <span className="muted"> · {t('panel.email.accounts.messages_count', '{count} messages', { count: u.messages })}</span>}</div>
      <div className={`meter ${meterTone(u.percent)}`} aria-hidden={u.percent == null} style={{ marginTop: 5 }}><span style={{ width: `${u.percent ?? 0}%` }} /></div>
    </div>
  );
}

function QuotaFields({ quotaMb, onChange, defaultQuotaMb, error }) {
  const { t } = useEmailT();
  const unlimited = quotaMb == null;
  return (
    <>
      <Field label={t('panel.email.accounts.storage_quota', 'Storage quota')} error={error} help={unlimited ? t('panel.email.accounts.quota_help_unlimited', 'The mailbox can grow until the account runs out of disk space.') : t('panel.email.accounts.quota_help', '{quota} of storage for this mailbox.', { quota: quotaText(quotaMb) })}>
        <div className="input-group">
          <NumberInput value={quotaMb} onChange={(v) => onChange(v == null ? null : Math.max(0, Math.floor(v)))} min={1} step={1} disabled={unlimited} aria-label={t('panel.email.accounts.quota_mb', 'Quota in megabytes')} placeholder={String(defaultQuotaMb || 1024)} />
          <span className="muted" style={{ alignSelf: 'center' }}>MB</span>
        </div>
      </Field>
      <Toggle checked={unlimited} onChange={(on) => onChange(on ? null : (defaultQuotaMb || 1024))} label={t('panel.email.common.unlimited', 'Unlimited')} description={t('panel.email.accounts.unlimited_help', 'No limit on this mailbox.')} />
    </>
  );
}

// The server's rule for mailbox passwords (meta.passwordPolicy): the length
// floor plus the Security Center minimum for the `email` context.
export function passwordHelp(policy) {
  const minLength = policy?.minLength || 8;
  const strength = Number(policy?.minStrength) || 0;
  if (strength <= 0) return tr('panel.email.accounts.password_help', 'At least {min} characters; use the generator for a strong one.', { min: minLength });
  return tr('panel.email.accounts.password_help_strength', 'At least {min} characters and a strength of {strength} out of 100 (length, upper and lower case, digits and symbols all count); use the generator for a strong one.', { min: minLength, strength });
}

export function CreateMailboxForm({ domains, defaultQuotaMb, onSubmit, onCancel, busy, error, passwordPolicy = null }) {
  const { t } = useEmailT();
  const [localPart, setLocalPart] = useState('');
  const [domain, setDomain] = useState(domains[0] || '');
  const [password, setPassword] = useState('');
  const [quotaMb, setQuotaMb] = useState(defaultQuotaMb || 1024);
  const submit = (e) => { e.preventDefault(); onSubmit({ localPart: localPart.trim(), domain, password, quotaMb }); };
  return (
    <form onSubmit={submit}>
      <MutationError error={error} />
      <AddressInput localPart={localPart} domain={domain} domains={domains} onLocalPart={setLocalPart} onDomain={setDomain} error={fieldError(error, 'localPart') || fieldError(error, 'domain')} help={t('panel.email.accounts.address_help', 'Lowercase letters, digits, dots, underscores and hyphens.')} autoFocus />
      <Field label={t('panel.email.accounts.password', 'Password')} required error={fieldError(error, 'password')} help={passwordHelp(passwordPolicy)}>
        <PasswordInput value={password} onChange={setPassword} />
      </Field>
      <QuotaFields quotaMb={quotaMb} onChange={setQuotaMb} defaultQuotaMb={defaultQuotaMb} error={fieldError(error, 'quotaMb')} />
      <FormActions align="right">
        <Button onClick={onCancel}>{t('panel.email.common.cancel', 'Cancel')}</Button>
        <Button type="submit" variant="primary" loading={busy} disabled={!localPart.trim() || !domain || !password}>{t('panel.email.accounts.create', 'Create mailbox')}</Button>
      </FormActions>
    </form>
  );
}

export function PasswordForm({ address, onSubmit, onCancel, busy, error, passwordPolicy = null }) {
  const { t } = useEmailT();
  const [password, setPassword] = useState('');
  return (
    <form onSubmit={(e) => { e.preventDefault(); onSubmit({ password }); }}>
      <MutationError error={error} />
      <p>{t('panel.email.accounts.password_for', 'New password for')} <strong>{address}</strong>. {t('panel.email.accounts.password_note', 'Mail apps signed in with the old password stop syncing until they are updated.')}</p>
      <Field label={t('panel.email.accounts.new_password', 'New password')} required error={fieldError(error, 'password')} help={passwordHelp(passwordPolicy)}>
        <PasswordInput value={password} onChange={setPassword} />
      </Field>
      <FormActions align="right"><Button onClick={onCancel}>{t('panel.email.common.cancel', 'Cancel')}</Button><Button type="submit" variant="primary" loading={busy} disabled={!password}>{t('panel.email.accounts.change_password', 'Change password')}</Button></FormActions>
    </form>
  );
}

export function QuotaForm({ row, defaultQuotaMb, onSubmit, onCancel, busy, error }) {
  const { t } = useEmailT();
  const [quotaMb, setQuotaMb] = useState(row.quotaMb ?? null);
  const u = usageOf(row);
  return (
    <form onSubmit={(e) => { e.preventDefault(); onSubmit({ quotaMb }); }}>
      <MutationError error={error} />
      <p>{t('panel.email.accounts.storage_for', 'Storage for')} <strong>{row.address}</strong>{u.bytes != null && <> — {t('panel.email.accounts.currently_in_use', 'currently {used} in use', { used: formatBytes(u.bytes) })}</>}.</p>
      <QuotaFields quotaMb={quotaMb} onChange={setQuotaMb} defaultQuotaMb={defaultQuotaMb} error={fieldError(error, 'quotaMb')} />
      {quotaMb != null && u.bytes != null && quotaMb * 1024 * 1024 < u.bytes && <p className="field-message">{t('panel.email.accounts.quota_below_usage', 'The new quota is below what the mailbox already holds; new mail bounces until space is freed.')}</p>}
      <FormActions align="right"><Button onClick={onCancel}>{t('panel.email.common.cancel', 'Cancel')}</Button><Button type="submit" variant="primary" loading={busy}>{t('panel.email.accounts.save_quota', 'Save quota')}</Button></FormActions>
    </form>
  );
}

export function DeleteForm({ row, onSubmit, onCancel, busy, error }) {
  const { t } = useEmailT();
  const [removeMail, setRemoveMail] = useState(false);
  return (
    <form onSubmit={(e) => { e.preventDefault(); onSubmit({ removeMail }); }}>
      <MutationError error={error} />
      <p>{t('panel.email.accounts.delete_intro', 'The mailbox')} <strong>{row.address}</strong> {t('panel.email.accounts.delete_effect', 'stops receiving mail and its login no longer works.')}</p>
      <Toggle checked={removeMail} onChange={setRemoveMail} label={t('panel.email.accounts.delete_messages', 'Also delete the stored messages')} description={t('panel.email.accounts.delete_messages_help', 'Removes the mailbox folder from your account. Leave this off to keep the messages on disk.')} />
      <FormActions align="right"><Button onClick={onCancel}>{t('panel.email.common.cancel', 'Cancel')}</Button><Button type="submit" variant="danger" loading={busy}>{t('panel.email.accounts.delete', 'Delete mailbox')}</Button></FormActions>
    </form>
  );
}

function serverRow(t, label, srv) {
  if (!srv) return null;
  const security = srv.ssl ? 'SSL/TLS' : srv.starttls ? 'STARTTLS' : t('panel.email.accounts.plain', 'plain');
  return [label, (
    <span key={label}>
      <code>{srv.host}</code> {t('panel.email.accounts.port', 'port')} <strong>{srv.port}</strong> ({security})
      {srv.alternative && <span className="muted"> · {t('panel.email.accounts.or_port', 'or port {port}', { port: srv.alternative.port })}{srv.alternative.starttls ? ` ${t('panel.email.accounts.with_starttls', 'with STARTTLS')}` : ''}</span>}
    </span>
  )];
}

// The certificate a mail app is shown when it connects (the hostname's service
// certificate), so a name mismatch is explained before the app warns about it.
function certificateText(t, cert, hostname) {
  if (!cert) return t('panel.email.accounts.cert_unreadable', 'The server certificate could not be read; your mail app shows it when you connect.');
  const name = cert.name || cert.sans?.[0] || hostname;
  const bits = [cert.issuer ? t('panel.email.accounts.cert_issued_by', 'issued by {issuer}', { issuer: cert.issuer }) : null, cert.selfSigned ? t('panel.email.accounts.cert_self_signed', 'self-signed') : null].filter(Boolean);
  const mismatch = cert.matchesHostname === false ? ` ${t('panel.email.accounts.cert_mismatch', 'It does not name {hostname}, so mail apps warn about it; ask your provider.', { hostname })}` : '';
  return `${name}${bits.length ? ` (${bits.join(', ')})` : ''}.${mismatch}`;
}

// The SMTP listeners exactly as the server reports them (smtp.ports from the
// API: 587 with STARTTLS and 465 with TLS exist only once the operator enabled
// the submission ports; 25 is what is left otherwise).
export function smtpPortsText(smtp) {
  if (!smtp) return [];
  const ports = smtp.ports || { enabled: Boolean(smtp.submissionPorts), port587: Boolean(smtp.submissionPorts), port465: Boolean(smtp.submissionPorts) && smtp.port === 465 };
  const out = [];
  if (ports.port587) out.push(`587 ${tr('panel.email.accounts.with_starttls', 'with STARTTLS')}`);
  if (ports.port465) out.push(`465 ${tr('panel.email.accounts.with_tls', 'with TLS')}`);
  if (!out.length) out.push(`25 ${tr('panel.email.accounts.with_starttls', 'with STARTTLS')}`);
  return out;
}

export function ClientSettings({ settings }) {
  const { t } = useEmailT();
  if (!settings) return null;
  const smtp = settings.smtp;
  const sendingOff = !smtp || smtp.auth == null;
  const submissionOff = Boolean(smtp) && smtp.submissionPorts === false;
  const ports = smtpPortsText(smtp);
  return (
    <>
      {sendingOff && (
        <div className="banner banner-warning" role="status">
          <Mail size={18} />
          <div><strong>{t('panel.email.accounts.sending_off_title', 'Sending is not enabled yet — ask your provider')}</strong><p>{t('panel.email.accounts.sending_off_text', "The mail server does not accept this mailbox's password for sending yet. Receiving and reading mail work once the mailbox is served.")}</p></div>
        </div>
      )}
      <KeyValue items={[
        [t('panel.email.accounts.username', 'Username'), <code key="u">{settings.username}</code>],
        [t('panel.email.accounts.password', 'Password'), t('panel.email.accounts.the_mailbox_password', 'The mailbox password')],
        [t('panel.email.common.mail_server', 'Mail server'), <code key="h">{settings.hostname}</code>],
        [t('panel.email.accounts.certificate', 'Certificate'), certificateText(t, settings.certificate?.dovecot || settings.certificate?.exim || null, settings.hostname)],
      ]} />
      <h3 style={{ marginTop: 16 }}>{t('panel.email.accounts.incoming', 'Incoming mail')}</h3>
      <KeyValue items={[
        serverRow(t, t('panel.email.accounts.imap', 'IMAP (keeps mail on the server)'), settings.imap),
        serverRow(t, t('panel.email.accounts.pop3', 'POP3 (downloads mail)'), settings.pop3),
        !settings.imap && !settings.pop3 && [t('panel.email.accounts.incoming_short', 'Incoming'), t('panel.email.accounts.no_incoming', 'Neither IMAP nor POP3 is enabled on this server.')],
      ]} />
      <h3 style={{ marginTop: 16 }}>{t('panel.email.accounts.outgoing', 'Outgoing mail')}</h3>
      <KeyValue items={[
        serverRow(t, 'SMTP', smtp),
        [t('panel.email.accounts.ports', 'Ports'), ports.join(` ${t('panel.email.common.or', 'or')} `)],
        [t('panel.email.accounts.authentication', 'Authentication'), sendingOff ? t('panel.email.accounts.auth_off', 'Not enabled yet — mail apps cannot send through this server until your provider enables it') : t('panel.email.accounts.auth_required', 'Required — same username and password')],
      ]} />
      {submissionOff && (
        <div className="banner banner-warning" style={{ marginTop: 12 }} role="status">
          <Mail size={18} />
          <div><strong>{t('panel.email.accounts.port25_title', 'Only port 25 is open for sending')}</strong><p>{t('panel.email.accounts.port25_text', 'Most ISPs and mobile networks block port 25, so mail apps on those networks cannot send. Ask your provider to enable the submission ports 587 and 465.')}</p></div>
        </div>
      )}
      {settings.webmail && <p style={{ marginTop: 12 }}><WebmailOpenButton info={{ url: settings.webmail, flavor: settings.webmailSso ? 'roundcube' : null, sso: Boolean(settings.webmailSso) }} address={settings.username} label={t('panel.email.webmail.open', 'Open webmail')} /></p>}
    </>
  );
}

function ClientSettingsSheet({ row, onClose }) {
  const { t } = useEmailT();
  const { data, error, loading, refetch } = usePanelApi(row ? `/email/accounts/${row.id}/client-settings` : null);
  return (
    <Modal open={Boolean(row)} title={row ? t('panel.email.accounts.connect_title', 'Connect {address}', { address: row.address }) : ''} onClose={onClose} footer={<Button onClick={onClose}>{t('panel.email.common.close', 'Close')}</Button>}>
      <PanelRequestError error={error} onRetry={refetch} />
      {loading && !data && <p className="muted">{t('panel.email.common.loading', 'Loading…')}</p>}
      <ClientSettings settings={data} />
    </Modal>
  );
}

export default function EmailAccounts({ fn }) {
  const { t } = useEmailT();
  const toast = useToast();
  const confirm = useConfirm();
  const table = useTableState({ pageSize: 25 });
  const [domainFilter, setDomainFilter] = useState('');
  const query = queryString({ page: table.state.page, pageSize: table.state.pageSize, q: table.state.q, sort: table.state.sort, dir: table.state.sort ? table.state.dir : undefined, domain: domainFilter });
  const { data, meta, error, loading, refetch } = usePanelApi(`/email/accounts${query}`);
  const domains = useAccountDomains(meta?.domains);
  const [dialog, setDialog] = useState(null);
  const [busy, setBusy] = useState(false);
  const [mutationError, setMutationError] = useState(null);
  const [pending, setPending] = useState({});

  const used = meta?.used ?? (data?.length || 0);
  const limit = meta?.limits?.max_email;
  // Server convention (assertLimit): null is unlimited, 0 means the plan has no mailboxes.
  const notIncluded = limit === 0;
  const atLimit = limit != null && used >= limit;
  const defaultQuotaMb = meta?.defaultQuotaMb ?? 1024;
  const passwordPolicy = meta?.passwordPolicy ?? null;
  // The wiring state comes with every list, rows or not, so the empty state
  // says what a new mailbox will do.
  const wiringWarning = (meta?.warnings || []).find((w) => w.code === 'virtual_mail_not_live' || w.code === 'virtual_mail_disabled') || null;

  const open = (kind, row = null) => { setMutationError(null); setDialog({ kind, row }); };
  const close = () => { setDialog(null); setMutationError(null); };

  const run = async (fnc, success) => {
    setBusy(true); setMutationError(null);
    try {
      const res = await fnc();
      if (success) toast.success(success);
      const warnings = res?.meta?.warnings || [];
      for (const w of warnings) toast.warning(w.message);
      close();
      refetch();
      return res;
    } catch (err) {
      setMutationError(err);
      return null;
    } finally { setBusy(false); }
  };

  const create = (body) => run(() => panelApi.post('/email/accounts', body), t('panel.email.accounts.toast_created', 'Mailbox {address} created', { address: `${body.localPart}@${body.domain}` }));
  const setPassword = (row, body) => run(() => panelApi.put(`/email/accounts/${row.id}/password`, body), t('panel.email.accounts.toast_password', 'Password changed for {address}', { address: row.address }));
  const setQuota = (row, body) => run(() => panelApi.put(`/email/accounts/${row.id}/quota`, body), t('panel.email.accounts.toast_quota', 'Quota saved for {address}', { address: row.address }));
  const remove = (row, { removeMail }) => run(() => panelApi.delete(`/email/accounts/${row.id}${queryString({ removeMail: removeMail ? 1 : undefined })}`), t('panel.email.accounts.toast_deleted', 'Mailbox {address} deleted', { address: row.address }));

  const toggleSuspend = async (row) => {
    const suspend = !row.suspended;
    if (suspend && !(await confirm({ title: t('panel.email.accounts.suspend_title', 'Suspend {address}?', { address: row.address }), message: t('panel.email.accounts.suspend_text', 'The mailbox keeps its messages but cannot sign in or receive mail until it is unsuspended.'), confirmLabel: t('panel.email.accounts.suspend', 'Suspend'), danger: true }))) return;
    setBusy(true);
    try {
      const res = await panelApi.patch(`/email/accounts/${row.id}`, { suspended: suspend });
      if (res?.data?.applied === false) setPending((p) => ({ ...p, [row.id]: res.data }));
      toast.success(suspend ? t('panel.email.accounts.toast_suspended', '{address} suspended', { address: row.address }) : t('panel.email.accounts.toast_unsuspended', '{address} unsuspended', { address: row.address }));
      refetch();
    } catch (err) { toast.error(err); } finally { setBusy(false); }
  };

  const columns = useMemo(() => [
    { key: 'address', label: t('panel.email.common.address', 'Address'), sortable: true, render: (r) => <><code>{r.address}</code>{pending[r.id] && <> <PendingPill result={pending[r.id]} /></>}</> },
    { key: 'usage', label: t('panel.email.accounts.storage', 'Storage'), render: (r) => <QuotaMeter row={r} /> },
    { key: 'quota_mb', label: t('panel.email.accounts.quota', 'Quota'), sortable: true, align: 'right', render: (r) => quotaText(r.quotaMb) },
    { key: 'status', label: t('panel.email.common.status', 'Status'), render: (r) => <StatusPill status={r.suspended ? 'suspended' : 'active'} /> },
    { key: 'created_at', label: t('panel.email.common.created', 'Created'), sortable: true, render: (r) => <span className="muted">{formatDate(r.createdAt)}</span> },
  ], [pending, t]);

  const featureOff = error && error.status === 403 && error.code === 'feature_disabled';

  return (
    <PanelPage fn={fn} actions={!featureOff && <Button variant="primary" icon={Plus} onClick={() => open('create')} disabled={atLimit || !domains.length} title={notIncluded ? t('panel.email.accounts.not_included_title', 'Mailboxes are not included in your plan') : atLimit ? t('panel.email.accounts.limit_reached_hint', 'Your plan limit for mailboxes is reached') : undefined}>{t('panel.email.accounts.create', 'Create mailbox')}</Button>}>
      {featureOff ? <PanelRequestError error={error} fn={fn} /> : (
        <>
          <div className="stat-grid" style={{ marginBottom: 18 }}>
            <div className="stat">
              <div className="label">{t('panel.email.common.mailboxes', 'Mailboxes')}</div>
              <div className="value">{notIncluded ? t('panel.email.accounts.not_included', 'Not included in your plan') : limit != null ? t('panel.email.common.n_of_m', '{n} of {m}', { n: used, m: limit }) : `${used}`}</div>
              <div className={`meter ${meterTone(percentOf(used, limit))}`} aria-hidden={limit == null || notIncluded}><span style={{ width: `${percentOf(used, limit) ?? 0}%` }} /></div>
            </div>
            <div className="stat"><div className="label">{t('panel.email.accounts.domains_with_mail', 'Domains with mail')}</div><div className="value">{domains.length}</div></div>
            <div className="stat"><div className="label">{t('panel.email.accounts.default_quota', 'Default quota')}</div><div className="value">{quotaText(defaultQuotaMb)}</div></div>
          </div>
          {atLimit && (notIncluded
            ? <div className="banner banner-warning"><Mail size={18} /><div><strong>{t('panel.email.accounts.not_included_title', 'Mailboxes are not included in your plan')}</strong><p>{t('panel.email.accounts.not_included_text', 'Ask your hosting provider about a plan that includes them.')}</p></div></div>
            : <div className="banner banner-warning"><Mail size={18} /><div><strong>{t('panel.email.common.plan_limit_reached', 'Plan limit reached')}</strong><p>{limit === 1 ? t('panel.email.accounts.limit_text_one', 'Your plan allows 1 mailbox. Delete one you no longer need, or ask your hosting provider about a larger plan.') : t('panel.email.accounts.limit_text', 'Your plan allows {limit} mailboxes. Delete one you no longer need, or ask your hosting provider about a larger plan.', { limit })}</p></div></div>)}
          {wiringWarning && (
            <div className="banner banner-warning" role="status">
              <Mail size={18} />
              <div><strong>{wiringWarning.code === 'virtual_mail_disabled' ? t('panel.email.accounts.wiring_disabled', 'Mailboxes are switched off on this server') : t('panel.email.accounts.wiring_not_live', 'Mailboxes are not served yet')}</strong><p>{used ? t('panel.email.accounts.wiring_text_existing', 'Your mailboxes are saved, but mail is not delivered to them and mail apps cannot sign in until your hosting provider finishes the mail server setup.') : t('panel.email.accounts.wiring_text_new', 'A mailbox you create is saved, but mail is not delivered to it and mail apps cannot sign in until your hosting provider finishes the mail server setup.')}</p></div>
            </div>
          )}
          <Card padded={false}>
            <PanelRequestError error={error} fn={fn} onRetry={refetch} />
            {!error && (
              <DataTable
                columns={columns} rows={data || []} loading={loading}
                total={meta?.total ?? null} page={table.state.page} pageSize={table.state.pageSize} onPageChange={table.setPage}
                sort={table.state.sort} dir={table.state.dir} onSortChange={table.setSort}
                searchable q={table.state.q} onSearch={table.setSearch} searchPlaceholder={t('panel.email.common.search_addresses', 'Search addresses')}
                toolbar={domains.length > 1 && <select className="input select" value={domainFilter} onChange={(e) => { setDomainFilter(e.target.value); table.setPage(1); }} aria-label={t('panel.email.common.filter_by_domain', 'Filter by domain')}><option value="">{t('panel.email.common.all_domains', 'All domains')}</option>{domains.map((d) => <option key={d} value={d}>{d}</option>)}</select>}
                emptyText={table.state.q || domainFilter ? t('panel.email.accounts.empty_filtered', 'No mailboxes match this filter.') : t('panel.email.accounts.empty', 'No mailboxes yet. Create one to receive mail at your domain; it appears here with its storage and status.')}
                rowActions={(r) => [
                  { label: t('panel.email.accounts.connect', 'Connect'), primary: true, onClick: () => open('settings', r) },
                  { label: t('panel.email.accounts.change_password', 'Change password'), onClick: () => open('password', r) },
                  { label: t('panel.email.accounts.change_quota', 'Change quota'), onClick: () => open('quota', r) },
                  { label: r.suspended ? t('panel.email.accounts.unsuspend', 'Unsuspend') : t('panel.email.accounts.suspend', 'Suspend'), onClick: () => toggleSuspend(r), disabled: busy },
                  { label: t('panel.email.common.delete', 'Delete'), danger: true, onClick: () => open('delete', r) },
                ]}
              />
            )}
          </Card>
          <p className="muted">{t('panel.email.accounts.footer_connect', 'Mail apps connect with the settings behind')} <strong>{t('panel.email.accounts.connect', 'Connect')}</strong>. {t('panel.email.accounts.footer_links', 'Forwarding and automatic replies live under')} <Link to="/panel/email/forwarders">{t('panel.email/forwarders.label', 'Forwarders')}</Link> {t('panel.email.common.and', 'and')} <Link to="/panel/email/autoresponders">{t('panel.email/autoresponders.label', 'Autoresponders')}</Link>.</p>
        </>
      )}

      <Modal open={dialog?.kind === 'create'} title={t('panel.email.accounts.create', 'Create mailbox')} onClose={close}>
        {dialog?.kind === 'create' && <CreateMailboxForm domains={domains} defaultQuotaMb={defaultQuotaMb} passwordPolicy={passwordPolicy} onSubmit={create} onCancel={close} busy={busy} error={mutationError} />}
      </Modal>
      <Modal open={dialog?.kind === 'password'} title={t('panel.email.accounts.change_password', 'Change password')} onClose={close} size="sm">
        {dialog?.kind === 'password' && <PasswordForm address={dialog.row.address} passwordPolicy={passwordPolicy} onSubmit={(b) => setPassword(dialog.row, b)} onCancel={close} busy={busy} error={mutationError} />}
      </Modal>
      <Modal open={dialog?.kind === 'quota'} title={t('panel.email.accounts.change_quota', 'Change quota')} onClose={close} size="sm">
        {dialog?.kind === 'quota' && <QuotaForm row={dialog.row} defaultQuotaMb={defaultQuotaMb} onSubmit={(b) => setQuota(dialog.row, b)} onCancel={close} busy={busy} error={mutationError} />}
      </Modal>
      <Modal open={dialog?.kind === 'delete'} title={t('panel.email.accounts.delete', 'Delete mailbox')} onClose={close} size="sm">
        {dialog?.kind === 'delete' && <DeleteForm row={dialog.row} onSubmit={(b) => remove(dialog.row, b)} onCancel={close} busy={busy} error={mutationError} />}
      </Modal>
      {dialog?.kind === 'settings' && <ClientSettingsSheet row={dialog.row} onClose={close} />}
    </PanelPage>
  );
}
