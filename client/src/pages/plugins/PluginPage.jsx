import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Puzzle } from 'lucide-react';
import { api } from '../../api/client.js';
import { useApi, useMutation } from '../../hooks/useApi.js';
import { usePluginNav } from '../../hooks/usePluginNav.js';
import { PageHeader, Card, Loading, EmptyState } from '../../components/Common.jsx';
import { DataTable } from '../../components/DataTable.jsx';
import { Field, TextInput, NumberInput, Textarea, Select, Toggle, PasswordInput, Button, FormActions, ErrorBanner } from '../../components/Form.jsx';
import { ProgressLog } from '../../components/ProgressLog.jsx';
import { useToast } from '../../components/Toast.jsx';
import { useConfirm } from '../../components/Modal.jsx';
import { NotFoundPage } from '../FunctionPage.jsx';

// Generic renderer for plugin UI pages (manifest ui.pages / ctx.ui.registerPage).
// Every kind is drawn with the shared components; plugin HTML only ever runs in
// a fully sandboxed iframe and markdown is rendered to React elements, never to
// raw HTML.

export function pluginFn(plugin, page) {
  return {
    key: `plugin:${plugin.id}:${page.route}`, label: page.title, description: page.description || `${plugin.name} ${plugin.version}`,
    category: 'Plugins', categorySlug: 'plugins', path: `/plugins/${plugin.id}${page.route === '/' ? '' : page.route}`, plugin: true,
  };
}

export function fieldDefault(f) {
  if (f.default !== undefined) return f.default;
  if (f.type === 'toggle') return false;
  if (f.type === 'multiselect') return [];
  if (f.type === 'number') return null;
  return '';
}

export function PluginField({ field, value, onChange, error }) {
  const id = `pf-${field.key}`;
  let control;
  switch (field.type) {
    case 'number':
      control = <NumberInput id={id} value={value} onChange={onChange} min={field.min} max={field.max} step={field.integer ? 1 : 'any'} placeholder={field.placeholder} />;
      break;
    case 'toggle':
      control = <Toggle checked={Boolean(value)} onChange={onChange} label={field.help} />;
      break;
    case 'select':
      control = <Select id={id} value={value ?? ''} onChange={onChange} options={field.options || []} placeholder={field.required ? undefined : '—'} />;
      break;
    case 'multiselect':
      control = (
        <div className="checkbox-list">
          {(field.options || []).map((o) => (
            <label key={o.value} className="checkbox">
              <input type="checkbox" checked={(value || []).includes(o.value)} onChange={(e) => onChange(e.target.checked ? [...(value || []), o.value] : (value || []).filter((v) => v !== o.value))} />
              <span>{o.label}</span>
            </label>
          ))}
        </div>
      );
      break;
    case 'password':
      control = <PasswordInput id={id} value={value ?? ''} onChange={onChange} showStrength={false} allowGenerate={false} placeholder={field.placeholder} />;
      break;
    case 'textarea':
      control = <Textarea id={id} value={value ?? ''} onChange={onChange} rows={5} placeholder={field.placeholder} />;
      break;
    case 'cron':
      control = <TextInput id={id} value={value ?? ''} onChange={onChange} placeholder={field.placeholder || '0 2 * * *'} className="input mono" />;
      break;
    default:
      control = <TextInput id={id} value={value ?? ''} onChange={onChange} placeholder={field.placeholder} maxLength={field.maxLength} />;
  }
  return <Field label={field.label} help={field.type === 'toggle' ? undefined : field.help} error={error} required={field.required} htmlFor={id}>{control}</Field>;
}

export function PluginFields({ fields, groups = [], values, onChange, errors }) {
  const byGroup = useMemo(() => {
    const map = new Map([[null, []]]);
    for (const g of groups) map.set(g.id, []);
    for (const f of fields) (map.get(f.group) || map.get(null)).push(f);
    return map;
  }, [fields, groups]);
  return (
    <>
      {[...byGroup.entries()].map(([gid, list]) => list.length === 0 ? null : (
        <fieldset key={gid || '_'} className="field-group">
          {gid && <legend>{groups.find((g) => g.id === gid)?.label || gid}</legend>}
          {list.map((f) => <PluginField key={f.key} field={f} value={values[f.key]} onChange={(v) => onChange(f.key, v)} error={errors?.[f.key]} />)}
        </fieldset>
      ))}
    </>
  );
}

function SettingsPage({ plugin, page, fn }) {
  const toast = useToast();
  const { data, error, loading, refetch } = useApi(`/plugins/manage/${plugin.id}/settings`);
  const [values, setValues] = useState({});
  useEffect(() => { if (data) setValues(Object.fromEntries((data.fields || []).map((f) => [f.key, data.values?.[f.key] ?? fieldDefault(f)]))); }, [data]);
  const save = useMutation(useCallback(async () => {
    const res = await api.put(`/plugins/manage/${plugin.id}/settings`, values);
    setValues((v) => ({ ...v, ...res.data }));
    toast.success('Settings saved');
    return res.data;
  }, [plugin.id, values, toast]));
  return (
    <>
      <PageHeader fn={fn} title={page.title} description={page.description} />
      <Card title={`${plugin.name} settings`}>
        {loading && !data && <Loading />}
        <ErrorBanner error={error} onRetry={refetch} />
        {data && (
          <form onSubmit={(e) => { e.preventDefault(); save.mutate().catch(() => {}); }}>
            <PluginFields fields={data.fields || []} groups={data.groups || []} values={values} onChange={(k, v) => setValues((s) => ({ ...s, [k]: v }))} errors={save.fieldErrors} />
            <ErrorBanner error={save.error && !save.fieldErrors ? save.error : null} />
            <FormActions><Button type="submit" variant="primary" loading={save.loading}>Save</Button></FormActions>
          </form>
        )}
      </Card>
    </>
  );
}

export function rowsOf(data) {
  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data.rows)) return data.rows;
  if (data && Array.isArray(data.items)) return data.items;
  if (data && Array.isArray(data.data)) return data.data;
  return [];
}

function TablePage({ plugin, page, fn, baseUrl }) {
  const { data, error, loading, refetch } = useApi(`${baseUrl}${page.source}`);
  const rows = rowsOf(data);
  const columns = page.columns?.length ? page.columns : Object.keys(rows[0] || {}).map((k) => ({ key: k, label: k }));
  const render = (col) => ({ ...col, render: (row) => { const v = row[col.key]; return v == null ? <span className="muted">—</span> : typeof v === 'object' ? <code>{JSON.stringify(v)}</code> : String(v); } });
  return (
    <>
      <PageHeader fn={fn} title={page.title} description={page.description} actions={<Button onClick={() => refetch()}>Refresh</Button>} />
      <Card padded={false}>
        <DataTable columns={columns.map(render)} rows={rows} loading={loading} error={error} rowKey={(r, i) => r.id ?? r.key ?? JSON.stringify(r) ?? i} emptyText="The plugin returned no rows" />
      </Card>
    </>
  );
}

function FormPage({ plugin, page, fn, baseUrl }) {
  const toast = useToast();
  const [values, setValues] = useState(() => Object.fromEntries((page.fields || []).map((f) => [f.key, fieldDefault(f)])));
  const [result, setResult] = useState(null);
  const submit = useMutation(useCallback(async () => {
    const res = await api.post(`${baseUrl}${page.source}`, values);
    setResult(res.data ?? res);
    toast.success(`${page.title}: submitted`);
    return res;
  }, [baseUrl, page.source, page.title, values, toast]));
  return (
    <>
      <PageHeader fn={fn} title={page.title} description={page.description} />
      <Card>
        <form onSubmit={(e) => { e.preventDefault(); submit.mutate().catch(() => {}); }}>
          <PluginFields fields={page.fields || []} values={values} onChange={(k, v) => setValues((s) => ({ ...s, [k]: v }))} errors={submit.fieldErrors} />
          <ErrorBanner error={submit.error && !submit.fieldErrors ? submit.error : null} />
          <FormActions><Button type="submit" variant="primary" loading={submit.loading}>Submit</Button></FormActions>
        </form>
        {result != null && <pre className="log">{typeof result === 'string' ? result : JSON.stringify(result, null, 2)}</pre>}
      </Card>
    </>
  );
}

function ActionPluginPage({ plugin, page, fn }) {
  const toast = useToast();
  const confirm = useConfirm();
  const [jobId, setJobId] = useState(null);
  const run = useMutation(useCallback(async () => {
    if (page.confirm) {
      const ok = await confirm({ title: page.title, message: `Run "${page.title}" (${plugin.name}) now?`, confirmLabel: 'Run' });
      if (!ok) return null;
    }
    const res = await api.post(`/plugins/manage/${plugin.id}/jobs/${page.job}`, { params: {} });
    setJobId(res.data.job.id);
    return res.data.job;
  }, [confirm, page, plugin]));
  return (
    <>
      <PageHeader fn={fn} title={page.title} description={page.description} />
      <Card>
        <p>{page.description || `Runs the "${page.job}" job of ${plugin.name} as a background task.`}</p>
        <div className="action-row">
          <Button variant="primary" loading={run.loading} onClick={() => run.mutate().catch((e) => toast.error(e))}>Run</Button>
        </div>
        <ErrorBanner error={run.error} />
        {jobId && <ProgressLog jobId={jobId} onFinished={(ev) => (ev.type === 'done' ? toast.success(`${page.title}: finished`) : toast.error(ev.error || `${page.title}: ${ev.type}`))} />}
      </Card>
    </>
  );
}

// Minimal markdown → React (headings, paragraphs, lists, code, emphasis, links).
// Raw HTML is shown as text; links are limited to http(s) and relative paths.
function inline(text, key = 0) {
  const parts = [];
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*]+\*)|(\[[^\]]+\]\((https?:\/\/[^)\s]+|\/[^)\s]*)\))/g;
  let last = 0;
  let m;
  let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    if (m[1]) parts.push(<code key={`${key}-${i++}`}>{m[1].slice(1, -1)}</code>);
    else if (m[2]) parts.push(<strong key={`${key}-${i++}`}>{m[2].slice(2, -2)}</strong>);
    else if (m[3]) parts.push(<em key={`${key}-${i++}`}>{m[3].slice(1, -1)}</em>);
    else if (m[4]) {
      const label = m[4].slice(1, m[4].indexOf(']'));
      parts.push(<a key={`${key}-${i++}`} href={m[5]} rel="noopener noreferrer" target={m[5].startsWith('/') ? undefined : '_blank'}>{label}</a>);
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

export function renderMarkdown(src) {
  const lines = String(src || '').replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let i = 0;
  let k = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    if (line.startsWith('```')) {
      const code = [];
      i++;
      while (i < lines.length && !lines[i].startsWith('```')) code.push(lines[i++]);
      i++;
      out.push(<pre key={k++} className="log">{code.join('\n')}</pre>);
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) { const Tag = `h${h[1].length}`; out.push(<Tag key={k++}>{inline(h[2], k)}</Tag>); i++; continue; }
    if (/^\s*[-*]\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*[-*]\s+/, ''));
      out.push(<ul key={k++}>{items.map((it, j) => <li key={j}>{inline(it, `${k}-${j}`)}</li>)}</ul>);
      continue;
    }
    if (/^\s*\d+\.\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*\d+\.\s+/, ''));
      out.push(<ol key={k++}>{items.map((it, j) => <li key={j}>{inline(it, `${k}-${j}`)}</li>)}</ol>);
      continue;
    }
    const para = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,6}\s|```|\s*[-*]\s|\s*\d+\.\s)/.test(lines[i])) para.push(lines[i++]);
    out.push(<p key={k++}>{inline(para.join(' '), k)}</p>);
  }
  return out;
}

function usePageFile(plugin, page, enabled) {
  const path = page.file ? `/plugins/ui/${plugin.id}/file?path=${encodeURIComponent(page.file)}` : null;
  return useApi(path, { enabled: Boolean(enabled && path) });
}

function MarkdownPage({ plugin, page, fn }) {
  const file = usePageFile(plugin, page, !page.content);
  const content = page.content ?? file.data?.content ?? '';
  return (
    <>
      <PageHeader fn={fn} title={page.title} description={page.description} />
      <Card>
        {file.loading && <Loading />}
        <ErrorBanner error={file.error} onRetry={file.refetch} />
        <div className="markdown">{renderMarkdown(content)}</div>
      </Card>
    </>
  );
}

function HtmlPage({ plugin, page, fn }) {
  const file = usePageFile(plugin, page, true);
  return (
    <>
      <PageHeader fn={fn} title={page.title} description={page.description} />
      <Card padded={false}>
        {file.loading && <Loading />}
        <ErrorBanner error={file.error} onRetry={file.refetch} />
        {file.data && <iframe title={page.title} className="plugin-frame" sandbox="" srcDoc={file.data.content} style={{ width: '100%', minHeight: '60vh', border: 0 }} />}
      </Card>
    </>
  );
}

const KINDS = { settings: SettingsPage, table: TablePage, form: FormPage, action: ActionPluginPage, markdown: MarkdownPage, html: HtmlPage };

export function PluginPageView({ plugin, page }) {
  const Kind = KINDS[page.kind];
  const fn = pluginFn(plugin, page);
  if (!Kind) return <NotFoundPage />;
  return <Kind plugin={plugin} page={page} fn={fn} baseUrl={`/plugins/${plugin.id}`} />;
}

export default function PluginPage() {
  const { pluginId, '*': rest } = useParams();
  const { plugins, loading, error } = usePluginNav();
  const route = `/${(rest || '').replace(/\/+$/, '')}`.replace(/^\/\//, '/');
  const plugin = plugins.find((p) => p.id === pluginId);
  const page = plugin?.pages?.find((p) => p.route === route);
  if (loading && !plugin) return <Loading text="Loading plugins…" />;
  if (error) return <><PageHeader title="Plugins" /><Card><ErrorBanner error={error} /></Card></>;
  if (!plugin || !page) {
    if (plugin && route === '/' && plugin.pages?.length) {
      return (
        <>
          <PageHeader title={plugin.name} description={`Version ${plugin.version}`} />
          <Card title="Pages">
            <ul>{plugin.pages.map((p) => <li key={p.route}><Link to={pluginFn(plugin, p).path}>{p.title}</Link></li>)}</ul>
          </Card>
        </>
      );
    }
    return (
      <>
        <PageHeader title="Plugin page not found" />
        <Card><EmptyState icon={Puzzle} title="There is no such plugin page">{plugin ? <p>The plugin "{plugin.name}" has no page at <code>{route}</code>.</p> : <p>No enabled plugin has the id <code>{pluginId}</code>.</p>}<p><Link to="/">Back to Home</Link></p></EmptyState></Card>
      </>
    );
  }
  return <PluginPageView plugin={plugin} page={page} />;
}
