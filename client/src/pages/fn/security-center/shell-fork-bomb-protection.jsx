import { useEffect, useState } from 'react';
import { api } from '../../../api/client.js';
import { useApi } from '../../../hooks/useApi.js';
import { PageHeader, Card, StatusPill, Loading, KeyValue } from '../../../components/Common.jsx';
import { Field, NumberInput, TextInput, Button, FormActions } from '../../../components/Form.jsx';
import { useToast } from '../../../components/Toast.jsx';
import { useConfirm } from '../../../components/Modal.jsx';
import { RequestError, ManagedFileNote } from '../../security/Shared.jsx';

export default function ShellForkBombProtection({ fn }) {
  const toast = useToast();
  const confirm = useConfirm();
  const { data, loading, error, refetch } = useApi('/security/fork-bomb');
  const [draft, setDraft] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (data) setDraft({ maxProcesses: data.maxProcesses, maxOpenFiles: data.maxOpenFiles, maxMemoryMb: data.maxMemoryMb, excludeGroups: data.excludeGroups }); }, [data]);

  const save = async (enabled) => {
    if (!enabled && !(await confirm({ title: 'Disable fork bomb protection?', message: 'Users with shell access will again be able to spawn unlimited processes.', confirmLabel: 'Disable', danger: true }))) return;
    setBusy(true);
    try {
      await api.put('/security/fork-bomb', { enabled, ...(enabled ? draft : {}) });
      toast.success(enabled ? 'Fork bomb protection enabled' : 'Fork bomb protection disabled');
      refetch();
    } catch (err) { toast.error(err); } finally { setBusy(false); }
  };

  return (
    <>
      <PageHeader fn={fn} />
      <RequestError error={error} onRetry={refetch} />
      {loading && !data && <Loading />}
      {data && draft && (
        <>
          <Card title="Status">
            <KeyValue items={[['Protection', <StatusPill key="s" status={data.enabled ? 'enabled' : 'disabled'}>{data.enabled ? 'Enabled' : 'Disabled'}</StatusPill>], ['Mechanism', 'pam_limits (/etc/security/limits.d)']]} />
            {!data.supported && <p className="muted">This host has no /etc/security/limits.d; PAM limits cannot be applied.</p>}
            <ManagedFileNote path={data.path} />
          </Card>
          <Card title="Limits for shell users" subtitle="Hard limits applied to every PAM login session except root and the exempt groups.">
            <div className="form-grid">
              <Field label="Maximum processes (nproc)" help="WHM's classic default is 35."><NumberInput value={draft.maxProcesses} onChange={(v) => setDraft({ ...draft, maxProcesses: v })} min={1} nullable={false} /></Field>
              <Field label="Maximum open files (nofile)"><NumberInput value={draft.maxOpenFiles} onChange={(v) => setDraft({ ...draft, maxOpenFiles: v })} min={16} nullable={false} /></Field>
              <Field label="Maximum virtual memory (MB)"><NumberInput value={draft.maxMemoryMb} onChange={(v) => setDraft({ ...draft, maxMemoryMb: v })} min={16} nullable={false} /></Field>
              <Field label="Exempt groups" help="Comma-separated. Members keep unlimited resources (e.g. wheel, sudo)."><TextInput value={draft.excludeGroups.join(', ')} onChange={(v) => setDraft({ ...draft, excludeGroups: v.split(',').map((s) => s.trim()).filter(Boolean) })} /></Field>
            </div>
            <FormActions>
              <Button variant="primary" loading={busy} onClick={() => save(true)} disabled={!data.supported}>{data.enabled ? 'Save limits' : 'Enable protection'}</Button>
              {data.enabled && <Button variant="danger" loading={busy} onClick={() => save(false)}>Disable</Button>}
            </FormActions>
          </Card>
        </>
      )}
    </>
  );
}
