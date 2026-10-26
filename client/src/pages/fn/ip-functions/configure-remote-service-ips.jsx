import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../../api/client.js';
import { useApi } from '../../../hooks/useApi.js';
import { PageHeader, Card, Loading, StatusPill } from '../../../components/Common.jsx';
import { Field, Select, Button, FormActions, ErrorBanner } from '../../../components/Form.jsx';
import { useToast } from '../../../components/Toast.jsx';
import { IpRequestError } from '../../ip/Shared.jsx';

const toDraft = (services) => Object.fromEntries(services.map((s) => [s.key, { ipv4: s.ipv4 || '', ipv6: s.ipv6 || '' }]));

export default function ConfigureRemoteServiceIps({ fn }) {
  const toast = useToast();
  const { data, loading, error, refetch } = useApi('/ip/remote-services');
  const [draft, setDraft] = useState(null);
  const [saveError, setSaveError] = useState(null);
  const [applied, setApplied] = useState(null);
  const [applyErrors, setApplyErrors] = useState({});
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (data) { setDraft(toDraft(data.services)); setApplied(null); setApplyErrors({}); } }, [data]);

  const original = data ? toDraft(data.services) : {};
  const changedKeys = draft ? Object.keys(draft).filter((k) => JSON.stringify(draft[k]) !== JSON.stringify(original[k])) : [];
  const set = (key, field) => (value) => setDraft((d) => ({ ...d, [key]: { ...d[key], [field]: value } }));

  const save = async () => {
    setBusy(true); setSaveError(null);
    try {
      const body = Object.fromEntries(changedKeys.map((k) => [k, draft[k]]));
      const { data: res } = await api.put('/ip/remote-services', body);
      setApplied(res.applied);
      setApplyErrors(res.applyErrors || {});
      const failed = Object.keys(res.applied || {}).filter((k) => res.applied[k] === 'failed');
      if (failed.length) toast.error(`Saved, but ${failed.join(', ')} could not apply the new address`); else toast.success('Remote service IPs saved');
      refetch();
    } catch (err) { setSaveError(err); } finally { setBusy(false); }
  };

  const options = (list) => [{ value: '', label: 'Default (main IP / kernel choice)' }, ...list.map((a) => ({ value: a, label: a }))];
  return (
    <>
      <PageHeader fn={fn} description="Chooses which of the server's addresses each service uses when it talks to the outside: outgoing mail, DNS lookups and cluster pushes, remote database connections, FTP passive data and the panel's own API calls. Only addresses bound to this server can be selected; the owning service is reconfigured when it is installed." />
      <IpRequestError error={error} onRetry={refetch} />
      {loading && !data && <Loading />}
      {data && draft && (
        <>
          {!data.candidates.ipv4.length && !data.candidates.ipv6.length && <div className="banner banner-info"><div>No addresses are recorded yet. Run <Link to="/ip-functions/rebuild-the-ip-address-pool">Rebuild the IP Address Pool</Link> or <Link to="/ip-functions/add-a-new-ip-address">add an address</Link> first.</div></div>}
          {data.services.map((s) => (
            <Card key={s.key} title={s.label} subtitle={s.help} className="config-fields">
              <div className="form-grid">
                <Field label="IPv4 source address" error={saveError?.fields?.[`${s.key}.ipv4`]}><Select value={draft[s.key].ipv4} onChange={set(s.key, 'ipv4')} options={options(data.candidates.ipv4)} /></Field>
                <Field label="IPv6 source address" error={saveError?.fields?.[`${s.key}.ipv6`]}><Select value={draft[s.key].ipv6} onChange={set(s.key, 'ipv6')} options={options(data.candidates.ipv6)} /></Field>
              </div>
              {applied?.[s.key] && (
                <div className="row-actions">
                  <StatusPill status={applied[s.key] === 'applied' ? 'ok' : applied[s.key] === 'failed' ? 'failed' : 'pending'}>{applied[s.key] === 'saved' ? 'saved — applied when the service is installed' : applied[s.key]}</StatusPill>
                  {applyErrors[s.key] && <span className="muted">{applyErrors[s.key]}</span>}
                </div>
              )}
            </Card>
          ))}
          <div className="sticky-actions">
            <ErrorBanner error={saveError && !saveError.fields ? saveError : null} />
            {saveError?.fields && <div className="banner banner-error"><div>{saveError.message}</div></div>}
            <FormActions>
              <Button variant="primary" loading={busy} disabled={!changedKeys.length} onClick={save}>Save</Button>
              <Button disabled={!changedKeys.length || busy} onClick={() => setDraft(toDraft(data.services))}>Reset</Button>
            </FormActions>
          </div>
        </>
      )}
    </>
  );
}
