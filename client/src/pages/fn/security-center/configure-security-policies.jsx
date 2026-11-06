import { ConfigPage } from '../../../components/ConfigPage.jsx';

export default function ConfigureSecurityPolicies({ fn }) {
  return (
    <ConfigPage fn={fn} prefix="security." description="Policies that govern how users log in to the panel."
      groups={[
        { title: 'Two-factor authentication', fields: [
          { key: 'security.2fa.required_for_root', label: 'Require two-factor authentication for root', type: 'toggle', help: 'Root must enrol in two-factor authentication before using anything but the account pages.' },
          { key: 'security.policy.require_2fa_for_resellers', label: 'Require two-factor authentication for resellers', type: 'toggle', help: 'Resellers must enrol in two-factor authentication on their next login.' },
          { key: 'security.2fa.required_for_users', label: 'Require two-factor authentication for account users', type: 'toggle', help: 'Account holders must enrol in two-factor authentication on their next sign-in to the account panel; until then only the enrolment page opens. The account panel setting of the same name (Panel › Customization) enforces the same rule.' },
          { key: 'security.policy.api_tokens_require_2fa', label: 'Only users with 2FA may create API tokens', type: 'toggle', help: 'API tokens of users without two-factor authentication are refused.' },
        ] },
        { title: 'Sessions', fields: [
          { key: 'security.policy.verified_ip_login', label: 'Limit logins to verified IP addresses', type: 'toggle', help: 'A login from a new address must be confirmed through the contact email.' },
          { key: 'security.policy.session_timeout_minutes', label: 'Idle session timeout (minutes)', type: 'number', min: 0, help: '0 uses the server default (WHM_SESSION_TTL).' },
          { key: 'security.policy.disallow_concurrent_sessions', label: 'One active session per user', type: 'toggle', help: 'A new login signs out every other session of the same user.' },
        ] },
        { title: 'Passwords', fields: [
          { key: 'security.policy.password_max_age_days', label: 'Maximum password age (days)', type: 'number', min: 0, help: '0 = never expire. Users with an older password must change it at their next login.' },
          { key: 'security.min_password_strength', label: 'Minimum password strength (0–100)', type: 'number', min: 0, max: 100, help: 'The default for every context; per-context overrides live in Password Strength Configuration.' },
        ] },
      ]} />
  );
}
