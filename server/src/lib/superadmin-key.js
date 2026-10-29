import fs from 'node:fs';
import path from 'node:path';
import bcrypt from 'bcryptjs';

// The super admin setup password. Its bcrypt hash lives root-only in
// <dataDir>/superadmin.key; `whm-cli superadmin <user>` grants the flag only
// after the password verifies against it, so a compromised panel process (it
// runs as whmpanel and cannot read the file) can never mint a super admin.
export const SUPERADMIN_KEY_FILE = 'superadmin.key';
export const MIN_SETUP_PASSWORD_LENGTH = 12;
const BCRYPT_ROUNDS = 12;

export const keyPath = (dataDir) => path.join(dataDir, SUPERADMIN_KEY_FILE);

export function keyExists(dataDir) {
  return fs.existsSync(keyPath(dataDir));
}

export function readKey(dataDir) {
  const file = keyPath(dataDir);
  if (!fs.existsSync(file)) return null;
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (parsed?.v !== 1 || typeof parsed.hash !== 'string' || !parsed.hash.startsWith('$2')) throw new Error(`${file} is not a super admin key file`);
  return { hash: parsed.hash, createdAt: parsed.created_at ?? null };
}

export function assertSetupPassword(password) {
  if (typeof password !== 'string' || password.length < MIN_SETUP_PASSWORD_LENGTH) throw new Error(`the setup password must be at least ${MIN_SETUP_PASSWORD_LENGTH} characters`);
  if (password.length > 256) throw new Error('the setup password must be at most 256 characters');
}

// False when the file is missing or the password does not match.
export async function verifyKey(dataDir, password) {
  const key = readKey(dataDir);
  if (!key || typeof password !== 'string' || !password) return false;
  return bcrypt.compare(password, key.hash);
}

// Writes the hash (0600). An existing file is replaced only when `current`
// verifies against it; otherwise the write is refused.
export async function writeKey(dataDir, password, { current = null, now = () => new Date() } = {}) {
  assertSetupPassword(password);
  const file = keyPath(dataDir);
  if (fs.existsSync(file)) {
    if (!(await verifyKey(dataDir, current))) throw new Error(`${file} already exists; the current setup password is required to replace it`);
  }
  const hash = await bcrypt.hash(password, BCRYPT_ROUNDS);
  const body = JSON.stringify({ v: 1, hash, created_at: now().toISOString() }) + '\n';
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, body, { mode: 0o600, flag: 'wx' });
  try {
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, file);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
  return { file };
}
