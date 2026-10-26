import { useEffect, useState } from 'react';
import { api } from '../../../api/client.js';
import { useApi } from '../../../hooks/useApi.js';
import { PageHeader, Card, StatusPill, Loading } from '../../../components/Common.jsx';
import { TextInput, Toggle, Button, FormActions } from '../../../components/Form.jsx';
import { useToast } from '../../../components/Toast.jsx';
import { IpRequestError, FamilyPill } from '../../ip/Shared.jsx';

const snapshot = (rows) => rows.map((r) => ({ address: r.address, reserved: r.reserved, reason: r.reserved_reason || '' }));

export default function ShowEditReservedIps({ fn }) {
  const toast = useToast();
  const { data, loading, error, refetch } = useApi('/ip/reserved');
  const [draft, setDraft] = useState([]);
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState(null);
  useEffect(() => { if (data) { setDraft(snapshot(data)); setResults(null); } }, [data]);

  const update = (address, patch) => setDraft((d) => d.map((r) => (r.address === address ? { ...r, ...patch } : r)));
  const original = data ? snapshot(data) : [];
  const changed = draft.filter((r) => { const o = original.find((x) => x.address === r.address); return o && (o.reserved !== r.reserved || (r.reserved && o.reason !== r.reason)); });

  const save = async () => {
    setBusy(true);
    try {
      const { data: res } = await api.put('/ip/reserved', { items: changed.map((r) => ({ address: r.address, reserved: r.reserved, ...(r.reserved ? { reason: r.reason || null } : {}) })) });
      const failed = res.results.filter((r) => !r.ok);
      setResults(res.results);
      if (failed.length) toast.warning(`${res.results.length - failed.length} saved, ${failed.length} refused`); else toast.success('Reservations saved');
      refetch();
    } catch (err) { toast.error(err); } finally { setBusy(false); }
  };

  return (
    <>
      <PageHeader fn={fn} description="Reserved addresses stay bound to the server but are never handed to accounts as a dedicated or shared IP. The main IP and addresses currently in use cannot be reserved." />
      <IpRequestError error={error} onRetry={refetch} />
      {loading && !data && <Loading />}
      {data && (
        <Card title="Reserved IP addresses" padded={false}>
          <div className="table-wrap">
            <table>
              <thead><tr><th style={{ width: 90 }}>Reserved</th><th>Address</th><th>Family</th><th>Interface</th><th>Status</th><th>Reason</th></tr></thead>
              <tbody>
                {data.length === 0 && <tr><td colSpan={6} className="table-state">No addresses recorded. Rebuild the IP address pool first.</td></tr>}
                {data.map((row) => {
                  const d = draft.find((x) => x.address === row.address) || { reserved: row.reserved, reason: '' };
                  const res = results?.find((r) => r.address === row.address);
                  return (
                    <tr key={row.address}>
                      <td><Toggle checked={d.reserved} onChange={(v) => update(row.address, { reserved: v })} disabled={!row.reservable && !row.reserved} /></td>
                      <td><code>{row.address}</code></td>
                      <td><FamilyPill family={row.family} /></td>
                      <td>{row.interface || <span className="muted">—</span>}</td>
                      <td>
                        {row.is_main ? <StatusPill status="info">main IP</StatusPill> : row.dedicated_to ? <StatusPill status="ok">dedicated: {row.dedicated_to}</StatusPill> : row.accounts ? <StatusPill status="ok">{row.accounts} account(s)</StatusPill> : row.reserved ? <StatusPill status="warning">reserved</StatusPill> : <StatusPill status="unknown">free</StatusPill>}
                        {res && !res.ok && <div className="field-message">{res.error}</div>}
                      </td>
                      <td>{d.reserved ? <TextInput value={d.reason} onChange={(v) => update(row.address, { reason: v })} placeholder="optional note" /> : <span className="muted">{row.reserved_reason || ''}</span>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="card-body">
            <FormActions>
              <Button variant="primary" loading={busy} disabled={!changed.length} onClick={save}>Save {changed.length ? `(${changed.length} change${changed.length === 1 ? '' : 's'})` : ''}</Button>
              <Button disabled={!changed.length || busy} onClick={() => setDraft(snapshot(data))}>Reset</Button>
            </FormActions>
          </div>
        </Card>
      )}
    </>
  );
}
