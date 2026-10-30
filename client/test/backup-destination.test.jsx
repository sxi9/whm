import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { cleanDestination, emptyDestination } from '../src/pages/backup/Shared.jsx';

const s3 = { ...emptyDestination('s3'), bucket: 'whm-backups', accessKey: 'AKIA1' };

describe('backup destination form payload', () => {
  it('drops blank fields when adding a destination so the API reports them as missing', () => {
    const out = cleanDestination(s3);
    expect(out).toEqual({ kind: 's3', region: 'us-east-1', bucket: 'whm-backups', accessKey: 'AKIA1', pathStyle: false, insecure: false });
    expect(out).not.toHaveProperty('secretKey');
    expect(cleanDestination({ ...emptyDestination('ftp'), host: 'h.example.com', username: 'u' }).password).toBe('');
  });

  it('sends a blank secret as "" on edit so the stored value is kept ("Leave blank to keep the stored value")', () => {
    const out = cleanDestination({ ...s3, pathStyle: true }, { editing: true });
    expect(out).toEqual({ kind: 's3', region: 'us-east-1', bucket: 'whm-backups', accessKey: 'AKIA1', secretKey: '', pathStyle: true, insecure: false });
    expect(out).not.toHaveProperty('endpoint');
    expect(cleanDestination({ ...s3, secretKey: 'new' }, { editing: true }).secretKey).toBe('new');
    const sftp = cleanDestination({ ...emptyDestination('sftp'), host: 'h.example.com', username: 'u', hostKeySha256: 'A'.repeat(43) }, { editing: true });
    expect(sftp).toMatchObject({ password: '', privateKey: '' });
    const webdav = cleanDestination({ ...emptyDestination('webdav'), url: 'https://dav.example.com/x' }, { editing: true });
    expect(webdav.password).toBe('');
    expect(webdav).not.toHaveProperty('username');
  });

  it('the edit form saves with the editing flag, the add form and the unsaved test without it', () => {
    const src = readFileSync(fileURLToPath(new URL('../src/pages/fn/backup/backup-configuration.jsx', import.meta.url)), 'utf8');
    expect(src).toContain("config: cleanDestination(cfg, { editing: editing !== 'new' })");
    expect(src).toContain("'/backup/destinations/test', { config: cleanDestination(cfg) }");
  });
});
