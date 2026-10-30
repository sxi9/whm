import fs from 'node:fs';
import path from 'node:path';
import bcrypt from 'bcryptjs';

// The super admin setup password. Its bcrypt hash lives root-only in the key
// file (config.superadminKeyFile: next to whm.conf on an installed host);
// `whm-cli superadmin <user>` grants the flag only after the password verifies
// against it. What this protects: no other panel user, operator or support
// login can make a root user the owner without the setup password. What it
// does not protect: the flag itself is users.superadmin in the panel's own
// database, so code running as the panel user can still set it directly.
export const SUPERADMIN_KEY_FILE = 'superadmin.key';
export const MIN_SETUP_PASSWORD_LENGTH = 12;
const BCRYPT_ROUNDS = 12;

export const keyPath = (dir) => path.join(dir, SUPERADMIN_KEY_FILE);

export function keyExists(file) {
  return fs.existsSync(file);
}

export function readKey(file) {
  if (!fs.existsSync(file)) return null;
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (parsed?.v !== 1 || typeof parsed.hash !== 'string' || !parsed.hash.startsWith('$2')) throw new Error(`${file} is not a super admin key file`);
  return { hash: parsed.hash, createdAt: parsed.created_at ?? null };
}

export function assertSetupPassword(password) {
  if (typeof password !== 'string' || password.length < MIN_SETUP_PASSWORD_LENGTH) throw new Error(`the setup password must be at least ${MIN_SETUP_PASSWORD_LENGTH} characters`);
  if (password.length > 256) throw new Error('the setup password must be at most 256 characters');
}

// The directory is never created here: a root-owned data directory would stop
// the panel from booting, so the operator is told what is missing instead.
export function assertKeyDir(file) {
  const dir = path.dirname(file);
  if (fs.existsSync(dir)) return dir;
  throw new Error(`the directory ${dir} does not exist yet: start the panel once (it creates its data directory) or create the directory, then rerun whm-cli superadmin --init`);
}

// False when the file is missing or the password does not match.
export async function verifyKey(file, password) {
  const key = readKey(file);
  if (!key || typeof password !== 'string' || !password) return false;
  return bcrypt.compare(password, key.hash);
}

// Writes the hash (0600). An existing file is replaced only when `current`
// verifies against it; otherwise the write is refused.
export async function writeKey(file, password, { current = null, now = () => new Date() } = {}) {
  assertSetupPassword(password);
  assertKeyDir(file);
  if (fs.existsSync(file)) {
    if (!(await verifyKey(file, current))) throw new Error(`${file} already exists; the current setup password is required to replace it`);
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
