import { useState } from 'react';
import { api } from '../../../api/client.js';
import { useApi } from '../../../hooks/useApi.js';
import { PageHeader, Card, StatusPill, Loading } from '../../../components/Common.jsx';
import { Field, Textarea, Toggle, Button, ErrorBanner } from '../../../components/Form.jsx';
import { RequestError, useJobRunner, JobPanel, JobHistory } from '../../software/Shared.jsx';

const MODULE_RE = /^[A-Za-z][A-Za-z0-9_]*(::[A-Za-z0-9_]+)*$/;

export default function InstallAPerlModule({ fn }) {
  const installers = useApi('/software/modules/installers');
  const { data, loading, error, refetch } = useApi('/software/perl/modules');
  const history = useApi('/system/jobs?type=software.perl.install&limit=10');
  const [text, setText] = useState('');
  const [notest, setNotest] = useState(true);
  const [q, setQ] = useState('');
  const runner = useJobRunner({ onFinished: () => { refetch(); history.refetch(); } });

  const modules = text.split(/[\s,]+/).map((m) => m.trim()).filter(Boolean);
  const invalid = modules.filter((m) => !MODULE_RE.test(m));
  const items = (data?.modules || []).filter((m) => !q || m.name.toLowerCase().includes(q.toLowerCase()));
  const installer = installers.data?.perl;

  const install = () => runner.start(() => api.post('/software/perl/install', { modules, notest }), `Install ${modules.join(', ')}`).then((d) => { if (d) setText(''); });

  return (
    <>
      <PageHeader fn={fn} actions={installers.data && <StatusPill status={installer ? 'ok' : 'not-installed'}>{installer ? `installer: ${installer}${installers.data.versions.perl ? ` · perl ${installers.data.versions.perl}` : ''}` : 'no CPAN client'}</StatusPill>} />
      <Card title="Install from CPAN" subtitle="Modules are built and installed non-interactively as a background job (cpanm when available, otherwise cpan with default answers).">
        {installers.data && !installer && <div className="banner banner-warning"><div><strong>No CPAN client</strong><p>Install <code>cpanminus</code> (Debian/Ubuntu) or <code>perl-App-cpanminus</code> (RHEL) from Install Distro Packages first.</p></div></div>}
        <Field label="Module names" help="One per line or separated by spaces, e.g. DBD::mysql, JSON::XS, LWP::UserAgent" error={invalid.length ? [`Not a Perl module name: ${invalid.join(', ')}`] : null} required>
          <Textarea value={text} onChange={setText} rows={4} mono placeholder={'DBD::mysql\nJSON::XS'} />
        </Field>
        <Toggle checked={notest} onChange={setNotest} label="Skip the module test suites" description="Much faster; tests are the usual reason CPAN installs fail on servers without a full build environment." />
        <div className="action-row"><Button variant="primary" loading={runner.busy} disabled={!modules.length || invalid.length > 0 || !installer} onClick={install}>Install {modules.length > 1 ? `${modules.length} modules` : 'module'}</Button></div>
        <ErrorBanner error={runner.error} />
      </Card>
      <JobPanel runner={runner} title="Install log" />
      <Card title="Installed modules" subtitle={data ? `${data.modules.length} modules registered with ExtUtils::Installed` : undefined} actions={<Button onClick={() => refetch()} loading={loading}>Refresh</Button>}>
        <RequestError error={error} onRetry={refetch} />
        {loading && !data && <Loading />}
        {data && (
          <>
            <input className="input" placeholder="Filter modules…" value={q} onChange={(e) => setQ(e.target.value)} style={{ marginBottom: 8 }} />
            <div className="table-wrap" style={{ maxHeight: 400, overflow: 'auto' }}>
              <table>
                <thead><tr><th>Module</th><th>Version</th></tr></thead>
                <tbody>
                  {items.length === 0 && <tr><td colSpan={2} className="table-state">No modules match</td></tr>}
                  {items.slice(0, 1000).map((m) => <tr key={m.name}><td><code>{m.name}</code></td><td>{m.version || '—'}</td></tr>)}
                </tbody>
              </table>
            </div>
          </>
        )}
      </Card>
      <Card title="Previous installs"><JobHistory jobs={history.data} onSelect={(id) => runner.setJobId(id)} /></Card>
    </>
  );
}
