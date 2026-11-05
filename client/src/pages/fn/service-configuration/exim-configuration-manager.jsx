import { useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { api } from '../../../api/client.js';
import { useApi } from '../../../hooks/useApi.js';
import { PageHeader, Card, Loading, StatusPill, KeyValue } from '../../../components/Common.jsx';
import { Field, NumberInput, TextInput, Select, Toggle, Button } from '../../../components/Form.jsx';
import { useConfirm } from '../../../components/Modal.jsx';
import { useToast } from '../../../components/Toast.jsx';
import { useSettingsForm, SaveBar, RequestError, DaemonNotice, LastApply, UnitPill, Tabs, ListEditor, Hints, ToggleList, isCapabilityError } from '../../service-config/Shared.jsx';

const LOG_ITEMS = [{ value: '+smtp_connection', label: 'SMTP connections' }, { value: '+subject', label: 'Subjects' }, { value: '+tls_cipher', label: 'TLS cipher' }, { value: '+received_recipients', label: 'Received recipients' }, { value: '+sender_on_delivery', label: 'Sender on delivery' }, { value: '+smtp_incomplete_transaction', label: 'Incomplete transactions' }, { value: '+all_parents', label: 'All parents' }, { value: '+arguments', label: 'Command arguments' }, { value: '+smtp_protocol_error', label: 'Protocol errors' }, { value: '+smtp_syntax_error', label: 'Syntax errors' }];

const yesNo = (v) => (v == null ? <StatusPill status="unknown">unknown</StatusPill> : v ? <StatusPill status="ok">yes</StatusPill> : <StatusPill status="warning">no</StatusPill>);

const submissionPortsLabel = (p) => (!p?.enabled ? <StatusPill status="warning">off</StatusPill> : p.port465 ? <StatusPill status="ok">465 + 587</StatusPill> : <span><StatusPill status="ok">587 only</StatusPill> <span className="muted">(no Exim TLS preset)</span></span>);

// POST /service-config/virtual-mail/apply after the operator confirms; every
// warning the apply reports becomes its own toast.
export async function applyVirtualMail({ enabled, confirm, toast, refetch }) {
  const ok = await confirm(enabled
    ? { title: 'Apply virtual mailboxes?', message: 'Writes the Dovecot passdb/userdb include and the Exim router, transport and authenticator fragments, validates them and reloads both daemons. Panel-created mailboxes are delivered and authenticated once Exim loads the fragments.', confirmLabel: 'Apply' }
    : { title: 'Disable virtual mailboxes?', message: 'Removes the Exim fragments and the Dovecot include and reloads both daemons. Panel-created mailboxes stop receiving mail and their logins stop working until virtual mail is applied again.', confirmLabel: 'Disable', danger: true });
  if (!ok) return null;
  try {
    const { data: d } = await api.post('/service-config/virtual-mail/apply', { enabled });
    if (!enabled) toast.success('Virtual mailboxes disabled');
    else if (d.live) toast.success('Virtual mailboxes are live');
    else toast.warning(`Virtual mail written but not live${d.lastApply?.error ? `: ${d.lastApply.error}` : ''}`);
    for (const w of d.warnings || []) toast.warning(w);
    await refetch?.();
    return d;
  } catch (err) {
    if (isCapabilityError(err)) toast.warning(err.message); else toast.error(err);
    await refetch?.();
    return null;
  }
}

export function VirtualMailCard() {
  const confirm = useConfirm();
  const toast = useToast();
  const { data, loading, error, refetch } = useApi('/service-config/virtual-mail');
  const [busy, setBusy] = useState(null);
  const run = async (enabled) => { setBusy(enabled ? 'apply' : 'disable'); try { await applyVirtualMail({ enabled, confirm, toast, refetch }); } finally { setBusy(null); } };
  const slots = data?.exim?.slots || {};
  const manual = data?.exim?.manualIncludes || [];
  return (
    <Card title="Virtual mailboxes" subtitle="Exim and Dovecot wiring for panel-created mailboxes: Dovecot passdb/userdb include, Exim router, transport and authenticators." actions={data && (
      <>
        <LastApply apply={data.lastApply} />
        <Button variant="primary" size="sm" loading={busy === 'apply'} disabled={Boolean(busy)} onClick={() => run(true)}>Apply</Button>
        <Button variant="danger" size="sm" loading={busy === 'disable'} disabled={Boolean(busy) || data.enabled === false} onClick={() => run(false)}>Disable</Button>
      </>
    )}>
      <RequestError error={error} onRetry={refetch} />
      {loading && !data && <Loading />}
      {data && (
        <>
          <KeyValue items={[
            ['Live', yesNo(data.live)],
            ['Enabled', yesNo(data.enabled)],
            ['Dovecot', data.dovecot?.installed ? <span key="d"><StatusPill status="ok">installed</StatusPill> {data.dovecot.version ? `version ${data.dovecot.version}` : ''}</span> : <StatusPill key="d" status="not-installed">not installed</StatusPill>],
            ...['router', 'transport', 'auth'].map((k) => [`Exim ${k} fragment`, slots[k] ? <span key={k}><code>{slots[k].path}</code> {slots[k].hooked ? <StatusPill status="ok">hooked</StatusPill> : <StatusPill status="warning">not hooked</StatusPill>}{k === 'router' && slots[k].precedes === false ? <> <StatusPill status="warning">after a local-delivery router</StatusPill></> : null}</span> : '—']),
            data.check && ['Rendered check', <span key="c">router {yesNo(data.check.routerHooked)} · auth {yesNo(data.check.authHooked)} · transport {yesNo(data.check.transportHooked)}</span>],
            ['Submission ports', submissionPortsLabel(data.submissionPorts)],
          ]} />
          {(data.warnings || []).map((w) => <div key={w} className="banner banner-warning"><AlertTriangle size={18} /><div>{w}</div></div>)}
          {manual.length > 0 && (
            <div className="banner banner-info">
              <AlertTriangle size={18} />
              <div>
                <strong>Manual include lines required on this layout</strong>
                <p>On unsplit Debian hosts (and monolithic RHEL configs) Exim builds its configuration from <code>{manual[0].file || data.exim?.mainConf || 'exim4.conf.template'}</code>, which the panel never edits. Add these {manual.length === 1 ? 'line' : `${manual.length} lines`} once, then run <code>update-exim4.conf</code> (Debian) and reload Exim:</p>
                <pre className="log">{manual.map((m) => `${m.line}    # ${m.where}`).join('\n')}</pre>
              </div>
            </div>
          )}
        </>
      )}
    </Card>
  );
}

export const IPV6_OPTIONS = [
  { value: 'auto', label: 'Automatic — off when this host has no global IPv6 address' },
  { value: 'on', label: 'On — Exim may try AAAA mail exchangers' },
  { value: 'off', label: 'Off — disable_ipv6 = true' },
];

// What the relay card says about the router on the host (GET /service-config/exim → smarthost).
export function relayState(sh) {
  if (!sh) return null;
  if (sh.error) return { status: 'unknown', label: 'Unknown', detail: sh.error };
  if (!sh.setting && !sh.configured) return { status: 'muted', label: 'Direct delivery', detail: 'Mail leaves this server straight to the recipients\' mail exchangers on port 25.' };
  if (sh.setting && !sh.configured) return { status: 'pending', label: 'Saved, not written', detail: 'The relay is saved; the router is written on the next save with Exim installed.' };
  if (sh.hooked === false) return { status: 'warning', label: 'Written, not loaded', detail: sh.hookable ? 'Exim\'s generated configuration does not contain the relay router yet; run update-exim4.conf and reload Exim.' : 'Exim does not load the relay router: add the include line below once.' };
  if (sh.precedes === false) return { status: 'warning', label: 'Loaded after dnslookup', detail: 'The relay router sits behind the dnslookup router, so mail still leaves directly; move the include line directly after "begin routers".' };
  if (!sh.setting && sh.configured) return { status: 'warning', label: 'Router left behind', detail: `${sh.routerFile} is still on the host without a relay setting; save once to remove it.` };
  return { status: 'active', label: `Relaying through ${sh.host || sh.setting.host}:${sh.port || sh.setting.port}`, detail: null };
}

// The draft the form keeps for `smarthost`: enabled toggles between null and
// the object; the password field is sent only when typed.
export function OutboundRelayCard({ data, draft, set }) {
  const sh = draft.smarthost;
  const state = relayState(data.smarthost);
  const update = (patch) => set('smarthost')({ host: '', port: 587, requireTls: true, auth: null, ...(sh || {}), ...patch });
  const setAuth = (patch) => update({ auth: { user: '', ...(sh?.auth || {}), ...patch } });
  const passwordSet = Boolean(data.settings?.smarthost?.auth?.passwordSet) && data.settings.smarthost.auth.user === sh?.auth?.user;
  return (
    <Card title="Outbound relay" subtitle="Send every message for other domains through one SMTP relay (smarthost) instead of connecting to the recipients' mail exchangers directly. Needed where the provider blocks outbound port 25 (EC2 and most clouds)." actions={state && <StatusPill status={state.status}>{state.label}</StatusPill>}>
      {state?.detail && <p className="muted">{state.detail}</p>}
      {data.smarthost?.hints?.map((h) => <div key={h} className="banner banner-info"><AlertTriangle size={18} /><div>{h}</div></div>)}
      <Field inline><Toggle checked={Boolean(sh)} onChange={(v) => set('smarthost')(v ? { host: '', port: 587, requireTls: true, auth: null } : null)} label="Relay outbound mail through a smarthost" description="Local domains are still delivered here; backup-MX relay domains still go direct." /></Field>
      {sh && (
        <>
          <div className="form-grid">
            <Field label="Relay host" help="Hostname of the SMTP relay (as the provider gives it; the TLS certificate must match it)"><TextInput value={sh.host} onChange={(v) => update({ host: v.trim().toLowerCase() })} placeholder="smtp.relay.example" maxLength={253} /></Field>
            <Field label="Port" help="587 (STARTTLS) for nearly every relay; 25 only when the relay is inside the provider's network"><NumberInput value={sh.port} onChange={(v) => update({ port: v })} min={1} max={65535} nullable={false} /></Field>
          </div>
          <Field inline><Toggle checked={sh.requireTls !== false} onChange={(v) => update({ requireTls: v })} label="Require TLS to the relay" description="Delivery is deferred rather than sent in clear when the relay offers no STARTTLS; the relay login is only sent over TLS either way" /></Field>
          <Field inline><Toggle checked={Boolean(sh.auth)} onChange={(v) => update({ auth: v ? { user: '' } : null })} label="Authenticate to the relay" description="SMTP AUTH (PLAIN/LOGIN) with the credentials below; stored encrypted" /></Field>
          {sh.auth && (
            <div className="form-grid">
              <Field label="Login"><TextInput value={sh.auth.user || ''} onChange={(v) => setAuth({ user: v })} maxLength={254} autoComplete="off" /></Field>
              <Field label="Password" help={passwordSet && !sh.auth.password ? 'A password is stored; leave empty to keep it' : 'Sent once on save and never shown again; may not contain ":"'}><TextInput type="password" value={sh.auth.password || ''} onChange={(v) => setAuth(v ? { password: v } : { password: undefined })} maxLength={256} autoComplete="new-password" placeholder={passwordSet ? '••••••••' : ''} /></Field>
            </div>
          )}
        </>
      )}
      {data.smarthost?.configured && <KeyValue items={[['Router', <code key="r">{data.smarthost.routerFile}</code>], ['Loaded by Exim', yesNo(data.smarthost.hooked)], data.smarthost.hooked && ['Before dnslookup', yesNo(data.smarthost.precedes)], data.smarthost.auth && ['Credential', <code key="p">{data.smarthost.passwdFile}</code>]]} />}
    </Card>
  );
}

export default function EximConfigurationManager({ fn }) {
  const [tab, setTab] = useState('filters');
  const form = useSettingsForm('/service-config/exim');
  const { data, draft, set } = form;
  const slot = (k) => data?.layout?.slots?.[k];
  // A hint is about the slot whose path it names; once that slot is live the hint is stale.
  const hints = (data?.layout?.hints || []).filter((h) => !Object.values(data?.layout?.slots || {}).some((s) => s.hooked && h.includes(s.path)));
  const rcptLive = !slot('acl_rcpt') || slot('acl_rcpt').hooked;
  const spfSupported = data?.support?.spf !== false;
  const hookPill = (s) => (s.hooked ? <StatusPill status="ok">included</StatusPill> : <><StatusPill status="warning">not included</StatusPill> <span className="muted">{s.claimedBy ? `${s.macro || 'hook'} is used by ${s.claimedBy}` : s.hookable ? 'included after the next save' : 'include line missing'}</span></>);

  return (
    <>
      <PageHeader fn={fn} description="Server-wide Exim policy: RBLs, SPF/DKIM verification, connection and rate limits, dictionary attack protection, message size and SMTP AUTH. Rendered into panel-managed fragments, validated with exim -bV (rolled back on error) and reloaded." />
      <RequestError error={form.error} onRetry={form.refetch} />
      {form.loading && !data && <Loading />}
      {data && (
        <>
          <DaemonNotice installed={data.installed} message="Exim is not installed on this server. Install exim4 (Debian/Ubuntu) or exim (RHEL); the policy you save here is kept and rendered once it is." onRetry={form.refetch} />
          <Card title="Mail server" actions={<LastApply apply={data.lastApply} />}>
            <KeyValue items={[
              ['Unit', <UnitPill key="u" unit={data.layout?.unit} />],
              ['Version', data.layout?.version || '—'],
              ['Compiled-in checks', data.layout?.features ? <span key="f">SPF {data.support?.spf ? <StatusPill status="ok">yes</StatusPill> : <><StatusPill status="warning">no</StatusPill> <span className="muted">(exim4-daemon-light; install exim4-daemon-heavy)</span></>} · DKIM {data.support?.dkim ? <StatusPill status="ok">yes</StatusPill> : <StatusPill status="warning">no</StatusPill>}</span> : 'unknown until Exim is installed'],
              ['Layout', data.layout?.flavor ? `${data.layout.flavor}${data.layout.flavor === 'debian' ? (data.layout.splitConfig ? ' (split config: conf.d fragments)' : ' (unsplit: managed block in exim4.conf.localmacros)') : ' (single exim.conf, manual .include)'}` : '—'],
              ['Main options', slot('main') ? <span key="m"><code>{slot('main').path}</code>{slot('main').block ? ' (managed block)' : ''} {slot('main').exists ? <StatusPill status="ok">written</StatusPill> : <StatusPill status="pending">not written</StatusPill>} {slot('main').hooked ? <StatusPill status="ok">live</StatusPill> : <><StatusPill status="warning">not live</StatusPill> <span className="muted">{slot('main').hookable ? (slot('main').exists ? 'not in the generated config' : 'live after the next save') : 'include line missing'}</span></>}</span> : '—'],
              ['RCPT ACL chain', slot('acl_rcpt') ? <span key="r"><code>{slot('acl_rcpt').path}</code> {hookPill(slot('acl_rcpt'))} {data.chain?.emailAclFile && (data.chain.includesEmailFilters ? <span className="muted">includes the Email filters file</span> : <span className="muted">includes the Email filters file after the next save</span>)}</span> : '—'],
              ['DATA ACL', slot('acl_data') ? <span key="d"><code>{slot('acl_data').path}</code> {hookPill(slot('acl_data'))}</span> : '—'],
              ['TLS policy', data.settings?.tls ? <span key="t">minimum {data.settings.tls.minProtocol}{data.support?.tls ? ` · ${data.support.tls === 'gnutls' ? 'GnuTLS priority string' : 'OpenSSL cipher list'}` : ''} <span className="muted">(from SSL/TLS Configuration)</span></span> : <span key="t" className="muted">not set; apply a preset under SSL/TLS Configuration</span>],
              data.mail && ['Queue', data.mail.queue ? `${data.mail.queue.total} message(s), ${data.mail.queue.frozen} frozen` : '—'],
              ['Email category', data.emailCategory ? <span key="e"><StatusPill status="ok">loaded</StatusPill> <span className="muted">filters, greylisting and DKIM keys are managed there</span></span> : <StatusPill key="e" status="muted">not loaded</StatusPill>],
            ]} />
          </Card>
          <VirtualMailCard />
          <Hints hints={hints} />
          {(data.warnings || []).map((w) => <div key={w} className="banner banner-warning"><AlertTriangle size={18} /><div>{w}</div></div>)}
        </>
      )}
      {data && draft && (
        <>
          <Tabs value={tab} onChange={setTab} tabs={[{ value: 'filters', label: 'RBLs and verification' }, { value: 'limits', label: 'Limits and rate limiting' }, { value: 'attack', label: 'Dictionary attack protection' }, { value: 'auth', label: 'Auth, size and logging' }, { value: 'outbound', label: 'Outbound and IPv6' }, { value: 'preview', label: 'Generated config' }]} />
          {tab === 'outbound' && (
            <>
              <OutboundRelayCard data={data} draft={draft} set={set} />
              <Card title="IPv6" className="config-fields" subtitle="Without a global IPv6 route Exim still tries the AAAA addresses of a mail exchanger first and logs a failure for every message.">
                <Field label="IPv6 for outgoing mail" help={data.ipv6 ? `This host ${data.ipv6.hostGlobal === true ? 'has' : data.ipv6.hostGlobal === false ? 'has no' : 'may or may not have'} global IPv6 address; disable_ipv6 is ${data.ipv6.disabled ? 'rendered' : 'not rendered'} with the saved setting.` : null}>
                  <Select value={draft.ipv6 || 'auto'} onChange={set('ipv6')} options={IPV6_OPTIONS} />
                </Field>
              </Card>
            </>
          )}
          {(tab === 'filters' || tab === 'attack') && data.installed && !rcptLive && (
            <div className="banner banner-warning"><AlertTriangle size={18} /><div><strong>Rejection rules are not in force.</strong> They live in the RCPT ACL chain, which Exim does not include on this host{slot('acl_rcpt')?.hookable && !slot('acl_rcpt')?.claimedBy ? ' until the next save hooks it in' : slot('acl_rcpt')?.claimedBy ? ' because another definition of its hook macro came first (save the Email filters page once, or see the step above)' : ' (see the manual step above)'}. Saving writes the chain but reports the apply as not ok until Exim includes it; until then the RBL, reverse-DNS, HELO, sender-verification and dictionary-attack settings only tag messages.</div></div>
          )}
          {tab === 'filters' && (
            <Card className="config-fields" subtitle="Enforced by deny rules in the RCPT ACL fragment for unauthenticated remote senders; authenticated clients and localhost are exempt.">
              <Field inline><Toggle checked={draft.rblEnabled} onChange={set('rblEnabled')} label="Reject mail from hosts listed in RBLs" description="Checked at RCPT time for unauthenticated senders" /></Field>
              <Field label="IP blacklists (dnslists)" help="One zone per line"><ListEditor value={draft.rbls} onChange={set('rbls')} placeholder="zen.spamhaus.org" /></Field>
              <Field inline><Toggle checked={draft.domainRblEnabled} onChange={set('domainRblEnabled')} label="Reject mail whose sender domain is listed in a domain RBL" /></Field>
              <Field label="Domain blacklists"><ListEditor value={draft.domainRbls} onChange={set('domainRbls')} placeholder="dbl.spamhaus.org" /></Field>
              <div className="form-grid">
                <Field inline><Toggle checked={draft.spfVerify} onChange={set('spfVerify')} label="Verify SPF" description={spfSupported ? 'Adds Received-SPF; fail and softfail are tagged and logged, nothing is rejected' : 'Needs an Exim built with SPF (exim4-daemon-heavy on Debian); left out of the ACL on this build'} /></Field>
                <Field inline><Toggle checked={draft.spfReject} onChange={set('spfReject')} label="Reject on SPF hard fail" description={spfSupported ? 'softfail stays tagged' : 'Not available on this Exim build'} disabled={!draft.spfVerify || !spfSupported} /></Field>
                <Field inline><Toggle checked={draft.dkimVerify} onChange={set('dkimVerify')} label="Verify DKIM signatures" description="Adds an X-WHM-DKIM header with the result" /></Field>
                <Field inline><Toggle checked={draft.dkimReject} onChange={set('dkimReject')} label="Reject on DKIM fail" disabled={!draft.dkimVerify} /></Field>
                <Field inline><Toggle checked={draft.reverseDnsRequired} onChange={set('reverseDnsRequired')} label="Require reverse DNS (PTR) for sending hosts" /></Field>
                <Field inline><Toggle checked={draft.verifySender} onChange={set('verifySender')} label="Verify the sender address is routable" /></Field>
                <Field inline><Toggle checked={draft.requireHelo} onChange={set('requireHelo')} label="Require HELO/EHLO before MAIL FROM" /></Field>
              </div>
            </Card>
          )}
          {tab === 'limits' && (
            <Card className="config-fields">
              <div className="form-grid">
                <Field label="Max simultaneous SMTP connections" help="smtp_accept_max"><NumberInput value={draft.smtpAcceptMax} onChange={set('smtpAcceptMax')} min={1} nullable={false} /></Field>
                <Field label="Max connections per host" help="smtp_accept_max_per_host"><NumberInput value={draft.smtpAcceptMaxPerHost} onChange={set('smtpAcceptMaxPerHost')} min={1} nullable={false} /></Field>
                <Field label="Messages per connection before queueing" help="smtp_accept_queue_per_connection"><NumberInput value={draft.smtpAcceptQueuePerConnection} onChange={set('smtpAcceptQueuePerConnection')} min={0} nullable={false} /></Field>
              </div>
              <Field inline><Toggle checked={draft.ratelimitEnabled} onChange={set('ratelimitEnabled')} label="Slow down busy clients (smtp_ratelimit_*)" description="After the threshold each further command is delayed, growing by 1.5× up to 30 s" /></Field>
              <div className="form-grid">
                <Field label="MAIL commands before delay"><NumberInput value={draft.ratelimitMailThreshold} onChange={set('ratelimitMailThreshold')} min={1} nullable={false} disabled={!draft.ratelimitEnabled} /></Field>
                <Field label="Initial MAIL delay (s)"><NumberInput value={draft.ratelimitMailDelay} onChange={set('ratelimitMailDelay')} min={1} max={300} nullable={false} disabled={!draft.ratelimitEnabled} /></Field>
                <Field label="RCPT commands before delay"><NumberInput value={draft.ratelimitRcptThreshold} onChange={set('ratelimitRcptThreshold')} min={1} nullable={false} disabled={!draft.ratelimitEnabled} /></Field>
                <Field label="Initial RCPT delay (s)"><NumberInput value={draft.ratelimitRcptDelay} onChange={set('ratelimitRcptDelay')} min={1} max={300} nullable={false} disabled={!draft.ratelimitEnabled} /></Field>
              </div>
            </Card>
          )}
          {tab === 'attack' && (
            <Card className="config-fields" subtitle="Stops clients that probe for valid mailboxes: unknown commands drop the connection, failed recipients add delays and finally a drop, recipient counts are capped.">
              <Field inline><Toggle checked={draft.dictionaryAttackProtection} onChange={set('dictionaryAttackProtection')} label="Enable dictionary attack protection" /></Field>
              <div className="form-grid">
                <Field label="Unknown SMTP commands before drop" help="smtp_max_unknown_commands"><NumberInput value={draft.maxUnknownCommands} onChange={set('maxUnknownCommands')} min={0} max={100} nullable={false} disabled={!draft.dictionaryAttackProtection} /></Field>
                <Field label="Failed recipients before drop" help="$rcpt_fail_count in the RCPT ACL"><NumberInput value={draft.rcptFailLimit} onChange={set('rcptFailLimit')} min={1} max={1000} nullable={false} disabled={!draft.dictionaryAttackProtection} /></Field>
                <Field label="Delay before drop (s)"><NumberInput value={draft.rcptFailDelay} onChange={set('rcptFailDelay')} min={1} max={300} nullable={false} disabled={!draft.dictionaryAttackProtection} /></Field>
                <Field label="Max recipients per message" help="recipients_max"><NumberInput value={draft.recipientsMax} onChange={set('recipientsMax')} min={1} nullable={false} disabled={!draft.dictionaryAttackProtection} /></Field>
              </div>
              <Field inline><Toggle checked={draft.recipientsMaxReject} onChange={set('recipientsMaxReject')} label="Reject the whole message when the recipient cap is exceeded" description="Off: extra recipients get a temporary error instead" disabled={!draft.dictionaryAttackProtection} /></Field>
            </Card>
          )}
          {tab === 'auth' && (
            <Card className="config-fields">
              <Field label="Maximum message size (MB)" help="message_size_limit"><NumberInput value={draft.maxMessageSizeMb} onChange={set('maxMessageSizeMb')} min={1} max={2048} nullable={false} /></Field>
              <Field inline><Toggle checked={draft.requireTlsForAuth} onChange={set('requireTlsForAuth')} label="Only advertise SMTP AUTH over TLS" description="Prevents passwords being sent in clear text on port 25/587 before STARTTLS" /></Field>
              <Field inline><Toggle checked={draft.submissionPorts} onChange={set('submissionPorts')} label="Submission ports 465/587" description="Adds daemon_smtp_ports = 25 : 465 : 587 with TLS on connect for 465. Port 465 needs the Exim TLS preset applied under SSL/TLS Configuration, and both ports must be opened in the firewall." /></Field>
              <Field label="Extra log selectors" help="Added to log_selector"><ToggleList options={LOG_ITEMS} value={draft.logSelector} onChange={set('logSelector')} /></Field>
            </Card>
          )}
          {tab === 'preview' && (
            <>
              <Card title="Main options" subtitle={slot('main')?.path}><pre className="log">{data.preview.main}</pre></Card>
              <Card title="RCPT ACL chain" subtitle={slot('acl_rcpt')?.path}><pre className="log">{data.preview.acl_rcpt}</pre></Card>
              <Card title="DATA ACL fragment" subtitle={slot('acl_data')?.path}><pre className="log">{data.preview.acl_data}</pre></Card>
              <p className="muted">The preview shows the last saved settings; save to regenerate.</p>
            </>
          )}
          <SaveBar form={form} label="Save and apply to Exim" />
        </>
      )}
    </>
  );
}
