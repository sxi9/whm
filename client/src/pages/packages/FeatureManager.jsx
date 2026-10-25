import { useEffect, useState } from 'react';
import { api } from '../../api/client.js';
import { useApi } from '../../hooks/useApi.js';
import { PageHeader, Card } from '../../components/Common.jsx';
import { Field, Select, TextInput, Toggle, Button, FormActions } from '../../components/Form.jsx';
import { useToast } from '../../components/Toast.jsx';
import { useConfirm } from '../../components/Modal.jsx';

const FEATURE_LABELS = {
  addondomains: 'Addon Domains', subdomains: 'Subdomains', parkeddomains: 'Aliases (Parked Domains)', filemanager: 'File Manager', ftpaccts: 'FTP Accounts',
  emailaccts: 'Email Accounts', forwarders: 'Forwarders', autoresponders: 'Autoresponders', defaultaddress: 'Default Address', spamassassin: 'Spam Filters',
  mysql: 'MySQL Databases', phpmyadmin: 'phpMyAdmin', postgres: 'PostgreSQL', cron: 'Cron Jobs', ssh: 'Terminal / SSH', backup: 'Backups', bandwidth: 'Bandwidth',
  statselect: 'Metrics Editor', awstats: 'AWStats', webalizer: 'Webalizer', errlog: 'Errors', rawlog: 'Raw Access Logs', sslmanager: 'SSL/TLS', autossl: 'AutoSSL',
  phpversion: 'PHP Version', multiphp: 'MultiPHP Manager', webdisk: 'Web Disk', api: 'API Access', passwordchange: 'Password & Security', hotlink: 'Hotlink Protection',
  leechprotect: 'Leech Protection', indexmanager: 'Indexes', errpgs: 'Error Pages', redirects: 'Redirects', cpanelpro_support: 'Support Tickets',
};

export default function FeatureManager({ fn }) {
  const toast = useToast();
  const confirm = useConfirm();
  const { data: lists, refetch } = useApi('/packages/feature-lists');
  const [name, setName] = useState('default');
  const [features, setFeatures] = useState(null);
  const [newName, setNewName] = useState('');
  const [busy, setBusy] = useState(false);
  const current = (lists || []).find((l) => l.name === name);

  useEffect(() => { setFeatures(current ? { ...current.features } : null); }, [current]);

  const save = async () => {
    setBusy(true);
    try { await api.put(`/packages/feature-lists/${name}`, { features }); toast.success(`Feature list "${name}" saved`); refetch(); } catch (err) { toast.error(err); } finally { setBusy(false); }
  };
  const create = async () => {
    if (!newName) return;
    try { await api.post('/packages/feature-lists', { name: newName, features: features || {} }); toast.success(`Created "${newName}"`); await refetch(); setName(newName); setNewName(''); } catch (err) { toast.error(err); }
  };
  const remove = async () => {
    if (!(await confirm({ title: `Delete feature list "${name}"?`, confirmLabel: 'Delete', danger: true }))) return;
    try { await api.delete(`/packages/feature-lists/${name}`); toast.success('Deleted'); setName('default'); refetch(); } catch (err) { toast.error(err); }
  };
  const setAll = (v) => setFeatures((f) => Object.fromEntries(Object.keys(f).map((k) => [k, v])));

  return (
    <>
      <PageHeader fn={fn} />
      <Card title="Feature lists">
        <div className="form-grid">
          <Field label="Edit feature list"><Select value={name} onChange={setName} options={(lists || []).map((l) => ({ value: l.name, label: `${l.name} (${l.packages} package${l.packages === 1 ? '' : 's'})` }))} /></Field>
          <Field label="Add a new feature list" help="Starts as a copy of the list selected on the left">
            <div className="input-group"><TextInput value={newName} onChange={setNewName} placeholder="e.g. Business" /><Button onClick={create} disabled={!newName}>Add</Button></div>
          </Field>
        </div>
      </Card>
      {features && (
        <Card title={`Features in "${name}"`} actions={<><button className="link-button" onClick={() => setAll(true)}>Select all</button><button className="link-button" onClick={() => setAll(false)}>Select none</button></>}>
          <div className="form-grid">
            {Object.keys(features).sort((a, b) => (FEATURE_LABELS[a] || a).localeCompare(FEATURE_LABELS[b] || b)).map((key) => (
              <Field key={key} inline><Toggle checked={features[key]} onChange={(v) => setFeatures((f) => ({ ...f, [key]: v }))} label={FEATURE_LABELS[key] || key} /></Field>
            ))}
          </div>
          <FormActions>
            <Button variant="primary" loading={busy} onClick={save}>Save</Button>
            {!['default', 'disabled'].includes(name) && <Button variant="danger" onClick={remove}>Delete list</Button>}
          </FormActions>
        </Card>
      )}
    </>
  );
}
