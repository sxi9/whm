import { unprocessable } from '../lib/errors.js';

// Curated one-click catalog behind Software › Install Software. Package lists
// are resolved per distro family; nodejs never uses distro packages (official
// nodejs.org builds under /opt/keel/node/<major> through pkg.node.install).
const phpDebian = (v) => ['php' + v + '-fpm', 'php' + v + '-cli', 'php' + v + '-common', 'php' + v + '-mysql', 'php' + v + '-curl', 'php' + v + '-gd', 'php' + v + '-mbstring', 'php' + v + '-xml', 'php' + v + '-zip', 'php' + v + '-intl', 'php' + v + '-bcmath', 'php' + v + '-opcache', 'php' + v + '-soap', 'php' + v + '-imagick'];
const phpRhel = (v) => { const s = 'php' + v.replace('.', ''); return [s + '-php-fpm', s + '-php-cli', s + '-php-common', s + '-php-mysqlnd', s + '-php-gd', s + '-php-mbstring', s + '-php-xml', s + '-php-pecl-zip', s + '-php-intl', s + '-php-bcmath', s + '-php-opcache', s + '-php-soap', s + '-php-pecl-imagick']; };

export const RUNTIMES = {
  php: { label: 'PHP', versions: ['8.5', '8.4', '8.3', '8.2', '8.1', '7.4'], repo: 'php', debian: phpDebian, rhel: phpRhel, source: true },
  nodejs: { label: 'Node.js', versions: ['24', '22', '20', '18'], installer: 'node' },
  python: { label: 'Python', versions: ['3.13', '3.12', '3.11', '3.10', '3.9'], repo: 'python', debian: (v) => ['python' + v, 'python' + v + '-venv', 'python' + v + '-dev'], rhel: (v) => ['python' + v, 'python' + v + '-pip', 'python' + v + '-devel'] },
  ruby: { label: 'Ruby', single: true, debian: ['ruby-full'], rhel: ['ruby', 'ruby-devel'] },
  go: { label: 'Go', single: true, debian: ['golang-go'], rhel: ['golang'] },
  composer: { label: 'Composer', single: true, debian: ['composer'], rhel: ['composer'], repo: 'epel' },
};

export const TOOLS = [
  { key: 'git', label: 'Git', debian: ['git'], rhel: ['git'] },
  { key: 'imagemagick', label: 'ImageMagick', debian: ['imagemagick'], rhel: ['ImageMagick'] },
  { key: 'ffmpeg', label: 'FFmpeg', debian: ['ffmpeg'], rhel: ['ffmpeg'] },
  { key: 'redis', label: 'Redis', debian: ['redis-server'], rhel: ['redis'] },
  { key: 'memcached', label: 'Memcached', debian: ['memcached'], rhel: ['memcached'] },
  { key: 'certbot', label: 'Certbot', debian: ['certbot'], rhel: ['certbot'] },
  { key: 'unzip', label: 'unzip', debian: ['unzip'], rhel: ['unzip'] },
  { key: 'build-essential', label: 'Build tools (gcc, make)', debian: ['build-essential'], rhel: ['gcc', 'make'] },
  { key: 'python3-pip', label: 'pip (Python 3)', debian: ['python3-pip'], rhel: ['python3-pip'] },
  { key: 'cpanminus', label: 'cpanminus (CPAN client)', debian: ['cpanminus'], rhel: ['perl-App-cpanminus'] },
  { key: 'php-pear', label: 'PEAR / PECL', debian: ['php-pear', 'php-dev'], rhel: ['php-pear', 'php-devel'] },
  { key: 'openssh-server', label: 'OpenSSH server', debian: ['openssh-server'], rhel: ['openssh-server'] },
  { key: 'bind', label: 'BIND DNS server', debian: ['bind9', 'bind9utils'], rhel: ['bind', 'bind-utils'] },
  { key: 'iproute2', label: 'iproute2', debian: ['iproute2'], rhel: ['iproute'] },
  { key: 'locales', label: 'Locales', debian: ['locales'], rhel: ['glibc-langpack-en'] },
  { key: 'goaccess', label: 'GoAccess', debian: ['goaccess'], rhel: ['goaccess'] },
  { key: 'clamav', label: 'ClamAV', debian: ['clamav-daemon'], rhel: ['clamd', 'clamav-update'] },
];

// What a PHP source build (agent pkg.php.build) needs installed first; the
// install job puts them in through pkg.install before the build starts.
export const PHP_BUILD_DEPS = {
  debian: ['build-essential', 'pkg-config', 'autoconf', 'bison', 're2c', 'xz-utils', 'libxml2-dev', 'libsqlite3-dev', 'libssl-dev', 'libcurl4-openssl-dev', 'libonig-dev', 'libzip-dev', 'libpng-dev', 'libjpeg-dev', 'libwebp-dev', 'libfreetype-dev', 'libicu-dev', 'libsodium-dev', 'libreadline-dev', 'libxslt1-dev', 'libgmp-dev', 'libbz2-dev', 'libffi-dev', 'zlib1g-dev'],
  rhel: ['gcc', 'gcc-c++', 'make', 'pkgconf-pkg-config', 'autoconf', 'bison', 're2c', 'xz', 'libxml2-devel', 'sqlite-devel', 'openssl-devel', 'libcurl-devel', 'oniguruma-devel', 'libzip-devel', 'libpng-devel', 'libjpeg-turbo-devel', 'libwebp-devel', 'freetype-devel', 'libicu-devel', 'libsodium-devel', 'readline-devel', 'libxslt-devel', 'gmp-devel', 'bzip2-devel', 'libffi-devel', 'zlib-devel'],
};
// On RHEL the -devel packages (oniguruma, libzip, libsodium, libwebp, re2c) sit in CRB and EPEL.
export const PHP_BUILD_REPOS = { debian: [], rhel: ['epel', 'crb'] };
// php.net's last 7.4 / 8.0 releases predate libxml2 2.12 and ICU 75 and fail to compile on current distributions.
export const PHP_SOURCE_MINORS = ['8.1', '8.2', '8.3', '8.4', '8.5'];
export const PHP_SOURCE_PREFIX = '/opt/keel/php';
export const INSTALL_METHODS = ['package', 'source'];

export const RUNTIME_KEYS = Object.keys(RUNTIMES);
export const TOOL_KEYS = TOOLS.map((t) => t.key);
export const FAMILIES = ['debian', 'rhel'];

// Repos a runtime entry needs on a family. epel is RHEL-only; php on RHEL
// comes from Remi (the agent adds epel first) and epel is ensured again after
// it so a Remi build that pulls EPEL dependencies resolves.
export function reposFor(entry, family) {
  if (!entry.repo) return [];
  if (entry.repo === 'epel') return family === 'rhel' ? ['epel'] : [];
  if (entry.repo === 'php' && family === 'rhel') return ['php', 'epel'];
  return [entry.repo];
}

export function packagesFor(entry, family, version) {
  const spec = entry[family];
  if (!spec) return null;
  return typeof spec === 'function' ? spec(version) : [...spec];
}

export function runtimeNote(key, family) {
  if (key === 'python' && family === 'debian') return 'Ubuntu adds versions from the deadsnakes PPA; on Debian only the distro version is available.';
  if (key === 'nodejs') return 'Installed under /opt/keel/node/<major> as node<major>/npm<major>/npx<major>; the panel\'s own Node.js stays untouched.';
  if (key === 'php' && family === 'rhel') return 'Remi collection; binaries live under /opt/remi/php<nn>.';
  if (key === 'php' && family === 'debian') return 'Ubuntu uses ppa:ondrej/php, Debian the packages.sury.org repository.';
  if (key === 'composer' && family === 'rhel') return 'From EPEL.';
  return null;
}

// Turns a validated install request into the exact work for a host family.
// `family` may be null (no package manager): nodejs still resolves, everything
// else is refused with a 422 that names the reason. `method: 'source'` (PHP
// only) resolves to the php.net build with the family's build dependencies.
export function resolveInstall({ runtime, version, tool }, family, { method = 'package' } = {}) {
  if (tool) {
    const entry = TOOLS.find((t) => t.key === tool);
    if (!entry) throw unprocessable(`Unknown tool "${tool}"`, { tool: ['Pick one of the catalog tools'] });
    const packages = family ? packagesFor(entry, family) : null;
    if (!packages) throw unprocessable(`No packages are known for ${entry.label} on this distribution`, { tool: ['Install it from the package search instead'] });
    return { kind: 'tool', key: tool, label: entry.label, version: null, packages, repos: [], installer: null };
  }
  const entry = RUNTIMES[runtime];
  if (!entry) throw unprocessable(`Unknown runtime "${runtime}"`, { runtime: ['Pick one of the catalog runtimes'] });
  const v = entry.single ? null : version;
  if (!entry.single) {
    if (!v) throw unprocessable(`${entry.label} needs a version`, { version: [`One of ${entry.versions.join(', ')}`] });
    if (!entry.versions.includes(v)) throw unprocessable(`${entry.label} ${v} is not in the catalog`, { version: [`One of ${entry.versions.join(', ')}`] });
  }
  if (entry.installer === 'node') return { kind: 'runtime', key: runtime, label: entry.label, version: v, packages: [], repos: [], installer: 'node', major: Number(v) };
  if (method === 'source') {
    if (!entry.source) throw unprocessable(`${entry.label} has no source build; install it from packages`, { method: ['package'] });
    if (!PHP_SOURCE_MINORS.includes(v)) throw unprocessable(`${entry.label} ${v} cannot be built from source: php.net's last ${v} release does not compile against this OS's libxml2/ICU`, { version: [`A source build covers ${PHP_SOURCE_MINORS.join(', ')}`] });
    const deps = family ? PHP_BUILD_DEPS[family] : null;
    if (!deps) throw unprocessable(`A ${entry.label} source build needs a package manager for its build dependencies`, { method: ['No supported package manager was found on this server'] });
    return { kind: 'runtime', key: runtime, label: entry.label, version: v, packages: [], repos: [...PHP_BUILD_REPOS[family]], installer: 'php-source', minor: v, deps: [...deps], prefix: `${PHP_SOURCE_PREFIX}/${v}` };
  }
  const packages = family ? packagesFor(entry, family, v) : null;
  if (!packages) throw unprocessable(`No packages are known for ${entry.label} on this distribution`, { runtime: ['Install it from the package search instead'] });
  return { kind: 'runtime', key: runtime, label: entry.label, version: v, packages, repos: reposFor(entry, family), installer: null };
}

const digitsOf = (v) => String(v).replace(/\D/g, '');

// Matches a catalog version against what pkg.runtime.detect found.
export function detectedVersion(key, version, detected = {}) {
  if (key === 'php') {
    const hit = (detected.php || []).find((p) => p.id === version || /php(\d+)$/.exec(String(p.id))?.[1] === digitsOf(version) || String(p.version || '').startsWith(version + '.'));
    return hit ? { installed: true, version: hit.version ?? hit.id, source: Boolean(hit.source || hit.layout === 'keel'), layout: hit.layout ?? null } : { installed: false, version: null };
  }
  if (key === 'nodejs') {
    const hit = (detected.node?.versions || []).find((n) => String(n.major) === String(version));
    return hit ? { installed: true, version: hit.version, path: hit.path, bin: hit.bin } : { installed: false, version: null };
  }
  if (key === 'python') {
    const hit = (detected.python || []).find((p) => String(p.minor) === version);
    return hit ? { installed: true, version: hit.version } : { installed: false, version: null };
  }
  const v = detected[key];
  return v ? { installed: true, version: typeof v === 'string' ? v : v.version ?? null } : { installed: false, version: null };
}
