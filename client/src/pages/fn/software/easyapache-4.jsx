import { useEffect, useState } from 'react';
import { api } from '../../../api/client.js';
import { useApi } from '../../../hooks/useApi.js';
import { PageHeader, Card, StatusPill, Loading, KeyValue } from '../../../components/Common.jsx';
import { Field, TextInput, Textarea, Toggle, Button, FormActions, ErrorBanner } from '../../../components/Form.jsx';
import { Modal, useConfirm } from '../../../components/Modal.jsx';
import { useToast } from '../../../components/Toast.jsx';
import { RequestError, Tabs, ManagerBadge, useJobRunner, JobPanel, JobHistory } from '../../software/Shared.jsx';

const EMPTY = { name: '', description: '', packages: { debian: [], rhel: [] } };

export default function EasyApache4({ fn }) {
  const toast = useToast();
  const confirm = useConfirm();
  const detect = useApi('/software/pkg/detect');
  const profiles = useApi('/software/ea4/profiles');
  const catalog = useApi('/software/ea4/catalog');
  const installed = useApi('/software/ea4/installed');
  const builds = useApi('/software/ea4/builds');
  const [selectedId, setSelectedId] = useState(null);
  const [diff, setDiff] = useState(null);
  const [diffError, setDiffError] = useState(null);
  const [removeExtras, setRemoveExtras] = useState(false);
  const [removeDependents, setRemoveDependents] = useState(false);
  const [editor, setEditor] = useState(null);
  const [family, setFamily] = useState('debian');
  const [custom, setCustom] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(null);
  const runner = useJobRunner({ onFinished: () => { profiles.refetch(); installed.refetch(); builds.refetch(); if (selectedId) loadDiff(selectedId); } });

  useEffect(() => { if (profiles.data?.family) setFamily(profiles.data.family); }, [profiles.data]);
  const hostFamily = profiles.data?.family || detect.data?.family || 'debian';

  const loadDiff = async (id) => {
    setSelectedId(id); setDiff(null); setDiffError(null); setRemoveDependents(false);
    try { const { data } = await api.get(`/software/ea4/profiles/${id}/diff`); setDiff(data); } catch (err) { setDiffError(err); }
  };
  const collateral = diff?.collateral || [];
  const removalBlocked = removeExtras && diff?.remove.length > 0 && (diff.simulationError || (collateral.length > 0 && !removeDependents));
  const build = async () => {
    const p = diff.profile;
    const removing = removeExtras && diff.remove.length > 0;
    const extra = removing && collateral.length ? ` The package manager also removes ${collateral.length} dependent package(s): ${collateral.map((c) => c.name).join(', ')}.` : '';
    if (!(await confirm({ title: `Provision profile "${p.name}"?`, message: `${diff.install.length} package(s) will be installed${removing ? ` and ${diff.remove.length} removed` : ''}.${extra} Apache and PHP-FPM may restart during the build.`, confirmLabel: 'Provision', danger: removing, typeToConfirm: removing && collateral.length ? p.name : undefined }))) return;
    runner.start(() => api.post(`/software/ea4/profiles/${p.id}/build`, { removeExtras, removeDependents: removeExtras && removeDependents }), `EasyApache build: ${p.name}`);
  };
  const openEditor = (profile, asCopy = false) => {
    setCustom('');
    if (!profile) return setEditor({ ...EMPTY, mode: 'create' });
    setEditor({ id: profile.id, name: asCopy ? `${profile.name} (custom)` : profile.name, description: profile.description || '', packages: { debian: [...profile.packages.debian], rhel: [...profile.packages.rhel] }, mode: asCopy ? 'copy' : 'edit' });
  };
  const saveProfile = async () => {
    setSaving(true); setSaveError(null);
    try {
      const body = { name: editor.name.trim(), description: editor.description || undefined, packages: editor.packages };
      if (editor.mode === 'create') await api.post('/software/ea4/profiles', body);
      else if (editor.mode === 'copy') { const { data } = await api.post(`/software/ea4/profiles/${editor.id}/copy`, { name: body.name }); await api.put(`/software/ea4/profiles/${data.id}`, { description: body.description, packages: body.packages }); }
      else await api.put(`/software/ea4/profiles/${editor.id}`, body);
      toast.success(`Profile "${body.name}" saved`);
      setEditor(null); profiles.refetch();
    } catch (err) { setSaveError(err); toast.error(err); } finally { setSaving(false); }
  };
  const removeProfile = async (p) => {
    if (!(await confirm({ title: `Delete profile "${p.name}"?`, message: 'Installed packages are not touched; only the saved package set is removed.', confirmLabel: 'Delete', danger: true }))) return;
    try { await api.delete(`/software/ea4/profiles/${p.id}`); toast.success('Profile deleted'); if (selectedId === p.id) { setSelectedId(null); setDiff(null); } profiles.refetch(); } catch (err) { toast.error(err); }
  };
  const togglePkg = (name) => setEditor((e) => { const list = e.packages[family]; return { ...e, packages: { ...e.packages, [family]: list.includes(name) ? list.filter((p) => p !== name) : [...list, name] } }; });
  const addCustom = (text) => { const names = text.split(/[\s,]+/).filter(Boolean); if (names.length) setEditor((e) => ({ ...e, packages: { ...e.packages, [family]: [...new Set([...e.packages[family], ...names])] } })); setCustom(''); };

  return (
    <>
      <PageHeader fn={fn} actions={<><ManagerBadge detect={detect.data} /> <Button variant="primary" onClick={() => openEditor(null)}>New profile</Button></>} />
      <RequestError error={profiles.error} onRetry={profiles.refetch} />
      {profiles.loading && !profiles.data && <Loading />}
      {profiles.data && (
        <Card title="Profiles" subtitle={`Package sets for the ${hostFamily === 'rhel' ? 'RHEL' : 'Debian'} family on this host. Stock profiles are read-only; copy one to customise.`} padded={false}>
          <div className="table-wrap">
            <table>
              <thead><tr><th>Profile</th><th>Description</th><th>Packages</th><th>State</th><th /></tr></thead>
              <tbody>
                {profiles.data.profiles.map((p) => (
                  <tr key={p.id} className={selectedId === p.id ? 'is-selected' : ''}>
                    <td><strong>{p.name}</strong>{p.stock && <StatusPill status="info">stock</StatusPill>}</td>
                    <td className="small">{p.description}</td>
                    <td>{(p.packages[hostFamily] || []).length}</td>
                    <td>{p.active && <StatusPill status="ok">currently provisioned</StatusPill>}</td>
                    <td className="actions-col">
                      <div className="row-actions">
                        <Button size="sm" variant={selectedId === p.id ? 'primary' : 'default'} onClick={() => loadDiff(p.id)}>Preview</Button>
                        <Button size="sm" onClick={() => openEditor(p, p.stock)}>{p.stock ? 'Customise' : 'Edit'}</Button>
                        {!p.stock && <Button size="sm" variant="danger-ghost" onClick={() => removeProfile(p)}>Delete</Button>}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
      {selectedId && (
        <Card title={diff ? `Provision "${diff.profile.name}"` : 'Preview'} subtitle="What changes on this host to match the profile.">
          <RequestError error={diffError} onRetry={() => loadDiff(selectedId)} />
          {!diff && !diffError && <Loading text="Comparing with installed packages…" />}
          {diff && (
            <>
              <KeyValue items={[
                ['To install', diff.install.length ? diff.install.map((p) => <code key={p} style={{ marginRight: 6 }}>{p}</code>) : 'nothing'],
                ['Already installed', `${diff.unchanged.length} of ${diff.total}`],
                ['Managed packages not in profile', diff.remove.length ? diff.remove.map((p) => <code key={p} style={{ marginRight: 6 }}>{p}</code>) : 'none'],
                diff.remove.length > 0 && ['Removed with them (dependents)', diff.simulationError ? <span key="e" className="muted">simulation failed: {diff.simulationError}</span> : collateral.length ? collateral.map((p) => <code key={p.name} style={{ marginRight: 6 }}>{p.name}</code>) : 'none (checked with the package manager)'],
              ]} />
              {diff.remove.length > 0 && <Toggle checked={removeExtras} onChange={setRemoveExtras} label={`Remove the ${diff.remove.length} package(s) other profiles manage but this one omits`} description="Only packages that appear in some profile are selected for removal, but apt/dnf also remove whatever depends on them. The removal is simulated first and refused if it would take anything else with it, unless you accept the dependents below." />}
              {removeExtras && diff.remove.length > 0 && collateral.length > 0 && (
                <div className="banner banner-warning">
                  <div>
                    <strong>Removing {diff.remove.join(', ')} also removes {collateral.map((p) => p.name).join(', ')}</strong>
                    <p>Keep those packages in the profile (Customise) or accept that they go too.</p>
                    <Toggle checked={removeDependents} onChange={setRemoveDependents} label={`Also remove the ${collateral.length} dependent package(s)`} />
                  </div>
                </div>
              )}
              {removeExtras && diff.remove.length > 0 && diff.simulationError && <div className="banner banner-error"><div><strong>The removal could not be simulated</strong><p>{diff.simulationError}. Nothing is removed until the package manager can say what the removal would take with it; retry the preview or provision without removing extras.</p></div></div>}
              <div className="action-row"><Button variant="primary" loading={runner.busy} disabled={removalBlocked || (!diff.install.length && !(removeExtras && diff.remove.length))} onClick={build}>{diff.install.length || (removeExtras && diff.remove.length) ? 'Provision' : 'Nothing to do'}</Button></div>
              <ErrorBanner error={runner.error} />
            </>
          )}
        </Card>
      )}
      <JobPanel runner={runner} title="Build log" />
      <Card title="Currently installed web stack" subtitle="Apache, PHP and module packages present on this host." actions={<Button size="sm" onClick={() => installed.refetch()}>Refresh</Button>}>
        <RequestError error={installed.error} onRetry={installed.refetch} />
        {installed.data && (installed.data.packages.length === 0 ? <p className="muted">No Apache or PHP packages are installed. Pick a profile above and provision it.</p> : (
          <div className="table-wrap" style={{ maxHeight: 320, overflow: 'auto' }}>
            <table><thead><tr><th>Package</th><th>Version</th><th>Summary</th></tr></thead>
              <tbody>{installed.data.packages.map((p) => <tr key={p.name}><td><code>{p.name}</code></td><td className="small">{p.version}</td><td className="small">{p.summary}</td></tr>)}</tbody></table>
          </div>
        ))}
      </Card>
      <Card title="Build history"><JobHistory jobs={builds.data} emptyText="No builds yet" onSelect={(id) => runner.setJobId(id)} /></Card>

      <Modal open={Boolean(editor)} title={editor?.mode === 'create' ? 'New profile' : editor?.mode === 'copy' ? `Customise ${editor.name}` : `Edit ${editor?.name}`} onClose={() => setEditor(null)} size="lg"
        footer={<><Button onClick={() => setEditor(null)}>Cancel</Button><Button variant="primary" loading={saving} disabled={!editor?.name.trim()} onClick={saveProfile}>Save profile</Button></>}>
        {editor && (
          <>
            <div className="form-grid">
              <Field label="Name" required><TextInput value={editor.name} onChange={(v) => setEditor({ ...editor, name: v })} /></Field>
              <Field label="Description"><TextInput value={editor.description} onChange={(v) => setEditor({ ...editor, description: v })} /></Field>
            </div>
            <Tabs value={family} onChange={setFamily} tabs={[{ value: 'debian', label: 'Debian / Ubuntu packages', count: editor.packages.debian.length }, { value: 'rhel', label: 'RHEL family packages', count: editor.packages.rhel.length }]} />
            {catalog.data && Object.entries(catalog.data[family] || {}).map(([group, names]) => (
              <div key={group} style={{ marginBottom: 12 }}>
                <h3 style={{ margin: '8px 0' }}>{group}</h3>
                <div className="form-grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))' }}>
                  {names.map((n) => <label key={n} className="radio"><input type="checkbox" checked={editor.packages[family].includes(n)} onChange={() => togglePkg(n)} /> <span><code>{n}</code></span></label>)}
                </div>
              </div>
            ))}
            <Field label="Additional packages" help="Any other distro package names, separated by spaces or commas (press Enter or Add)">
              <Textarea rows={2} mono value={custom} onChange={setCustom} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addCustom(custom); } }} placeholder="libapache2-mod-rpaf php8.3-xdebug" />
              <div className="action-row"><Button size="sm" disabled={!custom.trim()} onClick={() => addCustom(custom)}>Add to {family === 'rhel' ? 'RHEL' : 'Debian'} list</Button></div>
            </Field>
            <p className="small">Selected for {family}: {editor.packages[family].length ? editor.packages[family].map((p) => <code key={p} style={{ marginRight: 6 }}>{p}</code>) : <span className="muted">nothing yet</span>}</p>
            <ErrorBanner error={saveError} />
          </>
        )}
      </Modal>
    </>
  );
}
