import { useEffect, useMemo, useState } from 'react';
import { api } from '../../../api/client.js';
import { useApi } from '../../../hooks/useApi.js';
import { PageHeader, Card, Loading, KeyValue, StatusPill, CapabilityNotice } from '../../../components/Common.jsx';
import { Field, Select, TextInput, Toggle, Button, FormActions } from '../../../components/Form.jsx';
import { useToast } from '../../../components/Toast.jsx';
import { RequestError, YesNo } from '../../server-configuration/Shared.jsx';

// The browser knows the IANA list too; the server's list wins when it answers.
const LOCAL_ZONES = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : ['UTC'];

export default function ServerTime({ fn }) {
  const toast = useToast();
  const { data, loading, error, refetch } = useApi('/server-config/time', { refreshMs: 30_000 });
  const [timezone, setTimezone] = useState('');
  const [ntp, setNtp] = useState(true);
  const [filter, setFilter] = useState('');
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState(null);
  const [tick, setTick] = useState(Date.now());

  useEffect(() => { if (data) { setTimezone(data.timezone || 'UTC'); setNtp(Boolean(data.ntp)); } }, [data]);
  useEffect(() => { const t = setInterval(() => setTick(Date.now()), 1000); return () => clearInterval(t); }, []);

  const zones = useMemo(() => {
    const all = data?.timezones?.length ? data.timezones : LOCAL_ZONES;
    const f = filter.trim().toLowerCase();
    return f ? all.filter((z) => z.toLowerCase().includes(f)) : all;
  }, [data, filter]);
  const offset = useMemo(() => { try { return new Intl.DateTimeFormat('en-US', { timeZone: timezone || 'UTC', timeZoneName: 'longOffset' }).formatToParts(new Date()).find((p) => p.type === 'timeZoneName')?.value; } catch { return null; } }, [timezone, tick]);
  const serverClock = useMemo(() => { if (!data) return null; const skew = Date.now() - data.serverEpochMs; try { return new Date(new Date(data.now).getTime() + skew).toLocaleString('en-GB', { timeZone: timezone || 'UTC', hour12: false, dateStyle: 'full', timeStyle: 'long' }); } catch { return new Date(data.now).toISOString(); } }, [data, timezone, tick]);
  const dirty = data && (timezone !== (data.timezone || 'UTC') || ntp !== Boolean(data.ntp));

  const save = async () => {
    setBusy(true); setSaveError(null);
    const body = {};
    if (timezone !== (data.timezone || 'UTC')) body.timezone = timezone;
    if (ntp !== Boolean(data.ntp)) body.ntp = ntp;
    try { await api.put('/server-config/time', body); toast.success('Server time settings applied'); refetch(); } catch (err) { setSaveError(err); if (err.status !== 501) toast.error(err); } finally { setBusy(false); }
  };

  return (
    <>
      <PageHeader fn={fn} description="Set the system timezone and keep the clock synchronised with NTP through systemd's timedatectl. Mail headers, logs and cron use this clock." />
      <RequestError error={error} onRetry={refetch} />
      {loading && !data && <Loading />}
      {data && (
        <>
          <div className="form-grid">
            <Card title="Current server time">
              <KeyValue items={[['Server clock', <strong key="c">{serverClock}</strong>], ['System timezone', data.timezone || 'unknown'], ['NTP synchronisation', <YesNo key="n" value={data.ntp} yes="enabled" no="disabled" unknown="timedatectl missing" />], ['Clock synchronised', <YesNo key="s" value={data.ntpSynchronized} yes="synchronised" no="not synchronised" />], ['RTC in local time', <YesNo key="r" value={data.rtcLocal} yes="yes (Windows dual-boot style)" no="no (UTC, recommended)" />],
                ['NTP service', data.ntpService ? <StatusPill key="u" status={data.ntpService.active ? 'active' : 'inactive'}>{data.ntpService.unit}: {data.ntpService.state}</StatusPill> : <span key="u" className="muted">no NTP daemon unit found (systemd-timesyncd, chrony or ntpd)</span>]]} />
            </Card>
            <Card title="Change timezone and NTP">
              {!data.timedatectl && <CapabilityNotice error={{ code: 'capability_missing', message: 'timedatectl (systemd) is not available on this server, so the timezone and NTP cannot be changed from the panel.' }} onRetry={refetch} />}
              <Field label="Find a timezone" help="Type a city or region to filter the list"><TextInput value={filter} onChange={setFilter} placeholder="e.g. Berlin, New_York, Tokyo" /></Field>
              <Field label="Timezone" help={offset ? `Current offset ${offset}` : undefined}><Select value={zones.includes(timezone) ? timezone : ''} onChange={setTimezone} options={zones} placeholder={zones.includes(timezone) ? undefined : `${timezone} (filtered out)`} /></Field>
              <Field inline><Toggle checked={ntp} onChange={setNtp} label="Synchronise the clock with NTP" description="timedatectl set-ntp; uses systemd-timesyncd or the installed NTP daemon." /></Field>
              <RequestError error={saveError} onRetry={() => setSaveError(null)} />
              <FormActions>
                <Button variant="primary" loading={busy} disabled={!dirty || !data.timedatectl} onClick={save}>Apply</Button>
                <Button disabled={!dirty || busy} onClick={() => { setTimezone(data.timezone || 'UTC'); setNtp(Boolean(data.ntp)); }}>Reset</Button>
              </FormActions>
            </Card>
          </div>
        </>
      )}
    </>
  );
}
