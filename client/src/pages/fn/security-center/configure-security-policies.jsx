import { ConfigPage } from '../../../components/ConfigPage.jsx';

export default function ConfigureSecurityPolicies({ fn }) {
  return (
    <ConfigPage fn={fn} prefix="security." description="Policies that govern how users log in to the panel. These are read by the authentication layer on every login and session check." groups={[
      { title: 'Two-factor authentication', fields: [
        { key: 'security.2fa.required_for_root', label: 'Require two-factor authentication for root', type: 'toggle', help: 'Root cannot log in without an authenticator once enabled.' },
        { key: 'security.policy.require_2fa_for_resellers', label: 'Require two-factor authentication for resellers', type: 'toggle' },
        { key: 'security.policy.api_tokens_require_2fa', label: 'Only users with 2FA may create API tokens', type: 'toggle' },
      ] },
      { title: 'Sessions', fields: [
        { key: 'security.policy.verified_ip_login', label: 'Limit logins to verified IP addresses', type: 'toggle', help: 'A login from a new address must be confirmed through the contact email before the session is granted.' },
        { key: 'security.policy.session_timeout_minutes', label: 'Idle session timeout (minutes)', type: 'number', min: 0, help: '0 uses the server default (WHM_SESSION_TTL).' },
        { key: 'security.policy.disallow_concurrent_sessions', label: 'One active session per user', type: 'toggle', help: 'A new login signs out every other session of the same user.' },
      ] },
      { title: 'Passwords', fields: [
        { key: 'security.policy.password_max_age_days', label: 'Maximum password age (days)', type: 'number', min: 0, help: '0 = never expire. Users are forced to change an older password at their next login.' },
        { key: 'security.min_password_strength', label: 'Minimum password strength (0–100)', type: 'number', min: 0, max: 100, help: 'The default for every context; per-context overrides live in Password Strength Configuration.' },
      ] },
    ]} />
  );
}
