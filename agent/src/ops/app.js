import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { z } from 'zod';
import { exec, hasBinary, resolveBinary } from '../exec.js';
import { defineOp, arg, OpError, ensurePrivateDir } from './registry.js';
import { apacheLayout, parseApacheVersion, parseModules } from './web.js';

// Application Manager: Node.js, Python and static applications. A server
// application runs as its account user from a systemd unit bound to
// 127.0.0.1:<port>; every application is published through the account's
// Apache vhost include (<apache root>/whm-apps/<domain>.conf). Root writes only
// outside the home (unit files, the Apache include, managed runtimes under
// /opt/whm/runtimes); everything inside an account tree runs through runuser as
// that account, so a planted symlink can only ever redirect the account's own
// privileges.

export const RUNTIMES_ROOT = '/opt/whm/runtimes';
export const APPS_DIR = '/etc/whm/apps';
export const NODE_DIST_URL = 'https://nodejs.org/dist';
const MANAGED = '# Managed by WHM panel';
const INSPECT_FILE_MAX = 256 * 1024;
const NODE_ARCH = { x64: 'x64', arm64: 'arm64' };

const runtimesRoot = () => path.resolve(process.env.WHM_RUNTIMES_ROOT || RUNTIMES_ROOT);
const nodeRuntimesDir = () => path.join(runtimesRoot(), 'node');
const appsDir = () => path.resolve(process.env.WHM_APPS_DIR || APPS_DIR);

// ------------------------------------------------------------- validators ---

export const appId = z.number().int().positive().max(1_000_000);
export const unitName = (id) => `whm-app-${id}`;
export const envKey = z.string().regex(/^[A-Z_][A-Z0-9_]{0,63}$/, 'environment variable name');
export const envValue = z.string().max(4096).regex(/^[^\0\r\n]*$/, 'single-line value');
export const argToken = z.string().regex(/^[A-Za-z0-9_@.:=,+\/-]{1,256}$/, 'argument without shell or systemd metacharacters');
export const basePath = z.string().max(128).regex(/^\/(?:[A-Za-z0-9._-]+\/?)*$/, 'URL base path').refine((s) => !/(^|\/)\.\.?(\/|$)/.test(s), 'base paths cannot contain . or .. segments');
export const nodeVersion = z.string().regex(/^\d{1,3}\.\d{1,3}\.\d{1,3}$/, 'Node.js version such as 20.11.0');
export const scriptName = z.string().regex(/^[A-Za-z0-9:_.-]{1,64}$/, 'npm script name').refine((s) => !s.startsWith('-'), 'script names cannot start with -');
export const pipPackage = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}(\[[A-Za-z0-9,._-]+\])?(==[0-9][0-9A-Za-z.+!-]{0,63})?$/, 'pip requirement such as gunicorn==21.2.0');
export const moduleSpec = z.string().regex(/^[A-Za-z_][A-Za-z0-9_.]*:[A-Za-z_][A-Za-z0-9_]*$/, 'module:callable');
export const gitUrl = z.string().max(512).regex(/^https:\/\/[A-Za-z0-9._-]+(:\d{1,5})?\/[A-Za-z0-9._\/-]+(\.git)?$/, 'https git URL without credentials or query');
export const gitRef = z.string().regex(/^[A-Za-z0-9._\/-]{1,128}$/, 'git ref').refine((s) => !s.startsWith('-'), 'refs cannot start with -');
export const appName = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/, 'application name');
export const runUserName = z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/, 'web server user');
// Paths that end up in a unit file or an ExecStart line: systemd expands "%"
// specifiers and splits on whitespace and quotes, so none of those may appear.
export const unitPath = arg.absPath.max(1024).regex(/^[A-Za-z0-9._@+=,:\/-]+$/, 'path without spaces, quotes or metacharacters');
const UNIT_SAFE = /^[A-Za-z0-9._@+=,:\/-]+$/;
const envRecord = z.record(envKey, envValue).refine((o) => Object.keys(o).length <= 64, 'at most 64 environment variables');

// ---------------------------------------------------------------- helpers ---

const SYSTEM_USERS = new Set(['root', 'daemon', 'bin', 'sys', 'sync', 'games', 'man', 'lp', 'mail', 'news', 'uucp', 'proxy', 'www-data', 'backup', 'list', 'irc', 'nobody', 'systemd-network', 'systemd-resolve', 'messagebus', 'sshd', 'mysql', 'postfix', 'exim', 'exim4', 'named', 'bind', 'dovecot', 'nginx', 'apache', 'whmpanel', 'Debian-exim']);

function readText(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return null; }
}
function lstatOrNull(p) {
  try { return fs.lstatSync(p); } catch { return null; }
}
const lastLine = (s) => String(s || '').trim().split('\n').filter(Boolean).pop() || '';
const tailLines = (text, n) => { const lines = String(text || '').split('\n'); while (lines.length && !lines[lines.length - 1].trim()) lines.pop(); return lines.slice(-n); };
const outputOf = (r, n) => tailLines([r.stdout, r.stderr].filter((s) => s && s.trim()).map((s) => s.replace(/\n+$/, '')).join('\n'), n);
const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function getent(username) {
  const line = (readText('/etc/passwd') || '').split('\n').find((l) => l.startsWith(`${username}:`));
  if (!line) return null;
  const [name, , uid, gid, gecos, home, shell] = line.split(':');
  return { username: name, uid: Number(uid), gid: Number(gid), gecos, home, shell };
}

function groupName(gid) {
  const line = (readText('/etc/group') || '').split('\n').find((l) => l.split(':')[2] === String(gid));
  const name = line ? line.split(':')[0] : null;
  return name && /^[A-Za-z_][A-Za-z0-9_-]{0,31}$/.test(name) ? name : null;
}

export function assertManaged(username, ctx) {
  if (SYSTEM_USERS.has(username)) throw new OpError('refused', `"${username}" is a system account and is not managed by the panel`);
  const info = getent(username);
  if (!info) throw new OpError('not_found', `Linux user "${username}" does not exist`);
  if (!Number.isInteger(info.uid) || info.uid < 1000) throw new OpError('refused', `"${username}" has a system UID (${info.uid}) and is not managed by the panel`);
  if (!info.home || !path.isAbsolute(info.home)) throw new OpError('refused', `"${username}" has no home directory`);
  info.home = ctx.assertAllowedPath(info.home, 'read');
  return info;
}

function assertHome(info) {
  const home = path.resolve(info.home);
  const st = lstatOrNull(home);
  if (!st || !st.isDirectory() || st.uid !== info.uid) throw new OpError('refused', `${home} is not a directory owned by ${info.username}`);
  return { home, realHome: fs.realpathSync(home) };
}

// The application root must be the account's own directory inside its home:
// not the home itself, not a symbolic link, owned by the account, and its real
// path (every component resolved) still under the home. With mustExist false
// the nearest existing ancestor is checked the same way, so a planted link
// never makes the following mkdir land elsewhere.
export function assertAppRoot(info, root, ctx, { allowPublicHtml = true, mustExist = true } = {}) {
  const resolved = ctx.assertAllowedPath(root, 'write');
  const { home, realHome } = assertHome(info);
  if (resolved === home) throw new OpError('refused', `the application root cannot be ${info.username}'s home directory itself`);
  if (!resolved.startsWith(`${home}/`)) throw new OpError('refused', `${root} is outside ${info.username}'s home directory ${home}`);
  if (!allowPublicHtml && resolved === path.join(home, 'public_html')) throw new OpError('refused', `${root} is the account's public_html; a server application needs its own directory`);
  const st = lstatOrNull(resolved);
  if (st?.isSymbolicLink()) throw new OpError('refused', `${root} is a symbolic link; refusing to follow it`);
  let cur = st ? resolved : path.dirname(resolved);
  while (cur !== home && !lstatOrNull(cur)) cur = path.dirname(cur);
  const real = fs.realpathSync(cur);
  if (real !== realHome && !real.startsWith(`${realHome}/`)) throw new OpError('refused', `${root} escapes the home directory through a symbolic link`);
  if (!st) {
    if (mustExist) throw new OpError('not_found', `${root} does not exist`);
    return { root: resolved, home, exists: false };
  }
  if (!st.isDirectory()) throw new OpError('refused', `${root} is not a directory`);
  if (st.uid !== info.uid) throw new OpError('refused', `${root} is not owned by ${info.username} (uid ${info.uid})`);
  if (real === realHome) throw new OpError('refused', `${root} resolves to the home directory itself`);
  return { root: resolved, home, exists: true };
}

function requireRunuser() {
  if (!hasBinary('runuser')) throw new OpError('capability_missing', 'runuser is required to act as the account user');
}
const asUser = (username, argv, opts = {}) => exec('runuser', ['-u', username, '--', ...argv], opts);

function ensureRootDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
  const st = fs.lstatSync(dir);
  if (st.isSymbolicLink() || !st.isDirectory()) throw new OpError('refused', `${dir} is not a directory`);
  fs.chmodSync(dir, 0o755);
  return dir;
}

// Written beside the target and renamed over it, so a symlink planted under
// the name is replaced rather than followed.
function writeRootFile(file, content, mode) {
  const tmp = `${file}.whm-tmp-${process.pid}-${crypto.randomBytes(3).toString('hex')}`;
  fs.writeFileSync(tmp, content, { mode });
  fs.chmodSync(tmp, mode);
  fs.renameSync(tmp, file);
}

async function versionOf(bin, pattern) {
  const r = await exec(bin, ['--version'], { allowFailure: true, timeoutMs: 15_000 });
  const m = pattern.exec(`${r.stdout}${r.stderr}`);
  return r.code === 0 && m ? m[1] : null;
}

const realpathOr = (p) => { try { return fs.realpathSync(p); } catch { return p; } };
const byVersionDesc = (a, b) => { const pa = a.version.split('.').map(Number); const pb = b.version.split('.').map(Number); for (let i = 0; i < 3; i += 1) if (pa[i] !== pb[i]) return (pb[i] || 0) - (pa[i] || 0); return 0; };

export function managedNodeRuntimes() {
  const dir = nodeRuntimesDir();
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  return entries.filter((d) => d.isDirectory() && nodeVersion.safeParse(d.name).success).map((d) => {
    const base = path.join(dir, d.name);
    const bin = path.join(base, 'bin', 'node');
    const npm = path.join(base, 'bin', 'npm');
    return { version: d.name, bin, source: 'managed', path: base, npm: lstatOrNull(npm) ? npm : null, present: Boolean(lstatOrNull(bin)?.isFile()) };
  }).sort(byVersionDesc);
}

// ---------------------------------------------------------------- runtimes ---

defineOp('app.runtime.detect', {
  description: 'Node.js (system and managed under /opt/whm/runtimes/node), Python interpreters with venv support, git and the CPU architecture',
  run: async () => {
    const node = [];
    const seen = new Set();
    for (const name of ['node', 'nodejs']) {
      const bin = resolveBinary(name);
      if (!bin) continue;
      const real = realpathOr(bin);
      if (seen.has(real)) continue;
      seen.add(real);
      const version = await versionOf(bin, /v?(\d+\.\d+\.\d+)/);
      if (!version) continue;
      const sibling = path.join(path.dirname(bin), 'npm');
      node.push({ version, bin, source: 'system', path: path.dirname(bin), npm: lstatOrNull(sibling) ? sibling : resolveBinary('npm') });
    }
    for (const r of managedNodeRuntimes()) {
      if (!r.present) continue;
      const version = await versionOf(r.bin, /v?(\d+\.\d+\.\d+)/);
      node.push({ version: version || r.version, bin: r.bin, source: 'managed', path: r.path, npm: r.npm, ok: Boolean(version) });
    }
    const python = [];
    const candidates = new Set();
    const p3 = resolveBinary('python3');
    if (p3) candidates.add(p3);
    let usrBin = [];
    try { usrBin = fs.readdirSync('/usr/bin'); } catch { usrBin = []; }
    for (const n of usrBin) if (/^python3\.\d{1,2}$/.test(n)) candidates.add(`/usr/bin/${n}`);
    const seenPy = new Set();
    for (const bin of candidates) {
      const real = realpathOr(bin);
      if (seenPy.has(real)) continue;
      seenPy.add(real);
      const version = await versionOf(bin, /Python (\d+\.\d+\.\d+)/);
      if (!version) continue;
      const venv = (await exec(bin, ['-c', 'import venv, ensurepip'], { allowFailure: true, timeoutMs: 15_000 })).code === 0;
      python.push({ version, bin, source: 'system', venv });
    }
    python.sort(byVersionDesc);
    const git = hasBinary('git') ? { installed: true, version: await versionOf('git', /git version (\d+(?:\.\d+)+)/) } : { installed: false, version: null };
    return { node, python, git, arch: process.arch, runtimesRoot: runtimesRoot(), runuser: hasBinary('runuser'), systemd: hasBinary('systemctl'), acl: hasBinary('setfacl') };
  },
});

async function download(url, file) {
  const r = await exec('curl', ['--fail', '--silent', '--show-error', '--location', '--proto', '=https', '--proto-redir', '=https', '--max-time', '600', '-o', file, url], { allowFailure: true, timeoutMs: 620_000 });
  if (r.code !== 0) throw new OpError('download_failed', `Could not download ${url}: ${lastLine(r.stderr) || `curl exited with status ${r.code}`}`);
}

defineOp('app.runtime.node.install', {
  description: 'Download a Node.js release from nodejs.org, verify it against SHASUMS256.txt and install it under /opt/whm/runtimes/node/<version>',
  timeoutMs: 900_000,
  schema: z.object({ version: nodeVersion }).strict(),
  run: async ({ version }, ctx) => {
    const dest = ctx.assertAllowedPath(path.join(nodeRuntimesDir(), version), 'write');
    if (lstatOrNull(dest)) throw new OpError('exists', `Node.js ${version} is already installed at ${dest}`);
    const arch = NODE_ARCH[process.arch];
    if (!arch) throw new OpError('unsupported', `nodejs.org publishes no Linux build for ${process.arch}`);
    for (const bin of ['curl', 'sha256sum', 'tar']) if (!hasBinary(bin)) throw new OpError('capability_missing', `${bin} is required to install Node.js runtimes`);
    const name = `node-v${version}-linux-${arch}`;
    fs.mkdirSync(nodeRuntimesDir(), { recursive: true, mode: 0o755 });
    fs.chmodSync(runtimesRoot(), 0o755);
    fs.chmodSync(nodeRuntimesDir(), 0o755);
    const tmpRoot = ensurePrivateDir(ctx.assertAllowedPath(path.join(runtimesRoot(), '.tmp'), 'write'));
    const tmp = ensurePrivateDir(path.join(tmpRoot, crypto.randomBytes(8).toString('hex')));
    try {
      const tarball = path.join(tmp, `${name}.tar.xz`);
      const sums = path.join(tmp, 'SHASUMS256.txt');
      await download(`${NODE_DIST_URL}/v${version}/${name}.tar.xz`, tarball);
      await download(`${NODE_DIST_URL}/v${version}/SHASUMS256.txt`, sums);
      const line = (readText(sums) || '').split('\n').map((l) => l.trim()).find((l) => /^[0-9a-f]{64}  \S+$/.test(l) && l.endsWith(`  ${name}.tar.xz`));
      if (!line) throw new OpError('checksum_mismatch', `SHASUMS256.txt for Node.js ${version} has no entry for ${name}.tar.xz`);
      const checksumFile = path.join(tmp, 'checksum.sha256');
      fs.writeFileSync(checksumFile, `${line}\n`, { mode: 0o600 });
      const check = await exec('sha256sum', ['--check', '--strict', '--ignore-missing', '--quiet', checksumFile], { cwd: tmp, allowFailure: true, timeoutMs: 300_000 });
      if (check.code !== 0) throw new OpError('checksum_mismatch', `${name}.tar.xz does not match the SHA-256 checksum published by nodejs.org`, { output: lastLine(`${check.stdout}\n${check.stderr}`) });
      await exec('tar', ['--extract', '--xz', '--file', tarball, '--directory', tmp, '--no-same-owner', '--no-same-permissions'], { timeoutMs: 600_000 });
      const extracted = path.join(tmp, name);
      if (!lstatOrNull(extracted)?.isDirectory() || !lstatOrNull(path.join(extracted, 'bin', 'node'))?.isFile()) throw new OpError('download_failed', `${name}.tar.xz did not contain ${name}/bin/node`);
      await exec('chmod', ['-R', 'u+rwX,go+rX,go-w', '--', extracted], { timeoutMs: 120_000 });
      fs.chmodSync(extracted, 0o755);
      try { fs.renameSync(extracted, dest); } catch (err) {
        if (err.code === 'EEXIST' || err.code === 'ENOTEMPTY') throw new OpError('exists', `Node.js ${version} was installed concurrently at ${dest}`);
        throw err;
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
    return { version, path: dest, bin: path.join(dest, 'bin', 'node'), npm: path.join(dest, 'bin', 'npm') };
  },
});

defineOp('app.runtime.node.remove', {
  description: 'Remove a managed Node.js runtime from /opt/whm/runtimes/node/<version>',
  destructive: true,
  schema: z.object({ version: nodeVersion }).strict(),
  run: async ({ version }, ctx) => {
    const dir = ctx.assertAllowedPath(path.join(nodeRuntimesDir(), version), 'write');
    const st = lstatOrNull(dir);
    if (!st) throw new OpError('not_found', `Node.js ${version} is not installed under ${nodeRuntimesDir()}`);
    if (st.isSymbolicLink() || !st.isDirectory()) throw new OpError('refused', `${dir} is not a directory; refusing to remove it`);
    await exec('rm', ['-rf', '--', dir], { timeoutMs: 300_000 });
    return { version, path: dir, removed: true };
  },
});

// ----------------------------------------------------------------- inspect ---

export function parsePackageJson(text) {
  if (text == null) return null;
  let pkg;
  try { pkg = JSON.parse(text); } catch { return null; }
  if (!pkg || typeof pkg !== 'object' || Array.isArray(pkg)) return null;
  const str = (v, max) => (typeof v === 'string' && v.length <= max ? v : null);
  const scripts = {};
  if (pkg.scripts && typeof pkg.scripts === 'object') {
    for (const [k, v] of Object.entries(pkg.scripts).slice(0, 50)) if (typeof v === 'string') scripts[k.slice(0, 64)] = v.slice(0, 512);
  }
  const dependencies = new Set();
  for (const key of ['dependencies', 'devDependencies']) {
    if (pkg[key] && typeof pkg[key] === 'object') for (const name of Object.keys(pkg[key]).slice(0, 300)) dependencies.add(name);
  }
  return { name: str(pkg.name, 214), main: str(pkg.main, 256), scripts, dependencies: [...dependencies].slice(0, 300) };
}

export function parseRequirements(text) {
  const names = [];
  for (const raw of String(text || '').split('\n')) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line || line.startsWith('-')) continue;
    const m = /^([A-Za-z0-9][A-Za-z0-9._-]*)/.exec(line);
    if (m) names.push(m[1].toLowerCase().replace(/[._]+/g, '-'));
    if (names.length >= 200) break;
  }
  return names;
}

export function parseAngularProjects(text) {
  if (text == null) return [];
  let json;
  try { json = JSON.parse(text); } catch { return []; }
  const projects = json && typeof json === 'object' && json.projects && typeof json.projects === 'object' ? Object.keys(json.projects) : [];
  return projects.filter((n) => /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(n)).slice(0, 50);
}

const SAFE_ENTRY = /^(?:\.\/)?(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._\/-]{1,128}$/;

export function detectHints({ files = [], dirs = [], packageJson = null, requirements = null, angularProjects = [] } = {}) {
  const has = (f) => files.includes(f);
  const deps = new Set(packageJson?.dependencies || []);
  const scripts = packageJson?.scripts || {};
  const lockfile = ['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml'].find(has) || null;
  const existingOutputDirs = ['dist', 'build', '.output', '.next'].filter((d) => dirs.includes(d));
  let preset = null;
  let outputDir = null;
  let startEntry = null;
  if (packageJson) {
    if (deps.has('next')) preset = 'nextjs';
    else if (deps.has('nuxt')) { preset = 'nuxt'; startEntry = '.output/server/index.mjs'; }
    else if (deps.has('@nestjs/core')) { preset = 'nestjs'; startEntry = 'dist/main.js'; }
    else if (deps.has('@angular/core')) { preset = 'angular'; outputDir = angularProjects[0] ? `dist/${angularProjects[0]}/browser` : null; }
    else if (deps.has('react-scripts')) { preset = 'react-cra'; outputDir = 'build'; }
    else if (deps.has('vue')) { preset = 'vue'; outputDir = 'dist'; }
    else if (deps.has('svelte') || deps.has('@sveltejs/kit')) { preset = 'svelte'; outputDir = 'build'; }
    else if (deps.has('vite')) { preset = 'react-vite'; outputDir = 'dist'; }
    else if (deps.has('express')) {
      preset = 'express';
      const main = packageJson.main && SAFE_ENTRY.test(packageJson.main) ? packageJson.main.replace(/^\.\//, '') : null;
      startEntry = (main && has(main.split('/')[0]) ? main : null) || ['server.js', 'app.js', 'index.js'].find(has) || main || 'server.js';
    } else if (scripts.start) preset = 'node-custom';
  } else if (requirements || has('manage.py') || has('wsgi.py') || has('asgi.py')) {
    const req = new Set(requirements || []);
    if (req.has('django') || has('manage.py')) preset = 'django';
    else if (req.has('fastapi')) { preset = 'fastapi'; startEntry = 'main:app'; }
    else if (req.has('flask')) { preset = 'flask'; startEntry = 'app:app'; }
    else { preset = 'python-custom'; startEntry = ['main.py', 'app.py'].find(has) || null; }
  } else if (has('index.html')) { preset = 'static-files'; outputDir = '.'; }
  return { preset, outputDir, startEntry, lockfile, existingOutputDirs };
}

async function readAsUser(username, home, file) {
  const r = await asUser(username, ['head', '-c', String(INSPECT_FILE_MAX + 1), '--', file], { allowFailure: true, timeoutMs: 30_000, env: { HOME: home }, maxBuffer: 2 * INSPECT_FILE_MAX });
  if (r.code !== 0 || Buffer.byteLength(r.stdout) > INSPECT_FILE_MAX) return null;
  return r.stdout;
}

defineOp('app.inspect', {
  description: 'Inspect an application directory as the account user: listing, package.json, requirements.txt, angular.json and the framework preset they suggest',
  schema: z.object({ username: arg.username, root: arg.absPath }).strict(),
  run: async ({ username, root: rootArg }, ctx) => {
    const info = assertManaged(username, ctx);
    const { root, home, exists } = assertAppRoot(info, rootArg, ctx, { mustExist: false });
    if (!exists) return { root, exists: false, empty: true, files: [], dirs: [], packageJson: null, requirements: null, angularProjects: [], hints: detectHints() };
    requireRunuser();
    const ls = await asUser(username, ['ls', '-1Ap', '--', root], { allowFailure: true, timeoutMs: 30_000, env: { HOME: home }, maxBuffer: 4 * 1024 * 1024 });
    if (ls.code !== 0) throw new OpError('refused', `Cannot list ${root} as ${username}: ${lastLine(ls.stderr)}`);
    const names = ls.stdout.split('\n').filter(Boolean).slice(0, 500);
    const dirs = names.filter((n) => n.endsWith('/')).map((n) => n.slice(0, -1));
    const files = names.map((n) => n.replace(/\/$/, ''));
    const read = (f) => (files.includes(f) && !dirs.includes(f) ? readAsUser(username, home, path.join(root, f)) : Promise.resolve(null));
    const packageJson = parsePackageJson(await read('package.json'));
    const requirementsText = await read('requirements.txt');
    const requirements = requirementsText == null ? null : parseRequirements(requirementsText);
    const angularProjects = parseAngularProjects(await read('angular.json'));
    return { root, exists: true, empty: files.length === 0, files, dirs, packageJson, requirements, angularProjects, hints: detectHints({ files, dirs, packageJson, requirements, angularProjects }) };
  },
});

// ----------------------------------------------------------------- prepare ---

const slugOf = (name) => name.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64) || 'app';

export const SCAFFOLDS = {
  express: (name) => ({
    'package.json': `${JSON.stringify({ name: slugOf(name), version: '1.0.0', private: true, description: `${name} (created by the WHM panel Application Manager)`, scripts: { start: 'node server.js' }, dependencies: { express: '^4.21.2' } }, null, 2)}\n`,
    'server.js': [
      `// ${name} - created by the WHM panel Application Manager.`,
      "const express = require('express');",
      '',
      'const app = express();',
      'const port = Number(process.env.PORT) || 3000;',
      "const host = process.env.HOST || '127.0.0.1';",
      '',
      `app.get('/', (req, res) => { res.type('text/plain').send(${JSON.stringify(`${name} is running (created by the WHM panel Application Manager)`)}); });`,
      '',
      `app.listen(port, host, () => { console.log(${JSON.stringify(`${name} listening on`)}, \`\${host}:\${port}\`); });`,
      '',
    ].join('\n'),
  }),
  flask: (name) => ({
    'requirements.txt': 'flask\n',
    'app.py': [
      `# ${name} - created by the WHM panel Application Manager.`,
      'from flask import Flask',
      '',
      'app = Flask(__name__)',
      '',
      '',
      "@app.get('/')",
      'def index():',
      `    return '${name} is running (created by the WHM panel Application Manager)'`,
      '',
    ].join('\n'),
  }),
  fastapi: (name) => ({
    'requirements.txt': 'fastapi\nuvicorn\n',
    'main.py': [
      `# ${name} - created by the WHM panel Application Manager.`,
      'from fastapi import FastAPI',
      '',
      `app = FastAPI(title='${name}')`,
      '',
      '',
      "@app.get('/')",
      'def index():',
      `    return {'app': '${name}', 'message': 'created by the WHM panel Application Manager'}`,
      '',
    ].join('\n'),
  }),
  'static-files': (name) => ({
    'index.html': [
      '<!doctype html>',
      '<html lang="en">',
      '<head>',
      '  <meta charset="utf-8">',
      '  <meta name="viewport" content="width=device-width, initial-scale=1">',
      `  <title>${name}</title>`,
      '</head>',
      '<body>',
      `  <h1>${name}</h1>`,
      '  <p>This site was created by the WHM panel Application Manager. Replace this file with your own.</p>',
      '</body>',
      '</html>',
      '',
    ].join('\n'),
  }),
};

const sourceSchema = z.object({ gitUrl, ref: gitRef.optional() }).strict();
const scaffoldSchema = z.object({ template: z.enum(['express', 'flask', 'fastapi', 'static-files']), name: appName }).strict();
const gitEnv = (home) => ({ HOME: home, GIT_TERMINAL_PROMPT: '0' });

defineOp('app.prepare', {
  description: 'Create an application root as the account user and optionally clone a git repository or write a starter scaffold into it (only when it is empty)',
  timeoutMs: 900_000,
  schema: z.object({ username: arg.username, root: arg.absPath, source: sourceSchema.optional(), scaffold: scaffoldSchema.optional() }).strict()
    .refine((v) => !(v.source && v.scaffold), { message: 'clone a repository or write a scaffold, not both', path: ['scaffold'] }),
  run: async ({ username, root: rootArg, source, scaffold }, ctx) => {
    const info = assertManaged(username, ctx);
    requireRunuser();
    if (source && !hasBinary('git')) throw new OpError('capability_missing', 'git is not installed on this server');
    const { root, home } = assertAppRoot(info, rootArg, ctx, { mustExist: false });
    const env = { HOME: home };
    await asUser(username, ['mkdir', '-p', '-m', '0755', '--', root], { env, timeoutMs: 60_000 });
    assertAppRoot(info, root, ctx, { mustExist: true });
    if (source || scaffold) {
      const ls = await asUser(username, ['ls', '-1A', '--', root], { allowFailure: true, env, timeoutMs: 30_000 });
      if (ls.code !== 0) throw new OpError('refused', `Cannot list ${root} as ${username}: ${lastLine(ls.stderr)}`);
      if (ls.stdout.trim()) throw new OpError('exists', `${root} is not empty`);
    }
    let cloned = false;
    const scaffolded = [];
    if (source) {
      const argv = ['git', '-c', 'core.hooksPath=/dev/null', 'clone', '--depth', '1', ...(source.ref ? ['--branch', source.ref] : []), '--', source.gitUrl, root];
      const r = await asUser(username, argv, { allowFailure: true, env: gitEnv(home), timeoutMs: 900_000 });
      if (r.code !== 0) throw new OpError('git_failed', `git clone failed: ${lastLine(r.stderr) || `exit status ${r.code}`}`, { output: outputOf(r, 50) });
      cloned = true;
    }
    if (scaffold) {
      for (const [file, content] of Object.entries(SCAFFOLDS[scaffold.template](scaffold.name))) {
        await asUser(username, ['tee', '--', path.join(root, file)], { input: content, env, timeoutMs: 30_000 });
        scaffolded.push(file);
      }
    }
    return { root, cloned, scaffolded };
  },
});

defineOp('app.pull', {
  description: 'Update a cloned application as the account user: fetch --depth 1 from origin and reset --hard to FETCH_HEAD',
  timeoutMs: 600_000,
  schema: z.object({ username: arg.username, root: arg.absPath, ref: gitRef.optional() }).strict(),
  run: async ({ username, root: rootArg, ref }, ctx) => {
    const info = assertManaged(username, ctx);
    requireRunuser();
    if (!hasBinary('git')) throw new OpError('capability_missing', 'git is not installed on this server');
    const { root, home } = assertAppRoot(info, rootArg, ctx, { mustExist: true });
    const git = (argv) => asUser(username, ['git', '-c', 'core.hooksPath=/dev/null', ...argv], { cwd: root, env: gitEnv(home), allowFailure: true, timeoutMs: 600_000 });
    const fail = (verb, r) => new OpError('git_failed', `git ${verb} failed: ${lastLine(r.stderr) || `exit status ${r.code}`}`, { output: outputOf(r, 50) });
    const fetched = await git(['fetch', '--depth', '1', 'origin', ...(ref ? [ref] : [])]);
    if (fetched.code !== 0) throw fail('fetch', fetched);
    const reset = await git(['reset', '--hard', 'FETCH_HEAD']);
    if (reset.code !== 0) throw fail('reset', reset);
    const head = await git(['rev-parse', 'HEAD']);
    if (head.code !== 0) throw fail('rev-parse', head);
    return { root, head: head.stdout.trim() };
  },
});

// ------------------------------------------------------------------- steps ---

export function assertRuntimeBin({ kind, bin }) {
  const resolved = path.resolve(bin);
  const dir = path.dirname(resolved);
  const base = path.basename(resolved);
  const managed = new RegExp(`^${escapeRegex(nodeRuntimesDir())}/\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}/bin/node$`);
  const systemDir = dir === '/usr/bin' || dir === '/usr/local/bin';
  const ok = kind === 'node' ? (managed.test(resolved) || (systemDir && /^(node|nodejs)$/.test(base))) : (systemDir && /^python3(\.\d{1,2})?$/.test(base));
  if (!ok) throw new OpError('refused', `${bin} is not an allowed ${kind} runtime (managed runtimes under ${nodeRuntimesDir()}, or node/nodejs/python3 in /usr/bin or /usr/local/bin)`);
  let st;
  try { st = fs.statSync(resolved); } catch { st = null; }
  if (!st?.isFile()) throw new OpError('not_found', `${bin} does not exist on this server`);
  return resolved;
}

// npm is a script started by whichever `node` is first on PATH; running its
// entry file with the chosen node binary pins the runtime regardless of PATH.
function npmArgv(nodeBin) {
  const npm = path.join(path.dirname(nodeBin), 'npm');
  let st;
  try { st = fs.statSync(npm); } catch { st = null; }
  if (!st?.isFile()) throw new OpError('capability_missing', `npm is not installed next to ${nodeBin}`);
  const real = realpathOr(npm);
  return real.endsWith('.js') ? [nodeBin, real] : [npm];
}

export function stepEnv(runtimeBin, root, home, production) {
  return {
    HOME: home,
    PATH: `${path.dirname(runtimeBin)}:${root}/.venv/bin:/usr/local/bin:/usr/bin:/bin`,
    NODE_ENV: production ? 'production' : 'development',
    CI: '1',
    npm_config_fund: 'false',
    npm_config_audit: 'false',
    npm_config_update_notifier: 'false',
    PIP_DISABLE_PIP_VERSION_CHECK: '1',
  };
}

const runtimeSchema = z.object({ kind: z.enum(['node', 'python']), bin: unitPath }).strict();

defineOp('app.step', {
  description: 'Run one build step as the account user inside the application root: npm-install, npm-run <script>, venv-create or pip-install',
  timeoutMs: 1_800_000,
  schema: z.object({
    username: arg.username,
    root: arg.absPath,
    step: z.enum(['npm-install', 'npm-run', 'venv-create', 'pip-install']),
    runtime: runtimeSchema,
    script: scriptName.optional(),
    packages: z.array(pipPackage).max(50).optional(),
    production: z.boolean().default(false),
  }).strict().superRefine((v, c) => {
    if (v.step === 'npm-run' && !v.script) c.addIssue({ code: z.ZodIssueCode.custom, path: ['script'], message: 'npm-run needs a script name' });
    const needs = v.step.startsWith('npm') ? 'node' : 'python';
    if (v.runtime.kind !== needs) c.addIssue({ code: z.ZodIssueCode.custom, path: ['runtime', 'kind'], message: `${v.step} needs a ${needs} runtime` });
  }),
  run: async (a, ctx) => {
    const info = assertManaged(a.username, ctx);
    requireRunuser();
    const { root, home } = assertAppRoot(info, a.root, ctx, { mustExist: true });
    const bin = assertRuntimeBin(a.runtime);
    const env = stepEnv(bin, root, home, a.production);
    const hasFile = (f) => Boolean(lstatOrNull(path.join(root, f))?.isFile());
    let argv;
    switch (a.step) {
      case 'npm-install':
        argv = [...npmArgv(bin), hasFile('package-lock.json') ? 'ci' : 'install', ...(a.production ? ['--omit=dev'] : [])];
        break;
      case 'npm-run':
        argv = [...npmArgv(bin), 'run', '--', a.script];
        break;
      case 'venv-create':
        argv = [bin, '-m', 'venv', '--upgrade-deps', path.join(root, '.venv')];
        break;
      case 'pip-install': {
        const python = path.join(root, '.venv', 'bin', 'python');
        if (!lstatOrNull(python)) throw new OpError('not_found', `${root}/.venv does not exist; create the virtual environment first`);
        const items = [...(hasFile('requirements.txt') ? ['-r', 'requirements.txt'] : []), ...(a.packages || [])];
        if (!items.length) return { step: a.step, code: 0, durationMs: 0, output: ['nothing to install: no requirements.txt and no packages'] };
        argv = [python, '-m', 'pip', 'install', ...items];
        break;
      }
      default:
        throw new OpError('invalid_args', `unknown step ${a.step}`);
    }
    const started = Date.now();
    const opts = { cwd: root, env, allowFailure: true, timeoutMs: 1_800_000 };
    let r = await asUser(a.username, argv, opts);
    if (a.step === 'venv-create' && r.code !== 0 && /upgrade-deps/.test(r.stderr)) r = await asUser(a.username, argv.filter((x) => x !== '--upgrade-deps'), opts);
    const output = outputOf(r, 400);
    if (r.code !== 0) throw new OpError('build_failed', `${a.step} failed: ${output[output.length - 1] || `exit status ${r.code}`}`, { step: a.step, code: r.code, output });
    return { step: a.step, code: 0, durationMs: Date.now() - started, output };
  },
});

// ------------------------------------------------------------------- units ---

export function assertExecBin(bin, root) {
  const resolved = path.resolve(bin);
  const dirs = [`${runtimesRoot()}/`, '/usr/bin/', '/usr/local/bin/', `${root}/.venv/bin/`, `${root}/node_modules/.bin/`];
  if (!dirs.some((d) => resolved.startsWith(d))) throw new OpError('refused', `${bin} is outside the directories an application may start from (${dirs.join(', ')})`);
  if (!lstatOrNull(resolved)) throw new OpError('not_found', `${bin} does not exist`);
  return resolved;
}

export function renderEnvFile(env) {
  const esc = (v) => v.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `${Object.entries(env).map(([k, v]) => `${k}="${esc(v)}"`).join('\n')}\n`;
}

export function renderUnit(s) {
  const pathEnv = [...(s.pathDirs || []), '/usr/local/bin', '/usr/bin', '/bin'].join(':');
  const lines = [
    `${MANAGED} (application ${s.id}: ${s.name}). Edit through the panel; manual changes are overwritten.`,
    '[Unit]',
    `Description=WHM application ${s.name} (${s.username})`,
    'After=network.target',
    '[Service]',
    'Type=simple',
    `User=${s.username}`,
  ];
  if (s.group) lines.push(`Group=${s.group}`);
  lines.push(
    `WorkingDirectory=${s.root}`,
    `EnvironmentFile=${s.envPath}`,
    `Environment=PORT=${s.port} HOST=127.0.0.1 NODE_ENV=${s.mode} HOME=${s.home} PATH=${pathEnv}`,
    `ExecStart=${[s.bin, ...(s.args || [])].join(' ')}`,
    'Restart=on-failure',
    'RestartSec=3',
    'TimeoutStopSec=20',
    'KillSignal=SIGTERM',
    `SyslogIdentifier=${unitName(s.id)}`,
    `MemoryMax=${s.limits.memoryMaxMb}M`,
    `TasksMax=${s.limits.tasksMax}`,
    `CPUQuota=${s.limits.cpuQuotaPercent}%`,
    'NoNewPrivileges=yes',
    'PrivateTmp=yes',
    'ProtectSystem=full',
    'ProtectKernelTunables=yes',
    'ProtectControlGroups=yes',
    '[Install]',
    'WantedBy=multi-user.target',
  );
  return `${lines.join('\n')}\n`;
}

const limitsSchema = z.object({
  memoryMaxMb: z.number().int().min(64).max(65536).default(512),
  tasksMax: z.number().int().min(8).max(32768).default(256),
  cpuQuotaPercent: z.number().int().min(1).max(800).default(100),
}).strict().default({});

defineOp('app.unit.write', {
  description: 'Write /etc/whm/apps/<id>.env (0600) and whm-app-<id>.service for an application running as its account user, then daemon-reload and enable the unit',
  schema: z.object({
    id: appId,
    username: arg.username,
    name: appName,
    root: unitPath,
    exec: z.object({ bin: unitPath, args: z.array(argToken).max(32).default([]) }).strict(),
    port: z.number().int().min(1024).max(65535),
    env: envRecord.default({}),
    pathDirs: z.array(unitPath).max(4).default([]),
    mode: z.enum(['development', 'production']).default('production'),
    limits: limitsSchema,
  }).strict(),
  run: async (a, ctx) => {
    const info = assertManaged(a.username, ctx);
    const { root, home } = assertAppRoot(info, a.root, ctx, { allowPublicHtml: false, mustExist: true });
    if (!UNIT_SAFE.test(home)) throw new OpError('refused', `${home} cannot be written into a unit file`);
    const bin = assertExecBin(a.exec.bin, root);
    const dir = ctx.assertAllowedPath(appsDir(), 'write');
    const unitFile = ctx.assertAllowedPath(path.join(dir, `${unitName(a.id)}.service`), 'write');
    const envPath = ctx.assertAllowedPath(path.join(dir, `${a.id}.env`), 'write');
    if (!UNIT_SAFE.test(envPath)) throw new OpError('refused', `${envPath} cannot be written into a unit file`);
    if (!hasBinary('systemctl')) throw new OpError('capability_missing', 'systemd is not available on this host');
    ensureRootDir(dir);
    writeRootFile(envPath, renderEnvFile(a.env), 0o600);
    const unit = renderUnit({ id: a.id, username: a.username, group: groupName(info.gid), name: a.name, root, home, envPath, bin, args: a.exec.args, port: a.port, mode: a.mode, pathDirs: a.pathDirs, limits: a.limits });
    writeRootFile(unitFile, unit, 0o644);
    await exec('systemctl', ['daemon-reload'], { timeoutMs: 120_000 });
    await exec('systemctl', ['enable', unitFile], { timeoutMs: 120_000 });
    return { id: a.id, unit: unitName(a.id), path: unitFile, envPath };
  },
});

defineOp('app.unit.remove', {
  description: 'Stop and disable whm-app-<id>, remove its unit and environment files and daemon-reload',
  destructive: true,
  schema: z.object({ id: appId }).strict(),
  run: async ({ id }, ctx) => {
    const unit = unitName(id);
    const dir = ctx.assertAllowedPath(appsDir(), 'write');
    const files = [ctx.assertAllowedPath(path.join(dir, `${unit}.service`), 'write'), ctx.assertAllowedPath(path.join(dir, `${id}.env`), 'write')];
    const systemd = hasBinary('systemctl');
    let disabled = null;
    if (systemd) {
      const r = await exec('systemctl', ['disable', '--now', `${unit}.service`], { allowFailure: true, timeoutMs: 120_000 });
      disabled = r.code === 0;
    }
    let removed = false;
    for (const f of files) {
      const st = lstatOrNull(f);
      if (st && !st.isDirectory()) { fs.unlinkSync(f); removed = true; }
    }
    if (systemd) {
      await exec('systemctl', ['daemon-reload'], { allowFailure: true, timeoutMs: 120_000 });
      await exec('systemctl', ['reset-failed', `${unit}.service`], { allowFailure: true, timeoutMs: 60_000 });
    }
    return { id, unit, removed, disabled };
  },
});

// ------------------------------------------------------------------- proxy ---

function requireApache() {
  const apache = apacheLayout();
  if (!apache || !apache.bin) throw new OpError('capability_missing', 'Apache is not installed on this server (no /etc/apache2 or /etc/httpd with apache2ctl/httpd)');
  return apache;
}

async function configtest(apache) {
  const { code, stdout, stderr } = await exec(apache.bin, ['-t'], { allowFailure: true, timeoutMs: 60_000 });
  return { ok: code === 0, output: `${stdout}${stderr}`.trim() };
}

async function reloadApache(apache) {
  if (!hasBinary('systemctl')) return { reloaded: false, unit: null, error: 'systemd is not available on this host' };
  let last = null;
  for (const unit of apache.units) {
    const r = await exec('systemctl', ['reload-or-restart', `${unit}.service`], { allowFailure: true, timeoutMs: 180_000 });
    if (r.code === 0) return { reloaded: true, unit, error: null };
    last = { unit, error: lastLine(r.stderr) };
  }
  return { reloaded: false, unit: last?.unit ?? null, error: last?.error ?? 'no systemd unit found' };
}

export function apacheVersionNumber(text) {
  const m = /Apache\/(\d+\.\d+\.\d+)/.exec(String(text || ''));
  return m ? m[1] : null;
}

// ProxyPass upgrade=websocket is handled by mod_proxy_http from 2.4.47; older
// servers need the mod_rewrite + mod_proxy_wstunnel recipe.
export function supportsUpgradeWebsocket(version) {
  if (!version) return false;
  const [a, b, c] = version.split('.').map(Number);
  return a > 2 || (a === 2 && (b > 4 || (b === 4 && c >= 47)));
}

async function apacheInfo(apache) {
  const v = await exec(apache.bin, ['-v'], { allowFailure: true, timeoutMs: 30_000 });
  const m = await exec(apache.bin, ['-M'], { allowFailure: true, timeoutMs: 30_000 });
  return { version: apacheVersionNumber(parseApacheVersion(`${v.stdout}${v.stderr}`).version), modules: parseModules(`${m.stdout}${m.stderr}`).map((x) => x.name) };
}

const q = (s) => {
  const str = String(s);
  if (/["'\\\s\0-\x1f\x7f]/.test(str)) throw new OpError('invalid_args', `"${str.replace(/[\0-\x1f\x7f]/g, '?')}" cannot be rendered into the Apache configuration`);
  return `"${str}"`;
};
const trimBase = (b) => b.replace(/\/+$/, '');

export function modulesFor(apps, apacheVersion) {
  const proxies = apps.filter((a) => a.kind === 'proxy');
  const statics = apps.filter((a) => a.kind === 'static');
  const required = new Set();
  const all = new Set();
  if (proxies.length) {
    for (const m of ['proxy', 'proxy_http', 'headers']) required.add(m);
    for (const m of ['proxy', 'proxy_http', 'proxy_wstunnel', 'headers', 'rewrite']) all.add(m);
    if (proxies.some((a) => a.websockets) && !supportsUpgradeWebsocket(apacheVersion)) { required.add('proxy_wstunnel'); required.add('rewrite'); }
  }
  if (statics.some((a) => trimBase(a.basePath))) { required.add('alias'); all.add('alias'); }
  if (statics.some((a) => a.spaFallback)) { required.add('dir'); all.add('dir'); }
  return { required: [...required], all: [...all] };
}

export function renderAppsInclude(domain, apps, { apacheVersion = null } = {}) {
  if (!apps.length) return null;
  const upgrade = supportsUpgradeWebsocket(apacheVersion);
  const lines = [
    `${MANAGED} (applications for ${domain}). Edit through the panel; manual changes are overwritten.`,
    '# A proxied application sees request paths relative to its base path (the base is stripped).',
  ];
  const statics = apps.filter((a) => a.kind === 'static').sort((x, y) => trimBase(y.basePath).length - trimBase(x.basePath).length);
  const proxies = apps.filter((a) => a.kind === 'proxy').sort((x, y) => trimBase(x.basePath).length - trimBase(y.basePath).length);
  for (const a of statics) {
    const base = trimBase(a.basePath);
    lines.push('', `# Application ${a.id}: static files for ${base || '/'}`);
    lines.push(base ? `Alias ${q(base)} ${q(a.staticDir)}` : `DocumentRoot ${q(a.staticDir)}`);
    lines.push(`<Directory ${q(a.staticDir)}>`, '  Options -Indexes +FollowSymLinks', '  AllowOverride None', '  Require all granted');
    if (a.spaFallback) lines.push(`  FallbackResource ${q(`${base}/index.html`)}`);
    lines.push('</Directory>');
  }
  if (proxies.length) {
    lines.push('', 'ProxyPreserveHost On', 'RequestHeader set X-Forwarded-Proto "https" env=HTTPS');
    for (const a of proxies) {
      const base = trimBase(a.basePath);
      const target = `http://127.0.0.1:${a.port}/`;
      lines.push('', `# Application ${a.id}: proxy ${base || '/'} -> 127.0.0.1:${a.port}`);
      lines.push(`<Location ${q(base || '/')}>`, `  ProxyPass ${q(target)} retry=0 timeout=120${a.websockets && upgrade ? ' upgrade=websocket' : ''}`, `  ProxyPassReverse ${q(target)}`, '</Location>');
      for (const s of statics) {
        const sb = trimBase(s.basePath);
        if (sb && sb !== base && sb.startsWith(`${base}/`)) lines.push(`<Location ${q(sb)}>`, '  ProxyPass "!"', '</Location>');
      }
    }
    const ws = proxies.filter((a) => a.websockets && !upgrade).sort((x, y) => trimBase(y.basePath).length - trimBase(x.basePath).length);
    if (ws.length) {
      lines.push('', '# WebSocket upgrades on Apache older than 2.4.47 go through mod_proxy_wstunnel', 'RewriteEngine On');
      for (const a of ws) {
        lines.push('RewriteCond %{HTTP:Upgrade} =websocket [NC]', `RewriteRule ^${escapeRegex(trimBase(a.basePath))}/?(.*)$ ws://127.0.0.1:${a.port}/$1 [P,L]`);
      }
    }
  }
  return `${lines.join('\n')}\n`;
}

const proxyApp = z.object({
  id: appId,
  kind: z.enum(['proxy', 'static']),
  basePath,
  port: z.number().int().min(1024).max(65535).optional(),
  staticDir: unitPath.optional(),
  websockets: z.boolean().default(true),
  spaFallback: z.boolean().default(true),
}).strict().superRefine((a, c) => {
  if (a.kind === 'proxy' && a.port == null) c.addIssue({ code: z.ZodIssueCode.custom, path: ['port'], message: 'a proxied application needs a port' });
  if (a.kind === 'static' && !a.staticDir) c.addIssue({ code: z.ZodIssueCode.custom, path: ['staticDir'], message: 'a static application needs its output directory' });
});

defineOp('app.proxy.write', {
  description: 'Render <apache root>/whm-apps/<domain>.conf (proxy and static blocks for every application on the domain), ensure the Apache modules, configtest (rolled back on error) and reload; an empty list removes the file',
  schema: z.object({ domain: arg.hostname, apps: z.array(proxyApp).max(20), reload: z.boolean().default(true) }).strict()
    .refine((v) => new Set(v.apps.map((a) => trimBase(a.basePath) || '/')).size === v.apps.length, { message: 'base paths must be unique per domain', path: ['apps'] }),
  run: async ({ domain, apps, reload }, ctx) => {
    for (const a of apps) if (a.kind === 'static') ctx.assertAllowedPath(a.staticDir, 'read');
    const apache = requireApache();
    const dir = ctx.assertAllowedPath(path.join(apache.root, 'whm-apps'), 'write');
    const file = ctx.assertAllowedPath(path.join(dir, `${domain}.conf`), 'write');
    const previous = readText(file);
    const none = { enabled: [], missing: [] };
    if (!apps.length) {
      if (previous == null) return { domain, path: file, apps: 0, removed: false, modules: none, reloaded: false };
      fs.unlinkSync(file);
      const test = await configtest(apache);
      const r = reload ? await reloadApache(apache) : { reloaded: false, unit: null };
      return { domain, path: file, apps: 0, removed: true, modules: none, reloaded: r.reloaded, unit: r.unit, validated: test.ok };
    }
    const info = await apacheInfo(apache);
    const wanted = modulesFor(apps, info.version);
    let loaded = new Set(info.modules);
    const toEnable = wanted.all.filter((m) => !loaded.has(m));
    if (toEnable.length && apache.flavor === 'debian' && apache.a2tools) {
      for (const m of toEnable) await exec('a2enmod', ['-q', m], { allowFailure: true, timeoutMs: 60_000 });
      loaded = new Set((await apacheInfo(apache)).modules);
    }
    const enabled = wanted.all.filter((m) => loaded.has(m));
    const missing = wanted.all.filter((m) => !loaded.has(m));
    const requiredMissing = wanted.required.filter((m) => !loaded.has(m));
    if (requiredMissing.length) throw new OpError('capability_missing', `Apache modules required by these applications are not loaded: ${requiredMissing.join(', ')}`, { missing, enabled });
    const content = renderAppsInclude(domain, apps, { apacheVersion: info.version });
    ensureRootDir(dir);
    writeRootFile(file, content, 0o644);
    const test = await configtest(apache);
    if (!test.ok) {
      if (previous == null) fs.unlinkSync(file); else fs.writeFileSync(file, previous);
      throw new OpError('config_invalid', `Apache rejected the application include; the previous file was restored: ${lastLine(test.output)}`, { output: test.output, path: file });
    }
    const r = reload ? await reloadApache(apache) : { reloaded: false, unit: null };
    return { domain, path: file, apps: apps.length, removed: false, modules: { enabled, missing }, reloaded: r.reloaded, unit: r.unit, validated: test.ok, apacheVersion: info.version };
  },
});

// ------------------------------------------------------------------ static ---

defineOp('app.static.expose', {
  description: 'Let the web server user read a built output directory inside an account home: ACLs on the directory chain and the tree (setfacl), or o+x/o+rX modes without ACL tools, applied as the account user',
  schema: z.object({ username: arg.username, dir: arg.absPath, runUser: runUserName }).strict(),
  run: async ({ username, dir: dirArg, runUser }, ctx) => {
    const info = assertManaged(username, ctx);
    requireRunuser();
    const { root: dir, home } = assertAppRoot(info, dirArg, ctx, { allowPublicHtml: true, mustExist: true });
    const chain = [];
    for (let cur = path.dirname(dir); cur !== home; cur = path.dirname(cur)) chain.unshift(cur);
    chain.unshift(home);
    const opts = { env: { HOME: home }, timeoutMs: 600_000 };
    const acl = hasBinary('setfacl');
    if (acl) {
      for (const d of chain) await asUser(username, ['setfacl', '-m', `u:${runUser}:x`, '--', d], opts);
      await asUser(username, ['setfacl', '-R', '-m', `u:${runUser}:rX`, '-m', `d:u:${runUser}:rX`, '--', dir], opts);
    } else {
      for (const d of chain) await asUser(username, ['chmod', 'o+x', '--', d], opts);
      await asUser(username, ['chmod', '-R', 'o+rX', '--', dir], opts);
    }
    return { dir, method: acl ? 'acl' : 'mode', chain, runUser };
  },
});

// ------------------------------------------------------------------- purge ---

defineOp('app.purge', {
  description: 'Delete an application root inside the account home as the account user (never the home or public_html itself)',
  destructive: true,
  timeoutMs: 600_000,
  schema: z.object({ username: arg.username, root: arg.absPath }).strict(),
  run: async ({ username, root: rootArg }, ctx) => {
    const info = assertManaged(username, ctx);
    requireRunuser();
    const { root, home, exists } = assertAppRoot(info, rootArg, ctx, { allowPublicHtml: false, mustExist: false });
    if (!exists) return { root, removed: false };
    await asUser(username, ['rm', '-rf', '--', root], { env: { HOME: home }, timeoutMs: 600_000 });
    return { root, removed: true };
  },
});
