import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const FIXTURES_DIR = path.dirname(fileURLToPath(import.meta.url));
export const KEYS_DIR = path.join(FIXTURES_DIR, 'keys');

// Fixed Ed25519 pairs (<kid>.ed25519 private PKCS8 PEM, <kid>.pub SPKI PEM).
export const KIDS = {
  licenseA: '8456a2be',
  licenseB: '4619cf0e',
  pluginA: 'bdee6a71',
  pluginB: '742aaf57',
};

export const pubOf = (kid) => fs.readFileSync(path.join(KEYS_DIR, `${kid}.pub`), 'utf8');
export const privOf = (kid) => fs.readFileSync(path.join(KEYS_DIR, `${kid}.ed25519`), 'utf8');

// Copies the private key files into a writable keys dir for a test hub.
export function copyKeys(dest) {
  fs.mkdirSync(dest, { recursive: true, mode: 0o700 });
  for (const kid of Object.values(KIDS)) fs.copyFileSync(path.join(KEYS_DIR, `${kid}.ed25519`), path.join(dest, `${kid}.ed25519`));
  return dest;
}

export const canonicalVectors = JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, 'canonical-vectors.json'), 'utf8'));
