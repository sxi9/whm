import { ConfigPage } from '../../../components/ConfigPage.jsx';

const NOT_ENFORCED = 'Stored for the authentication layer; not enforced yet.';

export default function ConfigureSecurityPolicies({ fn }) {
  return (
    <ConfigPage fn={fn} prefix="security." description="Policies that govern how users log in to the panel. Not enforced yet: these values are stored for the authentication layer, which does not read them on login or session checks today. Only the minimum password strength is applied."
      extra={<div className="banner banner-warning"><div>Saving these switches does not harden the server yet. Enforcement of verified-IP login, session timeout, concurrent sessions, password age and the two-factor requirements is pending in the authentication layer; the Security Advisor lists any policy that is switched on but inactive.</div></div>}
      groups={[
        { title: 'Two-factor authentication', fields: [
          { key: 'security.2fa.required_for_root', label: 'Require two-factor authentication for root', type: 'toggle', help: NOT_ENFORCED },
          { key: 'security.policy.require_2fa_for_resellers', label: 'Require two-factor authentication for resellers', type: 'toggle', help: NOT_ENFORCED },
          { key: 'security.policy.api_tokens_require_2fa', label: 'Only users with 2FA may create API tokens', type: 'toggle', help: NOT_ENFORCED },
        ] },
        { title: 'Sessions', fields: [
          { key: 'security.policy.verified_ip_login', label: 'Limit logins to verified IP addresses', type: 'toggle', help: `Intended behaviour: a login from a new address must be confirmed through the contact email. ${NOT_ENFORCED}` },
          { key: 'security.policy.session_timeout_minutes', label: 'Idle session timeout (minutes)', type: 'number', min: 0, help: `0 uses the server default (WHM_SESSION_TTL), which is the only value applied today. ${NOT_ENFORCED}` },
          { key: 'security.policy.disallow_concurrent_sessions', label: 'One active session per user', type: 'toggle', help: `Intended behaviour: a new login signs out every other session of the same user. ${NOT_ENFORCED}` },
        ] },
        { title: 'Passwords', fields: [
          { key: 'security.policy.password_max_age_days', label: 'Maximum password age (days)', type: 'number', min: 0, help: `0 = never expire. ${NOT_ENFORCED}` },
          { key: 'security.min_password_strength', label: 'Minimum password strength (0–100)', type: 'number', min: 0, max: 100, help: 'Enforced. The default for every context; per-context overrides live in Password Strength Configuration.' },
        ] },
      ]} />
  );
}
