import { useEffect, useState } from 'react';
import { api } from '../../../api/client.js';
import { useApi } from '../../../hooks/useApi.js';
import { PageHeader, Card, StatusPill, Loading, KeyValue, CapabilityNotice } from '../../../components/Common.jsx';
import { Field, Select, NumberInput, TextInput, Button, FormActions } from '../../../components/Form.jsx';
import { useToast } from '../../../components/Toast.jsx';
import { RequestError, ManagedFileNote } from '../../security/Shared.jsx';

const DIRECTIVES = [
  { key: 'SecRuleEngine', label: 'Rule engine', type: 'select', options: ['On', 'DetectionOnly', 'Off'], help: 'DetectionOnly logs matches without blocking: use it while tuning.' },
  { key: 'SecAuditEngine', label: 'Audit engine', type: 'select', options: ['RelevantOnly', 'On', 'Off'] },
  { key: 'SecAuditLogRelevantStatus', label: 'Audit relevant status (regex)', type: 'text', placeholder: '^(?:5|4(?!04))' },
  { key: 'SecAuditLogParts', label: 'Audit log parts', type: 'text', placeholder: 'ABIJDEFHZ' },
  { key: 'SecRequestBodyAccess', label: 'Inspect request bodies', type: 'select', options: ['On', 'Off'] },
  { key: 'SecResponseBodyAccess', label: 'Inspect response bodies', type: 'select', options: ['On', 'Off'] },
  { key: 'SecRequestBodyLimit', label: 'Request body limit (bytes)', type: 'number', min: 1024 },
  { key: 'SecRequestBodyNoFilesLimit', label: 'Request body limit without files (bytes)', type: 'number', min: 1024 },
  { key: 'SecRequestBodyLimitAction', label: 'When the body limit is exceeded', type: 'select', options: ['Reject', 'ProcessPartial'] },
  { key: 'SecPcreMatchLimit', label: 'PCRE match limit', type: 'number', min: 1000 },
  { key: 'SecPcreMatchLimitRecursion', label: 'PCRE recursion limit', type: 'number', min: 1000 },
  { key: 'SecConnEngine', label: 'Connection engine', type: 'select', options: ['On', 'DetectionOnly', 'Off'] },
];

export default function ModsecurityConfiguration({ fn }) {
  const toast = useToast();
  const { data, loading, error, refetch } = useApi('/security/modsec');
  const [draft, setDraft] = useState({});
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (data?.installed) setDraft({ ...data.managed }); }, [data]);

  const save = async () => {
    setBusy(true);
    try {
      const directives = {};
      for (const d of DIRECTIVES) if (d.key in draft || d.key in (data.managed || {})) directives[d.key] = draft[d.key] === '' || draft[d.key] == null ? null : draft[d.key];
      const { data: result } = await api.put('/security/modsec/config', { directives });
      toast.success(result.reload?.error ? `Configuration written; Apache reload failed: ${result.reload.error}` : 'ModSecurity configuration applied and Apache reloaded');
      refetch();
    } catch (err) { toast.error(err); } finally { setBusy(false); }
  };

  return (
    <>
      <PageHeader fn={fn} />
      <RequestError error={error} onRetry={refetch} />
      {loading && !data && <Loading />}
      {data && !data.installed && <CapabilityNotice error={{ code: 'capability_missing', message: 'ModSecurity is not installed. Install libapache2-mod-security2 (Debian/Ubuntu) or mod_security (RHEL) and refresh.' }} onRetry={refetch} />}
      {data && data.installed && (
        <>
          <Card title="Status">
            <KeyValue items={[
              ['Rule engine', <StatusPill key="e" status={data.effective.SecRuleEngine === 'On' ? 'ok' : data.effective.SecRuleEngine === 'DetectionOnly' ? 'warning' : 'disabled'}>{data.effective.SecRuleEngine || 'Off (default)'}</StatusPill>],
              ['Module loaded in Apache', data.layout.moduleLoaded == null ? 'unknown' : data.layout.moduleLoaded ? 'yes' : 'no'],
              ['Distribution config', data.mainConf ? <code key="m">{data.mainConf}</code> : <span key="m" className="muted">missing{data.recommended ? ` (copy ${data.recommended} to modsecurity.conf)` : ''}</span>],
              ['Rules disabled from Tools', data.disabledRules.length],
              ['Vendor rule sets', data.vendors.length ? data.vendors.map((v) => `${v.name}${v.enabled ? '' : ' (off)'}`).join(', ') : 'none'],
            ]} />
            <ManagedFileNote path={data.managedPath} />
          </Card>
          <Card title="Engine directives" subtitle="Values here override the distribution file. Empty = keep the distribution value. Validated with apachectl -t and rolled back on error.">
            <div className="form-grid">
              {DIRECTIVES.map((d) => {
                const value = draft[d.key] ?? '';
                const base = data.base?.[d.key];
                const help = d.help || (base != null ? `Distribution value: ${base}` : undefined);
                if (d.type === 'select') return <Field key={d.key} label={d.label} help={help}><Select value={value} onChange={(v) => setDraft({ ...draft, [d.key]: v })} options={d.options} placeholder={base != null ? `inherit (${base})` : 'inherit'} /></Field>;
                if (d.type === 'number') return <Field key={d.key} label={d.label} help={help}><NumberInput value={value === '' ? null : value} onChange={(v) => setDraft({ ...draft, [d.key]: v })} min={d.min} placeholder={base != null ? String(base) : 'inherit'} /></Field>;
                return <Field key={d.key} label={d.label} help={help}><TextInput value={value} onChange={(v) => setDraft({ ...draft, [d.key]: v })} placeholder={d.placeholder} /></Field>;
              })}
            </div>
            <FormActions><Button variant="primary" loading={busy} onClick={save}>Save and reload Apache</Button><Button onClick={() => setDraft({ ...data.managed })}>Reset</Button></FormActions>
          </Card>
        </>
      )}
    </>
  );
}
