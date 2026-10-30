import { ConfigPage } from '../../../components/ConfigPage.jsx';

export default function ConfigureSecurityPolicies({ fn }) {
  return (
    <ConfigPage fn={fn} prefix="security." description="Policies that govern how users log in to the panel and how long they stay logged in. The authentication layer applies every one of them as soon as it is saved: on the next login, the next request of an open session, or the next API call."
      groups={[
        { title: 'Two-factor authentication', fields: [
          { key: 'security.2fa.required_for_root', label: 'Require two-factor authentication for root', type: 'toggle', help: 'A root user without a 2FA device is sent to the enrolment page after login and can use nothing but the authentication endpoints until a device is enrolled; 2FA can no longer be disabled while the policy is on.' },
          { key: 'security.policy.require_2fa_for_resellers', label: 'Require two-factor authentication for resellers', type: 'toggle', help: 'The same rule for reseller users.' },
          { key: 'security.policy.api_tokens_require_2fa', label: 'Only users with two-factor authentication may use API tokens', type: 'toggle', help: 'Every request made with a token whose owner has no 2FA device is refused (401). Existing tokens are kept and work again once the owner enrols.' },
        ] },
        { title: 'Sessions', fields: [
          { key: 'security.policy.verified_ip_login', label: 'Report logins from unverified IP addresses', type: 'toggle', help: 'A login from an address the user has not logged in from in the last 90 days is written to the audit log and reported through Contact Manager (event login.new_ip). The login itself is not blocked.' },
          { key: 'security.policy.session_timeout_minutes', label: 'Idle session timeout (minutes)', type: 'number', min: 0, help: 'A session idle for longer than this is ended on its next request. 0 disables the idle check; the panel’s fixed 8-hour session lifetime still applies.' },
          { key: 'security.policy.disallow_concurrent_sessions', label: 'One active session per user', type: 'toggle', help: 'A new login signs out every other browser session of the same user.' },
        ] },
        { title: 'Passwords', fields: [
          { key: 'security.policy.password_max_age_days', label: 'Maximum password age (days)', type: 'number', min: 0, help: 'A user whose password is older than this must change it at the next login. 0 = never expire.' },
          { key: 'security.min_password_strength', label: 'Minimum password strength (0–100)', type: 'number', min: 0, max: 100, help: 'The default for every context; per-context overrides live in Password Strength Configuration.' },
        ] },
      ]} />
  );
}
