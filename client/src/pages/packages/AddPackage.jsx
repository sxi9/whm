import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../../api/client.js';
import { PageHeader } from '../../components/Common.jsx';
import { Button, FormActions } from '../../components/Form.jsx';
import { useToast } from '../../components/Toast.jsx';
import { PackageForm, EMPTY_PACKAGE, formToBody } from './PackageForm.jsx';

export default function AddPackage({ fn }) {
  const toast = useToast();
  const navigate = useNavigate();
  const [form, setForm] = useState(EMPTY_PACKAGE);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post('/packages', formToBody(form));
      toast.success(`Package "${form.name}" created`);
      navigate('/packages/edit-a-package');
    } catch (err) { setError(err); } finally { setBusy(false); }
  };

  return (
    <>
      <PageHeader fn={fn} />
      <form onSubmit={submit}>
        <PackageForm form={form} setForm={setForm} error={error} />
        <FormActions><Button type="submit" variant="primary" loading={busy}>Add</Button></FormActions>
      </form>
    </>
  );
}
