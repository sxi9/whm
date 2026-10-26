import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { exec, hasBinary } from '../exec.js';
import { defineOp, arg, OpError } from './registry.js';

// Initial Quota Setup: detect whether the filesystems that hold account homes
// are mounted with user quotas, run quotacheck/quotaon where the mount allows
// it, and otherwise produce the exact /etc/fstab change the operator needs.
const FSTAB = '/etc/fstab';
const SUPPORTED = new Set(['ext2', 'ext3', 'ext4', 'xfs', 'jfs', 'reiserfs', 'f2fs']);
const USER_OPTS = /^(usrquota|quota|uquota|usrjquota=.*|uqnoenforce)$/;
const GROUP_OPTS = /^(grpquota|gquota|grpjquota=.*|gqnoenforce)$/;
const TOOLS = ['quotacheck', 'quotaon', 'quotaoff', 'repquota', 'setquota', 'edquota', 'xfs_quota', 'tune2fs', 'mount'];

const unescapeMount = (s) => s.replace(/\\(\d{3})/g, (_, oct) => String.fromCharCode(parseInt(oct, 8)));

export function parseMounts(text) {
  return text.split('\n').filter(Boolean).map((line) => {
    const [device, mountpoint, fstype, options] = line.split(/\s+/);
    return { device, mountpoint: unescapeMount(mountpoint || ''), fstype, options: (options || '').split(',').filter(Boolean) };
  }).filter((m) => m.device && (m.device.startsWith('/dev/') || SUPPORTED.has(m.fstype)));
}

export function parseFstab(text) {
  const entries = [];
  text.split('\n').forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;
    const fields = line.split(/\s+/);
    if (fields.length < 4) return;
    const [spec, mountpoint, fstype, options, dump = '0', pass = '0'] = fields;
    entries.push({ lineNo: i + 1, raw, spec, mountpoint: unescapeMount(mountpoint), fstype, options: options.split(',').filter(Boolean), dump, pass });
  });
  return entries;
}

export function withQuotaOptions(entry, { groupQuota = true } = {}) {
  const options = entry.options.filter((o) => o !== 'defaults' || entry.options.length === 1);
  const next = [...options];
  if (!next.some((o) => USER_OPTS.test(o))) next.push(entry.fstype === 'xfs' ? 'uquota' : 'usrquota');
  if (groupQuota && !next.some((o) => GROUP_OPTS.test(o))) next.push(entry.fstype === 'xfs' ? 'gquota' : 'grpquota');
  const fields = entry.raw.trim().split(/\s+/);
  fields[3] = next.join(',');
  return { options: next, line: fields.join('\t') };
}

function readFstab() {
  try { return fs.readFileSync(FSTAB, 'utf8'); } catch { return ''; }
}

function readMounts() {
  try { return parseMounts(fs.readFileSync('/proc/mounts', 'utf8')); } catch { return []; }
}

async function quotaonState(mountpoint) {
  if (!hasBinary('quotaon')) return { user: null, group: null };
  const { stdout, stderr } = await exec('quotaon', ['-p', '-u', '-g', mountpoint], { allowFailure: true });
  const text = `${stdout}\n${stderr}`;
  const pick = (kind) => { const m = text.match(new RegExp(`${kind} quota on .* is (on|off)`)); return m ? m[1] === 'on' : null; };
  return { user: pick('user'), group: pick('group') };
}

async function ext4QuotaFeature(device) {
  if (!hasBinary('tune2fs') || !device.startsWith('/dev/')) return null;
  const { stdout, code } = await exec('tune2fs', ['-l', device], { allowFailure: true, timeoutMs: 15_000 });
  if (code !== 0) return null;
  const m = stdout.match(/^Filesystem features:\s*(.*)$/m);
  return m ? m[1].split(/\s+/).includes('quota') : null;
}

async function describe(m, fstabEntries) {
  const fstab = fstabEntries.find((e) => e.mountpoint === m.mountpoint) || null;
  const supported = SUPPORTED.has(m.fstype);
  const userMounted = m.options.some((o) => USER_OPTS.test(o));
  const groupMounted = m.options.some((o) => GROUP_OPTS.test(o));
  const feature = supported && /^ext[34]$/.test(m.fstype) ? await ext4QuotaFeature(m.device) : null;
  const state = supported ? await quotaonState(m.mountpoint) : { user: null, group: null };
  const files = { user: fs.existsSync(path.join(m.mountpoint, 'aquota.user')), group: fs.existsSync(path.join(m.mountpoint, 'aquota.group')) };
  const proposed = fstab ? withQuotaOptions(fstab) : null;
  return {
    device: m.device, mountpoint: m.mountpoint, fstype: m.fstype, mountOptions: m.options, supported,
    userQuotaMounted: userMounted, groupQuotaMounted: groupMounted, ext4QuotaFeature: feature,
    quotaFiles: files, active: state,
    fstab: fstab ? { lineNo: fstab.lineNo, line: fstab.raw.trim(), options: fstab.options, hasUserQuota: fstab.options.some((o) => USER_OPTS.test(o)), hasGroupQuota: fstab.options.some((o) => GROUP_OPTS.test(o)) } : null,
    proposedFstabLine: proposed && !fstab.options.some((o) => USER_OPTS.test(o)) ? proposed.line : null,
    // xfs reads its quota options only at mount time, so a remount is not enough.
    rebootRequired: m.fstype === 'xfs' && !userMounted,
  };
}

defineOp('quota.status', {
  description: 'Quota tools, mounted filesystems and whether user quotas are enabled on each',
  run: async () => {
    const fstabEntries = parseFstab(readFstab());
    const filesystems = [];
    for (const m of readMounts()) filesystems.push(await describe(m, fstabEntries));
    return { tools: Object.fromEntries(TOOLS.map((t) => [t, hasBinary(t)])), fstabPath: FSTAB, fstabPresent: fs.existsSync(FSTAB), filesystems };
  },
});

defineOp('quota.fstab.enable', {
  description: 'Add usrquota (and grpquota) to a filesystem line in /etc/fstab, keeping a backup',
  destructive: true,
  schema: z.object({ mountpoint: arg.absPath, groupQuota: z.boolean().default(true) }).strict(),
  run: async ({ mountpoint, groupQuota }) => {
    const text = readFstab();
    const entry = parseFstab(text).find((e) => e.mountpoint === mountpoint);
    if (!entry) throw new OpError('not_found', `${FSTAB} has no entry for ${mountpoint}`);
    if (!SUPPORTED.has(entry.fstype)) throw new OpError('unsupported', `Disk quotas are not supported on ${entry.fstype} (${mountpoint})`);
    const { line } = withQuotaOptions(entry, { groupQuota });
    if (line.split(/\s+/)[3] === entry.options.join(',')) return { mountpoint, changed: false, line: entry.raw.trim() };
    const backup = `${FSTAB}.whm-bak`;
    fs.copyFileSync(FSTAB, backup);
    const lines = text.split('\n');
    lines[entry.lineNo - 1] = line;
    const tmp = `${FSTAB}.whm-tmp-${process.pid}`;
    fs.writeFileSync(tmp, lines.join('\n'), { mode: 0o644 });
    fs.renameSync(tmp, FSTAB);
    return { mountpoint, changed: true, previousLine: entry.raw.trim(), line, backup };
  },
});

defineOp('quota.enable', {
  description: 'Remount with quota options when fstab allows it, then quotacheck and quotaon a filesystem',
  timeoutMs: 3_600_000,
  schema: z.object({ mountpoint: arg.absPath, groupQuota: z.boolean().default(true) }).strict(),
  run: async ({ mountpoint, groupQuota }) => {
    if (!hasBinary('quotacheck') || !hasBinary('quotaon')) throw new OpError('capability_missing', 'The quota tools (quotacheck, quotaon) are not installed; install the "quota" package first');
    const steps = [];
    let mount = readMounts().find((m) => m.mountpoint === mountpoint);
    if (!mount) throw new OpError('not_found', `${mountpoint} is not a mounted filesystem`);
    if (!SUPPORTED.has(mount.fstype)) throw new OpError('unsupported', `Disk quotas are not supported on ${mount.fstype} (${mountpoint})`);
    const fstabEntry = parseFstab(readFstab()).find((e) => e.mountpoint === mountpoint) || null;
    const want = ['u', groupQuota ? 'g' : ''].join('');

    if (!mount.options.some((o) => USER_OPTS.test(o))) {
      if (mount.fstype === 'xfs') {
        steps.push({ step: 'remount', ok: false, detail: 'XFS reads quota options only at mount time; reboot after changing fstab' });
        return { mountpoint, enabled: false, reason: 'reboot_required', steps, fstab: fstabEntry ? withQuotaOptions(fstabEntry, { groupQuota }).line : null };
      }
      if (fstabEntry?.options.some((o) => USER_OPTS.test(o))) {
        const r = await exec('mount', ['-o', 'remount', mountpoint], { allowFailure: true, timeoutMs: 120_000 });
        steps.push({ step: 'remount', ok: r.code === 0, detail: r.code === 0 ? `remounted ${mountpoint} with ${fstabEntry.options.join(',')}` : r.stderr.trim() });
        mount = readMounts().find((m) => m.mountpoint === mountpoint) || mount;
      }
      const feature = /^ext[34]$/.test(mount.fstype) ? await ext4QuotaFeature(mount.device) : null;
      if (!mount.options.some((o) => USER_OPTS.test(o)) && !feature) {
        steps.push({ step: 'mount-options', ok: false, detail: 'the filesystem is not mounted with usrquota' });
        return { mountpoint, enabled: false, reason: 'fstab_option_required', steps, fstab: fstabEntry ? withQuotaOptions(fstabEntry, { groupQuota }).line : `${mount.device}\t${mountpoint}\t${mount.fstype}\tdefaults,usrquota${groupQuota ? ',grpquota' : ''}\t0\t1` };
      }
    }

    const feature = /^ext[34]$/.test(mount.fstype) ? await ext4QuotaFeature(mount.device) : null;
    if (!feature && (!fs.existsSync(path.join(mountpoint, 'aquota.user')) || (groupQuota && !fs.existsSync(path.join(mountpoint, 'aquota.group'))))) {
      const r = await exec('quotacheck', [`-c${want}`, '-m', '-f', mountpoint], { allowFailure: true, timeoutMs: 3_600_000 });
      steps.push({ step: 'quotacheck', ok: r.code === 0, detail: (r.stderr.trim() || r.stdout.trim()).split('\n').pop() || 'quota files created' });
      if (r.code !== 0) return { mountpoint, enabled: false, reason: 'quotacheck_failed', steps };
    } else {
      steps.push({ step: 'quotacheck', ok: true, detail: feature ? 'ext4 quota feature keeps quota data in the journal; no quota files needed' : 'quota files already exist' });
    }
    const on = await exec('quotaon', [`-${want}`, mountpoint], { allowFailure: true });
    const already = /already on|Device or resource busy/i.test(on.stderr);
    steps.push({ step: 'quotaon', ok: on.code === 0 || already, detail: on.code === 0 ? 'quotas turned on' : on.stderr.trim().split('\n').pop() });
    const state = await quotaonState(mountpoint);
    return { mountpoint, enabled: state.user !== false && (on.code === 0 || already), steps, active: state };
  },
});

defineOp('quota.disable', {
  description: 'Turn quotas off on a filesystem (quotaoff)',
  destructive: true,
  schema: z.object({ mountpoint: arg.absPath }).strict(),
  run: async ({ mountpoint }) => {
    if (!hasBinary('quotaoff')) throw new OpError('capability_missing', 'quotaoff is not installed');
    if (!readMounts().some((m) => m.mountpoint === mountpoint)) throw new OpError('not_found', `${mountpoint} is not a mounted filesystem`);
    const r = await exec('quotaoff', ['-ug', mountpoint], { allowFailure: true });
    return { mountpoint, disabled: r.code === 0, output: (r.stderr || r.stdout).trim(), active: await quotaonState(mountpoint) };
  },
});
