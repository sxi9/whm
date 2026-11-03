import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Globe, Plus, Trash2, Layers } from 'lucide-react';
import { Card, StatusPill, EmptyState, Loading } from '../../../components/Common.jsx';
import { Field, Select, TextInput, Button, FormActions, ErrorBanner } from '../../../components/Form.jsx';
import { useToast } from '../../../components/Toast.jsx';
import { PanelPage } from '../../../panel/PanelPage.jsx';
import { usePanelApi, panelApi } from '../../../panel/hooks/usePanel.js';
import { PANEL_FUNCTION_BY_KEY } from '../../../panel/nav.js';
import { RequestError, DIRECTIVES, DIRECTIVE_KEYS, INI_KEY_RE, INI_VALUE_RE, WEB_TYPES, changedDirectives, isCapabilityError } from './parts/Shared.jsx';

const VERSIONS_PATH = PANEL_FUNCTION_BY_KEY['panel:php/versions']?.path || '/panel/php/versions';
const BOOL_OPTIONS = [{ value: '', label: 'Not set (server default)' }, { value: 'On', label: 'On' }, { value: 'Off', label: 'Off' }];

// Everything in the file that is not one of the basic directives.
export function otherDirectives(directives) {
  return Object.entries(directives || {}).filter(([k]) => !DIRECTIVE_KEYS.has(k)).map(([key, value]) => ({ key, value: value == null ? '' : String(value) }));
}

function DirectiveField({ d, value, changed, onChange }) {
  const label = <><code>{d.key}</code>{changed && <> <StatusPill status="pending">changed</StatusPill></>}</>;
  if (d.type === 'bool') return <Field label={label} help={d.help}><Select value={value} onChange={onChange} options={BOOL_OPTIONS} /></Field>;
  return <Field label={label} help={d.help}><TextInput value={value} onChange={onChange} placeholder={d.type === 'size' ? 'for example 256M' : d.type === 'int' ? 'number' : 'not set'} /></Field>;
}

export default function PhpSettings({ fn }) {
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const domains = usePanelApi('/php/domains');
  const [domain, setDomain] = useState(params.get('domain') || '');
  const [mode, setMode] = useState('basic');
  // Edits are kept apart from the loaded file and keyed to it, so a reload
  // (after a save, or switching domains) starts from the saved values again.
  const [edits, setEdits] = useState({ base: null, basic: {}, others: null });
  const [adding, setAdding] = useState({ key: '', value: '' });
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(null);
  const ini = usePanelApi(domain ? `/php/domains/${encodeURIComponent(domain)}/ini` : null);

  const list = useMemo(() => (domains.data?.domains || []).filter((d) => WEB_TYPES.includes(d.type)), [domains.data]);
  useEffect(() => { if (!domain && list.length) setDomain(list[0].domain); }, [list, domain]);
  useEffect(() => { setParams(domain ? { domain } : {}, { replace: true }); }, [domain, setParams]);

  const savedBasic = useMemo(() => Object.fromEntries(Object.entries(ini.data?.basic || {}).map(([k, v]) => [k, v == null ? '' : String(v)])), [ini.data]);
  const savedOtherList = useMemo(() => otherDirectives(ini.data?.directives), [ini.data]);
  const savedOthers = useMemo(() => Object.fromEntries(savedOtherList.map((o) => [o.key, o.value])), [savedOtherList]);
  const live = edits.base === ini.data ? edits : { base: ini.data, basic: {}, others: null };
  const draft = useMemo(() => ({ ...savedBasic, ...live.basic }), [savedBasic, live.basic]);
  const others = live.others ?? savedOtherList;
  const update = (patch) => setEdits((e) => ({ ...(e.base === ini.data ? e : { base: ini.data, basic: {}, others: null }), ...patch }));
  const setDraft = (updater) => update({ basic: { ...live.basic, ...(typeof updater === 'function' ? updater(draft) : updater) } });
  const setOthers = (updater) => update({ others: typeof updater === 'function' ? updater(others) : updater });
  const changes = useMemo(() => ({ ...changedDirectives(savedBasic, draft), ...changedDirectives(savedOthers, Object.fromEntries(others.map((o) => [o.key, o.value]))) }), [savedBasic, draft, savedOthers, others]);
  const dirty = Object.keys(changes).length > 0;
  const invalidOther = others.find((o) => !INI_KEY_RE.test(o.key) || !INI_VALUE_RE.test(o.value));

  const addOther = () => {
    const key = adding.key.trim();
    if (!INI_KEY_RE.test(key)) { toast.warning('Directive names use letters, digits, dots and underscores, for example opcache.enable'); return; }
    if (DIRECTIVE_KEYS.has(key)) { setDraft({ [key]: adding.value }); setAdding({ key: '', value: '' }); return; }
    setOthers((o) => [...o.filter((x) => x.key !== key), { key, value: adding.value }]);
    setAdding({ key: '', value: '' });
  };

  const save = async () => {
    setSaving(true);
    setSaveError(null);
    try {
      const { data } = await panelApi.put(`/php/domains/${encodeURIComponent(domain)}/ini`, { directives: changes });
      toast.success(`${data.path || '.user.ini'} saved`);
      ini.refetch();
    } catch (err) { setSaveError(err); if (!err.fields) toast.error(err); } finally { setSaving(false); }
  };

  const reset = () => setEdits({ base: ini.data, basic: {}, others: null });
  const pageError = [domains.error, ini.error].find((e) => e && (e.status === 403 || isCapabilityError(e))) || null;

  return (
    <PanelPage fn={fn} actions={<Link className="btn" to={VERSIONS_PATH}><Layers size={16} /> PHP versions</Link>}>
      {pageError && <RequestError error={pageError} fn={fn} onRetry={() => { domains.refetch(); ini.refetch(); }} />}
      {!pageError && (
        <>
          <RequestError error={domains.error} onRetry={domains.refetch} />
          <Card title="Domain" subtitle="Settings live in the .user.ini file of the domain's document root and apply to that domain only.">
            <div className="form-grid">
              <Field label="Edit settings for">
                <Select value={domain} onChange={setDomain} options={list.map((d) => ({ value: d.domain, label: `${d.domain}${d.type !== 'main' ? ` (${d.type === 'sub' ? 'subdomain' : d.type})` : ''} · PHP ${d.effective || '?'}` }))} placeholder={domains.loading ? 'Loading…' : list.length ? 'Select a domain' : 'No domains on this account'} />
              </Field>
              {ini.data && (
                <Field label="File">
                  <div><code className="small">{ini.data.path}</code> {ini.data.exists ? <StatusPill status="ok">exists</StatusPill> : <StatusPill status="unknown">not created yet</StatusPill>}</div>
                  <div className="field-help">PHP re-reads the file within about five minutes; only directives that may be set per directory take effect here.</div>
                </Field>
              )}
            </div>
          </Card>

          {!domains.loading && domains.data && list.length === 0 && (
            <Card><EmptyState icon={Globe} title="No web domains yet"><p>Per-domain PHP settings appear here once the account has a domain.</p><p className="muted">Add one under Domains first.</p></EmptyState></Card>
          )}

          {domain && (
            <Card title={mode === 'basic' ? 'Common directives' : 'All directives'} subtitle={mode === 'basic' ? 'Leave a value empty to use the server default.' : 'Every directive in the file, including ones not in the common list.'}
              actions={(
                <div className="segmented" role="tablist">
                  <button type="button" role="tab" aria-selected={mode === 'basic'} className={mode === 'basic' ? 'active' : ''} onClick={() => setMode('basic')}>Common</button>
                  <button type="button" role="tab" aria-selected={mode === 'all'} className={mode === 'all' ? 'active' : ''} onClick={() => setMode('all')}>All directives</button>
                </div>
              )}>
              <RequestError error={ini.error} onRetry={ini.refetch} inline />
              {ini.loading && !ini.data && <Loading />}
              {ini.data && mode === 'basic' && (
                <div className="form-grid">
                  {DIRECTIVES.map((d) => <DirectiveField key={d.key} d={d} value={draft[d.key] ?? ''} changed={d.key in changes} onChange={(v) => setDraft({ [d.key]: v })} />)}
                </div>
              )}
              {ini.data && mode === 'all' && (
                <>
                  <div className="table-wrap">
                    <table>
                      <thead><tr><th>Directive</th><th>Value</th><th className="actions-col" /></tr></thead>
                      <tbody>
                        {DIRECTIVES.filter((d) => (draft[d.key] ?? '') !== '').map((d) => (
                          <tr key={d.key}><td><code>{d.key}</code>{d.key in changes && <> <StatusPill status="pending">changed</StatusPill></>}</td><td><TextInput value={draft[d.key]} onChange={(v) => setDraft({ [d.key]: v })} aria-label={d.key} /></td><td className="actions-col"><button className="btn btn-sm btn-danger-ghost" onClick={() => setDraft({ [d.key]: '' })} aria-label={`Remove ${d.key}`}><Trash2 size={14} /></button></td></tr>
                        ))}
                        {others.map((o) => (
                          <tr key={o.key}><td><code>{o.key}</code>{o.key in changes && <> <StatusPill status="pending">changed</StatusPill></>}</td><td><TextInput value={o.value} onChange={(v) => setOthers((list) => list.map((x) => (x.key === o.key ? { ...x, value: v } : x)))} aria-label={o.key} /></td><td className="actions-col"><button className="btn btn-sm btn-danger-ghost" onClick={() => setOthers((list) => list.filter((x) => x.key !== o.key))} aria-label={`Remove ${o.key}`}><Trash2 size={14} /></button></td></tr>
                        ))}
                        {DIRECTIVES.every((d) => (draft[d.key] ?? '') === '') && others.length === 0 && <tr><td colSpan={3} className="table-state">The file has no directives yet; add one below or fill in the common ones.</td></tr>}
                      </tbody>
                    </table>
                  </div>
                  <div className="input-group" style={{ marginTop: 12, maxWidth: 640 }}>
                    <TextInput value={adding.key} onChange={(v) => setAdding({ ...adding, key: v })} placeholder="directive, for example opcache.enable" aria-label="New directive" />
                    <TextInput value={adding.value} onChange={(v) => setAdding({ ...adding, value: v })} placeholder="value" aria-label="New value" />
                    <Button icon={Plus} disabled={!adding.key.trim()} onClick={addOther}>Add</Button>
                  </div>
                  {invalidOther && <p className="field-message">"{invalidOther.key}" is not a valid directive name or its value spans more than one line.</p>}
                </>
              )}
              {ini.data && (
                <div className="sticky-actions">
                  {saveError && <ErrorBanner error={saveError} />}
                  <FormActions>
                    <Button variant="primary" loading={saving} disabled={!dirty || Boolean(invalidOther)} onClick={save}>Save</Button>
                    <Button disabled={!dirty || saving} onClick={reset}>Reset</Button>
                    <span className="muted">{Object.keys(changes).length} directive{Object.keys(changes).length === 1 ? '' : 's'} changed</span>
                  </FormActions>
                </div>
              )}
            </Card>
          )}

          {ini.data?.content && (
            <Card title="Current file" subtitle="What is in the file right now, before your changes."><pre className="log">{ini.data.content}</pre></Card>
          )}
        </>
      )}
    </PanelPage>
  );
}
