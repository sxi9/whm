import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { exec, hasBinary, resolveBinary } from '../exec.js';
import { defineOp, arg, OpError } from './registry.js';

// cPanel category op family: Mailman list administration and the panel's own
// upgrade (unpack a verified release archive, run scripts/install.sh --upgrade
// detached under a transient systemd unit so the installer survives the restart
// of whm-agentd / whm-panel that it performs itself).

// ------------------------------------------------------------ mailman ------

// Mailman 2 keeps its tools outside $PATH; the cPanel bundle and the distro
// package use these directories. Mailman 3 ships a single `mailman` CLI.
export const MAILMAN2_BIN_DIRS = ['/usr/lib/mailman/bin', '/usr/local/cpanel/3rdparty/mailman/bin', '/usr/local/mailman/bin', '/var/lib/mailman/bin'];
const MM2_TOOLS = ['list_lists', 'change_pw', 'mmsitepass'];

export const listName = z.string().regex(/^[a-z0-9][a-z0-9_.-]{0,63}$/, 'Mailing list names use lowercase letters, digits, ".", "_" and "-"');
// Passed to change_pw as an argument value: no control characters and never a
// leading "-", which the tool would read as an option.
export const listPassword = z.string().min(8).max(128).regex(/^[^\s-][^\0-\x1f\x7f]*$/, 'Passwords must not start with "-" or contain control characters');

export function detectMailman() {
  for (const dir of MAILMAN2_BIN_DIRS) {
    const bins = Object.fromEntries(MM2_TOOLS.map((t) => [t, path.join(dir, t)]));
    if (fs.existsSync(bins.list_lists)) {
      return { installed: true, flavor: 'mailman2', binDir: dir, bins: Object.fromEntries(MM2_TOOLS.map((t) => [t, fs.existsSync(bins[t]) ? bins[t] : null])) };
    }
  }
  if (hasBinary('mailman')) return { installed: true, flavor: 'mailman3', binDir: path.dirname(resolveBinary('mailman')), bins: { mailman: resolveBinary('mailman') } };
  return { installed: false, flavor: null, binDir: null, bins: {} };
}

// list_lists prints "N matching mailing lists found:" then "    name - description".
export function parseListLists(stdout) {
  const out = [];
  for (const raw of String(stdout).split('\n')) {
    const line = raw.trim();
    if (!line || /matching mailing lists? found/i.test(line) || /^No matching/i.test(line)) continue;
    const m = /^(\S+?)\s+-\s+(.*)$/.exec(line);
    if (m) out.push({ name: m[1].toLowerCase(), description: m[2] === '[no description available]' ? '' : m[2] });
    else if (/^[A-Za-z0-9_.-]+$/.test(line)) out.push({ name: line.toLowerCase(), description: '' });
  }
  return out;
}

function requireMailman(flavor) {
  const mm = detectMailman();
  if (!mm.installed) throw new OpError('capability_missing', 'Mailman is not installed on this server (no list_lists tool or mailman command found)');
  if (flavor && mm.flavor !== flavor) throw new OpError('unsupported', `This operation needs ${flavor}; the server runs ${mm.flavor}`);
  return mm;
}

defineOp('cpanel.mailman.detect', {
  description: 'Whether Mailman (2 or 3) is installed and where its tools live',
  run: async () => detectMailman(),
});

defineOp('cpanel.mailman.lists', {
  description: 'Mailing lists known to Mailman (list_lists / mailman lists)',
  run: async () => {
    const mm = requireMailman();
    if (mm.flavor === 'mailman3') {
      const { stdout } = await exec(mm.bins.mailman, ['lists', '-q']);
      return { flavor: mm.flavor, lists: parseListLists(stdout) };
    }
    const { stdout } = await exec(mm.bins.list_lists, ['-a']);
    return { flavor: mm.flavor, lists: parseListLists(stdout) };
  },
});

defineOp('cpanel.mailman.change_pw', {
  description: 'Set a mailing list administrator password (Mailman 2 change_pw)',
  schema: z.object({ list: listName, password: listPassword }).strict(),
  run: async ({ list, password }) => {
    const mm = requireMailman();
    if (mm.flavor !== 'mailman2') throw new OpError('unsupported', 'Mailman 3 has no per-list administrator password; manage list owners with "mailman members" or the Postorius UI instead');
    if (!mm.bins.change_pw) throw new OpError('binary_not_found', `change_pw is missing from ${mm.binDir}`);
    const { stdout } = await exec(mm.bins.list_lists, ['-b']);
    const known = parseListLists(stdout).map((l) => l.name);
    if (!known.includes(list)) throw new OpError('not_found', `Mailing list "${list}" does not exist`);
    // change_pw only takes the password as an argument; it is never logged here.
    await exec(mm.bins.change_pw, ['--quiet', '--listname', list, '--password', password]);
    return { list, changed: true };
  },
});

defineOp('cpanel.mailman.site_password', {
  description: 'Set the Mailman site (or list-creator) password (Mailman 2 mmsitepass)',
  schema: z.object({ password: listPassword, creator: z.boolean().default(false) }).strict(),
  run: async ({ password, creator }) => {
    const mm = requireMailman('mailman2');
    if (!mm.bins.mmsitepass) throw new OpError('binary_not_found', `mmsitepass is missing from ${mm.binDir}`);
    await exec(mm.bins.mmsitepass, creator ? ['-c', password] : [password]);
    return { changed: true, scope: creator ? 'creator' : 'site' };
  },
});

// ------------------------------------------------------------ upgrade ------

const archivePath = arg.absPath.refine((p) => /\.(tar\.gz|tgz)$/.test(p), 'Release archives are .tar.gz files');
const unitName = z.string().regex(/^whm-upgrade-[A-Za-z0-9]{1,40}$/, 'Transient unit names look like whm-upgrade-<id>');

export function isReleaseDir(dir) {
  return fs.existsSync(path.join(dir, 'package.json')) && fs.existsSync(path.join(dir, 'scripts', 'install.sh')) && fs.existsSync(path.join(dir, 'server'));
}

// A release tarball is either flat or wrapped in one top-level directory (what
// `git archive` and GitHub produce); either way the directory holding
// package.json + scripts/install.sh is the source the installer runs from.
export function findReleaseRoot(destDir) {
  if (isReleaseDir(destDir)) return destDir;
  const entries = fs.readdirSync(destDir, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith('.'));
  if (entries.length === 1 && isReleaseDir(path.join(destDir, entries[0].name))) return path.join(destDir, entries[0].name);
  return null;
}

defineOp('cpanel.upgrade.extract', {
  description: 'Unpack a downloaded panel release archive into a staging directory',
  schema: z.object({ archive: archivePath, destDir: arg.absPath }).strict(),
  timeoutMs: 10 * 60 * 1000,
  run: async ({ archive, destDir }, ctx) => {
    const src = ctx.assertAllowedPath(archive, 'read');
    const dest = ctx.assertAllowedPath(destDir, 'write');
    if (!fs.existsSync(src)) throw new OpError('not_found', `${src} does not exist`);
    fs.rmSync(dest, { recursive: true, force: true });
    fs.mkdirSync(dest, { recursive: true, mode: 0o755 });
    await exec('tar', ['--no-absolute-names', '--no-same-owner', '-xzf', src, '-C', dest], { timeoutMs: 10 * 60 * 1000 });
    const sourceDir = findReleaseRoot(dest);
    if (!sourceDir) {
      fs.rmSync(dest, { recursive: true, force: true });
      throw new OpError('invalid_package', 'The archive is not a WHM release: package.json, server/ and scripts/install.sh are missing');
    }
    const pkg = JSON.parse(fs.readFileSync(path.join(sourceDir, 'package.json'), 'utf8'));
    return { sourceDir, version: typeof pkg.version === 'string' ? pkg.version : null, name: pkg.name ?? null };
  },
});

defineOp('cpanel.upgrade.run', {
  description: 'Run scripts/install.sh --upgrade from an unpacked release as a transient systemd unit',
  schema: z.object({ sourceDir: arg.absPath, logFile: arg.absPath, unit: unitName, appDir: arg.absPath.optional(), skipNode: z.boolean().default(false) }).strict(),
  destructive: true,
  run: async ({ sourceDir, logFile, unit, appDir, skipNode }, ctx) => {
    const src = ctx.assertAllowedPath(sourceDir, 'read');
    const log = ctx.assertAllowedPath(logFile, 'write');
    if (!isReleaseDir(src)) throw new OpError('invalid_package', `${src} is not an unpacked WHM release`);
    // The installer restarts whm-agentd and whm-panel; as a child of either it
    // would be killed half way. systemd-run detaches it into its own unit.
    if (!hasBinary('systemd-run')) throw new OpError('unsupported', 'systemd-run is required to run the installer detached from the panel');
    const bash = resolveBinary('bash');
    if (!bash) throw new OpError('binary_not_found', 'bash is not installed');
    fs.mkdirSync(path.dirname(log), { recursive: true });
    fs.writeFileSync(log, `# whm upgrade started ${new Date().toISOString()} from ${src}\n`, { flag: 'a' });
    const argv = ['--unit', unit, '--collect', '--quiet', `--property=StandardOutput=append:${log}`, `--property=StandardError=append:${log}`, '--setenv=WHM_UPGRADE_FROM_PANEL=1'];
    if (appDir) argv.push(`--setenv=WHM_APP_DIR=${ctx.assertAllowedPath(appDir, 'write')}`);
    argv.push(bash, path.join(src, 'scripts', 'install.sh'), '--upgrade');
    if (skipNode) argv.push('--skip-node');
    await exec('systemd-run', argv);
    return { unit: `${unit}.service`, logFile: log, detached: true, sourceDir: src };
  },
});
