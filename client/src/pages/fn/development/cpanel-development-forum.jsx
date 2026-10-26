import { Link } from 'react-router-dom';
import { ExternalLink, BookOpen, MessageSquare, Code2 } from 'lucide-react';
import { useApi } from '../../../hooks/useApi.js';
import { PageHeader, Card, StatusPill, Loading, KeyValue, formatDate } from '../../../components/Common.jsx';
import { RequestError, Stat, DocLinks, CopyButton } from '../../development/Shared.jsx';

const COMMUNITY = [
  { title: 'cPanel & WHM developer documentation', url: 'https://api.docs.cpanel.net/', text: 'Reference for the original UAPI / WHM API 1 the compatibility layer mirrors.' },
  { title: 'cPanel community forums', url: 'https://support.cpanel.net/hc/en-us/community/topics', text: 'Hosting-provider community: plugins, hooks, migrations and integrations.' },
  { title: 'OpenAPI specification', url: 'https://spec.openapis.org/oas/v3.0.3', text: 'The format the generated API reference uses; import it into any client generator.' },
  { title: 'Node.js documentation', url: 'https://nodejs.org/docs/latest-v22.x/api/', text: 'Plugins and hooks run on the same Node 22 runtime as the panel.' },
];

const QUICKSTART = `# 1. Create an API token (Development > Manage API Tokens), then:
export WHM_TOKEN=whm_...
curl -s "https://$HOST:2087/api/system/status" -H "Authorization: Bearer $WHM_TOKEN" | jq .data

# 2. React to events with a hook (Development > Manage Hooks):
cat > /usr/local/whm/hooks/notify <<'EOF'
#!/bin/sh
EVENT="$1"; STAGE="$2"; PAYLOAD="$(cat)"
curl -s -X POST https://billing.example.com/whm-events -H 'Content-Type: application/json' -d "$PAYLOAD"
EOF
chmod 0700 /usr/local/whm/hooks/notify

# 3. Scaffold a plugin (Development > cPanel Plugin File Generator) and validate it:
node -e "console.log(require('./plugins/sdk').validateManifest(require('./plugin.json')))"
`;

export default function CpanelDevelopmentForum({ fn }) {
  const overview = useApi('/development/overview');
  const docs = useApi('/development/docs');
  const o = overview.data;
  return (
    <>
      <PageHeader fn={fn} description="Everything a developer integrating with this server needs in one place: the live API reference, hooks and tokens, the plugin SDK, the design documents and the wider community." />
      <RequestError error={overview.error} onRetry={overview.refetch} />
      {overview.loading && !o && <Loading />}
      {o && (
        <div className="stat-grid" style={{ marginBottom: 14 }}>
          <Stat label="API endpoints" value={o.api.endpoints} hint="generated live" />
          <Stat label="API tokens" value={o.tokens.total} hint={o.tokens.expired ? `${o.tokens.expired} expired` : 'none expired'} />
          <Stat label="Hooks" value={`${o.hooks.enabled}/${o.hooks.total}`} hint={`${o.hooks.runs24h} runs in 24h${o.hooks.failed24h ? `, ${o.hooks.failed24h} failed` : ''}`} />
          <Stat label="AppConfig apps" value={o.apps.enabled} hint={`${o.apps.total} registered`} />
          <Stat label="Event catalog" value={o.events.catalog} hint={`${o.events.listeners} listener(s)`} />
          <Stat label="Plugin SDK" value={o.sdk.available ? <StatusPill status="ok">v{o.sdk.version || '?'}</StatusPill> : <StatusPill status="not-installed">missing</StatusPill>} />
        </div>
      )}
      <div className="form-grid" style={{ gap: 14 }}>
        <Card title={<><Code2 size={16} /> Build against this panel</>}>
          <ul>
            <li><Link to="/development/openapi-documentation-for-whm">OpenAPI Documentation for WHM</Link>: every endpoint with its role, plus a downloadable <code>openapi.json</code>.</li>
            <li><Link to="/development/openapi-documentation-for-cpanel">OpenAPI Documentation for cPanel</Link>: the account-scoped subset.</li>
            <li><Link to="/development/manage-api-tokens">Manage API Tokens</Link>: Bearer tokens with scopes and expiry.</li>
            <li><Link to="/development/manage-hooks">Manage Hooks</Link>: run scripts on account, login, service and backup events; pre hooks can veto.</li>
            <li><Link to="/development/apps-managed-by-appconfig">Apps Managed by AppConfig</Link>: link external tools into the panel menus by ACL.</li>
            <li><Link to="/development/cpanel-plugin-file-generator">cPanel Plugin File Generator</Link>: a validated plugin skeleton as a tarball.</li>
          </ul>
        </Card>
        <Card title={<><MessageSquare size={16} /> Community and upstream references</>}>
          <ul>
            {COMMUNITY.map((c) => <li key={c.url} style={{ marginBottom: 8 }}><a href={c.url} target="_blank" rel="noreferrer">{c.title} <ExternalLink size={12} /></a><div className="small muted">{c.text}</div></li>)}
          </ul>
          <p className="small muted">External sites open in a new tab. This panel is an independent implementation; upstream documentation describes the APIs it mirrors.</p>
        </Card>
      </div>
      <Card title="Quickstart" actions={<CopyButton text={QUICKSTART} />}>
        <pre className="log" style={{ maxHeight: 'none' }}>{QUICKSTART}</pre>
      </Card>
      <Card title={<><BookOpen size={16} /> Design documents</>} subtitle="Served from the install under Developer Documentation.">
        <RequestError error={docs.error} onRetry={docs.refetch} />
        <DocLinks docs={docs.data} />
      </Card>
      {o && (
        <Card title="Runtime">
          <KeyValue items={[['Panel version', o.panel.version], ['Mode', o.panel.mode], ['Node', o.panel.node], ['Hooks directory', <code key="h">{o.hooks.dir}</code>], ['Hooks globally', o.hooks.enabledGlobally ? 'enabled' : 'paused'], ['Last event', o.events.recent[0] ? `${o.events.recent[0].event} (${o.events.recent[0].stage}) ${formatDate(o.events.recent[0].at)}` : 'none yet'], ['SDK path', o.sdk.path ? <code key="p">{o.sdk.path}</code> : 'not shipped']]} />
        </Card>
      )}
    </>
  );
}
