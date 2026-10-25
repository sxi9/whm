import { describe, it, expect } from 'vitest';
import { authenticator } from 'otplib';
import { createCrypto, constantTimeEqual } from '../src/lib/crypto.js';

const KEY = 'a'.repeat(64);
const svc = createCrypto(KEY);

describe('createCrypto', () => {
  it('requires a 32-byte hex master key', () => {
    expect(() => createCrypto('abcd')).toThrow(/32 bytes/);
    expect(() => createCrypto('zz'.repeat(32))).toThrow();
    expect(() => createCrypto(KEY)).not.toThrow();
  });
});

describe('encrypt / decrypt', () => {
  it('round-trips text and uses a fresh IV every time', () => {
    const blob = svc.encrypt('s3cret value ✓');
    expect(blob.startsWith('v1:')).toBe(true);
    expect(blob.split(':')).toHaveLength(4);
    expect(svc.decrypt(blob)).toBe('s3cret value ✓');
    expect(svc.encrypt('same')).not.toBe(svc.encrypt('same'));
    expect(svc.decrypt(svc.encrypt(''))).toBe('');
    expect(svc.decrypt(svc.encrypt(12345))).toBe('12345');
  });

  it('detects tampering with the ciphertext, tag or IV', () => {
    const [v, iv, tag, data] = svc.encrypt('payload').split(':');
    const flip = (s) => (s[0] === 'A' ? 'B' : 'A') + s.slice(1);
    expect(() => svc.decrypt([v, iv, tag, flip(data)].join(':'))).toThrow();
    expect(() => svc.decrypt([v, iv, flip(tag), data].join(':'))).toThrow();
    expect(() => svc.decrypt([v, flip(iv), tag, data].join(':'))).toThrow();
    expect(() => svc.decrypt(['v2', iv, tag, data].join(':'))).toThrow(/version/);
    expect(() => svc.decrypt('garbage')).toThrow();
  });

  it('cannot be decrypted with a different master key', () => {
    const other = createCrypto('b'.repeat(64));
    expect(() => other.decrypt(svc.encrypt('payload'))).toThrow();
  });
});

describe('passwords', () => {
  it('hashes with bcrypt and verifies', async () => {
    const hash = await svc.hashPassword('Correct-Horse-1');
    expect(hash).toMatch(/^\$2[aby]\$12\$/);
    await expect(svc.verifyPassword('Correct-Horse-1', hash)).resolves.toBe(true);
    await expect(svc.verifyPassword('wrong', hash)).resolves.toBe(false);
    await expect(svc.verifyPassword('anything', null)).resolves.toBe(false);
    await expect(svc.verifyPassword('anything', '')).resolves.toBe(false);
  }, 20_000);

  it('generates random passwords from the documented alphabet', () => {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#%^*-_=+';
    const p = svc.randomPassword();
    expect(p).toHaveLength(20);
    expect(svc.randomPassword(40)).toHaveLength(40);
    for (let i = 0; i < 20; i++) {
      for (const ch of svc.randomPassword(32)) expect(alphabet).toContain(ch);
    }
    expect(svc.randomPassword()).not.toBe(svc.randomPassword());
  });
});

describe('tokens', () => {
  it('hashToken is deterministic SHA-256 hex', () => {
    const token = svc.randomToken();
    expect(token.length).toBeGreaterThanOrEqual(40);
    expect(svc.randomToken(8)).not.toBe(svc.randomToken(8));
    expect(svc.hashToken(token)).toBe(svc.hashToken(token));
    expect(svc.hashToken(token)).toMatch(/^[0-9a-f]{64}$/);
    expect(svc.hashToken(token)).not.toBe(svc.hashToken(token + 'x'));
    expect(svc.hashToken('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});

describe('totp', () => {
  it('generates a base32 secret and verifies the current code', () => {
    const secret = svc.totp.generateSecret();
    expect(secret).toMatch(/^[A-Z2-7]+$/);
    const code = authenticator.generate(secret);
    expect(svc.totp.verify(code, secret)).toBe(true);
    expect(svc.totp.verify(` ${code.slice(0, 3)} ${code.slice(3)} `, secret)).toBe(true);
    const wrong = String((Number(code) + 1) % 1_000_000).padStart(6, '0');
    expect(svc.totp.verify(wrong, secret)).toBe(false);
    expect(svc.totp.verify(code, svc.totp.generateSecret())).toBe(false);
  });

  it('builds an otpauth key URI', () => {
    const uri = svc.totp.keyUri('root', 'WHM (host)', 'JBSWY3DPEHPK3PXP');
    expect(uri.startsWith('otpauth://totp/')).toBe(true);
    expect(uri).toContain('secret=JBSWY3DPEHPK3PXP');
    expect(decodeURIComponent(uri)).toContain('WHM (host)');
  });
});

describe('constantTimeEqual', () => {
  it('compares strings without throwing on length mismatch', () => {
    expect(constantTimeEqual('abc', 'abc')).toBe(true);
    expect(constantTimeEqual('abc', 'abd')).toBe(false);
    expect(constantTimeEqual('abc', 'abcd')).toBe(false);
    expect(constantTimeEqual('', '')).toBe(true);
    expect(constantTimeEqual(123, '123')).toBe(true);
    expect(constantTimeEqual(undefined, 'undefined')).toBe(true);
  });
});
