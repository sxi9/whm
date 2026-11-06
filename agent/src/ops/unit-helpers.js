import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { exec, hasBinary } from '../exec.js';
import { OpError } from './registry.js';
import { lastLine } from './as-user.js';

// The systemd machinery shared by the per-account daemons (apps.unit.* for
// the Application Manager, webdisk.unit.* for Web Disk): a unit file rendered
// by the panel under /etc/whm/apps/<username>/ is linked into systemd with
// `systemctl link`, enabled and (re)started; nothing under /etc/systemd/system
// is ever written directly. This module registers no op (ops/index.js imports
// it like any family, which is harmless) and never imports lib.js.

export const APPS_DIR = '/etc/whm/apps';
export const MANAGED_PREFIX = '# Managed by Keel';

export const appsDir = () => process.env.WHM_APPS_DIR || APPS_DIR;
export const systemLink = (unit) => path.join('/etc/systemd/system', `${unit}.service`);

// The unit carries account secrets (variables, file paths): only root reads
// the directory and the file; systemd runs as root and `systemctl link` needs
// nothing more than the path.
export function writeAtomic(file, content, mode = 0o600) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.whm-tmp-${process.pid}-${crypto.randomBytes(3).toString('hex')}`;
  fs.writeFileSync(tmp, content, { mode });
  fs.chmodSync(tmp, mode);
  fs.renameSync(tmp, file);
}

export function requireSystemd() {
  if (!hasBinary('systemctl')) throw new OpError('capability_missing', 'systemd is not available on this host');
}

export async function systemctl(argv, { allowFailure = false, timeoutMs = 120_000 } = {}) {
  return exec('systemctl', argv, { allowFailure, timeoutMs });
}

export function linkedTo(unit) {
  try {
    const st = fs.lstatSync(systemLink(unit));
    return st.isSymbolicLink() ? fs.readlinkSync(systemLink(unit)) : false;
  } catch { return null; }
}

export function parseShow(stdout) {
  const kv = {};
  for (const line of String(stdout || '').split('\n')) {
    const i = line.indexOf('=');
    if (i > 0) kv[line.slice(0, i)] = line.slice(i + 1);
  }
  const installed = Boolean(kv.LoadState) && kv.LoadState !== 'not-found';
  return {
    installed,
    active: kv.ActiveState === 'active',
    state: installed ? kv.ActiveState || 'unknown' : 'absent',
    subState: kv.SubState || null,
    enabled: kv.UnitFileState === 'enabled' || kv.UnitFileState === 'linked',
    unitFileState: kv.UnitFileState || null,
    pid: Number(kv.MainPID) || null,
    startedAt: kv.ExecMainStartTimestamp || null,
    memoryBytes: /^\d+$/.test(kv.MemoryCurrent || '') ? Number(kv.MemoryCurrent) : null,
    restarts: Number(kv.NRestarts) || 0,
    result: kv.Result || null,
  };
}

export async function unitStatus(unit) {
  const props = ['ActiveState', 'SubState', 'UnitFileState', 'MainPID', 'ExecMainStartTimestamp', 'MemoryCurrent', 'NRestarts', 'LoadState', 'Result'];
  const { stdout } = await systemctl(['show', `${unit}.service`, '--no-pager', `--property=${props.join(',')}`], { allowFailure: true });
  return { unit, ...parseShow(stdout) };
}

const readOrNull = (file) => { try { return fs.readFileSync(file, 'utf8'); } catch { return null; } };

// Writes the rendered unit, links it (once), enables it and restarts it. A
// file or link the panel did not create is refused, never overwritten.
export async function installUnit({ unit, file, content }) {
  requireSystemd();
  const previous = readOrNull(file);
  if (previous != null && !previous.startsWith(MANAGED_PREFIX)) throw new OpError('refused', `${file} was not written by the panel; refusing to overwrite it`);
  const link = linkedTo(unit);
  if (link !== file && link != null) throw new OpError('refused', `${systemLink(unit)} exists and is not the panel's link`);
  writeAtomic(file, content);
  if (link !== file) {
    const r = await systemctl(['link', file], { allowFailure: true });
    if (r.code !== 0) throw new OpError('command_failed', `systemctl link: ${lastLine(r)}`);
  }
  await systemctl(['daemon-reload'], { allowFailure: true });
  const en = await systemctl(['enable', `${unit}.service`], { allowFailure: true });
  if (en.code !== 0) throw new OpError('command_failed', `systemctl enable: ${lastLine(en)}`);
  const start = await systemctl(['restart', `${unit}.service`], { allowFailure: true });
  const status = await unitStatus(unit);
  return { unit, path: file, bytes: Buffer.byteLength(content), started: start.code === 0, startError: start.code === 0 ? null : lastLine(start), status };
}

// Stops, disables and unlinks the unit and deletes its file; a stale link
// left by hand is reported, not forced.
export async function removeUnit({ unit, file }) {
  requireSystemd();
  const existed = fs.existsSync(file);
  if (existed && !fs.readFileSync(file, 'utf8').startsWith(MANAGED_PREFIX)) throw new OpError('refused', `${file} was not written by the panel; refusing to delete it`);
  await systemctl(['disable', '--now', `${unit}.service`], { allowFailure: true });
  // `disable` drops the link that `systemctl link` created.
  const link = linkedTo(unit);
  if (link === file) { try { fs.unlinkSync(systemLink(unit)); } catch { /* raced */ } }
  if (existed) fs.unlinkSync(file);
  await systemctl(['daemon-reload'], { allowFailure: true });
  await systemctl(['reset-failed', `${unit}.service`], { allowFailure: true });
  return { unit, path: file, removed: existed };
}

export async function controlUnit(unit, action) {
  requireSystemd();
  const status = await unitStatus(unit);
  if (!status.installed) throw new OpError('not_found', `${unit} is not installed`);
  const r = await systemctl([action, `${unit}.service`], { allowFailure: true });
  if (r.code !== 0) throw new OpError('command_failed', `systemctl ${action}: ${lastLine(r)}`);
  return { unit, action, status: await unitStatus(unit) };
}
