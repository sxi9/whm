import { useState } from 'react';
import { RefreshCw, AlertTriangle, Bug } from 'lucide-react';
import { Card, EmptyState, formatBytes, formatDate } from '../../../components/Common.jsx';
import { Field, Select, Toggle, Button } from '../../../components/Form.jsx';
import { useT } from '../../../i18n/useT.js';
import { fill, plural } from '../../../i18n/fill.js';
import { PanelPage, PanelCapabilityState, FeatureDisabledState } from '../../../panel/PanelPage.jsx';
import { usePanelApi } from '../../../panel/hooks/usePanel.js';
import { isCapabilityError, isFeatureDisabled, locationLabel, RequestError } from './parts/shared.jsx';

const LINE_CHOICES = ['100', '300', '500', '1000'];
const KIND_LABELS = { apache: 'Apache', nginx: 'NGINX' };

export const errorsPath = (lines, domain) => `/logs/errors?lines=${encodeURIComponent(lines)}${domain ? `&domain=${encodeURIComponent(domain)}` : ''}`;

export default function Errors({ fn }) {
  const { t } = useT();
  const [lines, setLines] = useState('300');
  const [domain, setDomain] = useState('');
  const [live, setLive] = useState(false);
  const { data, error, loading, refetch } = usePanelApi(errorsPath(lines, domain), { refreshMs: live ? 10000 : 0 });

  if (isFeatureDisabled(error)) return <PanelPage fn={fn}><FeatureDisabledState fn={fn} /></PanelPage>;

  const capability = isCapabilityError(error);
  const domains = data?.domains || [];
  const files = data?.files || [];
  const lineOptions = LINE_CHOICES.map((n) => ({ value: n, label: fill(t('panel.logs.errors_last_lines', 'Last {count} lines'), { count: n }) }));
  const updated = (mtime) => fill(t('panel.logs.updated_at', 'updated {date}'), { date: formatDate(mtime) });
  const noServer = data && !data.apache && !data.nginx && !files.length;

  return (
    <PanelPage fn={fn} actions={<Button icon={RefreshCw} onClick={refetch}>{t('common.refresh', 'Refresh')}</Button>}>
      {data?.warnings?.length > 0 && (
        <div className="banner banner-warning"><AlertTriangle size={18} /><div><strong>{t('panel.logs.skipped_title', 'Some log locations were skipped')}</strong><ul>{data.warnings.map((w) => <li key={w}>{w}</li>)}</ul></div></div>
      )}
      <Card title={t('panel.logs.errors_choose_title', 'What to show')} subtitle={t('panel.logs.errors_choose_subtitle', 'The newest lines of every error log of your domains, newest first.')}>
        <PanelCapabilityState error={capability ? error : null} onRetry={refetch} />
        <RequestError error={error} onRetry={refetch} />
        <div className="form-grid">
          <Field label={t('panel.logs.domain', 'Domain')} htmlFor="errors-domain"><Select id="errors-domain" value={domain} onChange={setDomain} placeholder={t('panel.logs.all_domains', 'All domains')} options={domains} /></Field>
          <Field label={t('panel.logs.show', 'Show')} htmlFor="errors-lines"><Select id="errors-lines" value={lines} onChange={setLines} options={lineOptions} /></Field>
          <Field label={t('panel.logs.follow', 'Follow')} htmlFor="errors-follow"><Toggle checked={live} onChange={setLive} label={t('panel.logs.errors_follow_label', 'Refresh every 10 seconds')} description={t('panel.logs.errors_follow_help', 'Keeps the view current while you reproduce a problem')} /></Field>
        </div>
      </Card>

      {loading && !data && <p className="muted">{t('panel.logs.reading', 'Reading the log…')}</p>}
      {data && !files.length && !capability && (
        <Card>
          <EmptyState icon={Bug} title={noServer ? t('panel.logs.errors_no_server', 'No web server logs on this server') : t('panel.logs.errors_none', 'No error logs yet')}>
            <p>{noServer ? t('panel.logs.errors_no_server_text', 'Error logs appear here once a web server serves your domains.') : t('panel.logs.errors_none_text', 'The web server creates an error log per domain the first time something goes wrong, such as a missing page or a PHP error.')}</p>
          </EmptyState>
        </Card>
      )}
      {files.map((f) => (
        <Card key={`${f.kind}:${f.name}`} title={f.name}
          subtitle={[f.domain || t('panel.logs.your_logs_folder', 'your logs folder'), KIND_LABELS[f.kind] || f.kind, locationLabel(f.location, t), formatBytes(f.size), f.mtime ? updated(f.mtime) : null].filter(Boolean).join(' · ')}
          actions={<span className="muted small">{plural(t, 'panel.logs.lines', f.lines.length, '{count} line', '{count} lines')}{f.truncated ? ` · ${t('panel.logs.errors_more', 'older lines not shown')}` : ''}{live ? ` · ${t('panel.logs.following', 'following')}` : ''}</span>}>
          {f.lines.length
            ? <pre className="log">{f.lines.join('\n')}</pre>
            : <EmptyState icon={Bug} title={t('panel.logs.empty_log', 'This log is empty')}><p>{t('panel.logs.errors_empty_text', 'Nothing has gone wrong on this domain since the log was created.')}</p></EmptyState>}
        </Card>
      ))}
    </PanelPage>
  );
}
