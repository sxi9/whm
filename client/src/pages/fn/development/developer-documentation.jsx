import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../../../api/client.js';
import { useApi } from '../../../hooks/useApi.js';
import { PageHeader, Card, Loading, StatusPill, formatDate } from '../../../components/Common.jsx';
import { Button } from '../../../components/Form.jsx';
import { RequestError, Markdown, DocLinks, CopyButton, downloadText } from '../../development/Shared.jsx';

export default function DeveloperDocumentation({ fn }) {
  const [params, setParams] = useSearchParams();
  const docs = useApi('/development/docs');
  const slug = params.get('doc');
  const section = params.get('section');
  const [doc, setDoc] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState('');

  useEffect(() => {
    if (!slug) { setDoc(null); return; }
    let cancelled = false;
    setLoading(true); setError(null);
    api.get(`/development/docs/${slug}${section ? `?section=${section}` : ''}`).then(({ data }) => { if (!cancelled) setDoc(data); }).catch((err) => { if (!cancelled) setError(err); }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [slug, section]);

  const open = (nextSlug, nextSection) => { const p = new URLSearchParams(); if (nextSlug) p.set('doc', nextSlug); if (nextSection) p.set('section', nextSection); setParams(p); window.scrollTo(0, 0); };
  const meta = docs.data?.find((d) => d.slug === slug);
  const sections = (doc?.sections || []).filter((s) => s.level === 2 && (!filter || s.title.toLowerCase().includes(filter.toLowerCase())));

  if (!slug) {
    return (
      <>
        <PageHeader fn={fn} description="The design documents and contracts this panel is built from, served from the install so they always match the running version." />
        <RequestError error={docs.error} onRetry={docs.refetch} />
        {docs.loading && !docs.data && <Loading />}
        {docs.data && <Card title="Documents"><DocLinks docs={docs.data} /></Card>}
        <Card title="Where to start">
          <ul>
            <li><button className="link-button" onClick={() => open('blueprint', '13-complete-functionality-specification')}>Blueprint §13</button> specifies every one of the 212 functions.</li>
            <li><button className="link-button" onClick={() => open('blueprint', '12-api-design-conventions')}>Blueprint §12</button> explains the envelope, pagination and job conventions the API reference relies on.</li>
            <li><button className="link-button" onClick={() => open('category-modules')}>Category route modules</button> and <button className="link-button" onClick={() => open('function-pages')}>Function pages</button> show how a new category or plugin page plugs in.</li>
            <li><button className="link-button" onClick={() => open('plugin-manifest-schema')}>Plugin manifest schema</button> is the contract the Plugin File Generator targets.</li>
          </ul>
        </Card>
      </>
    );
  }

  return (
    <>
      <PageHeader fn={fn} title={meta?.title || slug} description={meta?.summary} actions={<><Button onClick={() => open(null)}>All documents</Button>{doc && <CopyButton text={doc.content} label="Copy" size={undefined} />}{doc && <Button onClick={() => downloadText(doc.file.split('/').pop(), doc.content, doc.type === 'json' ? 'application/json' : 'text/markdown')}>Download</Button>}</>}>
        {meta && <p className="small muted"><code>{meta.file}</code>{meta.size ? ` · ${(meta.size / 1024).toFixed(1)} KB` : ''}{meta.updatedAt ? ` · updated ${formatDate(meta.updatedAt)}` : ''}</p>}
      </PageHeader>
      <RequestError error={error} onRetry={() => open(slug, section)} />
      {loading && !doc && <Loading text="Loading document…" />}
      {doc && (
        <div style={{ display: 'grid', gridTemplateColumns: doc.sections.length > 3 ? 'minmax(220px, 280px) 1fr' : '1fr', gap: 14, alignItems: 'start' }}>
          {doc.sections.length > 3 && (
            <Card title="Sections" padded={false} className="sticky-actions">
              <div style={{ padding: 10 }}><input className="input" placeholder="Filter sections…" value={filter} onChange={(e) => setFilter(e.target.value)} /></div>
              <nav style={{ maxHeight: '70vh', overflow: 'auto' }}>
                <button className={`menu-item ${!section ? 'is-selected' : ''}`} style={{ width: '100%', textAlign: 'left' }} onClick={() => open(slug)}>Whole document</button>
                {sections.map((s) => <button key={s.slug} className="menu-item" style={{ width: '100%', textAlign: 'left', fontWeight: section === s.slug ? 600 : 400 }} onClick={() => open(slug, s.slug)}>{s.title}</button>)}
              </nav>
            </Card>
          )}
          <Card title={section ? doc.sections.find((s) => s.slug === section)?.title || section : undefined} actions={section && <StatusPill status="info">section</StatusPill>}>
            {doc.type === 'json' ? <pre className="log" style={{ maxHeight: 'none' }}>{doc.content}</pre> : <Markdown text={doc.content} />}
          </Card>
        </div>
      )}
    </>
  );
}
