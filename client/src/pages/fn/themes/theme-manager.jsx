import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Plus } from 'lucide-react';
import { api } from '../../../api/client.js';
import { useAuth } from '../../../auth/AuthContext.jsx';
import { useApi } from '../../../hooks/useApi.js';
import { PageHeader, Card, Loading, KeyValue, formatDate } from '../../../components/Common.jsx';
import { DataTable } from '../../../components/DataTable.jsx';
import { Field, TextInput, Select, Toggle, Button, FormActions, ErrorBanner } from '../../../components/Form.jsx';
import { Modal, useConfirm } from '../../../components/Modal.jsx';
import { useToast } from '../../../components/Toast.jsx';
import { notifyThemeChanged } from '../../../theme/applyTheme.js';
import { BRAND } from '../../../brand.js';
import { RequestError, Tabs, useThemes, ThemeSelect, ThemePills, ThemeSwatch, ThemeEditor, BASES, usePreview, PreviewButton } from '../../themes/Shared.jsx';

const TABS = [
  { value: 'themes', label: 'Themes' },
  { value: 'defaults', label: 'Defaults' },
  { value: 'packages', label: 'Package assignment' },
  { value: 'mine', label: 'My preference' },
];

export default function ThemeManager({ fn }) {
  const { user } = useAuth();
  const isRoot = user?.role === 'root';
  const [tab, setTab] = useState('themes');
  const state = useThemes();
  const [editing, setEditing] = useState(null);

  const toast = useToast();
  const openEditor = async (slug) => {
    try { setEditing((await api.get(`/themes/${slug}`)).data); } catch (err) { toast.error(err); setEditing(null); }
  };

  return (
    <>
      <PageHeader fn={fn} actions={isRoot && tab === 'themes' && <CreateButton state={state} onCreated={(t) => { state.refetch(); openEditor(t.slug); }} />} />
      <Tabs tabs={TABS.filter((t) => isRoot || t.value !== 'defaults')} value={tab} onChange={setTab} />
      <RequestError error={state.error} onRetry={state.refetch} />
      {tab === 'themes' && (editing
        ? (
          <Card title={`Edit "${editing.name}"`} subtitle={<span><code>{editing.slug}</code>{editing.copiedFrom && <> · copied from <code>{editing.copiedFrom}</code></>} · updated {formatDate(editing.updatedAt)}</span>}>
            <ThemeEditor theme={editing} catalog={state.catalog} readOnly={!isRoot} onSaved={(t) => { setEditing(t); state.refetch(); }} onClose={() => { setEditing(null); state.refetch(); }} />
          </Card>
        )
        : <ThemesTab state={state} isRoot={isRoot} onEdit={openEditor} />)}
      {tab === 'defaults' && isRoot && <DefaultsTab state={state} />}
      {tab === 'packages' && <PackagesTab state={state} />}
      {tab === 'mine' && <PreferenceTab state={state} />}
    </>
  );
}

function ThemesTab({ state, isRoot, onEdit }) {
  const toast = useToast();
  const confirm = useConfirm();
  const { themes, loading, refetch } = state;

  const setDefault = async (t, key) => {
    try {
      await api.put('/themes/config', { [key]: t.slug });
      toast.success(`"${t.name}" is now the ${key === 'default' ? 'panel' : 'account'} default`);
      notifyThemeChanged();
      refetch();
    } catch (err) { toast.error(err); }
  };
  const remove = async (t) => {
    const ok = await confirm({ title: `Delete theme "${t.name}"?`, message: `The theme and its CSS override are removed. ${t.usage.users} user preference(s) pointing at it will fall back to the default. ${t.usage.accounts} existing account(s) recorded "${t.slug}" in their plan snapshot and keep that slug until their package is changed.`, confirmLabel: 'Delete', danger: true, typeToConfirm: t.slug });
    if (!ok) return;
    try { await api.delete(`/themes/${t.slug}`); toast.success(`Theme "${t.name}" deleted`); notifyThemeChanged(); refetch(); } catch (err) { toast.error(err); }
  };
  const toggle = async (t) => {
    try { await api.put(`/themes/${t.slug}`, { enabled: !t.enabled }); toast.success(`"${t.name}" ${t.enabled ? 'disabled' : 'enabled'}`); notifyThemeChanged(); refetch(); } catch (err) { toast.error(err); }
  };

  const columns = [
    { key: 'name', label: 'Theme', render: (t) => <div><strong>{t.name}</strong> <code>{t.slug}</code><div style={{ marginTop: 4 }}><ThemePills theme={t} /></div></div> },
    { key: 'palette', label: 'Palette', render: (t) => <ThemeSwatch theme={t} /> },
    { key: 'base', label: 'Base', render: (t) => BASES.find((b) => b.value === t.base)?.label || t.base },
    { key: 'tokens', label: 'Overrides', render: (t) => <span>{Object.keys(t.variables).length} token(s){t.hasCss && <span className="muted"> · {Math.ceil(t.cssBytes / 1024)} KB CSS</span>}</span> },
    { key: 'usage', label: 'In use by', render: (t) => <span className="small muted">{t.usage.packages} package(s) · {t.usage.accounts} account(s) · {t.usage.users} user(s)</span> },
  ];
  return (
    <Card title="Installed themes" subtitle="Built-in themes sit on the panel's own token layer; copy one to customise colours, shape and CSS." padded={false}>
      <DataTable columns={columns} rows={themes} loading={loading} rowKey={(t) => t.slug} emptyText="No themes"
        rowActions={(t) => [
          !t.builtin && isRoot && { label: 'Edit', primary: true, onClick: () => onEdit(t.slug) },
          (t.builtin || !isRoot) && { label: 'View', primary: true, onClick: () => onEdit(t.slug) },
          isRoot && { label: 'Copy', onClick: () => document.dispatchEvent(new CustomEvent('whm:theme-copy', { detail: t.slug })) },
          isRoot && !t.isDefault && t.enabled && { label: 'Set as panel default', onClick: () => setDefault(t, 'default') },
          isRoot && !t.isAccountDefault && t.enabled && { label: 'Set as account default', onClick: () => setDefault(t, 'accountDefault') },
          isRoot && !t.builtin && !t.isDefault && !t.isAccountDefault && { label: t.enabled ? 'Disable' : 'Enable', onClick: () => toggle(t) },
          isRoot && !t.builtin && { label: 'Delete', danger: true, onClick: () => remove(t) },
        ]} />
    </Card>
  );
}

function CreateButton({ state, onCreated }) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ slug: '', name: '', copyFrom: 'jupiter', base: 'light' });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    const onCopy = (e) => { setForm((f) => ({ ...f, copyFrom: e.detail, slug: `${e.detail}-copy`.slice(0, 32) })); setOpen(true); };
    document.addEventListener('whm:theme-copy', onCopy);
    return () => document.removeEventListener('whm:theme-copy', onCopy);
  }, []);

  const create = async () => {
    setSaving(true); setError(null);
    try {
      const body = { slug: form.slug.trim().toLowerCase(), name: form.name.trim() || undefined, copyFrom: form.copyFrom || undefined, base: form.copyFrom ? undefined : form.base };
      const { data } = await api.post('/themes', body);
      toast.success(`Theme "${data.name}" created`);
      setOpen(false);
      setForm({ slug: '', name: '', copyFrom: 'jupiter', base: 'light' });
      onCreated(data);
    } catch (err) { setError(err); } finally { setSaving(false); }
  };

  return (
    <>
      <Button variant="primary" icon={Plus} onClick={() => setOpen(true)}>New theme</Button>
      <Modal open={open} title="Create a theme" onClose={() => setOpen(false)} footer={<><Button onClick={() => setOpen(false)}>Cancel</Button><Button variant="primary" loading={saving} onClick={create}>Create</Button></>}>
        <Field label="Slug" required help='Lowercase letters, digits, "-" and "_" (max 32). Packages reference the theme by slug.' error={error?.fields?.slug}><TextInput value={form.slug} onChange={(v) => setForm({ ...form, slug: v })} placeholder="acme-hosting" /></Field>
        <Field label="Display name" error={error?.fields?.name}><TextInput value={form.name} onChange={(v) => setForm({ ...form, name: v })} placeholder="Defaults to the source name" /></Field>
        <Field label="Start from" help="Copies the base scheme, tokens and CSS override of an existing theme." error={error?.fields?.copyFrom}>
          <ThemeSelect value={form.copyFrom} onChange={(v) => setForm({ ...form, copyFrom: v })} themes={state.themes} placeholder="A blank theme" />
        </Field>
        {!form.copyFrom && <Field label="Base scheme"><Select value={form.base} onChange={(v) => setForm({ ...form, base: v })} options={BASES} /></Field>}
        <ErrorBanner error={error} />
      </Modal>
    </>
  );
}

function DefaultsTab({ state }) {
  const toast = useToast();
  const { themes, defaultSlug, accountDefault, allowUserOverride, loading, refetch } = state;
  const [draft, setDraft] = useState(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  useEffect(() => { if (themes.length && !draft) setDraft({ default: defaultSlug, accountDefault, allowUserOverride }); }, [themes, defaultSlug, accountDefault, allowUserOverride, draft]);

  const save = async () => {
    setSaving(true); setError(null);
    try {
      await api.put('/themes/config', draft);
      toast.success('Theme defaults saved');
      notifyThemeChanged();
      await refetch();
      setDraft(null);
    } catch (err) { setError(err); toast.error(err); } finally { setSaving(false); }
  };

  if (loading && !draft) return <Loading />;
  if (!draft) return null;
  const enabledOnly = (t) => t.enabled;
  return (
    <Card title="Default themes" subtitle="The panel default is what every signed-in user sees unless they pick their own. The account default replaces a package's theme in new accounts' plan snapshots when that theme is disabled or missing.">
      <div className="form-grid">
        <Field label="Panel default" required error={error?.fields?.default}><ThemeSelect value={draft.default} onChange={(v) => setDraft({ ...draft, default: v })} themes={themes} filter={enabledOnly} placeholder={null} /></Field>
        <Field label="Default for new accounts" required error={error?.fields?.accountDefault}><ThemeSelect value={draft.accountDefault} onChange={(v) => setDraft({ ...draft, accountDefault: v })} themes={themes} filter={enabledOnly} placeholder={null} /></Field>
      </div>
      <Field label="Per-user overrides"><Toggle checked={draft.allowUserOverride} onChange={(v) => setDraft({ ...draft, allowUserOverride: v })} label={draft.allowUserOverride ? 'Resellers and users may choose their own theme' : 'Everyone except root follows the panel default'} /></Field>
      <p className="muted">Logos and company branding are configured per account under <Link to="/cpanel/customization">{BRAND.product} › Customization</Link>.</p>
      <ErrorBanner error={error} />
      <FormActions>
        <Button variant="primary" loading={saving} onClick={save}>Save</Button>
        <Button onClick={() => setDraft(null)}>Reset</Button>
      </FormActions>
    </Card>
  );
}

function PackagesTab({ state }) {
  const toast = useToast();
  const { themes } = state;
  const { data, loading, error, refetch } = useApi('/themes/packages');
  const [busy, setBusy] = useState(null);
  const assign = async (pkg, slug) => {
    if (!slug || slug === pkg.theme) return;
    setBusy(pkg.name);
    try { await api.put(`/themes/packages/${encodeURIComponent(pkg.name)}`, { theme: slug }); toast.success(`Package "${pkg.name}" now uses "${slug}"`); refetch(); state.refetch(); } catch (err) { toast.error(err); } finally { setBusy(null); }
  };
  const fallbackPill = (p) => <span className="pill pill-warn" style={{ marginLeft: 6 }} title="The assigned theme is disabled; new accounts record the account default instead">falls back to {p.effective}</span>;
  const columns = [
    { key: 'name', label: 'Package', render: (p) => <strong>{p.name}</strong> },
    { key: 'accounts', label: 'Accounts', align: 'right' },
    { key: 'theme', label: 'Assigned theme', render: (p) => <span>{p.theme}{!p.themeKnown && <span className="pill pill-warn" style={{ marginLeft: 6 }}>unknown</span>}{p.themeKnown && p.effective !== p.theme && fallbackPill(p)}</span> },
    { key: 'change', label: 'Change', render: (p) => <ThemeSelect value={p.theme} onChange={(v) => assign(p, v)} themes={themes} filter={(t) => t.enabled || t.slug === p.theme} placeholder={null} disabled={busy === p.name || !p.owned} title={p.owned ? undefined : 'Only the owner of a package can change its theme'} style={{ maxWidth: 280 }} /> },
  ];
  return (
    <Card title="Theme per package" subtitle="New accounts created from a package record its theme in their plan snapshot. Packages whose theme is disabled or missing fall back to the account default. Resellers can only retheme packages they own." padded={false}>
      <RequestError error={error} onRetry={refetch} />
      <DataTable columns={columns} rows={data || []} loading={loading} rowKey={(p) => p.name} emptyText="No packages yet" />
    </Card>
  );
}

function PreferenceTab({ state }) {
  const toast = useToast();
  const { user } = useAuth();
  const preview = usePreview();
  const { themes, allowUserOverride, defaultSlug } = state;
  const active = useApi('/themes/active');
  const [saving, setSaving] = useState(false);
  const current = active.data;
  const choice = current?.preference || '';
  const locked = !allowUserOverride && user?.role !== 'root';

  const save = async (slug) => {
    setSaving(true);
    try {
      const { data } = await api.put('/themes/preference', { theme: slug || null });
      preview.stop();
      notifyThemeChanged();
      active.setData(data);
      toast.success(slug ? `You now see the "${data.name}" theme` : 'You follow the panel default again');
    } catch (err) { toast.error(err); } finally { setSaving(false); }
  };

  return (
    <Card title="Your theme" subtitle="Applies to your own sessions on every device; the panel default is used until you choose one.">
      {active.loading && !current && <Loading />}
      <RequestError error={active.error} onRetry={active.refetch} />
      {current && (
        <>
          <KeyValue items={[
            ['Currently applied', <span><strong>{current.name}</strong> <code>{current.slug}</code> <ThemeSwatch theme={current} size={14} /></span>],
            ['Source', current.source === 'user' ? 'your preference' : `panel default (${defaultSlug})${current.ignoredPreference ? ` — your stored choice "${current.ignoredPreference}" is not applied` : ''}`],
            ['Per-user overrides', allowUserOverride ? 'allowed' : 'disabled by the administrator (root is exempt)'],
          ]} />
          <Field label="Preferred theme" help={locked ? 'Overrides are disabled on this server.' : undefined}>
            <ThemeSelect value={choice} onChange={(v) => save(v)} themes={themes} filter={(t) => t.enabled} placeholder={`Panel default (${defaultSlug})`} disabled={saving || locked} style={{ maxWidth: 360 }} />
          </Field>
          <FormActions>
            {themes.filter((t) => t.enabled && t.slug !== current.slug).map((t) => (
              <Button key={t.slug} size="sm" onClick={() => preview.start({ base: t.base, scheme: t.scheme, variables: t.variables, css: '' })} title={t.hasCss ? 'Preview without the CSS override' : undefined}>Preview {t.name}</Button>
            ))}
            {preview.on && <PreviewButton preview={preview} theme={current} />}
          </FormActions>
        </>
      )}
    </Card>
  );
}
