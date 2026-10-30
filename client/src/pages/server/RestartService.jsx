import { Link } from 'react-router-dom';
import { api } from '../../api/client.js';
import { useApi } from '../../hooks/useApi.js';
import { RESTART_SERVICE_MAP } from '../../nav.js';
import { ActionPage } from '../../components/ActionPage.jsx';
import { PageHeader, Card, StatusPill, KeyValue, CapabilityNotice, formatBytes } from '../../components/Common.jsx';

// The stack-catalog capability that installs each restartable service
// (server/src/lib/stack-catalog.js; kept in step by client/test/server-pages.test.jsx).
// sshd has no component, so its page only gets the manual instructions.
export const RESTART_SERVICE_CAPABILITY = { mysql: 'mysql', named: 'bind', httpd: 'apache', imap: 'dovecot', exim: 'exim', mailman: 'mailman', 'php-fpm': 'php' };

// One component serves all eight "Restart Services" entries; the service is
// derived from the function slug via RESTART_SERVICE_MAP.
export default function RestartService({ fn }) {
  const service = RESTART_SERVICE_MAP[fn.slug];
  const { data: status, refetch } = useApi(`/system/services/${service}`);
  const statusView = status && (
    <KeyValue items={[
      ['Unit', status.unit ? <code key="u">{status.unit}</code> : 'not installed'],
      ['State', <StatusPill key="s" status={status.installed === false ? 'not-installed' : status.active ? 'active' : 'down'}>{status.installed === false ? 'Not installed' : status.active ? 'Up' : 'Down'}</StatusPill>],
      status.pid && ['PID', status.pid], status.memoryBytes != null && ['Memory', formatBytes(status.memoryBytes)], status.startedAt && ['Started', status.startedAt],
    ]} />
  );
  // Nothing to restart: offer the install instead of a button that can only 404.
  if (status?.installed === false) {
    return (
      <>
        <PageHeader fn={fn} />
        <Card>
          <div className="action-status">{statusView}</div>
          <CapabilityNotice capability={RESTART_SERVICE_CAPABILITY[service]} onRetry={refetch}
            error={{ code: 'capability_missing', message: `${fn.label} is not installed on this server, so there is nothing to restart yet.` }} />
          <p className="muted">Service Manager installs, repairs and monitors every service: <Link to="/service-configuration/service-manager">open Service Manager</Link>.</p>
        </Card>
      </>
    );
  }
  return (
    <ActionPage
      fn={fn}
      buttonLabel={`Restart ${fn.label}`}
      confirmMessage={`Restart ${fn.label} now? Active connections will be dropped briefly.`}
      run={async () => { const { data } = await api.post(`/system/services/${service}/restart`); await refetch(); return data; }}
      status={statusView}
      renderResult={(r) => <KeyValue items={[['Result', <StatusPill key="r" status="ok">restarted</StatusPill>], ['State now', r.status?.state], ['PID', r.status?.pid], r.output && ['Output', <pre key="o" className="log">{r.output}</pre>]]} />}
    />
  );
}
