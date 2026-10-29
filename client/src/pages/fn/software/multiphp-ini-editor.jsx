import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, queryString } from '../../../api/client.js';
import { useApi } from '../../../hooks/useApi.js';
import { useAuth } from '../../../auth/AuthContext.jsx';
import { PageHeader, Card, StatusPill, Loading } from '../../../components/Common.jsx';
import { Field, Select, TextInput, Textarea, Toggle, Button, FormActions, ErrorBanner } from '../../../components/Form.jsx';
import { useToast } from '../../../components/Toast.jsx';
import { RequestError, Tabs } from '../../software/Shared.jsx';

const BOOL_OPTIONS = [{ value: '', label: '(unset)' }, { value: 'On', label: 'On' }, { value: 'Off', label: 'Off' }];

export default function MultiPhpIniEditor({ fn }) {
  const toast = useToast();
  const { user } = useAuth();
  const isRoot = user?.role === 'root';
  const [params, setParams] = useSearchParams();
  const [scope, setScope] = useState(params.get('domain') ? 'domain' : isRoot ? 'version' : 'domain');
  const [version, setVersion] = useState(params.get('version') || '');
  const [domain, setDomain] = useState(params.get('domain') || '');
  const [mode, setMode] = useState('basic');
  const [draft, setDraft] = useState({});
  const [content, setContent] = useState('');
  const [reloadFpm, setReloadFpm] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(null);

  const versions = useApi('/software/php/versions', { enabled: isRoot });
  // The domain list is paged (500 per page); the picker filters server-side so
  // a server with more domains than one page can still reach every one of them.
  const [domainFilter, setDomainFilter] = useState('');
  const domains = useApi(`/software/php/domains${queryString({ q: domainFilter.trim() || undefined, pageSize: 500 })}`);
  const domainsTruncated = (domains.meta?.total || 0) > (domains.data?.domains?.length || 0);
  const directives = useApi('/software/php/ini/directives');
  const path = scope === 'version' ? (version ? `/software/php/ini/${encodeURIComponent(version)}` : null) : (domain ? `/software/php/ini/domain/${encodeURIComponent(domain)}` : null);
  const ini = useApi(path, { enabled: Boolean(path) });

  useEffect(() => { if (!version && versions.data?.versions?.length) setVersion(versions.data.effectiveDefault || versions.data.versions[0].id); }, [versions.data, version]);
  useEffect(() => { if (ini.data) { setDraft(ini.data.basic || {}); setContent(ini.data.content || ''); } }, [ini.data]);
  useEffect(() => { const next = {}; if (scope === 'version' && version) next.version = version; if (scope === 'domain' && domain) next.domain = domain; setParams(next, { replace: true }); }, [scope, version, domain, setParams]);

  const changed = useMemo(() => Object.fromEntries(Object.entries(draft).filter(([k, v]) => (v ?? '') !== (ini.data?.basic?.[k] ?? ''))), [draft, ini.data]);
  const dirty = mode === 'basic' ? Object.keys(changed).length > 0 : content !== (ini.data?.content || '');

  const save = async () => {
    setSaving(true); setSaveError(null);
    try {
      const body = mode === 'basic' ? { directives: Object.fromEntries(Object.entries(changed).map(([k, v]) => [k, v === '' || v == null ? null : String(v)])) } : { content };
      if (scope === 'version') body.reloadFpm = reloadFpm;
      const { data } = await api.put(path, body);
      toast.success(`${data.path} saved${data.reload?.attempted ? (data.reload.ok ? ` · ${data.reload.unit} reloaded` : ` · reload of ${data.reload.unit} failed: ${data.reload.error}`) : ''}${data.removed ? ' (empty file removed)' : ''}`);
      ini.refetch();
    } catch (err) { setSaveError(err); toast.error(err); } finally { setSaving(false); }
  };

  const domainOptions = (domains.data?.domains || []).map((d) => ({ value: d.domain, label: `${d.domain} (${d.account}${d.type !== 'main' ? `, ${d.type}` : ''}) · PHP ${d.effective || '?'}` }));
  const versionOptions = (versions.data?.versions || []).map((v) => ({ value: v.id, label: `${v.label || v.id}${v.version ? ` (${v.version})` : ''}` }));

  return (
    <>
      <PageHeader fn={fn} />
      <Card title="Scope">
        <div className="form-grid">
          {isRoot && (
            <Field label="Edit">
              <Select value={scope} onChange={setScope} options={[{ value: 'version', label: 'A PHP version (php.ini, server-wide)' }, { value: 'domain', label: 'A domain (.user.ini in its document root)' }]} />
            </Field>
          )}
          {scope === 'version' && <Field label="PHP version"><Select value={version} onChange={setVersion} options={versionOptions} placeholder={versions.data ? 'Select a version…' : 'Loading…'} /></Field>}
          {scope === 'domain' && <Field label="Find a domain" help={domainsTruncated ? `Showing the first ${domains.data?.domains?.length || 0} of ${domains.meta?.total} domains; type to narrow the list` : undefined}><TextInput value={domainFilter} onChange={setDomainFilter} placeholder="Domain or account name" /></Field>}
          {scope === 'domain' && <Field label="Domain"><Select value={domain} onChange={setDomain} options={domainOptions} placeholder={domains.data ? 'Select a domain…' : 'Loading…'} /></Field>}
        </div>
        <RequestError error={versions.error || domains.error} onRetry={() => { versions.refetch(); domains.refetch(); }} />
        {scope === 'version' && isRoot && ini.data?.sapis && (
          <p className="muted small">Editing <code>{ini.data.path}</code>. Other SAPI copies: {Object.entries(ini.data.sapis).filter(([, p]) => p && p !== ini.data.path).map(([s, p]) => <code key={s} style={{ marginRight: 6 }}>{p}</code>)}</p>
        )}
        {scope === 'domain' && ini.data && <p className="muted small"><code>{ini.data.path}</code> {ini.data.exists ? '' : '(does not exist yet; saving creates it)'} — PHP-FPM re-reads .user.ini every user_ini.cache_ttl seconds (300 by default).</p>}
      </Card>
      {path && (
        <Card title={mode === 'basic' ? 'Basic mode' : 'Editor mode'} subtitle={scope === 'version' ? 'Server-wide defaults for this PHP version.' : 'Overrides for this domain only. Only PHP_INI_PERDIR and PHP_INI_USER directives take effect here.'}
          actions={<Tabs value={mode} onChange={setMode} tabs={[{ value: 'basic', label: 'Basic' }, { value: 'editor', label: 'Editor' }]} />}>
          <RequestError error={ini.error} onRetry={ini.refetch} />
          {ini.loading && !ini.data && <Loading />}
          {ini.data && mode === 'basic' && (
            <div className="form-grid">
              {(directives.data || []).map((d) => {
                const value = draft[d.key] ?? '';
                const isChanged = d.key in changed;
                const label = <>{d.label}{isChanged && <StatusPill status="info">changed</StatusPill>}</>;
                if (d.type === 'bool') return <Field key={d.key} label={label} help={d.help}><Select value={value} onChange={(v) => setDraft({ ...draft, [d.key]: v })} options={BOOL_OPTIONS} /></Field>;
                return <Field key={d.key} label={label} help={d.help}><TextInput value={value} onChange={(v) => setDraft({ ...draft, [d.key]: v })} placeholder={d.type === 'size' ? 'e.g. 256M' : d.type === 'int' ? 'number' : ''} /></Field>;
              })}
            </div>
          )}
          {ini.data && mode === 'editor' && <Textarea value={content} onChange={setContent} rows={28} mono spellCheck={false} />}
          {ini.data && (
            <div className="sticky-actions">
              <ErrorBanner error={saveError} />
              {scope === 'version' && <Toggle checked={reloadFpm} onChange={setReloadFpm} label="Reload PHP-FPM after saving" description="Apache with mod_php needs a restart from Service Manager instead." />}
              <FormActions>
                <Button variant="primary" loading={saving} disabled={!dirty} onClick={save}>Save</Button>
                <Button disabled={!dirty || saving} onClick={() => { setDraft(ini.data.basic || {}); setContent(ini.data.content || ''); }}>Reset</Button>
                {mode === 'basic' && <span className="muted small">{Object.keys(changed).length} directive(s) changed; empty = remove the directive.</span>}
              </FormActions>
            </div>
          )}
        </Card>
      )}
    </>
  );
}
