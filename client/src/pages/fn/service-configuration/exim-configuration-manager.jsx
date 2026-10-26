import { useState } from 'react';
import { PageHeader, Card, Loading, StatusPill, KeyValue } from '../../../components/Common.jsx';
import { Field, NumberInput, Toggle } from '../../../components/Form.jsx';
import { useSettingsForm, SaveBar, RequestError, DaemonNotice, LastApply, UnitPill, Tabs, ListEditor, Hints, ToggleList } from '../../service-config/Shared.jsx';

const LOG_ITEMS = [{ value: '+smtp_connection', label: 'SMTP connections' }, { value: '+subject', label: 'Subjects' }, { value: '+tls_cipher', label: 'TLS cipher' }, { value: '+received_recipients', label: 'Received recipients' }, { value: '+sender_on_delivery', label: 'Sender on delivery' }, { value: '+smtp_incomplete_transaction', label: 'Incomplete transactions' }, { value: '+all_parents', label: 'All parents' }, { value: '+arguments', label: 'Command arguments' }, { value: '+smtp_protocol_error', label: 'Protocol errors' }, { value: '+smtp_syntax_error', label: 'Syntax errors' }];

export default function EximConfigurationManager({ fn }) {
  const [tab, setTab] = useState('filters');
  const form = useSettingsForm('/service-config/exim');
  const { data, draft, set } = form;
  const slot = (k) => data?.layout?.slots?.[k];
  // A hint is about the slot whose path it names; once that slot is live the hint is stale.
  const hints = (data?.layout?.hints || []).filter((h) => !Object.values(data?.layout?.slots || {}).some((s) => s.hooked && h.includes(s.path)));
  const rcptLive = !slot('acl_rcpt') || slot('acl_rcpt').hooked;
  const spfSupported = data?.support?.spf !== false;
  const hookPill = (s) => (s.hooked ? <StatusPill status="ok">included</StatusPill> : <StatusPill status="warning">{s.claimedBy ? `not included (${s.macro || 'hook'} is used by ${s.claimedBy})` : s.hookable ? 'included after the next save' : 'include line missing'}</StatusPill>);

  return (
    <>
      <PageHeader fn={fn} description="Server-wide Exim policy: RBLs, SPF/DKIM verification, connection and rate limits, dictionary attack protection, message size and SMTP AUTH. Rendered into panel-managed fragments, validated with exim -bV (rolled back on error) and reloaded." />
      <RequestError error={form.error} onRetry={form.refetch} />
      {form.loading && !data && <Loading />}
      {data && draft && (
        <>
          <DaemonNotice installed={data.installed} message="Exim is not installed on this server. Install exim4 (Debian/Ubuntu) or exim (RHEL); the policy you save here is kept and rendered once it is." onRetry={form.refetch} />
          <Card title="Mail server" actions={<LastApply apply={data.lastApply} />}>
            <KeyValue items={[
              ['Unit', <UnitPill key="u" unit={data.layout?.unit} />],
              ['Version', data.layout?.version || '—'],
              ['Compiled-in checks', data.layout?.features ? <span key="f">SPF {data.support?.spf ? <StatusPill status="ok">yes</StatusPill> : <StatusPill status="warning">no (exim4-daemon-light; install exim4-daemon-heavy)</StatusPill>} · DKIM {data.support?.dkim ? <StatusPill status="ok">yes</StatusPill> : <StatusPill status="warning">no</StatusPill>}</span> : 'unknown until Exim is installed'],
              ['Layout', data.layout?.flavor ? `${data.layout.flavor}${data.layout.flavor === 'debian' ? (data.layout.splitConfig ? ' (split config: conf.d fragments)' : ' (unsplit: managed block in exim4.conf.localmacros)') : ' (single exim.conf, manual .include)'}` : '—'],
              ['Main options', slot('main') ? <span key="m"><code>{slot('main').path}</code>{slot('main').block ? ' (managed block)' : ''} {slot('main').exists ? <StatusPill status="ok">written</StatusPill> : <StatusPill status="pending">not written</StatusPill>} {slot('main').hooked ? <StatusPill status="ok">live</StatusPill> : <StatusPill status="warning">{slot('main').hookable ? (slot('main').exists ? 'not in the generated config' : 'live after the next save') : 'include line missing'}</StatusPill>}</span> : '—'],
              ['RCPT ACL chain', slot('acl_rcpt') ? <span key="r"><code>{slot('acl_rcpt').path}</code> {hookPill(slot('acl_rcpt'))} {data.chain?.emailAclFile && (data.chain.includesEmailFilters ? <StatusPill status="ok">includes Email filters</StatusPill> : <StatusPill status="pending">includes Email filters after the next save</StatusPill>)}</span> : '—'],
              ['DATA ACL', slot('acl_data') ? <span key="d"><code>{slot('acl_data').path}</code> {hookPill(slot('acl_data'))}</span> : '—'],
              ['TLS policy', data.settings?.tls ? <span key="t">minimum {data.settings.tls.minProtocol}{data.support?.tls ? ` · ${data.support.tls === 'gnutls' ? 'GnuTLS priority string' : 'OpenSSL cipher list'}` : ''} <span className="muted">(from SSL/TLS Configuration)</span></span> : <span key="t" className="muted">not set; apply a preset under SSL/TLS Configuration</span>],
              data.mail && ['Queue', data.mail.queue ? `${data.mail.queue.total} message(s), ${data.mail.queue.frozen} frozen` : '—'],
              ['Email category', data.emailCategory ? <StatusPill key="e" status="ok">loaded (filters, greylisting, DKIM keys are managed there)</StatusPill> : <StatusPill key="e" status="muted">not loaded</StatusPill>],
            ]} />
          </Card>
          <Hints hints={hints} />
          {(data.warnings || []).map((w) => <div key={w} className="banner banner-warning"><div>{w}</div></div>)}
          <Tabs value={tab} onChange={setTab} tabs={[{ value: 'filters', label: 'RBLs & verification' }, { value: 'limits', label: 'Limits & rate limiting' }, { value: 'attack', label: 'Dictionary attack protection' }, { value: 'auth', label: 'Auth, size & logging' }, { value: 'preview', label: 'Generated config' }]} />
          {(tab === 'filters' || tab === 'attack') && data.installed && !rcptLive && (
            <div className="banner banner-warning"><div><strong>Rejection rules are not in force.</strong> They live in the RCPT ACL chain, which Exim does not include on this host{slot('acl_rcpt')?.hookable && !slot('acl_rcpt')?.claimedBy ? ' until the next save hooks it in' : slot('acl_rcpt')?.claimedBy ? ' because another definition of its hook macro came first (save the Email filters page once, or see the step above)' : ' (see the manual step above)'}. Saving writes the chain but reports the apply as not ok until Exim includes it; until then the RBL, reverse-DNS, HELO, sender-verification and dictionary-attack settings only tag messages.</div></div>
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
