import { PageHeader, Card, Loading, StatusPill, KeyValue } from '../../../components/Common.jsx';
import { Field, NumberInput, Select, Toggle, TextInput } from '../../../components/Form.jsx';
import { useConfirm } from '../../../components/Modal.jsx';
import { useSettingsForm, SaveBar, RequestError, DaemonNotice, LastApply, UnitPill, ToggleList } from '../../service-config/Shared.jsx';

const PROTOCOLS = [{ value: 'imap', label: 'IMAP (143 / 993)' }, { value: 'pop3', label: 'POP3 (110 / 995)' }, { value: 'lmtp', label: 'LMTP (local delivery from Exim)' }, { value: 'sieve', label: 'ManageSieve (filters)' }];

export default function MailserverConfiguration({ fn }) {
  const confirm = useConfirm();
  const form = useSettingsForm('/service-config/mailserver', {
    confirm: (draft, base) => (!draft.protocols.includes('imap') && base.protocols.includes('imap') ? confirm({ title: 'Disable IMAP?', message: 'Mail clients using IMAP lose access until it is enabled again.', confirmLabel: 'Disable IMAP', danger: true }) : true),
  });
  const { data, draft, set } = form;
  return (
    <>
      <PageHeader fn={fn} description="Dovecot IMAP/POP3 settings: protocols, connection and process limits, SSL requirements and mailbox location. Written to conf.d/97-whm-mailserver.conf, validated with doveconf -n and reloaded." />
      <RequestError error={form.error} onRetry={form.refetch} />
      {form.loading && !data && <Loading />}
      {data && draft && (
        <>
          <DaemonNotice capability="dovecot" installed={data.installed} message="Dovecot is not installed on this server. Install dovecot-imapd/dovecot-pop3d (Debian/Ubuntu) or dovecot (RHEL); the settings you save here are written once it is." onRetry={form.refetch} />
          <Card title="Dovecot" actions={<LastApply apply={data.lastApply} />}>
            <KeyValue items={[
              ['Unit', <UnitPill key="u" unit={data.detect?.unit} />],
              ['Version', data.detect?.version || '—'],
              ['Configuration test', data.detect?.configOk == null ? '—' : <StatusPill key="c" status={data.detect.configOk ? 'ok' : 'failed'}>{data.detect.configOk ? 'doveconf -n ok' : 'doveconf reports errors'}</StatusPill>],
              ['Effective protocols', data.detect?.effective?.protocols || '—'],
              ['Effective ssl', data.detect?.effective?.ssl ? `${data.detect.effective.ssl} (min ${data.detect.effective.ssl_min_protocol || '?'})` : '—'],
              ['mail_location', data.detect?.effective?.mail_location || '—'],
              ['Managed include', data.detect?.include ? <span key="i"><code>{data.detect.include.path}</code> {data.detect.include.exists ? <StatusPill status="ok">written</StatusPill> : <StatusPill status="pending">not written</StatusPill>}</span> : '—'],
            ]} />
          </Card>
          <Card title="Protocols" className="config-fields">
            <ToggleList options={PROTOCOLS} value={draft.protocols} onChange={set('protocols')} />
            {draft.protocols.includes('sieve') && <p className="muted">ManageSieve needs the dovecot-managesieved package; Dovecot refuses the configuration otherwise and the change is rolled back.</p>}
          </Card>
          <Card title="Connections" className="config-fields">
            <div className="form-grid">
              <Field label="Max connections per user per IP" help="mail_max_userip_connections (POP3 gets half)"><NumberInput value={draft.maxUserIpConnections} onChange={set('maxUserIpConnections')} min={1} nullable={false} /></Field>
              <Field label="Process limit" help="default_process_limit"><NumberInput value={draft.processLimit} onChange={set('processLimit')} min={1} nullable={false} /></Field>
              <Field label="Client limit" help="default_client_limit"><NumberInput value={draft.clientLimit} onChange={set('clientLimit')} min={1} nullable={false} /></Field>
              <Field label="IMAP IDLE notify interval (minutes)"><NumberInput value={draft.imapIdleNotifyIntervalMinutes} onChange={set('imapIdleNotifyIntervalMinutes')} min={1} max={60} nullable={false} /></Field>
            </div>
          </Card>
          <Card title="SSL" className="config-fields" subtitle="This file owns ssl=, the protocol floor and the ciphers; SSL/TLS Configuration presets fill the cipher fields when applied to Dovecot.">
            <div className="form-grid">
              <Field label="ssl" help="required refuses plain-text connections on 143/110 before STARTTLS"><Select value={draft.ssl} onChange={set('ssl')} options={[{ value: 'required', label: 'required' }, { value: 'yes', label: 'yes (offered, not required)' }, { value: 'no', label: 'no' }]} /></Field>
              <Field label="Minimum TLS protocol"><Select value={draft.sslMinProtocol} onChange={set('sslMinProtocol')} options={['TLSv1', 'TLSv1.1', 'TLSv1.2', 'TLSv1.3']} /></Field>
            </div>
            <Field label="Cipher list (ssl_cipher_list)" help="OpenSSL syntax for TLS 1.2 and below; empty keeps Dovecot's default"><TextInput value={draft.sslCipherList} onChange={set('sslCipherList')} placeholder="ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:..." /></Field>
            <Field label="TLS 1.3 cipher suites (ssl_cipher_suites)" help={data.cipherSuitesSupported === false ? 'This Dovecot is older than 2.3.15 and has no ssl_cipher_suites; the value is kept but not written' : 'Colon-separated TLS_* names; empty keeps the library default'}><TextInput value={draft.sslCipherSuites} onChange={set('sslCipherSuites')} placeholder="TLS_AES_128_GCM_SHA256:TLS_AES_256_GCM_SHA384" /></Field>
            <Field inline><Toggle checked={draft.sslPreferServerCiphers} onChange={set('sslPreferServerCiphers')} label="Prefer the server's cipher order (ssl_prefer_server_ciphers)" /></Field>
            <Field inline><Toggle checked={draft.disablePlaintextAuth} onChange={set('disablePlaintextAuth')} label="Disable plain-text authentication without TLS" disabled={draft.ssl === 'required'} /></Field>
            <p className="muted">The certificate itself is installed under Manage Service SSL Certificates (conf.d/90-whm-ssl-cert.conf, certificate paths only, loaded before this file so nothing here is overridden).</p>
          </Card>
          <Card title="Mailboxes" className="config-fields">
            <div className="form-grid">
              <Field label="mail_location" help="Where each user's mail lives"><TextInput value={draft.mailLocation} onChange={set('mailLocation')} placeholder="maildir:~/mail" /></Field>
              <Field label="Mailbox format for new accounts"><Select value={draft.mailboxFormat} onChange={(v) => { set('mailboxFormat')(v); if (/^(maildir|mbox|mdbox|sdbox):/.test(draft.mailLocation)) set('mailLocation')(draft.mailLocation.replace(/^[a-z]+:/, `${v}:`)); }} options={['maildir', 'mbox', 'mdbox', 'sdbox']} /></Field>
              <Field label="POP3 UIDL format"><TextInput value={draft.pop3UidlFormat} onChange={set('pop3UidlFormat')} /></Field>
              <Field label="Login greeting" help="Empty keeps Dovecot's default"><TextInput value={draft.loginGreeting} onChange={set('loginGreeting')} placeholder="Dovecot ready." /></Field>
            </div>
          </Card>
          <Card title="Preview" subtitle={data.detect?.include?.path || '/etc/dovecot/conf.d/97-whm-mailserver.conf'}><pre className="log">{data.preview}</pre></Card>
          <SaveBar form={form} label="Save and apply to Dovecot" />
        </>
      )}
    </>
  );
}
