import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { authenticator } from 'otplib';

const ALGO = 'aes-256-gcm';

export function createCrypto(masterKeyHex) {
  const key = Buffer.from(masterKeyHex, 'hex');
  if (key.length !== 32) throw new Error('master key must be 32 bytes (64 hex chars)');

  return {
    // Secrets at rest (database passwords, destination credentials, TOTP seeds,
    // ACME keys) are stored as  v1:<iv>:<tag>:<ciphertext>  in base64url.
    encrypt(plaintext) {
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv(ALGO, key, iv);
      const enc = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
      return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), enc.toString('base64url')].join(':');
    },
    decrypt(blob) {
      const [v, iv, tag, data] = String(blob).split(':');
      if (v !== 'v1') throw new Error('unknown ciphertext version');
      const decipher = crypto.createDecipheriv(ALGO, key, Buffer.from(iv, 'base64url'));
      decipher.setAuthTag(Buffer.from(tag, 'base64url'));
      return Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]).toString('utf8');
    },

    hashPassword: (password) => bcrypt.hash(password, 12),
    verifyPassword: (password, hash) => (hash ? bcrypt.compare(password, hash) : Promise.resolve(false)),

    // API tokens are shown once and stored only as a SHA-256 hash.
    randomToken: (bytes = 32) => crypto.randomBytes(bytes).toString('base64url'),
    hashToken: (token) => crypto.createHash('sha256').update(token).digest('hex'),
    randomPassword(length = 20) {
      const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#%^*-_=+';
      const bytes = crypto.randomBytes(length);
      let out = '';
      for (let i = 0; i < length; i++) out += alphabet[bytes[i] % alphabet.length];
      return out;
    },

    totp: {
      generateSecret: () => authenticator.generateSecret(),
      keyUri: (username, issuer, secret) => authenticator.keyuri(username, issuer, secret),
      verify: (token, secret) => authenticator.verify({ token: String(token).replace(/\s+/g, ''), secret }),
    },
  };
}

export function constantTimeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}
