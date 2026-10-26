import { BulkFlagPage } from '../../accounts/BulkFlagPage.jsx';

export default function ForcePasswordChange({ fn }) {
  return (
    <BulkFlagPage
      fn={fn} flag="force_password_change" endpoint="/account-functions/force-password-change"
      onLabel="Require change" offLabel="Clear requirement" columnLabel="Change required"
      description="Flags accounts so their owner must set a new password at the next panel login. The flag clears automatically when the password is changed (Password Modification)."
    />
  );
}
