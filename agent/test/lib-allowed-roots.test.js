import { describe, it, expect } from 'vitest';
import { createContext, DEFAULT_ALLOWED_ROOTS } from '../src/lib.js';

const ctx = createContext();
const refused = (p, mode) => { try { ctx.assertAllowedPath(p, mode); } catch (err) { return err.code; } return null; };

describe('default allowed roots', () => {
  it('take the apt keyring and sources.list.d entries the PHP source installer writes, never /etc/apt itself', () => {
    expect(DEFAULT_ALLOWED_ROOTS).toContain('/etc/apt/keyrings');
    expect(DEFAULT_ALLOWED_ROOTS).toContain('/etc/apt/sources.list.d');
    expect(DEFAULT_ALLOWED_ROOTS.filter((r) => r === '/etc' || r === '/etc/apt' || r === '/')).toEqual([]);
    for (const p of ['/etc/apt/keyrings/whm-sury-php.gpg', '/etc/apt/keyrings/whm-sury-php.asc', '/etc/apt/sources.list.d/whm-sury-php.list']) expect(ctx.assertAllowedPath(p, 'write'), p).toBe(p);
    for (const p of ['/etc/apt', '/etc/apt/sources.list', '/etc/apt/apt.conf', '/etc/apt/trusted.gpg', '/etc/apt/trusted.gpg.d/x.gpg', '/etc/apt/preferences', '/etc/apt/keyrings/../sources.list', '/etc/apt/sources.list.d/../apt.conf', '/etc/apt/keyringsx/x.gpg', '/etc/apt/sources.list.dx/x.list']) {
      expect(refused(p, 'write'), p).toBe('path_not_allowed');
    }
  });

  it('let the nginx proxy read every pair of the catch-all certificate chain', () => {
    for (const p of ['/etc/ssl/whm/host.example.com/fullchain.pem', '/etc/ssl/whm/host.example.com/key.pem', '/etc/ssl/whm/service/apache/fullchain.pem', '/etc/whm/tls/cert.pem', '/etc/whm/tls/key.pem', '/etc/ssl/whm/default/cert.pem', '/etc/letsencrypt/live/x/privkey.pem', '/etc/pki/tls/whm/x/key.pem']) {
      expect(ctx.assertAllowedPath(p, 'read'), p).toBe(p);
    }
    for (const p of ['/etc/ssl/private/ssl-cert-snakeoil.key', '/etc/pki/tls/private/localhost.key', '/etc/whm/../shadow']) expect(refused(p, 'read'), p).toBe('path_not_allowed');
  });
});
