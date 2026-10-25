import { api } from '../../api/client.js';
import { useApi } from '../../hooks/useApi.js';
import { RESTART_SERVICE_MAP } from '../../nav.js';
import { ActionPage } from '../../components/ActionPage.jsx';
import { StatusPill, KeyValue, formatBytes } from '../../components/Common.jsx';

// One component serves all eight "Restart Services" entries; the service is
// derived from the function slug via RESTART_SERVICE_MAP.
export default function RestartService({ fn }) {
  const service = RESTART_SERVICE_MAP[fn.slug];
  const { data: status, refetch } = useApi(`/system/services/${service}`);
  return (
    <ActionPage
      fn={fn}
      buttonLabel={`Restart ${fn.label}`}
      confirmMessage={`Restart ${fn.label} now? Active connections will be dropped briefly.`}
      run={async () => { const { data } = await api.post(`/system/services/${service}/restart`); await refetch(); return data; }}
      status={status && (
        <KeyValue items={[
          ['Unit', status.unit ? <code key="u">{status.unit}</code> : 'not installed'],
          ['State', <StatusPill key="s" status={status.installed === false ? 'not-installed' : status.active ? 'active' : 'down'}>{status.installed === false ? 'Not installed' : status.active ? 'Up' : 'Down'}</StatusPill>],
          status.pid && ['PID', status.pid], status.memoryBytes != null && ['Memory', formatBytes(status.memoryBytes)], status.startedAt && ['Started', status.startedAt],
        ]} />
      )}
      renderResult={(r) => <KeyValue items={[['Result', <StatusPill key="r" status="ok">restarted</StatusPill>], ['State now', r.status?.state], ['PID', r.status?.pid], r.output && ['Output', <pre key="o" className="log">{r.output}</pre>]]} />}
    />
  );
}
