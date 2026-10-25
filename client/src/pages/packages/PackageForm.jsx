import { useApi } from '../../hooks/useApi.js';
import { Card } from '../../components/Common.jsx';
import { Field, TextInput, NumberInput, Select, Toggle, ErrorBanner } from '../../components/Form.jsx';

export const EMPTY_PACKAGE = { name: '', disk_mb: 10240, bandwidth_mb: 102400, max_domains: 1, max_subdomains: 10, max_addons: 0, max_parked: 0, max_db: 10, max_email: 50, max_ftp: 10, max_email_per_hour: null, quota_inodes: null, php_version: 'ea-php83', feature_list: 'default', has_shell: false, has_dedicated_ip: false, cgi: true, digest_auth: false, theme: 'jupiter' };

export function packageToForm(pkg) {
  return { ...EMPTY_PACKAGE, ...Object.fromEntries(Object.keys(EMPTY_PACKAGE).map((k) => [k, pkg[k] ?? (k === 'feature_list' ? 'default' : EMPTY_PACKAGE[k])])), name: pkg.name };
}

const LIMITS = [
  ['disk_mb', 'Disk quota (MB)'], ['bandwidth_mb', 'Monthly bandwidth (MB)'], ['max_ftp', 'Max FTP accounts'], ['max_email', 'Max email accounts'],
  ['max_email_per_hour', 'Max hourly emails per domain'], ['max_db', 'Max databases'], ['max_domains', 'Max domains'], ['max_subdomains', 'Max subdomains'],
  ['max_parked', 'Max parked domains'], ['max_addons', 'Max addon domains'], ['quota_inodes', 'Inode quota'],
];

export function PackageForm({ form, setForm, error, nameEditable = true }) {
  const { data: featureLists } = useApi('/packages/feature-lists');
  const set = (k) => (v) => setForm((f) => ({ ...f, [k]: v }));
  return (
    <>
      <Card title="Package">
        <ErrorBanner error={error && !error.fields ? error : null} />
        <Field label="Package name" required error={error?.fields?.name || error?.fields?.newName} help="Letters, digits, spaces, _ . -">
          <TextInput value={form.name} onChange={set('name')} disabled={!nameEditable} />
        </Field>
      </Card>
      <Card title="Resources" subtitle="Leave a field blank for unlimited.">
        <div className="form-grid">
          {LIMITS.map(([key, label]) => (
            <Field key={key} label={label} error={error?.fields?.[key]}><NumberInput value={form[key]} onChange={set(key)} min={0} placeholder="Unlimited" /></Field>
          ))}
        </div>
      </Card>
      <Card title="Settings">
        <div className="form-grid">
          <Field label="Feature list" error={error?.fields?.feature_list}><Select value={form.feature_list} onChange={set('feature_list')} options={(featureLists || []).map((f) => ({ value: f.name, label: f.name }))} /></Field>
          <Field label="PHP version" error={error?.fields?.php_version}><TextInput value={form.php_version || ''} onChange={(v) => set('php_version')(v || null)} placeholder="ea-php83" /></Field>
          <Field label="cPanel theme" error={error?.fields?.theme}><Select value={form.theme} onChange={set('theme')} options={['jupiter', 'paper_lantern']} /></Field>
        </div>
        <Field inline><Toggle checked={form.has_shell} onChange={set('has_shell')} label="Shell access" description="Accounts get an interactive shell" /></Field>
        <Field inline><Toggle checked={form.has_dedicated_ip} onChange={set('has_dedicated_ip')} label="Dedicated IP" /></Field>
        <Field inline><Toggle checked={form.cgi} onChange={set('cgi')} label="CGI access" /></Field>
        <Field inline><Toggle checked={form.digest_auth} onChange={set('digest_auth')} label="Digest authentication at account creation" /></Field>
      </Card>
    </>
  );
}

export function formToBody(form, { rename = false, original } = {}) {
  const body = { ...form };
  if (rename) { if (form.name !== original) body.newName = form.name; delete body.name; }
  for (const [k, v] of Object.entries(body)) if (v === '' ) body[k] = null;
  return body;
}
