import { EmptyState } from '../../../components/Common.jsx';
import { ToggleFeaturePage, BinaryTable } from '../../security/Shared.jsx';

export default function TracerouteEnableDisable({ fn }) {
  return (
    <ToggleFeaturePage
      fn={fn} path="/security/traceroute" field="enabled" isOn={(d) => d.allowed}
      onLabel="Enable traceroute" offLabel="Disable traceroute"
      confirmOff="Hosting accounts will no longer be able to run traceroute, tracepath or mtr. Root keeps access."
      renderStatus={(d, on) => (on ? 'Traceroute available to all users' : 'Traceroute restricted to privileged users')}
      notInstalled={(d) => (!d.installed ? <EmptyState title="No traceroute tools are installed">traceroute, tracepath and mtr were not found on this server.</EmptyState> : null)}
      renderDetails={(d) => (
        <>
          <p className="muted">Disabling sets the binaries to mode 0750 so unprivileged users cannot probe your network topology; enabling restores 0755.</p>
          <BinaryTable binaries={d.binaries} />
        </>
      )}
    />
  );
}
