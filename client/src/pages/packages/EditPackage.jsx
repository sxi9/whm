import { useEffect, useState } from 'react';
import { api } from '../../api/client.js';
import { useApi } from '../../hooks/useApi.js';
import { PageHeader, Card } from '../../components/Common.jsx';
import { Field, Select, Button, FormActions } from '../../components/Form.jsx';
import { useToast } from '../../components/Toast.jsx';
import { PackageForm, packageToForm, formToBody } from './PackageForm.jsx';

export default function EditPackage({ fn }) {
  const toast = useToast();
  const { data: packages, refetch } = useApi('/packages?pageSize=500');
  const [name, setName] = useState('');
  const [form, setForm] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const pkg = (packages || []).find((p) => p.name === name);

  useEffect(() => { setForm(pkg ? packageToForm(pkg) : null); setError(null); }, [pkg]);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { data } = await api.put(`/packages/${encodeURIComponent(name)}`, formToBody(form, { rename: true, original: name, current: pkg }));
      toast.success(`Package "${data.name}" saved`);
      await refetch();
      setName(data.name);
    } catch (err) { setError(err); } finally { setBusy(false); }
  };

  return (
    <>
      <PageHeader fn={fn} />
      <Card title="Select a package">
        <Field label="Package"><Select value={name} onChange={setName} options={(packages || []).map((p) => ({ value: p.name, label: `${p.name} (${p.accounts} account${p.accounts === 1 ? '' : 's'})` }))} placeholder="Select a package" /></Field>
      </Card>
      {form && (
        <form onSubmit={submit}>
          <PackageForm form={form} setForm={setForm} error={error} />
          <FormActions><Button type="submit" variant="primary" loading={busy}>Save changes</Button></FormActions>
        </form>
      )}
    </>
  );
}
