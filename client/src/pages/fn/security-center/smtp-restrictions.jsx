import { ToggleFeaturePage } from '../../security/Shared.jsx';
import { CapabilityNotice, StatusPill } from '../../../components/Common.jsx';

const familyLabel = (v) => (v === true ? 'restricted' : v === false ? 'open' : 'no tooling');

export default function SmtpRestrictions({ fn }) {
  return (
    <ToggleFeaturePage
      fn={fn} path="/security/smtp-restrictions" field="enabled" isOn={(d) => d.enabled}
      onLabel="Enable SMTP restrictions" offLabel="Disable SMTP restrictions"
      confirmOn="Outbound connections to port 25 will be rejected unless they come from root or the mail server groups. Scripts that talk to remote SMTP servers directly (instead of through the local mail server) will stop working."
      renderStatus={(d, on) => (on ? `Restricted (${d.backend})` : 'Not restricted')}
      notInstalled={(d) => (!d.installed ? <CapabilityNotice error={{ code: 'capability_missing', message: 'No supported firewall (iptables or nftables) is installed, so outbound SMTP cannot be restricted.' }} /> : null)}
      renderDetails={(d) => (
        <>
          {d.families && (
            <div className="row-actions" style={{ marginTop: 10, flexWrap: 'wrap' }}>
              {Object.entries(d.families).map(([family, v]) => <StatusPill key={family} status={v === true ? 'ok' : v === false ? 'warning' : 'failed'}>{family.toUpperCase()}: {familyLabel(v)}</StatusPill>)}
            </div>
          )}
          {d.enabled && d.unprotected?.length > 0 && <div className="banner banner-warning" style={{ marginTop: 10 }}><div>Port 25 is still reachable over {d.unprotected.join(', ').toUpperCase()}: the iptables backend needs ip6tables to cover IPv6. Install it (or switch to nftables) and re-enable the restriction.</div></div>}
          {d.desired && !d.enabled && d.installed && <div className="banner banner-warning" style={{ marginTop: 10 }}><div>The restriction is switched on in the panel but its firewall rules are not active right now (a reboot or firewall restart removed them). They come back with the next hourly maintenance run; use "Enable SMTP restrictions" to put them back immediately.</div></div>}
          <p className="muted">Owner-match firewall rules allow port 25 only from root and these groups: {d.groups?.length ? d.groups.map((g) => <code key={g} style={{ marginRight: 6 }}>{g}</code>) : <em>none detected</em>}. Everything else is rejected with a TCP reset on both IPv4 and IPv6 when the tooling for each family is present, which stops compromised scripts from spamming directly while mail sent through the local server keeps flowing.</p>
          {d.backend && <p className="muted">Firewall backend: <code>{d.backend}</code>. The switch is stored as a panel setting: the rules are re-applied when the panel starts and checked every hour by the cPHulk maintenance job, so they survive reboots and firewall restarts.</p>}
        </>
      )}
    />
  );
}
