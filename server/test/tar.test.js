import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { listTar, extractTar, safeEntryName, TarError } from '../src/lib/tar.js';
import { createTar } from './support/tar.js';

let dir;
beforeAll(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whm-tar-')); });
afterAll(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe('tar reader', () => {
  it('lists files and directories, normalising ./ prefixes and trailing slashes', () => {
    const buf = createTar([{ name: './', type: 'dir' }, { name: './plugin.json', data: '{}' }, { name: 'lib/', type: 'dir' }, { name: 'lib/a.js', data: 'x'.repeat(1000), mode: 0o755 }]);
    expect(listTar(buf)).toEqual([
      { name: 'plugin.json', type: 'file', size: 2, mode: 0o644 },
      { name: 'lib', type: 'dir', size: 0, mode: 0o755 },
      { name: 'lib/a.js', type: 'file', size: 1000, mode: 0o755 },
    ]);
  });

  it('extracts into the destination with the file contents intact', () => {
    const dest = path.join(dir, 'out');
    const buf = createTar([{ name: 'a/b/c.txt', data: 'hello' }, { name: 'top.bin', data: Buffer.from([0, 1, 2, 255]) }]);
    const list = extractTar(buf, dest);
    expect(list.map((e) => e.name)).toEqual(['a/b/c.txt', 'top.bin']);
    expect(fs.readFileSync(path.join(dest, 'a/b/c.txt'), 'utf8')).toBe('hello');
    expect([...fs.readFileSync(path.join(dest, 'top.bin'))]).toEqual([0, 1, 2, 255]);
  });

  it('reads GNU long names and ustar prefixes', () => {
    const long = `${'d'.repeat(60)}/${'f'.repeat(60)}.js`;
    const buf = createTar([{ name: long, data: 'x', longName: true }, { name: 'short.js', data: 'y', prefix: 'deep/prefix' }]);
    expect(listTar(buf).map((e) => e.name)).toEqual([long, 'deep/prefix/short.js']);
  });

  it('refuses absolute names, "..", NUL bytes and backslashes', () => {
    expect(() => listTar(createTar([{ name: '/etc/passwd', data: 'x' }]))).toThrow(/absolute/);
    expect(() => listTar(createTar([{ name: '../x', data: 'x' }]))).toThrow(/\.\./);
    expect(() => listTar(createTar([{ name: 'a/../../x', data: 'x' }]))).toThrow(/\.\./);
    expect(() => safeEntryName('a\0b')).toThrow(TarError);
    expect(() => safeEntryName('a\\b')).toThrow(/backslash/);
    expect(safeEntryName('./a//b/')).toBe('a/b');
  });

  it('refuses symlinks, hard links, devices, fifos and PAX headers', () => {
    for (const [type, re] of [['symlink', /symbolic link/], ['hardlink', /hard link/], ['char', /character device/], ['block', /block device/], ['fifo', /fifo/], ['pax', /PAX/]]) {
      expect(() => listTar(createTar([{ name: 'x', type, linkname: '/etc/passwd' }]))).toThrow(re);
    }
  });

  it('enforces entry and byte limits and detects truncation and bad checksums', () => {
    expect(() => listTar(createTar([{ name: 'a', data: 'x'.repeat(600) }]), { maxBytes: 500 })).toThrow(/exceeds 500 bytes/);
    expect(() => listTar(createTar([{ name: 'a', data: '1' }, { name: 'b', data: '2' }]), { maxEntries: 1 })).toThrow(/more than 1 entries/);
    const truncated = createTar([{ name: 'a', data: 'x'.repeat(2000) }]).subarray(0, 1024);
    expect(() => listTar(truncated)).toThrow(/truncated/);
    const bad = Buffer.from(createTar([{ name: 'a', data: 'x' }]));
    bad[0] ^= 0xff;
    expect(() => listTar(bad)).toThrow(/corrupt tar header/);
  });

  it('refuses duplicate entry names and file/directory conflicts', () => {
    expect(() => listTar(createTar([{ name: 'a.js', data: '1' }, { name: './a.js', data: '2' }]))).toThrow(/duplicate entry "a.js"/);
    const dest = path.join(dir, 'dup');
    expect(() => extractTar(createTar([{ name: 'a', type: 'dir' }, { name: 'a', data: 'x' }]), dest)).toThrow(/duplicate entry/);
    expect(() => extractTar(createTar([{ name: 'a/b', data: 'x' }, { name: 'a', data: 'x' }]), path.join(dir, 'dup2'))).toThrow(TarError);
    expect(() => extractTar(createTar([{ name: 'f', data: 'x' }, { name: 'f/child', data: 'x' }]), path.join(dir, 'dup3'))).toThrow(/has a file as a parent/);
  });

  it('never writes outside the destination even through a pre-existing symlink', () => {
    const dest = path.join(dir, 'link-dest');
    fs.mkdirSync(dest, { recursive: true });
    fs.symlinkSync('/tmp', path.join(dest, 'escape'));
    expect(() => extractTar(createTar([{ name: 'escape', data: 'x' }]), dest)).toThrow(/symbolic link/);
    expect(() => extractTar(createTar([{ name: 'escape/evil.txt', data: 'x' }]), dest)).toThrow();
    expect(fs.existsSync('/tmp/evil.txt')).toBe(false);
  });
});
