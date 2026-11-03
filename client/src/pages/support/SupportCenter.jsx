import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ExternalLink, Download, BookOpen, Save, LifeBuoy, KeyRound } from 'lucide-react';
import { api } from '../../api/client.js';
import { useApi, useMutation } from '../../hooks/useApi.js';
import { useAuth } from '../../auth/AuthContext.jsx';
import { Card, KeyValue, Loading, StatusPill, formatDate } from '../../components/Common.jsx';
import { Field, TextInput, NumberInput, Button, FormActions, ErrorBanner } from '../../components/Form.jsx';
import { useToast } from '../../components/Toast.jsx';
import { Markdown } from '../development/Shared.jsx';
import { SeverityPill, RequestError, CopyButton, downloadText } from './Shared.jsx';

function LinkGrid({ links, external = false }) {
  if (!links.length) return <p className="muted" style={{ margin: 0 }}>No links are configured. Resources appear here once the support settings name them.</p>;
  return (
    <div className="tool-grid">
      {links.map((l) => (
        <div key={l.key} className="tool-card">
          {external
            ? <a className="tool-link" href={l.url} target="_blank" rel="noreferrer noopener"><strong>{l.label} <ExternalLink size={13} /></strong><small>{l.description}</small></a>
            : <Link className="tool-link" to={l.path}><strong>{l.label}</strong><small>{l.description}</small></Link>}
        </div>
      ))}
    </div>
  );
}

export function SupportSettings({ settings, onSaved }) {
  const toast = useToast();
  const [form, setForm] = useState(null);
  useEffect(() => { if (settings) setForm({ email: settings.email, providerName: settings.providerName, portalUrl: settings.portalUrl, defaultHours: settings.access.defaultHours, maxHours: settings.access.maxHours }); }, [settings]);
  const { mutate, loading, error, fieldErrors } = useMutation((body) => api.put('/support/settings', body));
  if (!form) return null;
  const set = (k) => (v) => setForm((f) => ({ ...f, [k]: v }));
  const submit = async (e) => {
    e.preventDefault();
    try {
      await mutate({ email: form.email, providerName: form.providerName, portalUrl: form.portalUrl, access: { defaultHours: form.defaultHours || 1, maxHours: form.maxHours || 1 } });
      toast.success('Support settings saved');
      onSaved?.();
    } catch (err) { if (!err.fields) toast.error(err); }
  };
  return (
    <Card title="Settings" subtitle="Where tickets go and how long support access may last.">
      <form onSubmit={submit}>
        <ErrorBanner error={error && !fieldErrors ? error : null} />
        <div className="form-grid">
          <Field label="Support email address" error={fieldErrors?.email} help="Tickets are emailed here with their snapshot. Leave empty to only keep tickets on this server."><TextInput value={form.email} onChange={set('email')} type="email" placeholder="support@example.com" /></Field>
          <Field label="Provider name" error={fieldErrors?.providerName}><TextInput value={form.providerName} onChange={set('providerName')} maxLength={80} /></Field>
          <Field label="Support portal URL" error={fieldErrors?.portalUrl} help="Shown as the first link above."><TextInput value={form.portalUrl} onChange={set('portalUrl')} placeholder="https://" /></Field>
          <Field label="Default grant length (hours)" error={fieldErrors?.['access.defaultHours']}><NumberInput value={form.defaultHours} onChange={set('defaultHours')} min={1} max={8760} nullable={false} /></Field>
          <Field label="Maximum grant length (hours)" error={fieldErrors?.['access.maxHours']}><NumberInput value={form.maxHours} onChange={set('maxHours')} min={1} max={8760} nullable={false} /></Field>
        </div>
        <FormActions><Button type="submit" variant="primary" icon={Save} loading={loading}>Save</Button></FormActions>
      </form>
    </Card>
  );
}

const DOC_TABLE_CSS = '.support-doc .markdown th { white-space: normal; } .support-doc .markdown th code, .support-doc .markdown td code { overflow-wrap: anywhere; }';

function DocReader({ docs }) {
  const [params, setParams] = useSearchParams();
  const slug = params.get('doc');
  const section = params.get('section');
  const [doc, setDoc] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    if (!slug) { setDoc(null); return undefined; }
    let cancelled = false;
    setLoading(true); setError(null);
    api.get(`/support/docs/${slug}${section ? `?section=${encodeURIComponent(section)}` : ''}`).then(({ data }) => { if (!cancelled) setDoc(data); }).catch((err) => { if (!cancelled) setError(err); }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [slug, section]);
  const open = (nextSlug, nextSection) => { const p = new URLSearchParams(); if (nextSlug) p.set('doc', nextSlug); if (nextSection) p.set('section', nextSection); setParams(p); };

  if (!slug) {
    return (
      <Card title="Documentation shipped with this panel" subtitle="Read here, straight from the installed version." padded={false}>
        {docs.length === 0 && <p className="muted" style={{ margin: 0, padding: 20 }}>No documents are shipped with this install. The README and the blueprint appear here when they are present.</p>}
        {docs.map((d, i) => (
          <div key={d.slug} className="card-body" style={{ borderTop: i ? '1px solid var(--border)' : 0 }}>
            <h3>{d.available ? <button className="link-button" onClick={() => open(d.slug)}><BookOpen size={15} /> {d.title}</button> : d.title}</h3>
            <p className="muted" style={{ margin: '4px 0 0' }}>{d.summary}{d.available ? <> · <code>{d.file}</code>{d.updatedAt ? ` · updated ${formatDate(d.updatedAt)}` : ''}</> : ' · not shipped with this install'}</p>
            {d.available && d.sections.length > 0 && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 10 }}>
                {d.sections.map((s) => <button key={s.slug} className="btn btn-sm" onClick={() => open(d.slug, s.slug)}>{s.title}</button>)}
              </div>
            )}
          </div>
        ))}
      </Card>
    );
  }
  const meta = docs.find((d) => d.slug === slug);
  const toc = (doc?.sections || []).filter((s) => s.level === 2);
  return (
    <Card title={meta?.title || slug} subtitle={section ? `Section: ${doc?.sections?.find((s) => s.slug === section)?.title || section}` : meta?.file}
      actions={<>{doc && <CopyButton text={doc.content} />}{doc && <Button size="sm" icon={Download} onClick={() => downloadText(`${(meta?.file || slug).split('/').pop()}`, doc.content, 'text/markdown')}>Download</Button>}{section && <Button size="sm" onClick={() => open(slug)}>Whole document</Button>}<Button size="sm" onClick={() => open(null)}>All documents</Button></>}>
      <RequestError error={error} onRetry={() => open(slug, section)} />
      {loading && !doc && <Loading text="Loading document…" />}
      {doc && (
        <div style={{ display: 'grid', gridTemplateColumns: toc.length > 3 ? 'minmax(200px, 260px) 1fr' : '1fr', gap: 16, alignItems: 'start' }}>
          {toc.length > 3 && (
            <nav style={{ position: 'sticky', top: 12, maxHeight: '70vh', overflow: 'auto' }}>
              {toc.map((s) => <div key={s.slug}><button className={`link-button ${s.slug === section ? 'active' : ''}`} style={{ padding: '3px 0', textAlign: 'left' }} onClick={() => open(slug, s.slug)}>{s.slug === section ? <strong>{s.title}</strong> : s.title}</button></div>)}
            </nav>
          )}
          <div className="support-doc" style={{ minWidth: 0 }}><style>{DOC_TABLE_CSS}</style><Markdown text={doc.content} /></div>
        </div>
      )}
    </Card>
  );
}

export function SupportCenter() {
  const { user } = useAuth();
  const toast = useToast();
  const { data, loading, error, refetch } = useApi('/support/center');
  const [downloading, setDownloading] = useState(false);
  const isRoot = user?.role === 'root';

  const downloadDiagnostics = async () => {
    setDownloading(true);
    try {
      const res = await api.get('/support/diagnostics');
      downloadText(`keel-diagnostics-${res.data.generatedAt.replace(/[:.]/g, '-')}.json`, JSON.stringify(res.data, null, 2), 'application/json');
      toast.success('Diagnostics bundle downloaded');
    } catch (err) { toast.error(err); } finally { setDownloading(false); }
  };

  return (
    <>
      <RequestError error={error} onRetry={refetch} />
      {loading && !data && <Loading />}
      {data && (
        <>
          {isRoot && (
            <div className="grid-2">
              <Card title="Tickets" actions={<Link className="btn btn-sm" to="/support/create-support-ticket"><LifeBuoy size={14} /> New ticket</Link>}>
                <KeyValue items={[['Open', data.tickets.open.length], ['Total', data.tickets.total], ['Email transport', data.mail.transport ? <StatusPill status="ok">{data.mail.transport}</StatusPill> : <StatusPill status="inactive">none</StatusPill>], ['Support address', data.mail.address || <span className="muted">not set</span>]]} />
                {data.tickets.open.length > 0 && (
                  <ul style={{ margin: '12px 0 0', paddingLeft: 18 }}>
                    {data.tickets.open.map((t) => <li key={t.id}><Link to={`/support/create-support-ticket?ticket=${t.id}`}><code>{t.reference}</code></Link> {t.subject} <SeverityPill severity={t.severity} /> <span className="muted">{formatDate(t.createdAt)}</span></li>)}
                  </ul>
                )}
              </Card>
              <Card title="Support access" actions={<Link className="btn btn-sm" to="/support/grant-cpanel-support-access"><KeyRound size={14} /> Manage</Link>}>
                <KeyValue items={[['Active grants', data.access.active.length], ['Cleanup pending', data.access.cleanupPending?.length ? <StatusPill status="warning">{data.access.cleanupPending.length} (root key still on the host)</StatusPill> : 0], ['sshd', data.access.sshd ? <StatusPill status="installed">installed</StatusPill> : <StatusPill status="not-installed">not installed</StatusPill>]]} />
                {data.access.active.length > 0 && <ul style={{ margin: '12px 0 0', paddingLeft: 18 }}>{data.access.active.map((g) => <li key={g.id}>{g.label} · until {formatDate(g.expiresAt)}{g.ssh ? ' · SSH' : ''}{g.apiToken ? ' · API' : ''}</li>)}</ul>}
              </Card>
              <Card title="Diagnostics" subtitle="A JSON bundle to attach to a ticket by hand: the system snapshot, capabilities, services, failed jobs, schedules, non-secret settings and recent audit entries.">
                <Button icon={Download} loading={downloading} onClick={downloadDiagnostics}>Download diagnostics</Button>
                <p className="muted" style={{ margin: '12px 0 0' }}>Panel {data.panel.version} · {data.panel.mode} mode · Node {data.panel.node}</p>
              </Card>
            </div>
          )}
          <Card title={`${data.settings.providerName || 'Vendor'} and community resources`}><LinkGrid links={data.links} external /></Card>
          <Card title="In this panel"><LinkGrid links={data.inApp} /></Card>
          <DocReader docs={data.docs} />
          {isRoot && <SupportSettings settings={data.settings} onSaved={refetch} />}
        </>
      )}
    </>
  );
}
