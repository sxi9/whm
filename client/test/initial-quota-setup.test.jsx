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
const { manualSteps, ManualSteps } = page;

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
  });
});
