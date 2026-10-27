import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { exec, hasBinary, resolveBinary, ExecError } from '../exec.js';
import { defineOp, arg, OpError } from './registry.js';

// cPanel category op family: Mailman list administration and the panel's own
// upgrade. The upgrade trust lives here, in the root tier: the agent copies the
// downloaded archive into a root-owned staging area, hashes and signature-checks
// that copy itself against keys only root can install, unpacks it there, and
// only runs scripts/install.sh --upgrade from a staging directory it created.
// The unprivileged panel never gets to choose a directory, a log file, a key,
// or whether verification happens: an archive must match its checksum and carry
// a signature from a trusted key unless the host's own policy (the agent's
// environment or /etc/whm/agent.conf, both root-only) says otherwise.

// ------------------------------------------------------------ mailman ------

// Mailman 2 keeps its tools outside $PATH; the cPanel bundle and the distro
// package use these directories. Mailman 3 ships a single `mailman` CLI.
export const MAILMAN2_BIN_DIRS = ['/usr/lib/mailman/bin', '/usr/local/cpanel/3rdparty/mailman/bin', '/usr/local/mailman/bin', '/var/lib/mailman/bin'];
const MM2_TOOLS = ['list_lists', 'change_pw', 'mmsitepass'];
// Mailman 3 installs that keep the CLI off $PATH: the upstream venv layouts
// and Debian's package wrapper directory.
export const MAILMAN3_BINS = ['/opt/mailman/venv/bin/mailman', '/opt/mailman/mm/bin/mailman', '/usr/lib/mailman3/bin/mailman', '/usr/local/mailman3/bin/mailman'];

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
  const mm3 = (hasBinary('mailman') ? resolveBinary('mailman') : null) ?? MAILMAN3_BINS.find((b) => { try { return fs.statSync(b).isFile(); } catch { return false; } }) ?? null;
  if (mm3) return { installed: true, flavor: 'mailman3', binDir: path.dirname(mm3), bins: { mailman: mm3 } };
  return { installed: false, flavor: null, binDir: null, bins: {} };
}

// Mailman 2 list_lists prints "N matching mailing lists found:" then
// "    Name - description" (or bare names with -b); Mailman 3 `mailman lists -q`
// prints fully qualified names such as "announce@example.com".
export function parseListLists(stdout) {
  const out = [];
  for (const raw of String(stdout).split('\n')) {
    const line = raw.trim();
    if (!line || /matching mailing lists? found/i.test(line) || /^No matching/i.test(line)) continue;
    const m = /^(\S+?)\s+-\s+(.*)$/.exec(line);
    if (m) out.push({ name: m[1].toLowerCase(), description: m[2] === '[no description available]' ? '' : m[2] });
    else if (/^[A-Za-z0-9_.-]+(@[A-Za-z0-9.-]+)?$/.test(line)) out.push({ name: line.toLowerCase(), description: '' });
  }
  return out;
}

function requireMailman(flavor) {
  const mm = detectMailman();
  if (!mm.installed) throw new OpError('capability_missing', 'Mailman is not installed on this server (no list_lists tool or mailman command found)');
  if (flavor && mm.flavor !== flavor) throw new OpError('unsupported', `This operation needs ${flavor}; the server runs ${mm.flavor}`);
  return mm;
}

// change_pw and mmsitepass only take the secret on their command line. A
// failure must therefore never surface the argv (or the tool's echo of it in
// stderr) through the error, which the panel serialises into the HTTP response.
export async function execRedacted(bin, argv, opts) {
  try {
    return await exec(bin, argv, opts);
  } catch (err) {
    if (err instanceof ExecError || err instanceof OpError) {
      const status = typeof err.details?.code === 'number' ? ` exited with status ${err.details.code}` : ' failed';
      throw new OpError(err.code, err.code === 'command_failed' ? `"${path.basename(bin)}"${status}` : `"${path.basename(bin)}": ${err.code}`, { bin: path.basename(bin), code: err.details?.code ?? null });
    }
    throw new OpError('op_failed', `"${path.basename(bin)}" failed`, { bin: path.basename(bin) });
  }
}

defineOp('cpanel.mailman.detect', {
  description: 'Whether Mailman (2 or 3) is installed and where its tools live',
  run: async () => detectMailman(),
});

defineOp('cpanel.mailman.lists', {
  description: 'Every mailing list known to Mailman, advertised or not (list_lists / mailman lists)',
  run: async () => {
    const mm = requireMailman();
    if (mm.flavor === 'mailman3') {
      const { stdout } = await exec(mm.bins.mailman, ['lists', '-q']);
      return { flavor: mm.flavor, lists: parseListLists(stdout) };
    }
    const { stdout } = await exec(mm.bins.list_lists, []);
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
    await execRedacted(mm.bins.change_pw, ['--quiet', '--listname', list, '--password', password]);
    return { list, changed: true };
  },
});

defineOp('cpanel.mailman.site_password', {
  description: 'Set the Mailman site (or list-creator) password (Mailman 2 mmsitepass)',
  schema: z.object({ password: listPassword, creator: z.boolean().default(false) }).strict(),
  run: async ({ password, creator }) => {
    const mm = requireMailman('mailman2');
    if (!mm.bins.mmsitepass) throw new OpError('binary_not_found', `mmsitepass is missing from ${mm.binDir}`);
    await execRedacted(mm.bins.mmsitepass, creator ? ['-c', password] : [password]);
    return { changed: true, scope: creator ? 'creator' : 'site' };
  },
});

// ------------------------------------------------------------ upgrade ------

// Root-owned, world-readable (0755) so the unprivileged panel can follow the
// installer log but never write, rename or replace anything in it. The env
// overrides exist for the test suite; the agent's own environment is set by its
// systemd unit, not by the panel.
export const UPGRADE_STAGING_ROOT = '/var/cache/whm/upgrades';
export const RELEASE_KEY_DIR = '/etc/whm/release-keys';
export const AGENT_CONFIG_FILE = '/etc/whm/agent.conf';
const stagingRoot = () => path.resolve(process.env.WHM_UPGRADE_STAGING_ROOT || UPGRADE_STAGING_ROOT);
const keyDir = () => path.resolve(process.env.WHM_RELEASE_KEY_DIR || RELEASE_KEY_DIR);
const agentConfigFile = () => path.resolve(process.env.WHM_AGENT_CONFIG || AGENT_CONFIG_FILE);

const ownUid = () => (typeof process.getuid === 'function' ? process.getuid() : 0);

// The `upgrade` object of the agent's config file, read only when the file is
// the agent's own and nobody else can write it; a config the panel could edit
// would be an op argument in disguise.
function readHostUpgradeConfig() {
  const file = agentConfigFile();
  try {
    const st = fs.lstatSync(file);
    if (st.isSymbolicLink() || !st.isFile() || st.uid !== ownUid() || (st.mode & 0o022)) return {};
    const conf = JSON.parse(fs.readFileSync(file, 'utf8'));
    return conf && typeof conf.upgrade === 'object' && conf.upgrade ? conf.upgrade : {};
  } catch { return {}; }
}

// Host policy for the panel's self-upgrade. Both switches default to off, so
// out of the box only a release whose checksum matches and whose signature
// verifies against a key root placed under RELEASE_KEY_DIR can be unpacked and
// run, and the panel cannot install keys of its own. Root opts in through the
// whm-agentd unit (WHM_UPGRADE_ALLOW_UNVERIFIED=1, WHM_RELEASE_KEYS_PANEL_MANAGED=1)
// or `"upgrade": { "allowUnverified": true, "panelManagedKeys": true }` in agent.conf.
export function upgradePolicy() {
  const conf = readHostUpgradeConfig();
  return {
    allowUnverified: process.env.WHM_UPGRADE_ALLOW_UNVERIFIED === '1' || conf.allowUnverified === true,
    panelManagedKeys: process.env.WHM_RELEASE_KEYS_PANEL_MANAGED === '1' || conf.panelManagedKeys === true,
    configFile: agentConfigFile(),
  };
}
const keysReadOnly = () => !upgradePolicy().panelManagedKeys;
const POLICY_HINT = () => `set upgrade.allowUnverified in ${agentConfigFile()} or WHM_UPGRADE_ALLOW_UNVERIFIED=1 in the whm-agentd unit to permit it`;
// The app directory the installer redeploys into is where this agent runs from
// (/opt/whm in a packaged install); it is never taken from the caller.
export const AGENT_APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

const archivePath = arg.absPath.refine((p) => /\.(tar\.gz|tgz)$/.test(p), 'Release archives are .tar.gz files');
const unitName = z.string().regex(/^whm-upgrade-[A-Za-z0-9]{1,40}$/, 'Transient unit names look like whm-upgrade-<id>');
export const releaseVersion = z.string().max(64).regex(/^\d+(\.\d+){0,3}([.-][0-9A-Za-z.]+)?$/, 'Release versions look like 1.2.3 or 1.2.3-rc.1');
const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/i).transform((s) => s.toLowerCase());
const signatureB64 = z.string().regex(/^[A-Za-z0-9+/=]{80,120}$/);
export const keyId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/, 'Key ids use letters, digits, ".", "_" and "-"');
const pemText = z.string().max(4096).regex(/-----BEGIN PUBLIC KEY-----/);

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

// Something root is about to trust or run must belong to the agent itself and
// be unwritable by anyone else; a symlink is never accepted.
export function assertPrivate(p, what, { dir = true } = {}) {
  let st;
  try { st = fs.lstatSync(p); } catch { throw new OpError('not_found', `${what} ${p} does not exist`); }
  if (st.isSymbolicLink()) throw new OpError('refused', `${what} ${p} is a symbolic link`);
  if (dir ? !st.isDirectory() : !st.isFile()) throw new OpError('refused', `${what} ${p} is not a ${dir ? 'directory' : 'regular file'}`);
  if (st.uid !== ownUid()) throw new OpError('refused', `${what} ${p} is not owned by the agent (uid ${st.uid})`);
  if (st.mode & 0o022) throw new OpError('refused', `${what} ${p} is writable by other users (mode ${(st.mode & 0o777).toString(8)})`);
  return st;
}

function ensureStagingRoot() {
  const root = stagingRoot();
  fs.mkdirSync(root, { recursive: true, mode: 0o755 });
  assertPrivate(root, 'Upgrade staging root');
  return root;
}

const stagePaths = (version) => {
  const root = stagingRoot();
  return { root, stageDir: path.join(root, `src-${version}`), marker: path.join(root, `src-${version}.json`), archive: path.join(root, `whm-${version}.tar.gz`) };
};

// Once a release's installer is launched, the staged copies of other releases
// are dead weight; each goes under the same ownership checks as a re-extract,
// and one that fails them is left alone.
export function pruneStageDirs(keepVersion) {
  const root = stagingRoot();
  const removed = [];
  let entries = [];
  try { entries = fs.readdirSync(root); } catch { return removed; }
  for (const name of entries) {
    const m = /^src-(.+)\.json$/.exec(name);
    if (!m || m[1] === keepVersion || !releaseVersion.safeParse(m[1]).success) continue;
    const { stageDir, marker } = stagePaths(m[1]);
    try { removeStageDir(stageDir, marker); removed.push(m[1]); } catch { /* not ours to remove */ }
  }
  return removed;
}

function readMarker(file) {
  try {
    const m = JSON.parse(fs.readFileSync(file, 'utf8'));
    return m && typeof m === 'object' && typeof m.stageDir === 'string' && typeof m.sourceDir === 'string' ? m : null;
  } catch { return null; }
}

// Only a directory this op created (its marker exists and points at it, and it
// still belongs to the agent) may be wiped to make room for a new unpack.
function removeStageDir(stageDir, marker) {
  if (!fs.existsSync(stageDir) && !fs.existsSync(marker)) return;
  if (fs.existsSync(stageDir)) {
    const m = fs.existsSync(marker) ? readMarker(marker) : null;
    const st = fs.lstatSync(stageDir);
    if (st.isSymbolicLink() || !st.isDirectory() || st.uid !== ownUid()) throw new OpError('refused', `${stageDir} is not a staging directory the agent created`);
    const empty = fs.readdirSync(stageDir).length === 0;
    if (!empty && (!m || path.resolve(m.stageDir) !== stageDir)) throw new OpError('exists', `${stageDir} exists but was not created by a previous unpack; remove it by hand`);
    fs.rmSync(stageDir, { recursive: true, force: true });
  }
  fs.rmSync(marker, { force: true });
}

// The archive lives in a panel-owned directory, so the source path must not be
// used as a read primitive: no symlink anywhere in it (the resolved path has to
// pass the allowed-roots check again), the final component is opened O_NOFOLLOW
// and the opened inode must be the regular file that was inspected, which
// closes the rename race on the parent directory. The copy is created O_EXCL
// with mode 0600: only root hashes, unpacks and later removes it.
function stageArchive(src, staged, assertAllowed) {
  let st;
  try { st = fs.lstatSync(src); } catch { throw new OpError('not_found', `${src} does not exist`); }
  if (st.isSymbolicLink()) throw new OpError('refused', `${src} is a symbolic link`);
  if (!st.isFile()) throw new OpError('refused', `${src} is not a regular file`);
  const real = fs.realpathSync(src);
  if (real !== src) {
    assertAllowed(real);
    st = fs.lstatSync(real);
    if (!st.isFile()) throw new OpError('refused', `${real} is not a regular file`);
  }
  const inFd = fs.openSync(real, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  let outFd = null;
  try {
    const opened = fs.fstatSync(inFd);
    if (!opened.isFile() || opened.ino !== st.ino || opened.dev !== st.dev) throw new OpError('refused', `${src} changed while it was being checked`);
    outFd = fs.openSync(staged, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
    const hash = crypto.createHash('sha256');
    const buf = Buffer.alloc(1024 * 1024);
    let size = 0;
    for (;;) {
      const n = fs.readSync(inFd, buf, 0, buf.length, null);
      if (n === 0) break;
      hash.update(buf.subarray(0, n));
      fs.writeSync(outFd, buf, 0, n);
      size += n;
    }
    return { digest: hash.digest(), size };
  } finally {
    fs.closeSync(inFd);
    if (outFd !== null) fs.closeSync(outFd);
  }
}

const keyFile = (kid) => path.join(keyDir(), `${kid}.pub`);
function listKeys() {
  const dir = keyDir();
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith('.pub')).sort().map((f) => {
    const kid = f.slice(0, -4);
    const file = path.join(dir, f);
    try {
      const st = fs.lstatSync(file);
      if (st.isSymbolicLink() || st.uid !== ownUid()) return { kid, type: null, fingerprint: null, addedAt: null, valid: false, pem: null, error: 'not owned by the agent' };
      const key = crypto.createPublicKey(fs.readFileSync(file, 'utf8'));
      const der = key.export({ type: 'spki', format: 'der' });
      return { kid, type: key.asymmetricKeyType, fingerprint: crypto.createHash('sha256').update(der).digest('hex').slice(0, 32), addedAt: st.mtime.toISOString(), valid: key.asymmetricKeyType === 'ed25519', pem: key.export({ type: 'spki', format: 'pem' }) };
    } catch (err) { return { kid, type: null, fingerprint: null, addedAt: null, valid: false, pem: null, error: err.message }; }
  });
}

// Returns the kid of the first trusted Ed25519 key the signature verifies with,
// `null` when keys exist but none verifies, and `undefined` when no usable key
// is installed at all (so there is nothing to verify against).
export function verifySignature(digest, signature, kid) {
  const keys = listKeys().filter((k) => k.valid && (!kid || k.kid === kid));
  const usable = listKeys().some((k) => k.valid);
  if (!usable) return undefined;
  const sig = Buffer.from(signature, 'base64');
  for (const k of keys) {
    if (crypto.verify(null, digest, crypto.createPublicKey(k.pem), sig)) return k.kid;
  }
  return null;
}

defineOp('cpanel.upgrade.keys', {
  description: 'Trusted release-signing keys installed on the host',
  run: async () => ({ dir: keyDir(), readOnly: keysReadOnly(), policy: upgradePolicy(), keys: listKeys() }),
});

defineOp('cpanel.upgrade.key_add', {
  description: 'Install a trusted Ed25519 release-signing public key',
  schema: z.object({ kid: keyId, pem: pemText }).strict(),
  run: async ({ kid, pem }) => {
    if (keysReadOnly()) throw new OpError('refused', `Release keys are managed on the host: add ${kid}.pub under ${keyDir()} as root, or set upgrade.panelManagedKeys in ${agentConfigFile()} to let the panel manage them`);
    let key;
    try { key = crypto.createPublicKey(pem); } catch (err) { throw new OpError('invalid_key', `Not a valid public key: ${err.message}`); }
    if (key.asymmetricKeyType !== 'ed25519') throw new OpError('invalid_key', `Release keys must be Ed25519 public keys (got ${key.asymmetricKeyType})`);
    fs.mkdirSync(keyDir(), { recursive: true, mode: 0o755 });
    assertPrivate(keyDir(), 'Release key directory');
    try {
      fs.writeFileSync(keyFile(kid), key.export({ type: 'spki', format: 'pem' }), { mode: 0o644, flag: 'wx' });
    } catch (err) {
      if (err.code === 'EEXIST') throw new OpError('exists', `A key named "${kid}" already exists`);
      throw err;
    }
    return listKeys().find((k) => k.kid === kid);
  },
});

defineOp('cpanel.upgrade.key_remove', {
  description: 'Stop trusting a release-signing key',
  schema: z.object({ kid: keyId }).strict(),
  destructive: true,
  run: async ({ kid }) => {
    if (keysReadOnly()) throw new OpError('refused', `Release keys are managed on the host: remove ${kid}.pub from ${keyDir()} as root`);
    const file = keyFile(kid);
    if (!fs.existsSync(file)) throw new OpError('not_found', `No trusted key named "${kid}"`);
    fs.unlinkSync(file);
    return { kid, removed: true };
  },
});

defineOp('cpanel.upgrade.extract', {
  description: 'Copy a downloaded release archive into the root-owned staging area, verify its checksum and signature there, and unpack it',
  schema: z.object({
    archive: archivePath,
    version: releaseVersion,
    sha256: sha256Hex.nullable().default(null),
    signature: signatureB64.nullable().default(null),
    keyId: keyId.nullable().default(null),
  }).strict(),
  destructive: true,
  timeoutMs: 10 * 60 * 1000,
  run: async ({ archive, version, sha256, signature, keyId: kid }, ctx) => {
    const src = ctx.assertAllowedPath(archive, 'read');
    ensureStagingRoot();
    const { stageDir, marker, archive: staged } = stagePaths(version);
    removeStageDir(stageDir, marker);
    // The panel owns the download; a private copy is what gets hashed and
    // unpacked so the bytes cannot change between the two.
    fs.rmSync(staged, { force: true });
    const policy = upgradePolicy();
    const digestHex = (() => {
      try { return stageArchive(src, staged, (p) => ctx.assertAllowedPath(p, 'read')).digest.toString('hex'); } catch (err) { fs.rmSync(staged, { force: true }); throw err; }
    })();
    const digest = Buffer.from(digestHex, 'hex');
    const warnings = [];
    const fail = (code, message) => { fs.rmSync(staged, { force: true }); throw new OpError(code, message, { sha256: digestHex }); };
    if (sha256) {
      if (digestHex !== sha256) fail('checksum_mismatch', `SHA-256 mismatch: feed says ${sha256}, archive is ${digestHex}`);
    } else if (!policy.allowUnverified) fail('unverified', `No SHA-256 checksum was published for this release and the host policy refuses unverified upgrades; ${POLICY_HINT()}`);
    else warnings.push('No checksum published; the archive was accepted because the host policy allows unverified upgrades');
    let signer = null;
    let signatureState;
    if (signature) {
      const result = verifySignature(digest, signature, kid);
      if (result === undefined) {
        if (!policy.allowUnverified) fail('unverified', `The release is signed but no trusted release key is installed under ${keyDir()}; add the publisher's key as root, or ${POLICY_HINT()}`);
        signatureState = 'no_trusted_key';
        warnings.push('Signature not checked: no trusted release key is installed; accepted because the host policy allows unverified upgrades');
      } else if (result === null) {
        // A signature that does not verify is evidence of tampering, never
        // something any policy may wave through.
        fail('invalid_signature', `The release signature does not verify against any trusted key${kid ? ` (feed names "${kid}")` : ''}`);
      } else { signer = result; signatureState = 'verified'; }
    } else if (!policy.allowUnverified) {
      fail('unsigned', `The feed published no signature and the host policy only runs releases signed by a key under ${keyDir()}; ${POLICY_HINT()}`);
    } else { signatureState = 'unsigned'; warnings.push('No signature published; accepted because the host policy allows unverified upgrades'); }

    fs.mkdirSync(stageDir, { mode: 0o755 });
    try {
      await exec('tar', ['--no-same-owner', '--no-same-permissions', '-xzf', staged, '-C', stageDir], { timeoutMs: 10 * 60 * 1000 });
      await exec('chmod', ['-R', 'go-w', stageDir]);
      const sourceDir = findReleaseRoot(stageDir);
      if (!sourceDir) throw new OpError('invalid_package', 'The archive is not a WHM release: package.json, server/ and scripts/install.sh are missing');
      const pkg = JSON.parse(fs.readFileSync(path.join(sourceDir, 'package.json'), 'utf8'));
      const record = { version, stageDir, sourceDir, sha256: digestHex, signer, signatureState, at: new Date().toISOString(), name: pkg.name ?? null, packageVersion: typeof pkg.version === 'string' ? pkg.version : null };
      fs.writeFileSync(marker, JSON.stringify(record), { mode: 0o644 });
      return { ...record, warnings };
    } catch (err) {
      fs.rmSync(stageDir, { recursive: true, force: true });
      fs.rmSync(marker, { force: true });
      throw err;
    } finally {
      fs.rmSync(staged, { force: true });
    }
  },
});

// What cpanel.upgrade.run re-checks before root executes anything: the staging
// root, the marker, the stage directory, the release root and the installer
// itself must all still be the agent's own, unwritable by others, and match.
export function verifyStagedRelease(version) {
  const { root, stageDir, marker } = stagePaths(version);
  assertPrivate(root, 'Upgrade staging root');
  assertPrivate(marker, 'Release marker', { dir: false });
  const m = readMarker(marker);
  if (!m || path.resolve(m.stageDir) !== stageDir) throw new OpError('invalid_package', `No verified release ${version} is staged; unpack it first`);
  const sourceDir = path.resolve(m.sourceDir);
  if (sourceDir !== stageDir && path.dirname(sourceDir) !== stageDir) throw new OpError('invalid_package', `Release root ${sourceDir} is outside ${stageDir}`);
  assertPrivate(stageDir, 'Staging directory');
  if (sourceDir !== stageDir) assertPrivate(sourceDir, 'Release root');
  assertPrivate(path.join(sourceDir, 'scripts'), 'Installer directory');
  assertPrivate(path.join(sourceDir, 'scripts', 'install.sh'), 'Installer', { dir: false });
  if (!isReleaseDir(sourceDir)) throw new OpError('invalid_package', `${sourceDir} is not an unpacked WHM release`);
  return { ...m, stageDir, sourceDir };
}

defineOp('cpanel.upgrade.run', {
  description: 'Run scripts/install.sh --upgrade from a verified, staged release as a transient systemd unit',
  schema: z.object({ version: releaseVersion, unit: unitName, skipNode: z.boolean().default(false) }).strict(),
  destructive: true,
  run: async ({ version, unit, skipNode }) => {
    const staged = verifyStagedRelease(version);
    // The policy is re-read here: a release staged while unverified upgrades
    // were permitted must not run once root has withdrawn that permission.
    if (staged.signatureState !== 'verified' && !upgradePolicy().allowUnverified) throw new OpError('unverified', `Release ${version} was staged without a verified signature (${staged.signatureState ?? 'unknown'}) and the host policy refuses to run it; ${POLICY_HINT()}`);
    // The installer restarts whm-agentd and whm-panel; as a child of either it
    // would be killed half way. systemd-run detaches it into its own unit. The
    // unit is deliberately not --collect'ed: a failed unit must stay visible
    // (Result=exit-code) until the panel has read it and reset it.
    if (!hasBinary('systemd-run')) throw new OpError('unsupported', 'systemd-run is required to run the installer detached from the panel');
    const bash = resolveBinary('bash');
    if (!bash) throw new OpError('binary_not_found', 'bash is not installed');
    const log = path.join(stagingRoot(), `${unit}.log`);
    try {
      fs.writeFileSync(log, `# whm upgrade started ${new Date().toISOString()} from ${staged.sourceDir} (sha256 ${staged.sha256}, signer ${staged.signer ?? 'none'})\n`, { mode: 0o644, flag: 'wx' });
    } catch (err) {
      if (err.code === 'EEXIST') throw new OpError('exists', `Unit ${unit} already ran (log ${log} exists)`);
      throw err;
    }
    const argv = ['--unit', unit, '--quiet', `--property=StandardOutput=append:${log}`, `--property=StandardError=append:${log}`, '--setenv=WHM_UPGRADE_FROM_PANEL=1'];
    if (AGENT_APP_DIR !== '/opt/whm') argv.push(`--setenv=WHM_APP_DIR=${AGENT_APP_DIR}`);
    argv.push(bash, path.join(staged.sourceDir, 'scripts', 'install.sh'), '--upgrade');
    if (skipNode) argv.push('--skip-node');
    await exec('systemd-run', argv);
    return { unit: `${unit}.service`, logFile: log, detached: true, sourceDir: staged.sourceDir, appDir: AGENT_APP_DIR, pruned: pruneStageDirs(version) };
  },
});

function parseShow(stdout) {
  const kv = {};
  for (const line of stdout.split('\n')) {
    const i = line.indexOf('=');
    if (i > 0) kv[line.slice(0, i)] = line.slice(i + 1);
  }
  return kv;
}

defineOp('cpanel.upgrade.unit_status', {
  description: 'State and exit status of an upgrade unit; optionally clears a failed unit once it has been read',
  schema: z.object({ unit: unitName, resetFailed: z.boolean().default(false) }).strict(),
  run: async ({ unit, resetFailed }) => {
    if (!hasBinary('systemctl')) throw new OpError('capability_missing', 'systemd is not available on this host');
    const { stdout } = await exec('systemctl', ['show', `${unit}.service`, '--no-pager', '--property=LoadState,ActiveState,SubState,Result,ExecMainStatus,ExecMainCode'], { allowFailure: true });
    const kv = parseShow(stdout);
    const installed = Boolean(kv.LoadState) && kv.LoadState !== 'not-found';
    const out = {
      unit, installed, state: installed ? kv.ActiveState || 'unknown' : 'gone', subState: kv.SubState || null,
      result: installed ? kv.Result || null : null,
      exitStatus: installed && /^\d+$/.test(kv.ExecMainStatus || '') ? Number(kv.ExecMainStatus) : null,
      exitCode: installed ? kv.ExecMainCode || null : null,
    };
    if (resetFailed && installed && kv.ActiveState === 'failed') {
      await exec('systemctl', ['reset-failed', `${unit}.service`], { allowFailure: true });
      out.reset = true;
    }
    return out;
  },
});
