import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Plus } from 'lucide-react';
import { PageHeader, Card } from '../../../components/Common.jsx';
import { ZonePicker, useZone } from '../../dns/ZonePicker.jsx';
import { ZoneEditor } from '../../dns/ZoneEditor.jsx';

export default function DnsZoneManager({ fn }) {
  const [domain, setDomain] = useState('');
  const { zone, loading, error, refetch, setData } = useZone(domain);
  return (
    <>
      <PageHeader fn={fn} description="Edit A, AAAA, CNAME, MX, TXT, SRV, NS, CAA and PTR records, the SOA, or the raw zone file. Every change is validated, written to BIND and reloaded."
        actions={<Link className="btn btn-primary" to="/dns-functions/add-a-dns-zone"><Plus size={16} /> Add a DNS Zone</Link>} />
      <Card title="Select a zone"><ZonePicker value={domain} onChange={setDomain} /></Card>
      {domain && <ZoneEditor domain={domain} zone={zone} loading={loading} error={error} refetch={refetch} setData={setData} />}
    </>
  );
}
