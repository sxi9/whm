import { Link } from 'react-router-dom';
import { KeyRound, ShieldCheck } from 'lucide-react';
import { Card, KeyValue, StatusPill, Loading, formatMb, formatDate } from '../../../components/Common.jsx';
import { PanelPage } from '../../../panel/PanelPage.jsx';
import { useT } from '../../../i18n/useT.js';
import { PANEL_PATHS, PANEL_FUNCTIONS, featureEnabled } from '../../../panel/nav.js';
import { usePanelMe } from '../../../panel/hooks/usePanel.js';

const LIMIT_LABELS = [
  ['disk_mb', 'Disk space', formatMb], ['bandwidth_mb', 'Bandwidth per month', formatMb], ['max_addons', 'Addon domains'], ['max_subdomains', 'Subdomains'],
  ['max_parked', 'Parked domains'], ['max_email', 'Mailboxes'], ['max_sql', 'Databases'], ['max_ftp', 'FTP accounts'], ['max_email_per_hour', 'Outgoing mail per hour'], ['quota_inodes', 'Files (inodes)'],
];

// Plan limits as the server enforces them (assertLimit): null is unlimited, 0 is
// a closed door, any other value is the cap.
export function limitText(value, format) {
  if (value == null) return 'Unlimited';
  if (value === 0) return 'Not included';
  return format ? format(value) : String(value);
}

// The plan's feature switches, named after the panel functions they gate; keys
// without a function (cPanel compatibility flags) are listed by key.
export function featureRows(features) {
  const named = new Map();
  for (const fn of PANEL_FUNCTIONS) if (fn.feature && !named.has(fn.feature)) named.set(fn.feature, fn.category === fn.label ? fn.label : `${fn.category} › ${fn.label}`);
  const keys = new Set([...named.keys(), ...Object.keys(features || {})]);
  return [...keys].sort().map((key) => ({ key, label: named.get(key) || key, enabled: featureEnabled(features, key) }));
}

export default function AccountDetails({ fn }) {
  const { me } = usePanelMe();
  const { t } = useT();
  const a = me?.account;
  const limits = a?.limits || {};
  return (
    <PanelPage fn={fn} actions={!me?.actingAs && (
      <>
        <Link className="btn" to={PANEL_PATHS.password}><KeyRound size={16} /> {t('panel.shell.change_password', 'Change password')}</Link>
        <Link className="btn" to={PANEL_PATHS.twoFactor}><ShieldCheck size={16} /> {t('panel.security/two-factor.label', 'Two-factor authentication')}</Link>
      </>
    )}>
      {!me && <Loading />}
      {a && (
        <div className="grid-2">
          <Card title={t('panel.account.title', 'Account')}>
            <KeyValue items={[
              [t('panel.account.username', 'Username'), a.username],
              [t('panel.account.main_domain', 'Main domain'), a.domain],
              [t('panel.account.ip', 'IP address'), a.ip],
              [t('panel.account.package', 'Plan'), a.package],
              [t('panel.account.contact_email', 'Contact email'), a.contactEmail],
              [t('panel.account.home', 'Home directory'), a.homeDir && <code>{a.homeDir}</code>],
              [t('panel.account.shell', 'Shell access'), a.shell && !/nologin|false$/.test(a.shell) ? <StatusPill status="enabled" /> : <StatusPill status="disabled" />],
              [t('panel.account.server', 'Server'), me.hostname],
              [t('panel.account.created', 'Created'), a.createdAt && formatDate(a.createdAt)],
              [t('panel.account.status', 'Status'), <StatusPill key="s" status={a.suspended ? 'suspended' : 'active'} />],
              a.demoMode && [t('panel.shell.demo_title', 'Demo mode'), <StatusPill key="d" status="warning">read-only</StatusPill>],
            ]} />
          </Card>
          <Card title={t('panel.account.limits', 'Plan limits')} subtitle={t('panel.account.limits_help', 'What this plan allows on the account.')}>
            <KeyValue items={LIMIT_LABELS.filter(([key]) => key in limits).map(([key, label, format]) => [t(`panel.account.limit.${key}`, label), limitText(limits[key], format)])} />
          </Card>
          <Card title={t('panel.account.features', 'Included features')} padded={false}>
            <div className="table-wrap">
              <table>
                <thead><tr><th>{t('panel.account.feature', 'Feature')}</th><th className="align-right">{t('panel.account.status', 'Status')}</th></tr></thead>
                <tbody>
                  {featureRows(a.features).map((f) => (
                    <tr key={f.key}><td>{f.label}<div className="muted" style={{ fontSize: 12 }}><code>{f.key}</code></div></td><td className="align-right"><StatusPill status={f.enabled ? 'enabled' : 'disabled'} /></td></tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
          <Card title={t('panel.account.login', 'Sign-in')}>
            <KeyValue items={[
              [t('panel.account.login_name', 'Login'), me.user?.username],
              [t('panel.account.email', 'Email'), me.user?.email],
              [t('panel.security/two-factor.label', 'Two-factor authentication'), <StatusPill key="t" status={me.user?.totpEnabled ? 'enabled' : 'disabled'} />],
              me.policy?.require2fa && [t('panel.account.required_2fa', 'Two-factor required'), <StatusPill key="r" status="warning">required</StatusPill>],
              me.policy && !me.actingAs && [t('panel.account.password_synced', 'Password in sync with the server'), me.policy.passwordSynced ? <StatusPill key="p" status="ok" /> : <StatusPill key="p" status="warning">not yet</StatusPill>],
            ]} />
          </Card>
        </div>
      )}
    </PanelPage>
  );
}
