import { useEffect, useState } from 'react';
import { api } from '../../../api/client.js';
import { useApi } from '../../../hooks/useApi.js';
import { PageHeader, Card, StatusPill, Loading, KeyValue } from '../../../components/Common.jsx';
import { Field, NumberInput, TextInput, Button, FormActions, isBlank } from '../../../components/Form.jsx';
import { useToast } from '../../../components/Toast.jsx';
import { useConfirm } from '../../../components/Modal.jsx';
import { RequestError, ManagedFileNote } from '../../security/Shared.jsx';

export const REQUIRED = 'Enter a value.';

export function draftFrom(data) {
  return { maxProcesses: data.maxProcesses ?? null, maxOpenFiles: data.maxOpenFiles ?? null, maxMemoryMb: data.maxMemoryMb ?? null, excludeGroups: data.excludeGroups || [] };
}

// The route takes integers only. A cleared memory field means "no cap" and is
// left out of the body (never sent as 0 or null); the two mandatory limits are
// refused here before the request when they are empty.
export function forkBombBody(draft, enabled) {
  if (!enabled) return { enabled: false };
  const body = { enabled: true, maxProcesses: draft.maxProcesses, maxOpenFiles: draft.maxOpenFiles, excludeGroups: draft.excludeGroups || [] };
  if (!isBlank(draft.maxMemoryMb)) body.maxMemoryMb = draft.maxMemoryMb;
  return body;
}

export function limitErrors(draft, memoryFloorMb) {
  const errors = {};
  if (isBlank(draft.maxProcesses)) errors.maxProcesses = REQUIRED;
  if (isBlank(draft.maxOpenFiles)) errors.maxOpenFiles = REQUIRED;
  if (!isBlank(draft.maxMemoryMb) && memoryFloorMb && draft.maxMemoryMb < memoryFloorMb) errors.maxMemoryMb = `At least ${memoryFloorMb} MB: a lower cap makes Node.js, Java and Go abort at startup in every account shell and cron job. Leave the field empty for no memory limit.`;
  return errors;
}

export default function ShellForkBombProtection({ fn }) {
  const toast = useToast();
  const confirm = useConfirm();
  const { data, loading, error, refetch } = useApi('/security/fork-bomb');
  const [edited, setEdited] = useState(null);
  const draft = edited ?? (data ? draftFrom(data) : null);
  const setDraft = setEdited;
  const [busy, setBusy] = useState(false);
  useEffect(() => { setEdited(null); }, [data]);
  const errors = draft ? limitErrors(draft, data?.memoryFloorMb) : {};
  const invalid = Object.keys(errors).length > 0;

  const save = async (enabled) => {
    if (!enabled && !(await confirm({ title: 'Disable fork bomb protection?', message: 'Users with shell access will again be able to spawn unlimited processes.', confirmLabel: 'Disable', danger: true }))) return;
    if (enabled && invalid) { toast.error(Object.values(errors)[0]); return; }
    setBusy(true);
    try {
      await api.put('/security/fork-bomb', forkBombBody(draft, enabled));
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
          {data.warnings?.length > 0 && (
            <div className="banner banner-warning" role="alert">
              <div>
                <strong>The current limits file needs attention.</strong>
                <ul>{data.warnings.map((w) => <li key={w}>{w}</li>)}</ul>
              </div>
            </div>
          )}
          <Card title="Status">
            <KeyValue items={[['Protection', <StatusPill key="s" status={data.enabled ? 'enabled' : 'disabled'}>{data.enabled ? 'Enabled' : 'Disabled'}</StatusPill>], ['Mechanism', 'pam_limits (/etc/security/limits.d)'], ['Virtual memory cap', data.maxMemoryMb != null ? `${data.maxMemoryMb} MB` : 'none']]} />
            {!data.supported && <p className="muted">This host has no /etc/security/limits.d; PAM limits cannot be applied.</p>}
            <ManagedFileNote path={data.path} />
          </Card>
          <Card title="Limits for shell users" subtitle="Hard limits applied to every PAM login session except root and the exempt groups.">
            <div className="form-grid">
              <Field label="Maximum processes (nproc)" help="WHM's classic default is 35." required error={errors.maxProcesses}><NumberInput value={draft.maxProcesses} onChange={(v) => setDraft({ ...draft, maxProcesses: v })} min={1} required aria-invalid={errors.maxProcesses ? true : undefined} /></Field>
              <Field label="Maximum open files (nofile)" required error={errors.maxOpenFiles}><NumberInput value={draft.maxOpenFiles} onChange={(v) => setDraft({ ...draft, maxOpenFiles: v })} min={16} required aria-invalid={errors.maxOpenFiles ? true : undefined} /></Field>
              <Field label="Maximum virtual memory (MB)" error={errors.maxMemoryMb} help={`Optional; leave empty for no memory cap. The cap applies to every process in the session, and Node.js, Java and Go reserve large address spaces at startup, so the agent refuses anything below ${data.memoryFloorMb || 4096} MB.`}><NumberInput value={draft.maxMemoryMb} onChange={(v) => setDraft({ ...draft, maxMemoryMb: v })} min={data.memoryFloorMb || 16} placeholder="no limit" aria-invalid={errors.maxMemoryMb ? true : undefined} /></Field>
              <Field label="Exempt groups" help="Comma-separated. Members keep unlimited resources (e.g. wheel, sudo)."><TextInput value={draft.excludeGroups.join(', ')} onChange={(v) => setDraft({ ...draft, excludeGroups: v.split(',').map((s) => s.trim()).filter(Boolean) })} /></Field>
            </div>
            <FormActions>
              <Button variant="primary" loading={busy} onClick={() => save(true)} disabled={!data.supported || invalid} title={invalid ? Object.values(errors)[0] : undefined}>{data.enabled ? 'Save limits' : 'Enable protection'}</Button>
              {data.enabled && <Button variant="danger" loading={busy} onClick={() => save(false)}>Disable</Button>}
            </FormActions>
          </Card>
        </>
      )}
    </>
  );
}
