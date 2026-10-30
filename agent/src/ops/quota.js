import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { exec, hasBinary } from '../exec.js';
import { defineOp, arg, OpError } from './registry.js';

// Initial Quota Setup: detect whether the filesystems that hold account homes
// are mounted with user quotas, run quotacheck/quotaon where the mount allows
// it, and otherwise produce the exact /etc/fstab change the operator needs.
const FSTAB = '/etc/fstab';
const CMDLINE = '/proc/cmdline';
const GRUB_DEFAULT = '/etc/default/grub';
// Regenerators for /etc/default/grub by distribution family; grubby (RHEL
// family) edits the boot entries directly and is preferred when present.
const GRUB_MKCONFIG = [['update-grub', []], ['grub2-mkconfig', ['-o', '/boot/grub2/grub.cfg']], ['grub-mkconfig', ['-o', '/boot/grub/grub.cfg']]];
const SUPPORTED = new Set(['ext2', 'ext3', 'ext4', 'xfs', 'jfs', 'reiserfs', 'f2fs']);
const USER_OPTS = /^(usrquota|quota|uquota|usrjquota=.*|uqnoenforce)$/;
const GROUP_OPTS = /^(grpquota|gquota|grpjquota=.*|gqnoenforce)$/;
const PROJECT_OPTS = /^(prjquota|pquota|pqnoenforce)$/;
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

// Existing options (including "defaults") are kept verbatim so a line that
// already carries the quota options is reported unchanged.
export function withQuotaOptions(entry, { groupQuota = true } = {}) {
  const next = [...entry.options];
  if (!next.some((o) => USER_OPTS.test(o))) next.push(entry.fstype === 'xfs' ? 'uquota' : 'usrquota');
  // xfs refuses to mount with group and project quotas together, which would
  // leave the filesystem (the whole boot, for "/") unmountable.
  const projectQuota = entry.fstype === 'xfs' && next.some((o) => PROJECT_OPTS.test(o));
  if (groupQuota && !projectQuota && !next.some((o) => GROUP_OPTS.test(o))) next.push(entry.fstype === 'xfs' ? 'gquota' : 'grpquota');
  const changed = next.length !== entry.options.length;
  if (!changed) return { options: next, line: entry.raw.trim(), changed };
  const fields = entry.raw.trim().split(/\s+/);
  fields[3] = next.join(',');
  return { options: next, line: fields.join('\t'), changed };
}

// The initramfs mounts "/" from the kernel command line before /etc/fstab is
// read, and xfs ignores quota options on the later remount, so an xfs root
// filesystem only gets them through rootflags= (merged with what it carries).
export function withRootflags(cmdline, { groupQuota = true, mountOptions = [] } = {}) {
  const m = cmdline.match(/(?:^|\s)rootflags=([^\s"']*)/);
  const current = m ? m[1].split(',').filter(Boolean) : [];
  const next = [...current];
  if (!next.some((o) => USER_OPTS.test(o))) next.push('uquota');
  const projectQuota = [...next, ...mountOptions].some((o) => PROJECT_OPTS.test(o));
  if (groupQuota && !projectQuota && !next.some((o) => GROUP_OPTS.test(o))) next.push('gquota');
  return { current, value: next.join(','), arg: `rootflags=${next.join(',')}`, changed: next.length !== current.length };
}

// GRUB_CMDLINE_LINUX is the variable every generated entry inherits.
export function withGrubCmdline(text, { groupQuota = true, mountOptions = [] } = {}) {
  const lines = text.split('\n');
  const idx = lines.findIndex((l) => /^\s*GRUB_CMDLINE_LINUX=/.test(l));
  if (idx === -1) {
    const { arg } = withRootflags('', { groupQuota, mountOptions });
    const body = text && !text.endsWith('\n') ? `${text}\n` : text;
    return { text: `${body}GRUB_CMDLINE_LINUX="${arg}"\n`, changed: true, arg, value: '' };
  }
  const m = lines[idx].match(/^(\s*GRUB_CMDLINE_LINUX=)(["']?)(.*?)\2\s*$/);
  if (!m) throw new OpError('config_invalid', `${GRUB_DEFAULT} line ${idx + 1} could not be parsed`);
  const [, prefix, quote, value] = m;
  const flags = withRootflags(value, { groupQuota, mountOptions });
  if (!flags.changed) return { text, changed: false, arg: flags.arg, value };
  const next = /(?:^|\s)rootflags=/.test(value) ? value.replace(/(^|\s)rootflags=[^\s"']*/, (_, lead) => `${lead}${flags.arg}`) : `${value}${value.trim() ? ' ' : ''}${flags.arg}`;
  lines[idx] = `${prefix}${quote || '"'}${next}${quote || '"'}`;
  return { text: lines.join('\n'), changed: true, arg: flags.arg, value };
}

export function kernelArgsPlan({ cmdline = '', groupQuota = true, mountOptions = [], grubby = false, mkconfig = null, grubDefault = false } = {}) {
  const { arg } = withRootflags(cmdline, { groupQuota, mountOptions });
  if (grubby) return { method: 'grubby', arg, bin: 'grubby', argv: ['--update-kernel=ALL', `--args=${arg}`], command: `grubby --update-kernel=ALL --args=${arg}` };
  if (mkconfig && grubDefault) return { method: 'grub-default', arg, bin: mkconfig[0], argv: mkconfig[1], command: `add ${arg} to GRUB_CMDLINE_LINUX in ${GRUB_DEFAULT}, then run ${[mkconfig[0], ...mkconfig[1]].join(' ')}` };
  return { method: null, arg, bin: null, argv: null, command: `add ${arg} to the kernel command line in the boot loader configuration` };
}

function readFstab() {
  try { return fs.readFileSync(FSTAB, 'utf8'); } catch { return ''; }
}

function readMounts() {
  try { return parseMounts(fs.readFileSync('/proc/mounts', 'utf8')); } catch { return []; }
}

function readText(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return ''; }
}

// What the boot loader will pass on the next boot: grubby's default entry, or
// the GRUB_CMDLINE_LINUX we maintain. rootflags= is merged from there (grubby
// replaces the whole key, so an entry's existing flags must be kept), from
// /proc/cmdline only when the boot entries cannot be read. `configured` is
// null when neither tool exists, so the caller can only hand over the argument.
async function rootKernelArgs({ groupQuota, mountOptions }) {
  const grubby = hasBinary('grubby');
  const mkconfig = GRUB_MKCONFIG.find(([bin]) => hasBinary(bin)) || null;
  const grubDefault = fs.existsSync(GRUB_DEFAULT);
  let cmdline = readText(CMDLINE);
  let configured = null;
  if (grubby) {
    const r = await exec('grubby', ['--info=DEFAULT'], { allowFailure: true, timeoutMs: 30_000 });
    const args = r.code === 0 ? (r.stdout.match(/^args="?(.*?)"?\s*$/m) || [])[1] : null;
    if (args != null) { cmdline = args; configured = !withRootflags(args, { groupQuota, mountOptions }).changed; }
  } else if (mkconfig && grubDefault) {
    const current = withGrubCmdline(readText(GRUB_DEFAULT), { groupQuota, mountOptions });
    cmdline = current.value;
    configured = !current.changed;
  }
  return { ...kernelArgsPlan({ cmdline, groupQuota, mountOptions, grubby, mkconfig, grubDefault }), configured };
}

async function applyRootKernelArgs({ groupQuota, mountOptions }) {
  const plan = await rootKernelArgs({ groupQuota, mountOptions });
  if (plan.configured) return { ...plan, applied: false };
  if (plan.method === 'grubby') {
    await exec('grubby', plan.argv, { timeoutMs: 120_000 });
    return { ...plan, configured: true, applied: true };
  }
  if (plan.method === 'grub-default') {
    const next = withGrubCmdline(readText(GRUB_DEFAULT), { groupQuota, mountOptions });
    const backup = `${GRUB_DEFAULT}.whm-bak`;
    fs.copyFileSync(GRUB_DEFAULT, backup);
    const tmp = `${GRUB_DEFAULT}.whm-tmp-${process.pid}`;
    fs.writeFileSync(tmp, next.text, { mode: 0o644 });
    fs.renameSync(tmp, GRUB_DEFAULT);
    await exec(plan.bin, plan.argv, { timeoutMs: 300_000 });
    return { ...plan, configured: true, applied: true, backup };
  }
  throw new OpError('unsupported', `No boot loader tool (grubby, update-grub, grub2-mkconfig) was found; ${plan.command}, then reboot`);
}

const publicKernelArgs = (k) => k && { method: k.method, arg: k.arg, command: k.command, configured: k.configured, ...(k.applied !== undefined ? { applied: k.applied } : {}), ...(k.backup ? { backup: k.backup } : {}) };

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
  const kernelArgs = m.fstype === 'xfs' && m.mountpoint === '/' && !userMounted ? await rootKernelArgs({ groupQuota: true, mountOptions: m.options }) : null;
  return {
    device: m.device, mountpoint: m.mountpoint, fstype: m.fstype, mountOptions: m.options, supported,
    userQuotaMounted: userMounted, groupQuotaMounted: groupMounted, ext4QuotaFeature: feature,
    quotaFiles: files, active: state,
    fstab: fstab ? { lineNo: fstab.lineNo, line: fstab.raw.trim(), options: fstab.options, hasUserQuota: fstab.options.some((o) => USER_OPTS.test(o)), hasGroupQuota: fstab.options.some((o) => GROUP_OPTS.test(o)) } : null,
    proposedFstabLine: proposed && !fstab.options.some((o) => USER_OPTS.test(o)) ? proposed.line : null,
    // An xfs "/" is mounted from the kernel command line, not /etc/fstab.
    kernelArgsRequired: Boolean(kernelArgs && !kernelArgs.configured),
    kernelArgs: publicKernelArgs(kernelArgs),
    // xfs reads its quota options only at mount time, so a remount is not enough.
    rebootRequired: m.fstype === 'xfs' && !userMounted,
  };
}

// Mountpoints are not run through ctx.assertAllowedPath: "/" and other roots
// never live under an allowed root. Every op instead pins the argument to an
// entry that actually exists in /proc/mounts or /etc/fstab before any exec.
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
  description: 'Add usrquota (and grpquota) to a filesystem line in /etc/fstab, keeping a backup; an xfs root filesystem also gets rootflags= on the kernel command line',
  destructive: true,
  schema: z.object({ mountpoint: arg.absPath, groupQuota: z.boolean().default(true) }).strict(),
  run: async ({ mountpoint, groupQuota }) => {
    const text = readFstab();
    const entry = parseFstab(text).find((e) => e.mountpoint === mountpoint);
    if (!entry) throw new OpError('not_found', `${FSTAB} has no entry for ${mountpoint}`);
    if (!SUPPORTED.has(entry.fstype)) throw new OpError('unsupported', `Disk quotas are not supported on ${entry.fstype} (${mountpoint})`);
    const { line, changed } = withQuotaOptions(entry, { groupQuota });
    const result = { mountpoint, changed: false, line };
    if (changed) {
      const backup = `${FSTAB}.whm-bak`;
      fs.copyFileSync(FSTAB, backup);
      const lines = text.split('\n');
      lines[entry.lineNo - 1] = line;
      const tmp = `${FSTAB}.whm-tmp-${process.pid}`;
      fs.writeFileSync(tmp, lines.join('\n'), { mode: 0o644 });
      fs.renameSync(tmp, FSTAB);
      Object.assign(result, { changed: true, previousLine: entry.raw.trim(), backup });
    }
    if (entry.fstype === 'xfs' && mountpoint === '/') {
      const mount = readMounts().find((m) => m.mountpoint === '/');
      result.kernelArgs = publicKernelArgs(await applyRootKernelArgs({ groupQuota, mountOptions: mount?.options || [] }));
    }
    return result;
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
        const fstab = fstabEntry ? withQuotaOptions(fstabEntry, { groupQuota }).line : null;
        if (mountpoint === '/') {
          const kernel = await rootKernelArgs({ groupQuota, mountOptions: mount.options });
          steps.push({
            step: 'kernel-args', ok: Boolean(kernel.configured),
            detail: kernel.configured
              ? `the boot loader passes ${kernel.arg} to the kernel; reboot to mount / with quotas`
              : `/ is mounted by the initramfs from the kernel command line, so /etc/fstab alone cannot enable quotas on it: ${kernel.command} (the "Update fstab and enable" action does this), then reboot`,
          });
          return { mountpoint, enabled: false, reason: kernel.configured ? 'reboot_required' : 'kernel_args_required', steps, fstab, kernelArgs: publicKernelArgs(kernel) };
        }
        steps.push({ step: 'remount', ok: false, detail: 'XFS reads quota options only at mount time; reboot after changing fstab' });
        return { mountpoint, enabled: false, reason: 'reboot_required', steps, fstab };
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
