import { describe, it, expect, vi } from 'vitest';
import { exec } from '../src/exec.js';
import { runOp, createContext, OpError } from '../src/lib.js';
import { parseFstab, parseMounts, withQuotaOptions } from '../src/ops/quota.js';

vi.mock('../src/exec.js', async (importOriginal) => {
  const mod = await importOriginal();
  return { ...mod, exec: vi.fn(mod.exec) };
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
    expect(withQuotaOptions(ext4)).toEqual({ options: ['defaults', 'usrquota', 'grpquota'], line: '/dev/vda1\t/\text4\tdefaults,usrquota,grpquota\t0\t1' });
    expect(withQuotaOptions(ext4, { groupQuota: false }).options).toEqual(['defaults', 'usrquota']);
    const [already] = parseFstab('/dev/vda1 / ext4 noatime,usrquota,grpquota 0 1');
    expect(withQuotaOptions(already).options).toEqual(['noatime', 'usrquota', 'grpquota']);
    const [xfs] = parseFstab('/dev/sdb1 /home xfs defaults 0 2');
    expect(withQuotaOptions(xfs).options).toEqual(['defaults', 'uquota', 'gquota']);
    const [journaled] = parseFstab('/dev/vda1 / ext4 usrjquota=aquota.user,jqfmt=vfsv1 0 1');
    expect(withQuotaOptions(journaled, { groupQuota: false }).options).toEqual(['usrjquota=aquota.user', 'jqfmt=vfsv1']);
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
