import { EmptyState } from '../../../components/Common.jsx';
import { ToggleFeaturePage, BinaryTable } from '../../security/Shared.jsx';

export default function CompilerAccess({ fn }) {
  return (
    <ToggleFeaturePage
      fn={fn} path="/security/compilers" field="allow" isOn={(d) => d.allowed}
      onLabel="Allow compilers" offLabel="Deny compilers"
      confirmOff="Unprivileged users (hosting accounts) will no longer be able to run gcc, cc, g++ or clang. Root and group members keep access. Deny access unless accounts need to build software."
      renderStatus={(d, on) => (on ? 'Compilers available to all users' : 'Compilers restricted to privileged users')}
      notInstalled={(d) => (!d.installed ? <EmptyState title="No compilers are installed">gcc, cc, g++ and clang were not found in /usr/bin, so there is nothing to restrict.</EmptyState> : null)}
      renderDetails={(d) => (
        <>
          <p className="muted">Denying access sets the compiler binaries to mode 0750 (owner and group only); allowing restores 0755. Exploit kits uploaded to compromised accounts often depend on a working compiler.</p>
          <BinaryTable binaries={d.binaries} />
        </>
      )}
    />
  );
}
