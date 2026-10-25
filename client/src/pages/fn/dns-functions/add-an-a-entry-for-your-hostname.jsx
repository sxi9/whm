import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../../api/client.js';
import { useApi } from '../../../hooks/useApi.js';
import { ActionPage } from '../../../components/ActionPage.jsx';
import { KeyValue, StatusPill } from '../../../components/Common.jsx';
import { Field, TextInput } from '../../../components/Form.jsx';
import { PublishBadge } from '../../dns/ZonePicker.jsx';

export default function AddHostnameAEntry({ fn }) {
  const { data: status, refetch } = useApi('/dns/hostname');
  const [ip, setIp] = useState('');
  return (
    <ActionPage
      fn={fn}
      description="Makes sure the server's hostname has an A record in a zone served here, creating the parent zone from the standard template when needed. The hostname must be fully qualified (set it in Basic WebHost Manager Setup)."
      buttonLabel="Add / update A entry"
      run={async () => { const { data } = await api.post('/dns/hostname', ip ? { ip } : {}); await refetch(); return data; }}
      status={status && (
        <KeyValue items={[
          ['Hostname', <code key="h">{status.hostname || '(not set)'}</code>],
          ['IP to use', <code key="i">{status.ip || '(none configured)'}</code>],
          ['Configured main IP', status.configuredIp || <span className="muted">not set — detected {status.detectedIp || 'none'}</span>],
          ['Zone', status.zone ? <Link key="z" to={`/dns-functions/dns-zone-manager?domain=${status.zone}`}>{status.zone}</Link> : status.suggestedZone ? <span key="z">none yet — <code>{status.suggestedZone}</code> will be created</span> : 'cannot derive a zone from the hostname'],
          ['Current A record', status.record ? <code key="r">{status.record.value}</code> : <StatusPill key="r" status="warning">missing</StatusPill>],
          ['Resolves publicly', status.resolves ? (status.resolves.matches ? <StatusPill key="p" status="ok">yes → {status.resolves.answers.join(', ')}</StatusPill> : <StatusPill key="p" status="warning">{status.resolves.answers.length ? `resolves to ${status.resolves.answers.join(', ')}` : status.resolves.error || 'no answer'}</StatusPill>) : '—'],
        ]} />
      )}
      renderResult={(r) => <KeyValue items={[['Hostname', r.hostname], ['Record', <code key="r">{r.recordName} IN A {r.ip}</code>], ['Zone', r.zone], r.createdZone && ['Zone created', r.createdZone], ['Status', <PublishBadge key="p" result={r} />]]} />}
    >
      <Field label="Override IP address" help="Blank uses the main IP from Basic Setup (or the first detected interface address)"><TextInput value={ip} onChange={setIp} placeholder={status?.ip || '203.0.113.10'} style={{ maxWidth: 300 }} /></Field>
    </ActionPage>
  );
}
