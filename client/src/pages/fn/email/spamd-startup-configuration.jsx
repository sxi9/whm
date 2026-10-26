import { useEffect, useState } from 'react';
import { api } from '../../../api/client.js';
import { useApi } from '../../../hooks/useApi.js';
import { PageHeader, Card, StatusPill, KeyValue, Loading, CapabilityNotice } from '../../../components/Common.jsx';
import { Field, TextInput, NumberInput, Select, Toggle, Button, FormActions, ErrorBanner } from '../../../components/Form.jsx';
import { useToast } from '../../../components/Toast.jsx';
import { useConfirm } from '../../../components/Modal.jsx';
import { RequestError } from '../../email/Shared.jsx';

const NUMERIC = ['maxChildren', 'minChildren', 'maxSpare', 'minSpare', 'maxConnPerChild', 'timeoutChild', 'port', 'nice'];
const FIELDS = ['maxChildren', 'minChildren', 'maxSpare', 'minSpare', 'maxConnPerChild', 'timeoutChild', 'listenIp', 'port', 'allowedIps', 'username', 'nice', 'createPrefs', 'allowTell', 'helperHomeDir', 'localOnly', 'syslog'];

function toDraft(data) {
  const o = data.options || {};
  return { enabled: data.enabled ?? true, cron: data.cron ?? false, ...Object.fromEntries(FIELDS.map((k) => [k, o[k] ?? null])), allowedIps: (o.allowedIps || []).join(', ') };
}

export default function SpamdStartupConfiguration({ fn }) {
  const toast = useToast();
  const confirm = useConfirm();
  const { data, loading, error, refetch } = useApi('/email/spamd');
  const [draft, setDraft] = useState(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(null);
  useEffect(() => { if (data) setDraft(toDraft(data)); }, [data]);
  const set = (k) => (v) => setDraft((d) => ({ ...d, [k]: v }));
  const base = data ? toDraft(data) : null;
  const dirty = draft && base && JSON.stringify(draft) !== JSON.stringify(base);

  const save = async () => {
    if (draft.enabled === false && base.enabled !== false && !(await confirm({ title: 'Disable spamd?', message: 'SpamAssassin stops scanning incoming mail until it is enabled again.', confirmLabel: 'Disable', danger: true }))) return;
    setSaving(true); setSaveError(null);
    try {
      const body = {};
      for (const k of Object.keys(draft)) {
        if (JSON.stringify(draft[k]) === JSON.stringify(base[k])) continue;
        if (k === 'allowedIps') body[k] = draft[k].trim() ? draft[k].split(/[\s,]+/).filter(Boolean) : null;
        else if (NUMERIC.includes(k)) body[k] = draft[k] === null || draft[k] === '' ? null : Number(draft[k]);
        else body[k] = draft[k] === '' ? null : draft[k];
      }
      await api.put('/email/spamd', body);
      toast.success('spamd options saved and the daemon restarted');
      await refetch();
    } catch (err) { setSaveError(err); toast.error(err); } finally { setSaving(false); }
  };

  const tri = (k, label, help) => <Field label={label} help={help}><Select value={draft[k] === true ? 'yes' : draft[k] === false ? 'no' : ''} onChange={(v) => set(k)(v === '' ? null : v === 'yes')} options={[{ value: 'yes', label: 'Yes' }, { value: 'no', label: 'No' }]} placeholder="Default" /></Field>;
  return (
    <>
      <PageHeader fn={fn} description="Options passed to the SpamAssassin daemon at start-up (OPTIONS in /etc/default/spamassassin or SPAMDOPTIONS in /etc/sysconfig/spamassassin). Saving rewrites the file and restarts spamd." />
      <RequestError error={error} onRetry={refetch} />
      {loading && !data && <Loading />}
      {data && !data.installed && <CapabilityNotice error={{ code: 'capability_missing', message: 'SpamAssassin is not installed on this server. Install the spamassassin package to run spamd; the options file below is shown for reference.' }} onRetry={refetch} />}
      {data && draft && (
        <>
          <Card title="Daemon">
            <KeyValue items={[
              ['spamd unit', data.unit ? <span key="u"><StatusPill status={data.unit.active === 'active' ? 'active' : 'inactive'}>{data.unit.name}: {data.unit.active}{data.unit.sub ? ` (${data.unit.sub})` : ''}</StatusPill></span> : <StatusPill key="n" status="unknown">no systemd unit found</StatusPill>],
              ['Options file', <code key="p">{data.path}</code>],
              ['Current OPTIONS', <code key="o">{data.optionString || '(empty)'}</code>],
              data.localCf && ['Rules (local.cf)', <code key="l">{data.localCf}</code>],
            ]} />
          </Card>
          <Card title="Start-up" className="config-fields">
            {data.flavor === 'debian' && <Field inline><Toggle checked={draft.enabled} onChange={set('enabled')} label="Start spamd at boot (ENABLED=1)" /></Field>}
            {data.flavor === 'debian' && <Field inline><Toggle checked={draft.cron} onChange={set('cron')} label="Nightly rule updates (CRON=1, sa-update)" /></Field>}
          </Card>
          <Card title="Capacity" className="config-fields">
            <div className="form-grid">
              <Field label="Max children" help="--max-children: concurrent scanning processes (RAM ≈ 30–50 MB each)"><NumberInput value={draft.maxChildren} onChange={set('maxChildren')} min={1} max={200} /></Field>
              <Field label="Min children" help="--min-children"><NumberInput value={draft.minChildren} onChange={set('minChildren')} min={1} max={200} /></Field>
              <Field label="Max spare" help="--max-spare"><NumberInput value={draft.maxSpare} onChange={set('maxSpare')} min={0} max={200} /></Field>
              <Field label="Min spare" help="--min-spare"><NumberInput value={draft.minSpare} onChange={set('minSpare')} min={0} max={200} /></Field>
              <Field label="Max connections per child" help="--max-conn-per-child: recycle a child after this many scans"><NumberInput value={draft.maxConnPerChild} onChange={set('maxConnPerChild')} min={1} /></Field>
              <Field label="Scan timeout (s)" help="--timeout-child"><NumberInput value={draft.timeoutChild} onChange={set('timeoutChild')} min={1} max={3600} /></Field>
              <Field label="Nice level" help="--nice"><NumberInput value={draft.nice} onChange={set('nice')} min={-20} max={19} /></Field>
            </div>
          </Card>
          <Card title="Network" className="config-fields">
            <div className="form-grid">
              <Field label="Listen address" help="--listen: 127.0.0.1 keeps spamd local; * listens everywhere"><TextInput value={draft.listenIp ?? ''} onChange={(v) => set('listenIp')(v || null)} placeholder="127.0.0.1" /></Field>
              <Field label="Port" help="--port (default 783)"><NumberInput value={draft.port} onChange={set('port')} min={1} max={65535} /></Field>
              <Field label="Allowed client IPs" help="--allowed-ips, comma-separated IPs or networks"><TextInput value={draft.allowedIps} onChange={set('allowedIps')} placeholder="127.0.0.1, ::1" /></Field>
              {tri('localOnly', 'Local tests only (--local)', 'Skip DNS/network checks such as RBLs')}
            </div>
          </Card>
          <Card title="Users and preferences" className="config-fields">
            <div className="form-grid">
              <Field label="Run as user" help="--username"><TextInput value={draft.username ?? ''} onChange={(v) => set('username')(v || null)} placeholder="debian-spamd" /></Field>
              <Field label="Helper home directory" help="--helper-home-dir, for Razor/Pyzor/DCC state"><TextInput value={draft.helperHomeDir ?? ''} onChange={(v) => set('helperHomeDir')(v || null)} placeholder="/var/lib/spamassassin" /></Field>
              {tri('createPrefs', 'Per-user preferences (--create-prefs / --nouser-config)', 'Yes creates ~/.spamassassin/user_prefs; No ignores user configs')}
              {tri('allowTell', 'Allow learning (--allow-tell)', 'Lets spamc -L/-R train the Bayes database')}
              <Field label="Syslog facility" help="--syslog"><Select value={draft.syslog ?? ''} onChange={(v) => set('syslog')(v || null)} options={['mail', 'local0', 'local1', 'local2', 'local3', 'local4', 'local5', 'local6', 'local7', 'stderr', 'null']} placeholder="Default (mail)" /></Field>
            </div>
            {data.options?.extra?.length > 0 && <p className="muted">Other flags kept as-is: <code>{data.options.extra.join(' ')}</code></p>}
          </Card>
          <div className="sticky-actions">
            <ErrorBanner error={saveError} />
            <FormActions>
              <Button variant="primary" loading={saving} disabled={!dirty || !data.installed} onClick={save}>Save and restart spamd</Button>
              <Button disabled={!dirty || saving} onClick={() => setDraft(base)}>Reset</Button>
            </FormActions>
          </div>
          <Card title="Current file"><pre className="log">{data.raw ?? '(the options file does not exist yet)'}</pre></Card>
        </>
      )}
    </>
  );
}
