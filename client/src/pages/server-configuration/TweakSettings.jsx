import { ConfigPage } from '../../components/ConfigPage.jsx';

export default function TweakSettings({ fn }) {
  return (
    <ConfigPage fn={fn} prefix="" groups={[
      { title: 'Mail', fields: [
        { key: 'tweak.max_emails_per_hour', label: 'Maximum hourly emails per domain', type: 'number', help: '0 = unlimited. Accounts exceeding this are rate limited.', min: 0 },
        { key: 'tweak.allow_remote_domains', label: 'Allow remote domains', type: 'toggle', help: 'Allow creation of parked/addon domains that resolve to other servers.' },
      ] },
      { title: 'Accounts', fields: [
        { key: 'tweak.prevent_unlimited_bandwidth', label: 'Prevent unlimited bandwidth on new accounts', type: 'toggle' },
        { key: 'tweak.login_theme', label: 'Login theme', type: 'select', options: ['jupiter', 'paper_lantern'] },
      ] },
      { title: 'Security', fields: [
        { key: 'security.min_password_strength', label: 'Minimum password strength', type: 'number', min: 0, max: 100, help: '0–100. Applied to account and panel passwords.' },
        { key: 'security.cphulk.enabled', label: 'cPHulk brute force protection', type: 'toggle' },
        { key: 'security.cphulk.max_failures_per_ip', label: 'Failed logins per IP before blocking', type: 'number', min: 1 },
        { key: 'security.cphulk.lockout_minutes', label: 'Block duration (minutes)', type: 'number', min: 1 },
        { key: 'security.2fa.required_for_root', label: 'Require two-factor authentication for root', type: 'toggle' },
      ] },
      { title: 'System', fields: [
        { key: 'dns.default_ttl', label: 'Default DNS zone TTL (seconds)', type: 'number', min: 60 },
        { key: 'php.default_version', label: 'Default PHP version for new accounts', type: 'text', placeholder: 'ea-php83' },
        { key: 'updates.tier', label: 'Update tier', type: 'select', options: ['stable', 'release', 'edge'] },
        { key: 'updates.auto', label: 'Automatic updates', type: 'toggle' },
        { key: 'analytics.enabled', label: 'Interface analytics', type: 'toggle', help: 'Anonymous usage statistics.' },
      ] },
      { title: 'Backups', fields: [
        { key: 'backup.enabled', label: 'Enable scheduled backups', type: 'toggle' },
        { key: 'backup.schedule', label: 'Backup schedule (cron)', type: 'text', placeholder: '0 2 * * *' },
        { key: 'backup.retention_daily', label: 'Keep daily backups', type: 'number', min: 0 },
        { key: 'backup.retention_weekly', label: 'Keep weekly backups', type: 'number', min: 0 },
        { key: 'backup.retention_monthly', label: 'Keep monthly backups', type: 'number', min: 0 },
      ] },
    ]} />
  );
}
