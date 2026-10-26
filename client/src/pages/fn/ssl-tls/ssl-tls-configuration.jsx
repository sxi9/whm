import { useEffect, useState } from 'react';
import { api } from '../../../api/client.js';
import { useApi } from '../../../hooks/useApi.js';
import { PageHeader, Card, Loading, StatusPill, KeyValue } from '../../../components/Common.jsx';
import { Field, Textarea, NumberInput, Toggle, Button, FormActions, RadioGroup } from '../../../components/Form.jsx';
import { useConfirm } from '../../../components/Modal.jsx';
import { useToast } from '../../../components/Toast.jsx';
import { RequestError, isCapabilityError } from '../../ssl/Shared.jsx';

const PROTOCOLS = ['TLSv1', 'TLSv1.1', 'TLSv1.2', 'TLSv1.3'];
const SERVICES = [{ key: 'apache', label: 'Apache (all SSL vhosts)' }, { key: 'exim', label: 'Exim (SMTP)' }, { key: 'dovecot', label: 'Dovecot (IMAP/POP3)' }];

export default function SslTlsConfiguration({ fn }) {
  const toast = useToast();
  const confirm = useConfirm();
  const { data, loading, error, refetch } = useApi('/ssl/tls-config');
  const [draft, setDraft] = useState(null);
  const [busy, setBusy] = useState(false);
  const [applied, setApplied] = useState(null);
  const [applyError, setApplyError] = useState(null);

  useEffect(() => { if (data) setDraft(data.settings); }, [data]);

  const choosePreset = (preset) => {
    if (preset === 'custom') { setDraft({ ...draft, preset }); return; }
    const p = data.presets[preset];
    setDraft({ ...draft, preset, protocols: p.protocols, ciphers: p.ciphers, ciphersuites: p.ciphersuites, preferServerCiphers: p.preferServerCiphers });
  };
  const toggleProtocol = (p) => setDraft({ ...draft, preset: 'custom', protocols: draft.protocols.includes(p) ? draft.protocols.filter((x) => x !== p) : PROTOCOLS.filter((x) => x === p || draft.protocols.includes(x)) });
  const toggleService = (s) => setDraft({ ...draft, services: draft.services.includes(s) ? draft.services.filter((x) => x !== s) : [...draft.services, s] });

  const save = async (apply) => {
    if (apply && draft.protocols.length === 1 && draft.protocols[0] === 'TLSv1.3' && !(await confirm({ title: 'TLS 1.3 only?', message: 'Clients older than 2019 (and many mail apps) will no longer connect to websites, SMTP, IMAP or POP3 on this server.', confirmLabel: 'Apply' }))) return;
    setBusy(true);
    setApplyError(null);
    try {
      const { data: d } = await api.put('/ssl/tls-config', { preset: draft.preset, protocols: draft.protocols, ciphers: draft.ciphers.trim(), ciphersuites: draft.ciphersuites.trim(), preferServerCiphers: Boolean(draft.preferServerCiphers), services: draft.services, hsts: { enabled: Boolean(draft.hsts.enabled), maxAge: Number(draft.hsts.maxAge), includeSubdomains: Boolean(draft.hsts.includeSubdomains), preload: Boolean(draft.hsts.preload) }, apply });
      setApplied(d.applied);
      toast.success(apply ? `TLS policy applied to ${d.applied.applied.join(', ')}` : 'TLS policy saved');
      refetch();
    } catch (err) {
      if (isCapabilityError(err)) { setApplyError(err); toast.warning('Policy saved; no daemon to apply it to yet'); refetch(); } else toast.error(err);
    } finally { setBusy(false); }
  };

  return (
    <>
      <PageHeader fn={fn} />
      <RequestError error={error} onRetry={refetch} />
      {loading && !data && <Loading />}
      {data && draft && (
        <>
          <div className="form-grid">
            <Card title="Profile" subtitle="Mozilla-style presets. Switching a protocol or cipher turns the profile into Custom.">
              <RadioGroup name="preset" value={draft.preset} onChange={choosePreset} options={[...Object.entries(data.presets).map(([k, p]) => ({ value: k, label: p.label, description: p.description })), { value: 'custom', label: 'Custom', description: 'Hand-edited protocols and cipher list below.' }]} />
              <Field label="Protocols">
                <div className="row-actions" style={{ flexWrap: 'wrap' }}>
                  {PROTOCOLS.map((p) => <Toggle key={p} checked={draft.protocols.includes(p)} onChange={() => toggleProtocol(p)} label={p} />)}
                </div>
                {draft.protocols.some((p) => p === 'TLSv1' || p === 'TLSv1.1') && <div className="banner banner-warning" style={{ marginTop: 8 }}><div>TLS 1.0/1.1 are deprecated (RFC 8996) and fail PCI-DSS scans.</div></div>}
              </Field>
              <Field label="Cipher list (TLS ≤ 1.2)" help="OpenSSL cipher string syntax. Applied to Apache SSLCipherSuite, Exim tls_require_ciphers and Dovecot ssl_cipher_list."><Textarea value={draft.ciphers} onChange={(v) => setDraft({ ...draft, preset: 'custom', ciphers: v })} rows={4} mono /></Field>
              <Field label="TLS 1.3 cipher suites" help="Colon-separated TLS_* names; leave empty for the library default."><Textarea value={draft.ciphersuites} onChange={(v) => setDraft({ ...draft, preset: 'custom', ciphersuites: v })} rows={2} mono /></Field>
              <Field inline><Toggle checked={draft.preferServerCiphers} onChange={(v) => setDraft({ ...draft, preferServerCiphers: v })} label="Prefer the server's cipher order" /></Field>
            </Card>
            <div>
              <Card title="HTTP Strict Transport Security" subtitle="Sent by Apache on every HTTPS response. Only enable once every site on this server works over HTTPS.">
                <Field inline><Toggle checked={draft.hsts.enabled} onChange={(v) => setDraft({ ...draft, hsts: { ...draft.hsts, enabled: v } })} label="Enable HSTS" /></Field>
                <Field label="max-age (seconds)" help="31536000 = 1 year; preload lists require ≥ 1 year with includeSubDomains."><NumberInput value={draft.hsts.maxAge} onChange={(v) => setDraft({ ...draft, hsts: { ...draft.hsts, maxAge: v } })} min={0} max={63072000} nullable={false} disabled={!draft.hsts.enabled} /></Field>
                <Field inline><Toggle checked={draft.hsts.includeSubdomains} onChange={(v) => setDraft({ ...draft, hsts: { ...draft.hsts, includeSubdomains: v } })} label="includeSubDomains" disabled={!draft.hsts.enabled} /></Field>
                <Field inline><Toggle checked={draft.hsts.preload} onChange={(v) => setDraft({ ...draft, hsts: { ...draft.hsts, preload: v } })} label="preload" description="Browsers hard-code the domain as HTTPS-only; removal takes months." disabled={!draft.hsts.enabled} /></Field>
              </Card>
              <Card title="Apply to" subtitle="Each daemon gets a managed include; Apache, Exim and Dovecot configs are validated and rolled back if rejected.">
                {SERVICES.map((s) => (
                  <Field inline key={s.key}>
                    <Toggle checked={draft.services.includes(s.key)} onChange={() => toggleService(s.key)} label={s.label} description={data.daemons[s.key] ? (data.status[s.key]?.path ? `Managed file: ${data.status[s.key].path}${data.status[s.key].content ? '' : ' (not written yet)'}` : 'installed') : 'not installed on this server'} />
                  </Field>
                ))}
                {data.status?.exim?.includeMode === 'manual' && <p className="muted">Exim uses a single configuration file here; add <code>.include {data.status.exim.path}</code> to its main section once.</p>}
                {data.status?.exim?.includeMode === 'localmacros' && <p className="muted">Exim runs Debian's unsplit configuration here; the policy is kept as a managed block in <code>{data.status.exim.path}</code>, which update-exim4.conf reads in both modes.</p>}
                {data.status?.exim?.library === 'gnutls' && <p className="muted">Exim is built with GnuTLS here: the cipher list cannot be translated, so its include carries a priority string with the protocol floor and server preference only.</p>}
              </Card>
            </div>
          </div>
          <Card>
            <FormActions>
              <Button variant="primary" loading={busy} disabled={!draft.protocols.length || !draft.services.length} onClick={() => save(true)}>Save and apply</Button>
              <Button loading={busy} onClick={() => save(false)}>Save only</Button>
              <Button disabled={busy} onClick={() => setDraft(data.settings)}>Reset</Button>
            </FormActions>
            <RequestError error={applyError} />
            {applied && (
              <div className="action-result">
                <KeyValue items={Object.entries(applied.results).map(([svc, r]) => [svc, <span key={svc}><code className="small">{r.path}</code> {r.validated ? <StatusPill status="ok">validated</StatusPill> : null} {r.library ? <StatusPill status="neutral">{r.library}</StatusPill> : null} <StatusPill status={r.reload?.reloaded ? 'ok' : 'warning'}>{r.reload?.reloaded ? `${r.reload.unit} reloaded` : r.reload?.error || r.note || 'not reloaded'}</StatusPill></span>])} />
              </div>
            )}
            {Object.entries(data.status || {}).filter(([, s]) => s.content).map(([svc, s]) => (
              <details key={svc} style={{ marginTop: 10 }}><summary className="muted">Current managed include for {svc}: <code>{s.path}</code></summary><pre className="log">{s.content}</pre></details>
            ))}
          </Card>
        </>
      )}
    </>
  );
}
