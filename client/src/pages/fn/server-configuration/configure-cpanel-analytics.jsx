import { useEffect, useState } from 'react';
import { api } from '../../../api/client.js';
import { useApi } from '../../../hooks/useApi.js';
import { PageHeader, Card, Loading, KeyValue, formatDate } from '../../../components/Common.jsx';
import { Field, Toggle, Button, FormActions } from '../../../components/Form.jsx';
import { useToast } from '../../../components/Toast.jsx';
import { useConfirm } from '../../../components/Modal.jsx';
import { RequestError } from '../../server-configuration/Shared.jsx';

export default function ConfigureAnalytics({ fn }) {
  const toast = useToast();
  const confirm = useConfirm();
  const { data, loading, error, refetch } = useApi('/server-config/analytics');
  const [draft, setDraft] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (data) setDraft({ enabled: data.enabled, shareUsage: data.shareUsage, shareErrors: data.shareErrors }); }, [data]);
  const dirty = data && draft && (draft.enabled !== data.enabled || draft.shareUsage !== data.shareUsage || draft.shareErrors !== data.shareErrors);

  const save = async () => {
    setBusy(true);
    try { await api.put('/server-config/analytics', draft); toast.success(draft.enabled ? 'Analytics enabled' : 'Analytics preferences saved'); refetch(); } catch (err) { toast.error(err); } finally { setBusy(false); }
  };
  const rotate = async () => {
    if (!(await confirm({ title: 'Rotate the participant ID?', message: 'Previously submitted analytics can no longer be linked to this server.', confirmLabel: 'Rotate' }))) return;
    try { await api.post('/server-config/analytics/rotate-id'); toast.success('Participant ID rotated'); refetch(); } catch (err) { toast.error(err); }
  };

  return (
    <>
      <PageHeader fn={fn} description="Interface analytics help improve the panel by reporting which functions are used. Participation is optional, anonymous and off by default." />
      <RequestError error={error} onRetry={refetch} />
      {loading && !data && <Loading />}
      {data && draft && (
        <>
          <Card title="Participation">
            <Field inline><Toggle checked={draft.enabled} onChange={(v) => setDraft((d) => ({ ...d, enabled: v }))} label="Send anonymous interface analytics" description="A random participant ID is generated the first time you opt in." /></Field>
            <Field inline><Toggle checked={draft.shareUsage} onChange={(v) => setDraft((d) => ({ ...d, shareUsage: v }))} label="Include feature usage" description="Which WHM functions are opened and how often." disabled={!draft.enabled} /></Field>
            <Field inline><Toggle checked={draft.shareErrors} onChange={(v) => setDraft((d) => ({ ...d, shareErrors: v }))} label="Include anonymous error signatures" description="Error codes and the function they occurred in, never messages or data." disabled={!draft.enabled} /></Field>
            <FormActions>
              <Button variant="primary" loading={busy} disabled={!dirty} onClick={save}>Save</Button>
              <Button disabled={!dirty || busy} onClick={() => setDraft({ enabled: data.enabled, shareUsage: data.shareUsage, shareErrors: data.shareErrors })}>Reset</Button>
            </FormActions>
          </Card>
          <div className="form-grid">
            <Card title="Identity" actions={data.participantId && <Button size="sm" onClick={rotate}>Rotate ID</Button>}>
              <KeyValue items={[['Status', data.enabled ? 'Participating' : 'Not participating'], ['Participant ID', data.participantId ? <code key="p">{data.participantId}</code> : 'assigned on opt-in'], ['Last changed', formatDate(data.updatedAt)]]} />
            </Card>
            <Card title="What is collected">
              <ul>{data.collected.map((c) => <li key={c}>{c}</li>)}</ul>
              <p className="muted" style={{ marginTop: 10 }}><strong>Never collected:</strong> {data.notCollected.join('; ')}.</p>
            </Card>
          </div>
        </>
      )}
    </>
  );
}
