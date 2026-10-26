import { Link } from 'react-router-dom';
import { useApi } from '../../../hooks/useApi.js';
import { PageHeader, Card, StatusPill, Loading } from '../../../components/Common.jsx';
import { RequestError, useJobRunner, JobPanel, InstallerCard } from '../../software/Shared.jsx';

const RUNTIMES = [
  { key: 'php', label: 'PHP', tools: ['pecl', 'pear'], hint: 'php-pear (plus php-dev / php-devel to build PECL extensions)' },
  { key: 'perl', label: 'Perl', tools: ['cpanm', 'cpan'], hint: 'cpanminus / perl-App-cpanminus' },
  { key: 'ruby', label: 'Ruby', tools: ['gem'], hint: 'ruby' },
  { key: 'python3', label: 'Python 3', tools: ['pip3', 'pip'], hint: 'python3-pip' },
];

export default function ModuleInstallers({ fn }) {
  const { data, loading, error, refetch } = useApi('/software/modules/installers');
  const runner = useJobRunner();
  const present = data?.present || {};

  return (
    <>
      <PageHeader fn={fn} />
      <RequestError error={error} onRetry={refetch} />
      {loading && !data && <Loading />}
      {data && (
        <Card title="Available installers" subtitle="Each runtime's own package tool, run non-interactively by the agent. Missing tools are regular distro packages.">
          <div className="table-wrap">
            <table>
              <thead><tr><th>Runtime</th><th>Version</th><th>Installer</th><th>Install with</th></tr></thead>
              <tbody>
                {RUNTIMES.map((r) => (
                  <tr key={r.key}>
                    <td><strong>{r.label}</strong></td>
                    <td>{present[r.key] ? data.versions[r.key] || 'installed' : <StatusPill status="not-installed">not installed</StatusPill>}</td>
                    <td>{r.tools.map((t) => <StatusPill key={t} status={present[t] ? 'ok' : 'not-installed'}>{t}</StatusPill>)}</td>
                    <td className="small">{r.tools.some((t) => present[t]) ? '—' : <>Install <code>{r.hint}</code> via <Link to="/software/install-distro-packages">Install Distro Packages</Link></>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
      <JobPanel runner={runner} title="Install log" />
      {data && (
        <>
          <InstallerCard title="PHP PECL extensions" subtitle="Compiled extensions from pecl.php.net. After installing, enable it with extension=<name>.so in the MultiPHP INI Editor." kind="pecl" listPath="/software/modules/pecl" installPath="/software/modules/pecl/install" nameLabel="Extension" namePlaceholder="redis, imagick, apcu" allowVersion={false} present={present.pecl} runner={runner} disabledReason="pecl is not installed: add the php-pear package (and php-dev / php-devel for the build toolchain)." />
          <InstallerCard title="PHP PEAR packages" subtitle="Pure-PHP libraries from pear.php.net (installed with all dependencies)." kind="pear" listPath="/software/modules/pear" installPath="/software/modules/pear/install" nameLabel="Package" namePlaceholder="Mail, Net_SMTP" allowVersion={false} present={present.pear} runner={runner} disabledReason="pear is not installed: add the php-pear package." />
          <InstallerCard title="Ruby gems" subtitle="gem install --no-document" kind="gem" listPath="/software/modules/gem" installPath="/software/modules/gem/install" nameLabel="Gem" namePlaceholder="bundler, rails, nokogiri" present={present.gem} runner={runner} disabledReason="Ruby is not installed: add the ruby package." />
          <InstallerCard title="Python packages (pip)" subtitle="Installed into the system interpreter; on PEP 668 distributions the agent retries with --break-system-packages." kind="pip" listPath="/software/modules/pip" installPath="/software/modules/pip/install" nameLabel="Package" namePlaceholder="requests, certbot-dns-cloudflare" present={Boolean(present.pip3 || present.pip)} runner={runner} disabledReason="pip is not installed: add the python3-pip package." />
          <Card title="Perl modules">
            <p className="muted">CPAN installs have their own page with a module list and test options: <Link to="/software/install-a-perl-module">Install a Perl Module</Link>.</p>
          </Card>
        </>
      )}
    </>
  );
}
