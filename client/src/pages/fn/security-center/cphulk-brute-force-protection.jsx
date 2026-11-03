import { useState } from 'react';
import { useApi } from '../../../hooks/useApi.js';
import { PageHeader, Loading } from '../../../components/Common.jsx';
import { Button } from '../../../components/Form.jsx';
import { Tabs, RequestError } from '../../security/Shared.jsx';
import { CphulkStatus, CphulkBlocks, CphulkHistory, CphulkLists } from '../../security/CphulkPanels.jsx';

export default function CphulkBruteForceProtection({ fn }) {
  const [tab, setTab] = useState('status');
  const { data, loading, error, refetch } = useApi('/security/cphulk', { refreshMs: 30_000 });
  return (
    <>
      <PageHeader fn={fn} actions={<Button onClick={() => refetch()}>Refresh</Button>} />
      <RequestError error={error} onRetry={refetch} />
      {loading && !data && <Loading />}
      {data && (
        <>
          <Tabs value={tab} onChange={setTab} tabs={[{ value: 'status', label: 'Status and settings' }, { value: 'blocks', label: 'Current blocks', count: data.blocks.length }, { value: 'history', label: 'Login history' }, { value: 'lists', label: 'Allow and deny lists' }]} />
          {tab === 'status' && <CphulkStatus overview={data} refetch={refetch} />}
          {tab === 'blocks' && <CphulkBlocks blocks={data.blocks} refetch={refetch} />}
          {tab === 'history' && <CphulkHistory />}
          {tab === 'lists' && <CphulkLists />}
        </>
      )}
    </>
  );
}
