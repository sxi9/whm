import { ToggleFeaturePage } from '../../security/Shared.jsx';
import { CapabilityNotice } from '../../../components/Common.jsx';

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
          <p className="muted">Owner-match firewall rules allow port 25 only from root and these groups: {d.groups?.length ? d.groups.map((g) => <code key={g} style={{ marginRight: 6 }}>{g}</code>) : <em>none detected</em>}. Everything else is rejected with a TCP reset, which stops compromised scripts from spamming directly while mail sent through the local server keeps flowing.</p>
          {d.backend && <p className="muted">Firewall backend: <code>{d.backend}</code>. Rules are re-applied by the hourly cPHulk maintenance job when firewall sync is enabled.</p>}
        </>
      )}
    />
  );
}
