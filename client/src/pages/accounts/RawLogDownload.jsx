import { useState } from 'react';
import { useApi } from '../../hooks/useApi.js';
import { PageHeader, Card, CapabilityNotice, EmptyState, formatBytes, formatDate, DownloadLink } from '../../components/Common.jsx';
import { DataTable } from '../../components/DataTable.jsx';
import { ErrorBanner } from '../../components/Form.jsx';
import { AccountPicker } from './AccountPicker.jsx';

// Shared by Raw Apache Log Download and Raw NGINX Log Download. Files are
// streamed by the API in ranges through the agent, so any size downloads.
export function RawLogDownload({ fn, kind, description }) {
  const [username, setUsername] = useState('');
  const { data, loading, error, refetch } = useApi(username ? `/account-functions/logs/${kind}/${encodeURIComponent(username)}` : null, { enabled: Boolean(username) });

  return (
    <>
      <PageHeader fn={fn} description={description} />
      <Card title="Select an account"><AccountPicker value={username} onChange={setUsername} /></Card>
      {username && (
        <Card title={`${kind === 'nginx' ? 'NGINX' : 'Apache'} logs for ${username}`} subtitle={data ? `Looked in ${data.dirs.join(' and ')}` : undefined} padded={false} actions={<button className="btn btn-sm" onClick={() => refetch()}>Refresh</button>}>
          <CapabilityNotice error={error} onRetry={refetch} />
          {error && error.status !== 501 && <ErrorBanner error={error} onRetry={refetch} />}
          {data && !data.files.length && <EmptyState title="No log files yet">{kind === 'nginx' ? 'NGINX writes per-domain logs once a vhost for this account has served traffic.' : data.apache ? 'Apache creates the access and error logs once the site has served its first request.' : 'Apache is not installed on this server; logs appear once the web server serves this account.'}</EmptyState>}
          {data?.files.length > 0 && (
            <DataTable
              columns={[
                { key: 'name', label: 'File', render: (f) => <code>{f.name}</code> },
                { key: 'dir', label: 'Directory', render: (f) => <code>{f.dir}</code> },
                { key: 'size', label: 'Size', align: 'right', render: (f) => formatBytes(f.size) },
                { key: 'mtime', label: 'Last written', render: (f) => formatDate(f.mtime) },
                { key: 'dl', label: '', render: (f) => <DownloadLink href={`/api/account-functions/logs/${kind}/${encodeURIComponent(username)}/download?file=${encodeURIComponent(f.name)}`}>Download</DownloadLink> },
              ]}
              rows={data.files} loading={loading} rowKey={(f) => f.path} dense
            />
          )}
        </Card>
      )}
    </>
  );
}
