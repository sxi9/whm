import { useEffect, useState } from 'react';
import { api } from '../../../api/client.js';
import { useApi } from '../../../hooks/useApi.js';
import { PageHeader, Card, StatusPill, KeyValue, Loading, CapabilityNotice } from '../../../components/Common.jsx';
import { Field, TextInput, Select, Toggle, NumberInput, Button, FormActions, ErrorBanner } from '../../../components/Form.jsx';
import { useToast } from '../../../components/Toast.jsx';
import { useConfirm } from '../../../components/Modal.jsx';
import { ZonePicker, publishMessage } from '../../dns/ZonePicker.jsx';

function buildSpf({ a, mx, ip4, ip6, include, all }) {
  const parts = ['v=spf1'];
  if (a) parts.push('+a');
  if (mx) parts.push('+mx');
  for (const ip of ip4.split(/[\s,]+/).filter(Boolean)) parts.push(`ip4:${ip}`);
  for (const ip of ip6.split(/[\s,]+/).filter(Boolean)) parts.push(`ip6:${ip}`);
  for (const inc of include.split(/[\s,]+/).filter(Boolean)) parts.push(`include:${inc}`);
  parts.push(all);
  return parts.join(' ');
}

function parseSpf(value) {
  const out = { a: false, mx: false, ip4: [], ip6: [], include: [], all: '~all' };
  for (const tok of (value || '').split(/\s+/).slice(1)) {
    const t = tok.replace(/^\+/, '');
    if (t === 'a') out.a = true;
    else if (t === 'mx') out.mx = true;
    else if (t.startsWith('ip4:')) out.ip4.push(t.slice(4));
    else if (t.startsWith('ip6:')) out.ip6.push(t.slice(4));
    else if (t.startsWith('include:')) out.include.push(t.slice(8));
    else if (/^[-~?+]?all$/.test(tok)) out.all = tok === 'all' ? '+all' : tok;
  }
  return { ...out, ip4: out.ip4.join(', '), ip6: out.ip6.join(', '), include: out.include.join(', ') };
}

function SpfCard({ domain, status, onChange }) {
  const toast = useToast();
  const [form, setForm] = useState(parseSpf(status.spf?.value || status.suggestions.spf));
  const [raw, setRaw] = useState(status.spf?.value || status.suggestions.spf);
  const [mode, setMode] = useState('builder');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { setForm(parseSpf(status.spf?.value || status.suggestions.spf)); setRaw(status.spf?.value || status.suggestions.spf); }, [status]);
  const set = (k) => (v) => setForm((f) => ({ ...f, [k]: v }));
  const value = mode === 'builder' ? buildSpf(form) : raw;
  const save = async () => {
    setBusy(true); setError(null);
    try { const { data } = await api.put(`/dns/zones/${domain}/email/spf`, { value }); toast.success(publishMessage(data, 'SPF record saved')); onChange(data); } catch (err) { setError(err); } finally { setBusy(false); }
  };
  return (
    <Card title="SPF" subtitle="Which hosts may send mail for this domain (TXT record at the zone apex)" actions={<StatusPill status={status.spf ? 'ok' : 'warning'}>{status.spf ? 'configured' : 'missing'}</StatusPill>}>
      <ErrorBanner error={error} />
      <div className="form-actions"><Button size="sm" variant={mode === 'builder' ? 'primary' : 'default'} onClick={() => setMode('builder')}>Builder</Button><Button size="sm" variant={mode === 'raw' ? 'primary' : 'default'} onClick={() => { setRaw(buildSpf(form)); setMode('raw'); }}>Raw</Button></div>
      {mode === 'builder' ? (
        <>
          <Field inline><Toggle checked={form.a} onChange={set('a')} label="Allow the domain's A/AAAA addresses (+a)" /></Field>
          <Field inline><Toggle checked={form.mx} onChange={set('mx')} label="Allow the domain's mail exchangers (+mx)" /></Field>
          <div className="form-grid">
            <Field label="Additional IPv4 (ip4:)" help="Comma-separated, CIDR allowed"><TextInput value={form.ip4} onChange={set('ip4')} placeholder="203.0.113.10, 198.51.100.0/24" /></Field>
            <Field label="Additional IPv6 (ip6:)"><TextInput value={form.ip6} onChange={set('ip6')} placeholder="2001:db8::/32" /></Field>
            <Field label="Include (include:)" help="Third-party senders, e.g. _spf.google.com"><TextInput value={form.include} onChange={set('include')} placeholder="_spf.google.com" /></Field>
            <Field label="Everyone else"><Select value={form.all} onChange={set('all')} options={[{ value: '-all', label: 'Fail (-all, strict)' }, { value: '~all', label: 'Soft fail (~all, recommended)' }, { value: '?all', label: 'Neutral (?all)' }]} /></Field>
          </div>
        </>
      ) : <Field label="SPF record"><TextInput value={raw} onChange={setRaw} /></Field>}
      <KeyValue items={[['Will publish', <code key="v">{value}</code>], status.spf && ['Currently', <code key="c">{status.spf.value}</code>]]} />
      <FormActions><Button variant="primary" loading={busy} onClick={save}>Save SPF</Button></FormActions>
    </Card>
  );
}

function DkimCard({ domain, status, onChange }) {
  const toast = useToast();
  const confirm = useConfirm();
  const [selector, setSelector] = useState(status.dkimKey?.selector || 'default');
  const [bits, setBits] = useState('2048');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  useEffect(() => setSelector(status.dkimKey?.selector || 'default'), [status]);
  const run = async (rotate) => {
    if (rotate && !(await confirm({ title: 'Rotate the DKIM key?', message: 'Mail signed with the old key will fail verification once the new public key is published. Make sure the mail server picks up the new private key.', confirmLabel: 'Rotate', danger: true }))) return;
    setBusy(true); setError(null);
    try { const { data } = await api.post(`/dns/zones/${domain}/email/dkim`, { selector, bits: Number(bits), rotate }); toast.success(publishMessage(data, data.dkimResult.generated ? 'DKIM key generated' : 'DKIM record ensured')); onChange(data); } catch (err) { setError(err); } finally { setBusy(false); }
  };
  const remove = async () => {
    if (!(await confirm({ title: 'Remove DKIM?', message: 'Deletes the stored private key and the public TXT record.', confirmLabel: 'Remove', danger: true }))) return;
    setBusy(true);
    try { const { data } = await api.delete(`/dns/zones/${domain}/email/dkim`); toast.success(publishMessage(data, 'DKIM removed')); onChange(data); } catch (err) { toast.error(err); } finally { setBusy(false); }
  };
  return (
    <Card title="DKIM" subtitle="An RSA key pair is generated here; the private key is stored encrypted for the mail server and the public key is published as a TXT record" actions={<StatusPill status={status.dkim ? 'ok' : 'warning'}>{status.dkim ? `signed · ${status.dkim.selector}` : 'missing'}</StatusPill>}>
      <ErrorBanner error={error} />
      <div className="form-grid">
        <Field label="Selector" help="Becomes <selector>._domainkey" error={error?.fields?.selector}><TextInput value={selector} onChange={(v) => setSelector(v.toLowerCase())} /></Field>
        <Field label="Key size"><Select value={bits} onChange={setBits} options={[{ value: '1024', label: '1024 bits' }, { value: '2048', label: '2048 bits (recommended)' }, { value: '4096', label: '4096 bits' }]} /></Field>
      </div>
      {status.dkim && <KeyValue items={[['Record', <code key="n">{status.dkim.name}.{domain}</code>], ['Key created', status.dkimKey?.createdAt], ['Public key TXT', <code key="v" style={{ wordBreak: 'break-all' }}>{status.dkim.value}</code>]]} />}
      <FormActions>
        <Button variant="primary" loading={busy} onClick={() => run(false)}>{status.dkimKey ? 'Ensure record' : 'Generate key & publish'}</Button>
        {status.dkimKey && <Button loading={busy} onClick={() => run(true)}>Rotate key</Button>}
        {status.dkimKey && <Button variant="danger" loading={busy} onClick={remove}>Remove DKIM</Button>}
      </FormActions>
    </Card>
  );
}

function DmarcCard({ domain, status, onChange }) {
  const toast = useToast();
  const [form, setForm] = useState({ p: 'none', sp: '', rua: `postmaster@${domain}`, ruf: '', pct: 100, adkim: '', aspf: '' });
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const set = (k) => (v) => setForm((f) => ({ ...f, [k]: v }));
  const save = async () => {
    setBusy(true); setError(null);
    const body = Object.fromEntries(Object.entries(form).filter(([, v]) => v !== '' && v != null));
    try { const { data } = await api.put(`/dns/zones/${domain}/email/dmarc`, body); toast.success(publishMessage(data, 'DMARC record saved')); onChange(data); } catch (err) { setError(err); } finally { setBusy(false); }
  };
  return (
    <Card title="DMARC" subtitle="Tells receivers what to do when SPF/DKIM fail and where to send reports (TXT at _dmarc)" actions={<StatusPill status={status.dmarc ? 'ok' : 'warning'}>{status.dmarc ? 'configured' : 'missing'}</StatusPill>}>
      <ErrorBanner error={error} />
      <div className="form-grid">
        <Field label="Policy (p)"><Select value={form.p} onChange={set('p')} options={[{ value: 'none', label: 'none — monitor only' }, { value: 'quarantine', label: 'quarantine' }, { value: 'reject', label: 'reject' }]} /></Field>
        <Field label="Subdomain policy (sp)"><Select value={form.sp} onChange={set('sp')} options={['none', 'quarantine', 'reject']} placeholder="Same as p" /></Field>
        <Field label="Aggregate reports (rua)" help="Email address(es)"><TextInput value={form.rua} onChange={set('rua')} /></Field>
        <Field label="Forensic reports (ruf)"><TextInput value={form.ruf} onChange={set('ruf')} /></Field>
        <Field label="Percentage (pct)"><NumberInput value={form.pct} onChange={(v) => set('pct')(v ?? 100)} min={0} max={100} nullable={false} /></Field>
        <Field label="DKIM alignment (adkim)"><Select value={form.adkim} onChange={set('adkim')} options={[{ value: 'r', label: 'relaxed' }, { value: 's', label: 'strict' }]} placeholder="relaxed (default)" /></Field>
        <Field label="SPF alignment (aspf)"><Select value={form.aspf} onChange={set('aspf')} options={[{ value: 'r', label: 'relaxed' }, { value: 's', label: 'strict' }]} placeholder="relaxed (default)" /></Field>
      </div>
      {status.dmarc && <KeyValue items={[['Currently', <code key="c">{status.dmarc.value}</code>]]} />}
      <FormActions><Button variant="primary" loading={busy} onClick={save}>Save DMARC</Button></FormActions>
    </Card>
  );
}

export default function EmailDnsRecordManager({ fn }) {
  const [domain, setDomain] = useState('');
  const { data: status, loading, error, refetch, setData } = useApi(domain ? `/dns/zones/${domain}/email` : null, { enabled: Boolean(domain) });
  const onChange = (data) => { if (data?.domain) setData(data); refetch(); };
  return (
    <>
      <PageHeader fn={fn} description="Generate and publish SPF, DKIM and DMARC records for a domain. DKIM private keys are stored encrypted and handed to the mail server." />
      <Card title="Select a domain"><ZonePicker value={domain} onChange={setDomain} label="Domain" /></Card>
      {domain && loading && !status && <Loading />}
      {domain && error && <><CapabilityNotice error={error} onRetry={refetch} />{error.code !== 'capability_missing' && <ErrorBanner error={error} onRetry={refetch} />}</>}
      {domain && status && (
        <>
          <Card title="Mail exchangers">
            {status.mx.length ? <KeyValue items={status.mx.map((m) => [`MX ${m.priority}`, <code key={m.id}>{m.value}</code>])} /> : <p className="muted">No MX records; see Email Routing Configuration.</p>}
          </Card>
          <SpfCard domain={domain} status={status} onChange={onChange} />
          <DkimCard domain={domain} status={status} onChange={onChange} />
          <DmarcCard domain={domain} status={status} onChange={onChange} />
        </>
      )}
    </>
  );
}
