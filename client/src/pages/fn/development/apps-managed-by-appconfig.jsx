import { useState } from 'react';
import { AppWindow, Plus, Upload } from 'lucide-react';
import { api } from '../../../api/client.js';
import { useApi } from '../../../hooks/useApi.js';
import { PageHeader, Card, StatusPill, Loading } from '../../../components/Common.jsx';
import { Field, TextInput, Textarea, Select, Toggle, Button, ErrorBanner } from '../../../components/Form.jsx';
import { Modal, useConfirm } from '../../../components/Modal.jsx';
import { useToast } from '../../../components/Toast.jsx';
import { RequestError, downloadText } from '../../development/Shared.jsx';

const EMPTY = { name: '', displayName: '', url: '', entryUrl: '', service: 'whm', description: '', icon: '', acls: ['all'], features: [], display: true, enabled: true, customAcl: '' };
const SERVICES = [{ value: 'whm', label: 'WHM (administrators and resellers)' }, { value: 'cpanel', label: 'cPanel (account users)' }, { value: 'webmail', label: 'Webmail' }];

export default function AppsManagedByAppConfig({ fn }) {
  const toast = useToast();
  const confirm = useConfirm();
  const apps = useApi('/development/appconfig');
  const acls = useApi('/development/appconfig/acls');
  const launch = useApi('/development/appconfig/launch');
  const [editor, setEditor] = useState(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(null);
  const [importText, setImportText] = useState(null);

  const openEditor = (a) => setEditor(a ? { ...EMPTY, ...a, entryUrl: a.entryUrl || '', description: a.description || '', icon: a.icon || '', id: a.id } : { ...EMPTY });
  const save = async () => {
    setSaving(true); setSaveError(null);
    try {
      const body = { name: editor.name.trim(), displayName: editor.displayName.trim() || undefined, url: editor.url.trim(), entryUrl: editor.entryUrl.trim() || null, service: editor.service, description: editor.description.trim() || null, icon: editor.icon.trim() || null, acls: editor.acls, features: editor.features, display: editor.display, enabled: editor.enabled };
      if (editor.id) await api.put(`/development/appconfig/${editor.id}`, body); else await api.post('/development/appconfig', body);
      toast.success(`${body.displayName || body.name} ${editor.id ? 'updated' : 'registered'}`); setEditor(null); apps.refetch(); launch.refetch();
    } catch (err) { setSaveError(err); } finally { setSaving(false); }
  };
  const remove = async (a) => {
    if (!(await confirm({ title: `Unregister ${a.displayName}?`, message: 'The entry disappears from every menu. The application itself is not touched.', confirmLabel: 'Unregister', danger: true }))) return;
    try { await api.delete(`/development/appconfig/${a.id}`); toast.success('App unregistered'); apps.refetch(); launch.refetch(); } catch (err) { toast.error(err); }
  };
  const toggleEnabled = async (a) => { try { await api.put(`/development/appconfig/${a.id}`, { enabled: !a.enabled }); apps.refetch(); launch.refetch(); } catch (err) { toast.error(err); } };
  const exportConf = async (a) => { try { const { data } = await api.get(`/development/appconfig/${a.id}/export`); downloadText(data.filename, data.content); } catch (err) { toast.error(err); } };
  const doImport = async () => {
    try {
      const { data } = await api.post('/development/appconfig/parse', { text: importText });
      if (!data.name || !data.url) return toast.error('The file needs at least name= and url=');
      setImportText(null);
      setEditor({ ...EMPTY, name: data.name, displayName: data.displayName || '', url: data.url, entryUrl: data.entryUrl || '', service: ['whm', 'cpanel', 'webmail'].includes(data.service) ? data.service : 'whm', description: data.description || '', icon: data.icon || '', acls: data.acls.length ? data.acls : ['all'], features: data.features });
    } catch (err) { toast.error(err); }
  };
  const toggleAcl = (key) => setEditor((e) => ({ ...e, acls: e.acls.includes(key) ? e.acls.filter((a) => a !== key) : [...e.acls.filter((a) => (key === 'all' ? false : a !== 'all')), key] }));
  const addCustomAcl = () => { const v = editor.customAcl.trim().toLowerCase(); if (v && !editor.acls.includes(v)) setEditor({ ...editor, acls: [...editor.acls.filter((a) => a !== 'all'), v], customAcl: '' }); };

  return (
    <>
      <PageHeader fn={fn} actions={<><Button icon={Upload} onClick={() => setImportText('')}>Import .conf</Button><Button variant="primary" icon={Plus} onClick={() => openEditor(null)}>Register app</Button></>} />
      <RequestError error={apps.error} onRetry={apps.refetch} />
      <Card padded={false} title="Registered applications" subtitle="Third-party and custom apps that appear in WHM, cPanel or Webmail. ACLs decide which resellers see a WHM app; cPanel apps can be gated by feature-list keys.">
        {apps.loading && !apps.data && <Loading />}
        {apps.data && (
          <div className="table-wrap">
            <table>
              <thead><tr><th>App</th><th>Service</th><th>URL</th><th>Requires</th><th>Visible</th><th>State</th><th /></tr></thead>
              <tbody>
                {apps.data.length === 0 && <tr><td colSpan={7} className="table-state">No apps registered. Register a billing portal, monitoring dashboard or any internal tool to link it from the panel.</td></tr>}
                {apps.data.map((a) => (
                  <tr key={a.id}>
                    <td><strong>{a.displayName}</strong> <code className="small">{a.name}</code>{a.description && <div className="small muted">{a.description}</div>}</td>
                    <td><StatusPill status="info">{a.service}</StatusPill></td>
                    <td className="small"><code>{a.url}</code></td>
                    <td className="small">{a.acls.map((x) => <code key={x} style={{ marginRight: 4 }}>{x}</code>)}{a.features.length > 0 && <div className="muted">features: {a.features.join(', ')}</div>}</td>
                    <td>{a.display ? 'in menus' : <span className="muted">hidden</span>}</td>
                    <td><StatusPill status={a.enabled ? 'enabled' : 'disabled'} /></td>
                    <td className="actions-col">
                      <div className="row-actions">
                        <Button size="sm" onClick={() => openEditor(a)}>Edit</Button>
                        <Button size="sm" onClick={() => toggleEnabled(a)}>{a.enabled ? 'Disable' : 'Enable'}</Button>
                        <Button size="sm" onClick={() => exportConf(a)}>Export</Button>
                        <Button size="sm" variant="danger-ghost" onClick={() => remove(a)}>Unregister</Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      <Card title="Launchable by you" subtitle="What GET /api/development/appconfig/launch returns for the current session: enabled, displayed apps whose ACLs you hold.">
        {launch.data && (launch.data.length === 0 ? <p className="muted">Nothing to launch yet.</p> : (
          <div className="tool-grid">
            {launch.data.map((a) => (
              <div key={a.id} className="tool-card">
                <a className="tool-link" href={a.entryUrl || a.url} target={/^https?:/.test(a.entryUrl || a.url) ? '_blank' : undefined} rel="noreferrer"><strong><AppWindow size={14} /> {a.displayName}</strong><small>{a.service} · {a.url}</small></a>
              </div>
            ))}
          </div>
        ))}
      </Card>

      <Modal open={Boolean(editor)} title={editor?.id ? `Edit ${editor.displayName || editor.name}` : 'Register application'} onClose={() => setEditor(null)} size="lg"
        footer={<><Button onClick={() => setEditor(null)}>Cancel</Button><Button variant="primary" loading={saving} disabled={!editor?.name.trim() || !editor?.url.trim()} onClick={save}>{editor?.id ? 'Save' : 'Register'}</Button></>}>
        {editor && (
          <>
            <div className="form-grid">
              <Field label="Identifier" required help="Lowercase, e.g. billing_portal"><TextInput value={editor.name} onChange={(v) => setEditor({ ...editor, name: v })} disabled={Boolean(editor.id)} /></Field>
              <Field label="Display name"><TextInput value={editor.displayName} onChange={(v) => setEditor({ ...editor, displayName: v })} placeholder={editor.name} /></Field>
              <Field label="URL" required help="https://… or an absolute path served by this panel"><TextInput value={editor.url} onChange={(v) => setEditor({ ...editor, url: v })} placeholder="https://billing.example.com/admin" /></Field>
              <Field label="Entry URL" help="Optional alternative link used by the launcher"><TextInput value={editor.entryUrl} onChange={(v) => setEditor({ ...editor, entryUrl: v })} /></Field>
              <Field label="Service"><Select value={editor.service} onChange={(v) => setEditor({ ...editor, service: v })} options={SERVICES} /></Field>
              <Field label="Icon" help="lucide icon name, e.g. credit-card"><TextInput value={editor.icon} onChange={(v) => setEditor({ ...editor, icon: v })} /></Field>
            </div>
            <Field label="Description"><TextInput value={editor.description} onChange={(v) => setEditor({ ...editor, description: v })} /></Field>
            <Field label="Required ACLs" help='"all" makes the app visible to every reseller; otherwise a reseller needs every listed ACL. Root always sees everything.'>
              <div className="form-grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(190px, 1fr))' }}>
                {[...new Set([...(acls.data || []), ...editor.acls])].map((key) => <label key={key} className="radio"><input type="checkbox" checked={editor.acls.includes(key)} onChange={() => toggleAcl(key)} /> <span><code>{key}</code></span></label>)}
              </div>
              <div className="input-group" style={{ marginTop: 8, maxWidth: 360 }}><input className="input" placeholder="custom-acl-key" value={editor.customAcl} onChange={(e) => setEditor({ ...editor, customAcl: e.target.value })} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addCustomAcl(); } }} /><Button onClick={addCustomAcl}>Add</Button></div>
            </Field>
            {editor.service !== 'whm' && <Field label="Required feature-list keys" help="Space or comma separated, e.g. ssl filemanager"><TextInput value={editor.features.join(' ')} onChange={(v) => setEditor({ ...editor, features: v.split(/[\s,]+/).filter(Boolean) })} /></Field>}
            <Toggle checked={editor.display} onChange={(v) => setEditor({ ...editor, display: v })} label="Show in menus" description="Hidden apps stay registered for API use only." />
            <Toggle checked={editor.enabled} onChange={(v) => setEditor({ ...editor, enabled: v })} label="Enabled" />
            <ErrorBanner error={saveError} />
          </>
        )}
      </Modal>

      <Modal open={importText !== null} title="Import an AppConfig file" onClose={() => setImportText(null)} size="lg" footer={<><Button onClick={() => setImportText(null)}>Cancel</Button><Button variant="primary" disabled={!importText?.trim()} onClick={doImport}>Parse and review</Button></>}>
        <p className="small muted">Paste a cPanel-style <code>/var/cpanel/apps/&lt;name&gt;.conf</code>: <code>name=</code>, <code>service=</code>, <code>url=</code>, <code>displayname=</code>, <code>acls=</code>, <code>features=</code>. You review the result before it is saved.</p>
        <Textarea mono rows={10} value={importText || ''} onChange={setImportText} placeholder={'name=billing\nservice=whm\nurl=/cgi/billing/index.cgi\ndisplayname=Billing Portal\nacls=list-accts,create-acct'} />
      </Modal>
    </>
  );
}
