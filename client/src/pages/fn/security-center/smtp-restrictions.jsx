import { AlertTriangle } from 'lucide-react';
import { ToggleFeaturePage } from '../../security/Shared.jsx';
import { CapabilityNotice, StatusPill, Card } from '../../../components/Common.jsx';

const familyLabel = (v) => (v === true ? 'restricted' : v === false ? 'open' : 'no tooling');
const FAMILY_NAMES = { ipv4: 'IPv4', ipv6: 'IPv6' };
const familyName = (f) => FAMILY_NAMES[String(f).toLowerCase()] || f;

export default function SmtpRestrictions({ fn }) {
  return (
    <ToggleFeaturePage
      fn={fn} path="/security/smtp-restrictions" field="enabled" isOn={(d) => d.enabled}
      onLabel="Enable SMTP restrictions" offLabel="Disable SMTP restrictions"
      confirmOn="Outbound connections to port 25 will be rejected unless they come from root or the mail server groups. Scripts that talk to remote SMTP servers directly (instead of through the local mail server) will stop working."
      renderStatus={(d, on) => (on ? `Restricted (${d.backend})` : 'Not restricted')}
      notInstalled={(d) => (!d.installed ? <CapabilityNotice error={{ code: 'capability_missing', message: 'No supported firewall (iptables or nftables) is installed, so outbound SMTP cannot be restricted.' }} /> : null)}
      renderDetails={(d) => (d.installed ? (
        <Card title="How the restriction works">
          {d.families && (
            <div className="row-actions" style={{ justifyContent: 'flex-start', flexWrap: 'wrap', marginBottom: 12 }}>
              {Object.entries(d.families).map(([family, v]) => <StatusPill key={family} status={v === true ? 'ok' : v === false ? 'warning' : 'failed'}>{familyName(family)}: {familyLabel(v)}</StatusPill>)}
            </div>
          )}
          {d.enabled && d.unprotected?.length > 0 && <div className="banner banner-warning"><AlertTriangle size={18} /><div>Port 25 is still reachable over {d.unprotected.map(familyName).join(', ')}: the iptables backend needs ip6tables to cover IPv6. Install it (or switch to nftables) and re-enable the restriction.</div></div>}
          {d.desired && !d.enabled && d.installed && <div className="banner banner-warning"><AlertTriangle size={18} /><div>The restriction is switched on in the panel but its firewall rules are not active right now (a reboot or firewall restart removed them). They come back with the next hourly maintenance run; use "Enable SMTP restrictions" to put them back immediately.</div></div>}
          <p className="muted">Owner-match firewall rules allow port 25 only from root and these groups: {d.groups?.length ? d.groups.map((g, i) => <span key={g}>{i > 0 ? ', ' : ''}<code>{g}</code></span>) : <em>none detected</em>}. Everything else is rejected with a TCP reset on both IPv4 and IPv6 when the tooling for each family is present, which stops compromised scripts from spamming directly while mail sent through the local server keeps flowing.</p>
          {d.backend && <p className="muted">Firewall backend: <code>{d.backend}</code>. The switch is stored as a panel setting: the rules are re-applied when the panel starts and checked every hour by the brute force protection maintenance job, so they survive reboots and firewall restarts.</p>}
        </Card>
      ) : null)}
    />
  );
}
