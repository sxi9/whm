import { BulkFlagPage } from '../../accounts/BulkFlagPage.jsx';

export default function ManageDemoMode({ fn }) {
  return (
    <BulkFlagPage
      fn={fn} flag="demo_mode" endpoint="/account-functions/demo-mode"
      onLabel="Enable demo mode" offLabel="Disable demo mode" columnLabel="Demo mode"
      description="Demo accounts are read-only: their panel login can browse every feature but no change is applied to the server. Useful for showcasing the control panel."
      confirmOn="Owners of these accounts will be able to log in but not change anything until demo mode is disabled."
    />
  );
}
