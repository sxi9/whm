import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { ToastProvider } from '../src/components/Toast.jsx';
import { ConfirmProvider } from '../src/components/Modal.jsx';
import { FUNCTION_BY_KEY } from '../src/nav.js';

vi.mock('../src/auth/AuthContext.jsx', () => ({ useAuth: () => ({ user: { id: 1, username: 'root', role: 'root' }, refresh: async () => {} }) }));

const responses = new Map();
vi.mock('../src/hooks/useApi.js', () => ({
  useApi: (path) => {
    const r = [...responses.entries()].find(([k]) => path.startsWith(k))?.[1] ?? null;
    return { data: r?.data ?? null, meta: null, error: r?.error ?? null, loading: false, refetch() {}, setData() {} };
  },
  useMutation: (fn) => ({ mutate: fn, loading: false, error: null, fieldErrors: null, reset() {} }),
}));

const page = await import('../src/pages/fn/server-configuration/initial-quota-setup.jsx');
const InitialQuotaSetup = page.default;
const { manualSteps, ManualSteps, MountOptionsNote, applyStep, kernelArgsFor, needsManualSteps } = page;

React.useLayoutEffect = React.useEffect;
const render = (el) => renderToStaticMarkup(
  <ToastProvider><ConfirmProvider><MemoryRouter>{el}</MemoryRouter></ConfirmProvider></ToastProvider>,
);
const fn = FUNCTION_BY_KEY['initial-quota-setup'] || { key: 'initial-quota-setup', label: 'Initial Quota Setup' };

// Shapes copied from agent quota.status: the proposed line always carries
// both options because the op computes it with the default groupQuota=true.
const ext4 = (over = {}) => ({
  device: '/dev/sda2', mountpoint: '/home', fstype: 'ext4', mountOptions: ['rw', 'relatime'], supported: true,
  userQuotaMounted: false, groupQuotaMounted: false, ext4QuotaFeature: false, quotaFiles: { user: false, group: false },
  active: { user: null, group: null }, holdsHomes: true, rebootRequired: false,
  fstab: { lineNo: 4, line: 'UUID=abc\t/home\text4\tdefaults\t0\t2', options: ['defaults'], hasUserQuota: false, hasGroupQuota: false },
  proposedFstabLine: 'UUID=abc\t/home\text4\tdefaults,usrquota,grpquota\t0\t2',
  ...over,
});
const xfs = () => ext4({
  device: '/dev/sdb1', fstype: 'xfs', rebootRequired: true,
  fstab: { lineNo: 6, line: '/dev/sdb1\t/home\txfs\tdefaults\t0\t0', options: ['defaults'], hasUserQuota: false, hasGroupQuota: false },
  proposedFstabLine: '/dev/sdb1\t/home\txfs\tdefaults,uquota,gquota\t0\t0',
});
// An xfs "/" (stock AlmaLinux 9): the agent adds kernelArgs (computed with
// group quotas on) because the initramfs mounts it from the kernel command
// line, and kernelArgsRequired until rootflags= is in the boot entries.
const grubby = { method: 'grubby', arg: 'rootflags=uquota,gquota', command: 'grubby --update-kernel=ALL --args=rootflags=uquota,gquota', configured: false };
const grubDefault = { method: 'grub-default', arg: 'rootflags=uquota,gquota', command: 'add rootflags=uquota,gquota to GRUB_CMDLINE_LINUX in /etc/default/grub, then run update-grub', configured: false };
const xfsRoot = (over = {}) => ext4({
  device: '/dev/sda3', mountpoint: '/', fstype: 'xfs', rebootRequired: true, holdsHomes: true,
  fstab: { lineNo: 2, line: 'UUID=root\t/\txfs\tdefaults\t0\t0', options: ['defaults'], hasUserQuota: false, hasGroupQuota: false },
  proposedFstabLine: 'UUID=root\t/\txfs\tdefaults,uquota,gquota\t0\t0',
  kernelArgsRequired: true, kernelArgs: grubby,
  ...over,
});
const status = (filesystems) => ({
  toolsInstalled: true, tools: {}, fstabPath: '/etc/fstab', fstabPresent: true, homeRoot: '/home', homeFilesystem: '/home',
  enabled: false, enforceable: false, filesystems, lastJob: null, installPackages: ['quota'], pkgAvailable: true,
});

describe('Initial Quota Setup manual steps', () => {
  it('mirrors the action with the group switch on', () => {
    const text = manualSteps(ext4(), true);
    expect(text).toContain('+ UUID=abc\t/home\text4\tdefaults,usrquota,grpquota\t0\t2');
    expect(text).toContain('mount -o remount /home');
    expect(text).toContain('quotacheck -cug -m -f /home');
    expect(text).toContain('quotaon -ug /home');
  });

  it('drops the group option and the g flag when the switch is off', () => {
    const text = manualSteps(ext4(), false);
    expect(text).toContain('+ UUID=abc\t/home\text4\tdefaults,usrquota\t0\t2');
    expect(text).not.toContain('grpquota');
    expect(text).toContain('quotacheck -cu -m -f /home');
    expect(text).toContain('quotaon -u /home');
    expect(text).not.toMatch(/-cug|-ug /);
  });

  it('keeps a group option the fstab line already has, as the action does', () => {
    const f = ext4({
      fstab: { lineNo: 4, line: 'UUID=abc\t/home\text4\tdefaults,grpquota\t0\t2', options: ['defaults', 'grpquota'], hasUserQuota: false, hasGroupQuota: true },
      proposedFstabLine: 'UUID=abc\t/home\text4\tdefaults,grpquota,usrquota\t0\t2',
    });
    expect(manualSteps(f, false)).toContain('+ UUID=abc\t/home\text4\tdefaults,grpquota,usrquota\t0\t2');
  });

  it('tells XFS operators to reboot instead of remounting', () => {
    const on = manualSteps(xfs(), true);
    expect(on).not.toContain('mount -o remount');
    expect(on).toContain('# reboot (XFS applies quota options only at mount time)');
    expect(on).toContain('uquota,gquota');
    const off = manualSteps(xfs(), false);
    expect(off).toContain('+ /dev/sdb1\t/home\txfs\tdefaults,uquota\t0\t0');
    expect(off).not.toContain('gquota');
  });

  it('renders the block from the switch and hides it when fstab needs no change', () => {
    const off = render(<ManualSteps filesystems={[ext4()]} groupQuota={false} />);
    expect(off).toContain('Show manual steps');
    expect(off).toContain('quotacheck -cu -m -f /home');
    expect(off).not.toContain('grpquota');
    expect(off).not.toContain('does the same');
    expect(off).toContain('group quotas following the switch above');
    const done = ext4({ proposedFstabLine: null, fstab: { lineNo: 4, line: 'x', options: ['defaults', 'usrquota'], hasUserQuota: true, hasGroupQuota: false } });
    expect(renderToStaticMarkup(<ManualSteps filesystems={[done, ext4({ fstab: null })]} groupQuota={true} />)).toBe('');
  });

  it('page shows the manual block for the default switch state', () => {
    responses.clear();
    responses.set('/server-config/quota', { data: status([ext4()]) });
    const html = render(<InitialQuotaSetup fn={fn} />);
    expect(html).toContain('Also enable group quotas');
    expect(html).toContain('Show manual steps');
    expect(html).toContain('quotacheck -cug -m -f /home');
    expect(html).toContain('Update fstab and enable');
    expect(html).not.toContain('GRUB_CMDLINE_LINUX');
    expect(html).not.toContain('kernel args:');
  });
});

describe('Initial Quota Setup on an XFS root filesystem', () => {
  it('prints the grubby line and a reboot instead of "reboot after editing fstab"', () => {
    const text = manualSteps(xfsRoot(), true);
    expect(text).toContain('+ UUID=root\t/\txfs\tdefaults,uquota,gquota\t0\t0');
    expect(text).toContain('grubby --update-kernel=ALL --args=rootflags=uquota,gquota\n# then reboot: / is mounted by the initramfs from the kernel command line');
    expect(text).not.toContain('mount -o remount');
    expect(text).not.toContain('# reboot (XFS applies quota options only at mount time)');
    expect(text).toContain('quotaon -ug /');
  });

  it('follows the group switch in the kernel argument as it does in the fstab line', () => {
    const off = manualSteps(xfsRoot(), false);
    expect(off).toContain('--args=rootflags=uquota\n');
    expect(off).not.toContain('gquota');
    expect(kernelArgsFor(xfsRoot(), false)).toMatchObject({ method: 'grubby', configured: false, arg: 'rootflags=uquota', command: 'grubby --update-kernel=ALL --args=rootflags=uquota' });
    const mountedGroup = xfsRoot({ groupQuotaMounted: true });
    expect(kernelArgsFor(mountedGroup, false).arg).toBe('rootflags=uquota,gquota');
    expect(kernelArgsFor(ext4(), true)).toBeNull();
  });

  it('shows the GRUB_CMDLINE_LINUX + update-grub route outside the RHEL family', () => {
    const text = manualSteps(xfsRoot({ kernelArgs: grubDefault }), true);
    expect(text).toContain('add rootflags=uquota,gquota to GRUB_CMDLINE_LINUX in /etc/default/grub, then run update-grub');
    expect(text).toContain('# then reboot');
    expect(manualSteps(xfsRoot({ kernelArgs: grubDefault }), false)).toContain('add rootflags=uquota to GRUB_CMDLINE_LINUX');
  });

  it('only asks for the reboot once the boot loader already carries rootflags', () => {
    const ready = xfsRoot({ kernelArgsRequired: false, kernelArgs: { ...grubby, configured: true } });
    expect(applyStep(ready, true)).toBe('# the boot loader already passes rootflags=uquota,gquota; reboot so XFS mounts / with the quota options');
    expect(applyStep(xfsRoot(), true)).toContain('grubby');
    expect(applyStep(xfs(), true)).toBe('# reboot (XFS applies quota options only at mount time)');
    expect(applyStep(ext4(), true)).toBe('mount -o remount /home');
  });

  it('keeps the manual block and the fstab action when fstab already has uquota but the boot entries do not', () => {
    const f = xfsRoot({ proposedFstabLine: null, fstab: { lineNo: 2, line: 'UUID=root\t/\txfs\tdefaults,uquota,gquota\t0\t0', options: ['defaults', 'uquota', 'gquota'], hasUserQuota: true, hasGroupQuota: true } });
    expect(needsManualSteps(f)).toBe(true);
    expect(needsManualSteps(ext4({ proposedFstabLine: null }))).toBe(false);
    const text = manualSteps(f, true);
    expect(text).not.toContain('+ UUID');
    expect(text.startsWith('grubby --update-kernel=ALL')).toBe(true);
    const block = render(<ManualSteps filesystems={[f]} groupQuota={true} />);
    expect(block).toContain('Show manual steps');
    expect(block).toContain('grubby --update-kernel=ALL');
    responses.clear();
    responses.set('/server-config/quota', { data: status([f]) });
    const html = render(<InitialQuotaSetup fn={fn} />);
    expect(html).toContain('Update fstab and enable');
  });

  it('page footer and table explain the kernel-args requirement with the exact command', () => {
    responses.clear();
    responses.set('/server-config/quota', { data: status([xfsRoot()]) });
    const html = render(<InitialQuotaSetup fn={fn} />);
    expect(html).toContain('boot loader change needed');
    expect(html).toContain('kernel args: rootflags= missing');
    expect(html).toContain('mounted by the initramfs from the kernel command line');
    expect(html).toContain('grubby --update-kernel=ALL --args=…');
    expect(html).toContain('GRUB_CMDLINE_LINUX');
    expect(html).toContain('runs <code>grubby --update-kernel=ALL --args=rootflags=uquota,gquota</code> for you; reboot afterwards');
    expect(html).not.toContain('so it needs a reboot after the fstab change.</p>');
    const note = render(<MountOptionsNote filesystems={[xfsRoot({ kernelArgsRequired: false, kernelArgs: { ...grubby, configured: true } })]} />);
    expect(note).toContain('The boot loader already passes it; reboot to mount with quotas.');
    expect(render(<MountOptionsNote filesystems={[ext4(), xfs()]} />)).not.toContain('initramfs');
  });
});
