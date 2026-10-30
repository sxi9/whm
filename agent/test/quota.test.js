import fs from 'node:fs';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { exec, hasBinary } from '../src/exec.js';
import { runOp, createContext, OpError } from '../src/lib.js';
import { parseFstab, parseMounts, withQuotaOptions, withRootflags, withGrubCmdline, kernelArgsPlan } from '../src/ops/quota.js';

vi.mock('../src/exec.js', async (importOriginal) => {
  const mod = await importOriginal();
  return { ...mod, exec: vi.fn(mod.exec), hasBinary: vi.fn(mod.hasBinary) };
});

const ctx = createContext();

async function opError(promise) {
  try { await promise; } catch (err) { expect(err).toBeInstanceOf(OpError); return err; }
  throw new Error('expected the op to reject');
}

describe('quota helpers', () => {
  it('parses fstab lines, skipping comments and blanks', () => {
    const entries = parseFstab('# comment\n\nUUID=abc /  ext4  defaults,errors=remount-ro 0 1\n/dev/sdb1 /home xfs defaults 0 2\ntmpfs /tmp tmpfs defaults 0 0\n');
    expect(entries).toHaveLength(3);
    expect(entries[0]).toMatchObject({ lineNo: 3, spec: 'UUID=abc', mountpoint: '/', fstype: 'ext4', options: ['defaults', 'errors=remount-ro'], pass: '1' });
    expect(entries[1].mountpoint).toBe('/home');
  });

  it('parses /proc/mounts keeping block devices and decoding escapes', () => {
    const mounts = parseMounts('proc /proc proc rw 0 0\n/dev/vda / ext4 rw,relatime 0 0\n/dev/sdb1 /mnt/my\\040disk ext4 rw 0 0\ntmpfs /run tmpfs rw 0 0\n');
    expect(mounts.map((m) => m.mountpoint)).toEqual(['/', '/mnt/my disk']);
    expect(mounts[0].options).toEqual(['rw', 'relatime']);
  });

  it('adds usrquota/grpquota (uquota/gquota on xfs) exactly once and keeps other options', () => {
    const [ext4] = parseFstab('/dev/vda1 / ext4 defaults 0 1');
    expect(withQuotaOptions(ext4)).toEqual({ options: ['defaults', 'usrquota', 'grpquota'], line: '/dev/vda1\t/\text4\tdefaults,usrquota,grpquota\t0\t1', changed: true });
    expect(withQuotaOptions(ext4, { groupQuota: false }).options).toEqual(['defaults', 'usrquota']);
    const [already] = parseFstab('/dev/vda1 / ext4 noatime,usrquota,grpquota 0 1');
    expect(withQuotaOptions(already)).toMatchObject({ options: ['noatime', 'usrquota', 'grpquota'], changed: false, line: '/dev/vda1 / ext4 noatime,usrquota,grpquota 0 1' });
    const [withDefaults] = parseFstab('/dev/vda1 / ext4 defaults,usrquota,grpquota 0 1');
    expect(withQuotaOptions(withDefaults)).toMatchObject({ options: ['defaults', 'usrquota', 'grpquota'], changed: false });
    expect(withQuotaOptions(withDefaults, { groupQuota: false }).changed).toBe(false);
    const [userOnly] = parseFstab('/dev/vda1 / ext4 defaults,usrquota 0 1');
    expect(withQuotaOptions(userOnly)).toMatchObject({ options: ['defaults', 'usrquota', 'grpquota'], changed: true });
    const [xfs] = parseFstab('/dev/sdb1 /home xfs defaults 0 2');
    expect(withQuotaOptions(xfs).options).toEqual(['defaults', 'uquota', 'gquota']);
    const [journaled] = parseFstab('/dev/vda1 / ext4 usrjquota=aquota.user,jqfmt=vfsv1 0 1');
    expect(withQuotaOptions(journaled, { groupQuota: false })).toMatchObject({ options: ['usrjquota=aquota.user', 'jqfmt=vfsv1'], changed: false });
    // gquota next to pquota makes xfs refuse the mount: never add it.
    const [project] = parseFstab('/dev/sdb1 /home xfs defaults,pquota 0 2');
    expect(withQuotaOptions(project).options).toEqual(['defaults', 'pquota', 'uquota']);
  });

  it('merges rootflags= for an xfs root with what the kernel command line already carries', () => {
    expect(withRootflags('')).toEqual({ current: [], value: 'uquota,gquota', arg: 'rootflags=uquota,gquota', changed: true });
    expect(withRootflags('BOOT_IMAGE=/vmlinuz root=UUID=x ro rootflags=inode64 quiet')).toMatchObject({ current: ['inode64'], arg: 'rootflags=inode64,uquota,gquota', changed: true });
    expect(withRootflags('ro rootflags=uquota,gquota')).toMatchObject({ changed: false, arg: 'rootflags=uquota,gquota' });
    expect(withRootflags('ro rootflags=uquota', { groupQuota: false })).toMatchObject({ changed: false });
    expect(withRootflags('ro rootflags=uquota')).toMatchObject({ changed: true, arg: 'rootflags=uquota,gquota' });
    expect(withRootflags('ro rootflags=prjquota').arg).toBe('rootflags=prjquota,uquota');
    expect(withRootflags('ro', { mountOptions: ['rw', 'prjquota'] }).arg).toBe('rootflags=uquota');
  });

  it('edits GRUB_CMDLINE_LINUX in /etc/default/grub idempotently', () => {
    const base = 'GRUB_TIMEOUT=5\nGRUB_CMDLINE_LINUX="crashkernel=auto quiet"\nGRUB_DISABLE_RECOVERY="true"\n';
    const edited = withGrubCmdline(base);
    expect(edited).toMatchObject({ changed: true, arg: 'rootflags=uquota,gquota' });
    expect(edited.text).toBe('GRUB_TIMEOUT=5\nGRUB_CMDLINE_LINUX="crashkernel=auto quiet rootflags=uquota,gquota"\nGRUB_DISABLE_RECOVERY="true"\n');
    expect(withGrubCmdline(edited.text)).toMatchObject({ changed: false, text: edited.text });
    expect(withGrubCmdline("GRUB_CMDLINE_LINUX='ro rootflags=inode64 quiet'\n").text).toBe("GRUB_CMDLINE_LINUX='ro rootflags=inode64,uquota,gquota quiet'\n");
    expect(withGrubCmdline('GRUB_CMDLINE_LINUX=""\n').text).toBe('GRUB_CMDLINE_LINUX="rootflags=uquota,gquota"\n');
    expect(withGrubCmdline('GRUB_TIMEOUT=5').text).toBe('GRUB_TIMEOUT=5\nGRUB_CMDLINE_LINUX="rootflags=uquota,gquota"\n');
    expect(withGrubCmdline('', { groupQuota: false }).text).toBe('GRUB_CMDLINE_LINUX="rootflags=uquota"\n');
  });

  it('plans the exact boot loader command: grubby first, else /etc/default/grub plus the regenerator', () => {
    expect(kernelArgsPlan({ cmdline: 'ro quiet', grubby: true })).toEqual({ method: 'grubby', arg: 'rootflags=uquota,gquota', bin: 'grubby', argv: ['--update-kernel=ALL', '--args=rootflags=uquota,gquota'], command: 'grubby --update-kernel=ALL --args=rootflags=uquota,gquota' });
    expect(kernelArgsPlan({ grubby: true, groupQuota: false }).argv).toEqual(['--update-kernel=ALL', '--args=rootflags=uquota']);
    expect(kernelArgsPlan({ mkconfig: ['update-grub', []], grubDefault: true })).toMatchObject({ method: 'grub-default', bin: 'update-grub', argv: [], command: 'add rootflags=uquota,gquota to GRUB_CMDLINE_LINUX in /etc/default/grub, then run update-grub' });
    expect(kernelArgsPlan({ mkconfig: ['grub2-mkconfig', ['-o', '/boot/grub2/grub.cfg']], grubDefault: true })).toMatchObject({ bin: 'grub2-mkconfig', argv: ['-o', '/boot/grub2/grub.cfg'] });
    expect(kernelArgsPlan({ mkconfig: ['update-grub', []], grubDefault: false })).toMatchObject({ method: null, bin: null, command: expect.stringContaining('rootflags=uquota,gquota') });
  });
});

// A stock AlmaLinux 9 layout: xfs "/" (holding /home) mounted by the initramfs
// without quota options, an fstab line for it, grubby installed.
describe('quota ops on an xfs root filesystem', () => {
  const MOUNTS = '/dev/mapper/almalinux-root / xfs rw,seclabel,relatime,attr2,inode64,logbufs=8,logbsize=32k,noquota 0 0\n/dev/vda1 /boot xfs rw,relatime,noquota 0 0\n';
  const FSTAB = '# /etc/fstab\n/dev/mapper/almalinux-root /                       xfs     defaults        0 0\nUUID=aaaa /boot                   xfs     defaults        0 0\n';
  const CMDLINE = 'BOOT_IMAGE=(hd0,msdos1)/vmlinuz-5.14.0 root=/dev/mapper/almalinux-root ro crashkernel=1G-4G:192M rd.lvm.lv=almalinux/root quiet\n';
  const grubbyInfo = (args) => `index=0\nkernel="/boot/vmlinuz-5.14.0"\nargs="${args}"\nroot="/dev/mapper/almalinux-root"\ninitrd="/boot/initramfs-5.14.0.img"\ntitle="AlmaLinux (5.14.0) 9.4"\nid="x"\n`;
  const ok = (stdout = '') => ({ code: 0, stdout, stderr: '', bin: '/usr/sbin/grubby', argv: [] });
  let files = {};
  let written = {};
  const spies = [];
  const originalRead = fs.readFileSync;

  function host({ binaries, grubDefault = null }) {
    files = { '/proc/mounts': MOUNTS, '/etc/fstab': FSTAB, '/proc/cmdline': CMDLINE, ...(grubDefault != null ? { '/etc/default/grub': grubDefault } : {}) };
    written = {};
    hasBinary.mockImplementation((name) => binaries.includes(name));
    spies.push(
      vi.spyOn(fs, 'readFileSync').mockImplementation((p, ...rest) => (typeof p === 'string' && p in files ? files[p] : originalRead(p, ...rest))),
      vi.spyOn(fs, 'existsSync').mockImplementation((p) => typeof p === 'string' && p in files),
      vi.spyOn(fs, 'copyFileSync').mockImplementation((src, dst) => { written[dst] = files[src]; }),
      vi.spyOn(fs, 'writeFileSync').mockImplementation((p, data) => { written[p] = String(data); }),
      vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => { written[to] = written[from]; delete written[from]; files[to] = written[to]; }),
    );
  }

  afterEach(async () => {
    while (spies.length) spies.pop().mockRestore();
    const mod = await vi.importActual('../src/exec.js');
    hasBinary.mockImplementation(mod.hasBinary);
    exec.mockReset();
    exec.mockImplementation(mod.exec);
  });

  it('status reports kernel_args_required with the grubby command and only reads the boot entries', async () => {
    host({ binaries: ['grubby'] });
    exec.mockImplementation(async (bin, argv) => { expect([bin, argv]).toEqual(['grubby', ['--info=DEFAULT']]); return ok(grubbyInfo('ro crashkernel=1G-4G:192M quiet')); });
    const status = await runOp('quota.status', {}, ctx);
    const root = status.filesystems.find((f) => f.mountpoint === '/');
    expect(root).toMatchObject({ fstype: 'xfs', userQuotaMounted: false, rebootRequired: true, kernelArgsRequired: true, proposedFstabLine: expect.stringContaining('uquota,gquota'), kernelArgs: { method: 'grubby', arg: 'rootflags=uquota,gquota', command: 'grubby --update-kernel=ALL --args=rootflags=uquota,gquota', configured: false } });
    expect(status.filesystems.find((f) => f.mountpoint === '/boot')).toMatchObject({ rebootRequired: true, kernelArgsRequired: false, kernelArgs: null });
    expect(exec).toHaveBeenCalledTimes(1);
    expect(Object.keys(written)).toEqual([]);
  });

  it('status says a reboot (not grubby) is pending once the default boot entry carries rootflags', async () => {
    host({ binaries: ['grubby'] });
    exec.mockResolvedValue(ok(grubbyInfo('ro quiet rootflags=uquota,gquota')));
    const root = (await runOp('quota.status', {}, ctx)).filesystems.find((f) => f.mountpoint === '/');
    expect(root).toMatchObject({ rebootRequired: true, kernelArgsRequired: false, kernelArgs: { configured: true } });
  });

  it('quota.enable never touches the boot loader: it reports kernel_args_required with the command, or reboot_required once configured', async () => {
    host({ binaries: ['grubby', 'quotacheck', 'quotaon'] });
    exec.mockResolvedValue(ok(grubbyInfo('ro quiet')));
    const result = await runOp('quota.enable', { mountpoint: '/' }, ctx);
    expect(result).toMatchObject({ enabled: false, reason: 'kernel_args_required', fstab: expect.stringContaining('uquota,gquota'), kernelArgs: { method: 'grubby', configured: false } });
    expect(result.steps).toEqual([{ step: 'kernel-args', ok: false, detail: expect.stringContaining('grubby --update-kernel=ALL --args=rootflags=uquota,gquota') }]);
    expect(exec.mock.calls.map(([bin, argv]) => [bin, argv])).toEqual([['grubby', ['--info=DEFAULT']]]);
    expect(Object.keys(written)).toEqual([]);

    exec.mockClear();
    exec.mockResolvedValue(ok(grubbyInfo('ro quiet rootflags=uquota')));
    const pending = await runOp('quota.enable', { mountpoint: '/', groupQuota: false }, ctx);
    expect(pending).toMatchObject({ enabled: false, reason: 'reboot_required', kernelArgs: { configured: true }, steps: [{ step: 'kernel-args', ok: true }] });
    expect(exec.mock.calls.map(([bin, argv]) => [bin, argv])).toEqual([['grubby', ['--info=DEFAULT']]]);
  });

  it('quota.fstab.enable on the xfs root rewrites fstab and runs grubby --update-kernel=ALL with the merged rootflags', async () => {
    host({ binaries: ['grubby'] });
    exec.mockImplementation(async (bin, argv) => (argv[0] === '--info=DEFAULT' ? ok(grubbyInfo('ro quiet rootflags=inode64')) : ok()));
    const result = await runOp('quota.fstab.enable', { mountpoint: '/' }, ctx);
    expect(result).toMatchObject({ mountpoint: '/', changed: true, backup: '/etc/fstab.whm-bak', line: '/dev/mapper/almalinux-root\t/\txfs\tdefaults,uquota,gquota\t0\t0', kernelArgs: { method: 'grubby', arg: 'rootflags=inode64,uquota,gquota', configured: true, applied: true } });
    expect(written['/etc/fstab']).toBe(FSTAB.replace('/dev/mapper/almalinux-root /                       xfs     defaults        0 0', result.line));
    expect(written['/etc/fstab.whm-bak']).toBe(FSTAB);
    expect(exec.mock.calls.map(([bin, argv]) => [bin, argv])).toEqual([['grubby', ['--info=DEFAULT']], ['grubby', ['--update-kernel=ALL', '--args=rootflags=inode64,uquota,gquota']]]);

    // Second run: fstab already right, boot entry already right -> nothing rewritten, grubby only read.
    exec.mockClear();
    exec.mockResolvedValue(ok(grubbyInfo('ro quiet rootflags=inode64,uquota,gquota')));
    const again = await runOp('quota.fstab.enable', { mountpoint: '/' }, ctx);
    expect(again).toMatchObject({ changed: false, kernelArgs: { configured: true, applied: false } });
    expect(exec.mock.calls.map(([bin, argv]) => [bin, argv])).toEqual([['grubby', ['--info=DEFAULT']]]);
  });

  it('quota.fstab.enable fails loudly when grubby cannot update the boot entries', async () => {
    host({ binaries: ['grubby'] });
    exec.mockImplementation(async (bin, argv, opts) => {
      if (argv[0] === '--info=DEFAULT') return ok(grubbyInfo('ro quiet'));
      expect(opts.allowFailure).not.toBe(true);
      const err = new Error('"grubby" exited with status 1: grubby: no kernels found'); err.code = 'command_failed'; throw err;
    });
    await expect(runOp('quota.fstab.enable', { mountpoint: '/' }, ctx)).rejects.toThrow(/grubby/);
    expect(written['/etc/fstab']).toContain('uquota,gquota');
  });

  it('without grubby, quota.fstab.enable edits GRUB_CMDLINE_LINUX (with a backup) and runs the regenerator', async () => {
    host({ binaries: ['update-grub'], grubDefault: 'GRUB_DEFAULT=0\nGRUB_CMDLINE_LINUX="quiet rootflags=inode64"\n' });
    exec.mockResolvedValue(ok());
    const result = await runOp('quota.fstab.enable', { mountpoint: '/', groupQuota: false }, ctx);
    expect(result.kernelArgs).toEqual({ method: 'grub-default', arg: 'rootflags=inode64,uquota', command: 'add rootflags=inode64,uquota to GRUB_CMDLINE_LINUX in /etc/default/grub, then run update-grub', configured: true, applied: true, backup: '/etc/default/grub.whm-bak' });
    expect(written['/etc/default/grub']).toBe('GRUB_DEFAULT=0\nGRUB_CMDLINE_LINUX="quiet rootflags=inode64,uquota"\n');
    expect(written['/etc/default/grub.whm-bak']).toBe('GRUB_DEFAULT=0\nGRUB_CMDLINE_LINUX="quiet rootflags=inode64"\n');
    expect(exec.mock.calls.map(([bin, argv]) => [bin, argv])).toEqual([['update-grub', []]]);

    const status = await runOp('quota.status', {}, ctx);
    expect(status.filesystems.find((f) => f.mountpoint === '/')).toMatchObject({ kernelArgsRequired: true, kernelArgs: { method: 'grub-default', configured: false } });
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it('with no boot loader tool at all, status hands over the argument and quota.fstab.enable refuses after the fstab edit', async () => {
    host({ binaries: [] });
    const root = (await runOp('quota.status', {}, ctx)).filesystems.find((f) => f.mountpoint === '/');
    expect(root).toMatchObject({ kernelArgsRequired: true, kernelArgs: { method: null, configured: null, command: expect.stringContaining('rootflags=uquota,gquota') } });
    expect(exec).not.toHaveBeenCalled();
    const err = await opError(runOp('quota.fstab.enable', { mountpoint: '/' }, ctx));
    expect(err.code).toBe('unsupported');
    expect(err.message).toContain('rootflags=uquota,gquota');
  });

  it('a non-root xfs mount still only needs fstab and a reboot', async () => {
    host({ binaries: ['grubby', 'quotacheck', 'quotaon'] });
    files['/proc/mounts'] = '/dev/vda1 / ext4 rw,relatime 0 0\n/dev/vdb1 /home xfs rw,relatime,noquota 0 0\n';
    files['/etc/fstab'] = '/dev/vda1 / ext4 defaults 0 1\n/dev/vdb1 /home xfs defaults 0 2\n';
    const result = await runOp('quota.enable', { mountpoint: '/home' }, ctx);
    expect(result).toMatchObject({ enabled: false, reason: 'reboot_required', fstab: '/dev/vdb1\t/home\txfs\tdefaults,uquota,gquota\t0\t2' });
    expect(result.kernelArgs).toBeUndefined();
    expect(exec).not.toHaveBeenCalled();
    const fstab = await runOp('quota.fstab.enable', { mountpoint: '/home' }, ctx);
    expect(fstab).toMatchObject({ changed: true });
    expect(fstab.kernelArgs).toBeUndefined();
    expect(exec).not.toHaveBeenCalled();
  });
});

describe('quota ops', () => {
  it('unknown ops are refused and mountpoints must be clean absolute paths', async () => {
    exec.mockClear();
    expect((await opError(runOp('quota.format', { mountpoint: '/' }, ctx))).code).toBe('unknown_op');
    for (const mountpoint of ['home', '../', '/home/../etc', '/home\0x', '-f', '']) {
      expect((await opError(runOp('quota.enable', { mountpoint }, ctx))).code, mountpoint).toBe('invalid_args');
      expect((await opError(runOp('quota.fstab.enable', { mountpoint }, ctx))).code, mountpoint).toBe('invalid_args');
      expect((await opError(runOp('quota.disable', { mountpoint }, ctx))).code, mountpoint).toBe('invalid_args');
    }
    expect((await opError(runOp('quota.enable', { mountpoint: '/', force: true }, ctx))).code).toBe('invalid_args');
    expect((await opError(runOp('quota.enable', { mountpoint: '/', groupQuota: 'yes' }, ctx))).code).toBe('invalid_args');
    expect((await opError(runOp('quota.status', { mountpoint: '/' }, ctx))).code).toBe('invalid_args');
    expect(exec).not.toHaveBeenCalled();
  });

  it('quota.status reports tools and mounted filesystems without needing the quota package', async () => {
    const status = await runOp('quota.status', {}, ctx);
    expect(typeof status.tools.quotacheck).toBe('boolean');
    expect(status.fstabPath).toBe('/etc/fstab');
    expect(Array.isArray(status.filesystems)).toBe(true);
    for (const f of status.filesystems) {
      expect(f).toMatchObject({ device: expect.any(String), mountpoint: expect.any(String), fstype: expect.any(String), supported: expect.any(Boolean), userQuotaMounted: expect.any(Boolean) });
      expect(f.active).toHaveProperty('user');
    }
  });

  it('quota.fstab.enable refuses unknown mountpoints before touching /etc/fstab', async () => {
    const err = await opError(runOp('quota.fstab.enable', { mountpoint: '/definitely/not/mounted/whm-test' }, ctx));
    expect(['not_found', 'unsupported']).toContain(err.code);
  });

  it('quota.enable / quota.disable fail closed when the tools are missing or the path is not mounted', async () => {
    const err = await opError(runOp('quota.enable', { mountpoint: '/definitely/not/mounted/whm-test' }, ctx));
    expect(['capability_missing', 'not_found']).toContain(err.code);
    const off = await opError(runOp('quota.disable', { mountpoint: '/definitely/not/mounted/whm-test' }, ctx));
    expect(['capability_missing', 'not_found']).toContain(off.code);
  });
});
