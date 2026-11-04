import { useEffect, useMemo, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { Image as ImageIcon } from 'lucide-react';
import { api, queryString } from '../../../api/client.js';
import { useApi } from '../../../hooks/useApi.js';
import { useAuth } from '../../../auth/AuthContext.jsx';
import { PageHeader, Card, Loading, KeyValue, StatusPill, formatBytes, formatDate } from '../../../components/Common.jsx';
import { Field, TextInput, NumberInput, Toggle, Textarea, Button, FormActions, ErrorBanner } from '../../../components/Form.jsx';
import { DataTable, useTableState } from '../../../components/DataTable.jsx';
import { useToast } from '../../../components/Toast.jsx';
import { useConfirm } from '../../../components/Modal.jsx';
import { Tabs } from '../../security/Shared.jsx';
import { notifyBrandingChanged } from '../../cpanel/branding.js';

export const TABS = [{ value: 'branding', label: 'Branding' }, { value: 'account-panel', label: 'Account panel' }];
export const ACCOUNT_PANEL_HASH = '#account-panel';
export const LOGIN_AS_TTL = { min: 5, max: 480 };

const TEXT_FIELDS = ['companyName', 'tagline', 'primaryColor', 'chromeColor', 'helpUrl', 'docsUrl', 'supportUrl', 'loginNotice', 'footerText'];
const KINDS = {
  logo: { label: 'Logo', help: 'PNG, JPEG, GIF, WebP or SVG up to 512 KB. Shown in the top bar and on the login page.', accept: '.png,.jpg,.jpeg,.gif,.webp,.svg,image/*' },
  favicon: { label: 'Favicon', help: 'ICO, PNG or SVG up to 128 KB.', accept: '.ico,.png,.svg,image/x-icon,image/png,image/svg+xml' },
};

// A native colour picker only accepts #rrggbb, so the theme's accent is read
// from the token when the field is empty.
function themeToken(name) {
  try {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return /^#[0-9a-f]{6}$/i.test(v) ? v : '';
  } catch { return ''; }
}

function ColorField({ label, value, onChange, help, token }) {
  const valid = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(value || '');
  const fallback = useMemo(() => themeToken(token), [token]);
  return (
    <Field label={label} help={help}>
      <div className="input-group">
        <input type="color" className="input" aria-label={`${label} picker`} value={valid && value.length === 7 ? value : fallback} onChange={(e) => onChange(e.target.value)} style={{ width: 48, flex: 'none', padding: 4 }} />
        <TextInput value={value} onChange={onChange} placeholder="#rrggbb (empty = theme default)" className="input mono" />
        {value && <Button size="sm" onClick={() => onChange('')}>Clear</Button>}
      </div>
    </Field>
  );
}

function ImageCard({ kind, descriptor, onChanged }) {
  const toast = useToast();
  const confirm = useConfirm();
  const [file, setFile] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const spec = KINDS[kind];
  const upload = async () => {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      await api.postRaw(`/cpanel/branding/${kind}`, file, file.type || 'application/octet-stream');
      toast.success(`${spec.label} updated`);
      setFile(null);
      onChanged();
    } catch (err) { setError(err); } finally { setBusy(false); }
  };
  const remove = async () => {
    if (!(await confirm({ title: `Remove the ${spec.label.toLowerCase()}?`, message: 'The default Keel mark is shown until a new image is uploaded.', confirmLabel: 'Remove', danger: true }))) return;
    setBusy(true);
    try { await api.delete(`/cpanel/branding/${kind}`); toast.success(`${spec.label} removed`); onChanged(); } catch (err) { toast.error(err); } finally { setBusy(false); }
  };
  return (
    <Card title={spec.label} subtitle={spec.help}>
      <div className="form-grid">
        <div>
          {descriptor ? (
            <>
              <div className="stat" style={{ display: 'inline-block', marginBottom: 12 }}>
                <img src={descriptor.url} alt={`Current ${spec.label.toLowerCase()}`} style={{ maxHeight: kind === 'logo' ? 64 : 32, maxWidth: 320, display: 'block' }} />
              </div>
              <KeyValue items={[['Type', descriptor.mime], ['Size', formatBytes(descriptor.size)], ['Updated', formatDate(descriptor.updatedAt)]]} />
            </>
          ) : (
            <p className="muted" style={{ display: 'flex', alignItems: 'center', gap: 8 }}><ImageIcon size={16} /> No {spec.label.toLowerCase()} uploaded; the built-in Keel mark is used.</p>
          )}
        </div>
        <div>
          <Field label={`Upload a new ${spec.label.toLowerCase()}`} htmlFor={`${kind}-file`}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
              <input id={`${kind}-file`} type="file" accept={spec.accept} hidden onChange={(e) => setFile(e.target.files?.[0] || null)} />
              <label htmlFor={`${kind}-file`} className="btn">Choose file</label>
              <span className={file ? '' : 'muted'}>{file ? file.name : 'No file chosen'}</span>
            </div>
          </Field>
          <div className="action-row">
            <Button variant="primary" loading={busy} disabled={!file} onClick={upload}>Upload</Button>
            {descriptor && <Button variant="danger" disabled={busy} onClick={remove}>Remove</Button>}
          </div>
          <ErrorBanner error={error} />
        </div>
      </div>
    </Card>
  );
}

function BrandingTab() {
  const toast = useToast();
  const { data, loading, error, refetch } = useApi('/cpanel/branding');
  const [draft, setDraft] = useState({});
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(null);
  useEffect(() => { if (data) setDraft(Object.fromEntries(TEXT_FIELDS.map((k) => [k, data[k] ?? '']))); }, [data]);
  const dirty = useMemo(() => data && TEXT_FIELDS.some((k) => (draft[k] ?? '') !== (data[k] ?? '')), [draft, data]);
  const set = (k) => (v) => setDraft((d) => ({ ...d, [k]: v }));
  const changed = () => { refetch(); notifyBrandingChanged(); };

  const save = async () => {
    setSaving(true);
    setSaveError(null);
    try {
      const body = Object.fromEntries(TEXT_FIELDS.filter((k) => (draft[k] ?? '') !== (data[k] ?? '')).map((k) => [k, draft[k]]));
      await api.put('/cpanel/branding', body);
      toast.success('Branding saved');
      changed();
    } catch (err) { setSaveError(err); toast.error(err); } finally { setSaving(false); }
  };

  return (
    <>
      {loading && !data && <Loading />}
      <ErrorBanner error={error} onRetry={refetch} />
      {data && (
        <>
          <Card title="Company" subtitle="Shown in the top bar, the browser title and the login page">
            <div className="form-grid">
              <Field label="Company name" required><TextInput value={draft.companyName} onChange={set('companyName')} maxLength={80} /></Field>
              <Field label="Tagline" help="Shown under the company name next to the logo."><TextInput value={draft.tagline} onChange={set('tagline')} maxLength={120} /></Field>
              <Field label="Footer text" help="Shown in the footer of every page; empty keeps the default."><TextInput value={draft.footerText} onChange={set('footerText')} maxLength={200} /></Field>
            </div>
          </Card>
          <ImageCard kind="logo" descriptor={data.logo} onChanged={changed} />
          <ImageCard kind="favicon" descriptor={data.favicon} onChanged={changed} />
          <Card title="Colours" subtitle="Applied on top of the active theme; a theme that sets the same token wins (Themes › Theme Manager)">
            <div className="form-grid">
              <ColorField label="Primary colour" token="--primary" value={draft.primaryColor} onChange={set('primaryColor')} help="Buttons, links and the active sidebar item." />
              <ColorField label="Chrome colour" token="--chrome-active" value={draft.chromeColor} onChange={set('chromeColor')} help="Top bar and sidebar background." />
            </div>
            <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
              <span className="muted">Preview</span>
              <span className="btn btn-primary" style={draft.primaryColor ? { background: draft.primaryColor } : undefined}>Primary button</span>
              <span className="btn" style={{ background: draft.chromeColor || 'var(--chrome)', color: draft.chromeColor ? 'var(--primary-text)' : 'var(--chrome-text)', boxShadow: '0 0 0 1px var(--border) inset' }}>Chrome</span>
            </div>
          </Card>
          <Card title="Help and documentation links" subtitle="Linked from the top bar user menu and the login page when set">
            <div className="form-grid">
              <Field label="Help URL"><TextInput value={draft.helpUrl} onChange={set('helpUrl')} placeholder="https://help.example.com/" type="url" /></Field>
              <Field label="Documentation URL"><TextInput value={draft.docsUrl} onChange={set('docsUrl')} placeholder="https://docs.example.com/" type="url" /></Field>
              <Field label="Support URL"><TextInput value={draft.supportUrl} onChange={set('supportUrl')} placeholder="https://support.example.com/tickets" type="url" /></Field>
            </div>
          </Card>
          <Card title="Login page notice" subtitle="Plain text or simple Markdown shown above the login form, for example a legal or acceptable-use notice. Like the company name, logo and favicon it is served to anyone who opens the login page.">
            <Textarea value={draft.loginNotice} onChange={set('loginNotice')} rows={4} maxLength={2000} placeholder="Authorised administrators only. All activity is logged." />
          </Card>
          <div className="sticky-actions">
            <ErrorBanner error={saveError} />
            <FormActions>
              <Button variant="primary" loading={saving} disabled={!dirty} onClick={save}>Save</Button>
              <Button disabled={!dirty || saving} onClick={() => setDraft(Object.fromEntries(TEXT_FIELDS.map((k) => [k, data[k] ?? ''])))}>Reset</Button>
            </FormActions>
          </div>
        </>
      )}
    </>
  );
}

const PANEL_FIELDS = ['enabled', 'require2faForUsers', 'loginAsTtlMinutes', 'webmailUrl'];
const panelDraft = (d) => ({ enabled: d.enabled !== false, require2faForUsers: Boolean(d.require2faForUsers), loginAsTtlMinutes: d.loginAsTtlMinutes ?? 60, webmailUrl: d.webmailUrl ?? '' });

export function ttlError(v) {
  if (v === null || v === undefined || v === '') return 'Enter a value in minutes';
  if (!Number.isInteger(v) || v < LOGIN_AS_TTL.min || v > LOGIN_AS_TTL.max) return `Must be a whole number between ${LOGIN_AS_TTL.min} and ${LOGIN_AS_TTL.max}`;
  return null;
}

export function webmailUrlError(v) {
  if (!v) return null;
  return /^https?:\/\/\S+$/i.test(v) ? null : 'Must be an http(s) URL, or empty to auto-detect';
}

export function AccountPanelSettingsCard() {
  const toast = useToast();
  const { data, loading, error, refetch } = useApi('/panel/admin/settings');
  // The draft is derived from the loaded settings so the form renders on the
  // first pass; a refetch drops local edits.
  const [edits, setEdits] = useState(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(null);
  const base = useMemo(() => (data ? panelDraft(data) : null), [data]);
  useEffect(() => { setEdits(null); }, [data]);
  const draft = edits ?? base;
  const setDraft = (updater) => setEdits((e) => (typeof updater === 'function' ? updater(e ?? base) : updater));
  const dirty = Boolean(draft && base && PANEL_FIELDS.some((k) => draft[k] !== base[k]));
  const errors = draft ? { loginAsTtlMinutes: ttlError(draft.loginAsTtlMinutes), webmailUrl: webmailUrlError(draft.webmailUrl) } : {};
  const invalid = Object.values(errors).some(Boolean);
  const set = (k) => (v) => setDraft((d) => ({ ...d, [k]: v }));

  const save = async () => {
    setSaving(true);
    setSaveError(null);
    try {
      const body = Object.fromEntries(PANEL_FIELDS.filter((k) => draft[k] !== base[k]).map((k) => [k, draft[k]]));
      await api.put('/panel/admin/settings', body);
      toast.success('Account panel settings saved');
      refetch();
    } catch (err) { setSaveError(err); toast.error(err); } finally { setSaving(false); }
  };

  return (
    <Card title="Account panel" subtitle="How account holders sign in to their own panel and how long an administrator's “Log in as” session lasts">
      {loading && !data && <Loading />}
      <ErrorBanner error={error} onRetry={refetch} />
      {draft && (
        <>
          <div className="form-grid">
            <Field label="Availability">
              <Toggle checked={draft.enabled} onChange={set('enabled')} label="Account panel enabled" description="Off: every account panel request is refused and the sign-in page says the panel is switched off. Account logins are still created and kept in sync." />
            </Field>
            <Field label="Two-factor authentication">
              <Toggle checked={draft.require2faForUsers} onChange={set('require2faForUsers')} label="Require 2FA for account users" description="Account users must enrol an authenticator before using the panel and cannot disable it afterwards." />
            </Field>
            <Field label="Log in as window (minutes)" required error={errors.loginAsTtlMinutes} help={`How long a “Log in as” context lasts before it ends on its own (${LOGIN_AS_TTL.min}–${LOGIN_AS_TTL.max}).`}>
              <NumberInput value={draft.loginAsTtlMinutes} onChange={set('loginAsTtlMinutes')} min={LOGIN_AS_TTL.min} max={LOGIN_AS_TTL.max} step={1} nullable />
            </Field>
            <Field label="Webmail URL" error={errors.webmailUrl} help="Shown as the webmail link in the account panel. Empty means the webmail published below (or detected on this server).">
              <TextInput value={draft.webmailUrl} onChange={set('webmailUrl')} type="url" placeholder="https://webmail.example.com/" maxLength={2048} />
            </Field>
          </div>
          {data?.loginAsAcl && <p className="muted">Resellers need the <code>{data.loginAsAcl}</code> privilege (Resellers › Edit Reseller Nameservers and Privileges) before they can log in to an account panel; root always may.</p>}
          <ErrorBanner error={saveError} />
          <FormActions>
            <Button variant="primary" loading={saving} disabled={!dirty || invalid} onClick={save}>Save</Button>
            <Button disabled={!dirty || saving} onClick={() => setEdits(null)}>Reset</Button>
          </FormActions>
        </>
      )}
    </Card>
  );
}

// What the Publish webmail card says about GET /service-config/webmail.
export function webmailState(s) {
  if (!s) return null;
  if (!s.installed) return { status: 'not-installed', label: 'Not installed', detail: 'No webmail application was found. Install Roundcube from the distribution (Debian/Ubuntu: roundcube roundcube-core roundcube-mysql) and publish it here.' };
  if (!s.apache) return { status: 'warning', label: 'Apache missing', detail: 'Apache is not installed, so the webmail cannot be published under the server hostname.' };
  if (!s.fqdn) return { status: 'warning', label: 'Hostname not qualified', detail: `"${s.hostname || '(unset)'}" is not a fully-qualified hostname; set one in Basic Setup before publishing.` };
  if (!s.published) return { status: 'pending', label: 'Not published', detail: `${s.flavor}${s.version ? ` ${s.version}` : ''} is installed but no web alias serves it. Publish it to make https://${s.hostname}/webmail/ answer with the hostname certificate.` };
  if (!s.published.managed) return { status: 'warning', label: 'Published by the distribution', detail: `${s.published.file} serves it as ${s.published.alias}; publish it here to pin it to the hostname site (then disable the distribution fragment with a2disconf).` };
  if (s.site && (!s.site.exists || !s.site.enabled)) return { status: 'warning', label: 'Hostname site missing', detail: 'The drop-in exists but the hostname site is absent or disabled; apply the hostname site (Manage Service SSL Certificates).' };
  if (s.site && !s.site.ssl) return { status: 'warning', label: 'Published without HTTPS', detail: 'The hostname site has no service certificate yet; install one (AutoSSL for the hostname) and publish again.' };
  if (s.config && s.config.exists && !s.config.inSync) return { status: 'warning', label: 'Mail hosts out of date', detail: 'config.inc.php does not carry the current hostname or company name; publish again to rewrite the Keel block.' };
  return { status: 'active', label: 'Published', detail: null };
}

export function WebmailPublishCard() {
  const toast = useToast();
  const confirm = useConfirm();
  const { data, loading, error, refetch } = useApi('/service-config/webmail');
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState(null);
  const state = webmailState(data);
  const run = async (fn, done) => {
    setBusy(true);
    setActionError(null);
    try { const r = await fn(); toast.success(done(r.data)); refetch(); } catch (err) { setActionError(err); toast.error(err); } finally { setBusy(false); }
  };
  const publish = () => run(() => api.post('/service-config/webmail/publish', {}), (d) => `Webmail published at ${d.url}`);
  const unpublish = async () => {
    if (!(await confirm({ title: 'Unpublish webmail?', message: `${data?.url || 'The webmail URL'} stops answering and the Keel block is removed from config.inc.php; the application stays installed.`, confirmLabel: 'Unpublish', danger: true }))) return;
    return run(() => api.delete('/service-config/webmail'), () => 'Webmail unpublished');
  };
  const canPublish = Boolean(data?.installed && data?.apache && data?.fqdn);
  return (
    <Card title="Webmail" subtitle="Roundcube installed from the distribution, published as /webmail under the server hostname site with its certificate; the account panel links to it unless a Webmail URL is set above"
      actions={data && (
        <div className="action-row">
          {data.published?.managed && <Button variant="danger" disabled={busy} onClick={unpublish}>Unpublish</Button>}
          <Button variant="primary" loading={busy} disabled={!canPublish} onClick={publish}>{data.published?.managed ? 'Publish again' : 'Publish webmail'}</Button>
        </div>
      )}>
      {loading && !data && <Loading />}
      <ErrorBanner error={error} onRetry={refetch} />
      {data && state && (
        <>
          <KeyValue items={[
            ['Status', <StatusPill key="s" status={state.status}>{state.label}</StatusPill>],
            ['Application', data.installed ? `${data.flavor}${data.version ? ` ${data.version}` : ''} (${data.root || data.path})` : '—'],
            ['Address', data.url ? <a key="u" href={data.url} target="_blank" rel="noopener noreferrer">{data.url}</a> : '—'],
            data.published && ['Apache', <code key="f">{data.published.file}</code>],
            data.config && ['Mail hosts', data.config.exists ? (data.config.managed ? `${data.config.managed.imapHost} · ${data.config.managed.smtpHost} · "${data.config.managed.productName}"` : 'Distribution defaults (localhost:143, no TLS)') : 'config.inc.php missing'],
            data.lastApply && ['Last publish', `${formatDate(data.lastApply.at)}${data.lastApply.ok ? '' : ` — failed: ${data.lastApply.error}`}`],
          ]} />
          {state.detail && <p className="muted">{state.detail}</p>}
          {data.globalAlias && <p className="muted">The distribution also serves it as <code>{data.globalAlias.alias}</code> on every site (<code>{data.globalAlias.file}</code>); run <code>a2disconf</code> on that fragment so customer sites do not answer for it.</p>}
          {data.config?.ok === false && <p className="muted">PHP reports a syntax error in <code>{data.config.path}</code>; the webmail cannot start until it is fixed.</p>}
        </>
      )}
      <ErrorBanner error={actionError} />
    </Card>
  );
}

export function loginAsStatus(row) {
  if (row.ended_at) return { status: 'disabled', label: 'Ended' };
  if (row.active) return { status: 'active', label: 'Active' };
  return { status: 'warning', label: 'Expired' };
}

export function LoginAsHistoryCard() {
  const t = useTableState({ pageSize: 25, sort: 'started_at', dir: 'desc' });
  const { data, meta, loading, error } = useApi(`/panel/admin/login-as/history${queryString(t.state)}`);
  return (
    <Card title="Log in as history" subtitle="Every time an administrator opened an account's panel, with when it ended" padded={false}>
      <DataTable
        columns={[
          { key: 'started_at', label: 'When', sortable: true, width: 170, render: (r) => <span style={{ whiteSpace: 'nowrap' }}>{formatDate(r.started_at)}</span> },
          { key: 'actor', label: 'Admin', sortable: true, width: 140 },
          { key: 'account', label: 'Account', sortable: true, width: 140 },
          { key: 'ip', label: 'From', width: 130 },
          { key: 'ended_at', label: 'Ended', width: 170, render: (r) => <span style={{ whiteSpace: 'nowrap' }}>{r.ended_at ? formatDate(r.ended_at) : r.active ? `Expires ${formatDate(r.expires_at)}` : formatDate(r.expires_at)}</span> },
          { key: 'status', label: 'Status', width: 100, render: (r) => { const s = loginAsStatus(r); return <StatusPill status={s.status}>{s.label}</StatusPill>; } },
        ]}
        rows={data || []} loading={loading} error={error} rowKey={(r) => r.id}
        total={meta?.total} page={t.state.page} pageSize={t.state.pageSize} onPageChange={t.setPage}
        sort={t.state.sort} dir={t.state.dir} onSortChange={t.setSort}
        emptyText="Nobody has logged in to an account panel yet. Use Log in as from Account Information › List Accounts." dense
      />
    </Card>
  );
}

export function AccountPanelTab() {
  return (
    <>
      <AccountPanelSettingsCard />
      <WebmailPublishCard />
      <LoginAsHistoryCard />
    </>
  );
}

// The account panel settings are root-only (the API is requireRoot), so a
// reseller sees the branding form without tabs.
export default function Customization({ fn }) {
  const { user } = useAuth();
  const location = useLocation();
  const isRoot = user?.role === 'root';
  const [tab, setTab] = useState(location.hash === ACCOUNT_PANEL_HASH ? 'account-panel' : 'branding');
  useEffect(() => { if (location.hash === ACCOUNT_PANEL_HASH) setTab('account-panel'); }, [location.hash]);
  const current = isRoot ? tab : 'branding';
  return (
    <>
      <PageHeader fn={fn} />
      {isRoot && <Tabs tabs={TABS} value={current} onChange={setTab} />}
      {current === 'account-panel' ? <AccountPanelTab /> : <BrandingTab />}
    </>
  );
}
