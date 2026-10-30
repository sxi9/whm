#!/usr/bin/env node
// Administrative command line for the WHM panel (run as root or the whmpanel user).
//
//   whm-cli status                      show panel/agent state and counts
//   whm-cli reset-password <user> [pw]  set a panel user's password (prompts if omitted)
//   whm-cli create-admin <user> [pw]    create another root-level panel user
//   whm-cli list-users                  list panel users
//   whm-cli unlock-ip <ip>              remove cPHulk blocks for an address
//   whm-cli superadmin --init           create the super admin key file from the setup password
//                                       (prompted, or WHM_SUPERADMIN_SETUP_PASSWORD)
//   whm-cli superadmin <user>           make an existing root user the super admin (asks for
//                                       the setup password; refused without the key file)
//   whm-cli superadmin --revoke <user>  clear the flag (same check)
//
// Reads the same configuration as the panel (WHM_CONFIG / env / defaults). The super admin
// commands run as root on an installed host: the key file lives next to whm.conf
// (config superadminKeyFile / WHM_SUPERADMIN_KEY_FILE), in a directory the panel user cannot
// write, so neither a panel-user shell nor a mistaken `sudo -u whmpanel` can mint or replace it.
import fs from 'node:fs';
import { stdin, stdout } from 'node:process';
import readline from 'node:readline/promises';
import { loadConfig, readConfig } from '../server/src/config.js';
import { openDatabase } from '../server/src/db/index.js';
import { createCrypto } from '../server/src/lib/crypto.js';
import { keyExists, verifyKey, writeKey, assertKeyDir, assertSetupPassword, MIN_SETUP_PASSWORD_LENGTH } from '../server/src/lib/superadmin-key.js';

const [cmd, ...rest] = process.argv.slice(2);

function usage(code = 0) {
  console.log(`Usage:
  whm-cli status
  whm-cli reset-password <username> [password]
  whm-cli create-admin <username> [password]
  whm-cli list-users
  whm-cli unlock-ip <ip>
  whm-cli superadmin --init
  whm-cli superadmin <username>
  whm-cli superadmin --revoke <username>`);
  process.exit(code);
}

// Passwords are typed without echo on a terminal; piped input reads one line.
async function askSecret(prompt) {
  if (!stdin.isTTY) {
    const rl = readline.createInterface({ input: stdin, terminal: false });
    for await (const line of rl) { rl.close(); return line; }
    return '';
  }
  stdout.write(prompt);
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding('utf8');
  return new Promise((resolve, reject) => {
    let value = '';
    const finish = () => { stdin.setRawMode(false); stdin.pause(); stdin.off('data', onData); stdout.write('\n'); };
    function onData(chunk) {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') { finish(); resolve(value); return; }
        if (ch === '\u0003' || ch === '\u0004') { finish(); reject(new Error('cancelled')); return; }
        if (ch === '\u007f' || ch === '\b') { value = value.slice(0, -1); continue; }
        value += ch;
      }
    }
    stdin.on('data', onData);
  });
}

const askPassword = askSecret;

// The super admin commands belong to whoever owns the key file's directory:
// root on an installed host (/etc/whm), the developer on a checkout (./data).
// Run as the panel user they are refused before anything is read or written.
function assertKeyAccess(file) {
  const uid = process.getuid?.();
  if (uid === undefined || uid === 0) { assertKeyDir(file); return; }
  const dir = assertKeyDir(file);
  if (fs.statSync(dir).uid !== uid) throw new Error(`run this command as root: ${file} lives in ${dir}, which belongs to another user`);
}

// The setup password gate shared by grant and revoke: no key file → explain
// how to create one; wrong password → refuse. Nothing is changed either way.
async function verifySetupPassword(file) {
  assertKeyAccess(file);
  if (!keyExists(file)) {
    throw new Error(`no super admin key at ${file}: create it first with "whm-cli superadmin --init" (as root), then run this command again`);
  }
  const password = process.env.WHM_SUPERADMIN_SETUP_PASSWORD || await askSecret('Super admin setup password: ');
  if (!(await verifyKey(file, password))) throw new Error('the setup password does not match; the super admin was not changed');
}

async function superadminInit() {
  const config = readConfig();
  const file = config.superadminKeyFile;
  assertKeyAccess(file);
  const given = process.env.WHM_SUPERADMIN_SETUP_PASSWORD;
  let current = null;
  if (keyExists(file)) {
    if (given) throw new Error(`${file} already exists; run "whm-cli superadmin --init" interactively to replace it with the current setup password`);
    current = await askSecret('Current super admin setup password (the key file exists): ');
    if (!(await verifyKey(file, current))) throw new Error('the current setup password does not match; the key file was not replaced');
  }
  let password = given;
  if (!password) {
    password = await askSecret(`New super admin setup password (at least ${MIN_SETUP_PASSWORD_LENGTH} characters): `);
    assertSetupPassword(password);
    // Piped input carries the password once; a terminal confirms it.
    const again = stdin.isTTY ? await askSecret('Repeat it: ') : password;
    if (again !== password) throw new Error('the passwords do not match');
  }
  await writeKey(file, password, { current });
  console.log(`super admin setup password stored in ${file} (0600). Grant the flag with: whm-cli superadmin <root-username>`);
}

async function main() {
  if (!cmd || cmd === '-h' || cmd === '--help') usage(0);
  // --init must not open the database or create the panel's secrets: on a fresh
  // install it runs as root before the panel's first boot.
  if (cmd === 'superadmin' && rest[0] === '--init') return superadminInit();

  const config = loadConfig();
  const db = openDatabase(config.dbPath, { info() {}, warn() {}, error() {} });
  const crypto = createCrypto(config.masterKeyHex);

  switch (cmd) {
    case 'status': {
      const n = (sql) => db.prepare(sql).get().n;
      console.log(JSON.stringify({
        dataDir: config.dataDir, mode: config.mode, port: config.port, tls: config.tls,
        users: n('SELECT COUNT(*) AS n FROM users'), accounts: n('SELECT COUNT(*) AS n FROM accounts'),
        suspended: n('SELECT COUNT(*) AS n FROM accounts WHERE suspended = 1'), packages: n('SELECT COUNT(*) AS n FROM packages'),
        superadmins: n('SELECT COUNT(*) AS n FROM users WHERE superadmin = 1'), superadminKey: keyExists(config.superadminKeyFile), superadminKeyFile: config.superadminKeyFile,
        jobsRunning: n("SELECT COUNT(*) AS n FROM jobs WHERE status = 'running'"),
        activeBlocks: n("SELECT COUNT(*) AS n FROM cphulk_blocks WHERE expires_at IS NULL OR expires_at > datetime('now')"),
      }, null, 2));
      break;
    }
    case 'list-users':
      console.table(db.prepare('SELECT id, username, role, superadmin, totp_enabled, suspended, last_login_at FROM users ORDER BY id').all());
      break;
    case 'reset-password': {
      const [username, given] = rest;
      if (!username) usage(2);
      const user = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
      if (!user) throw new Error(`no panel user "${username}"`);
      const password = given || await askPassword(`New password for ${username}: `);
      if (password.length < 8) throw new Error('password must be at least 8 characters');
      db.prepare('UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?').run(await crypto.hashPassword(password), user.id);
      db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id);
      console.log(`password updated for ${username}; existing sessions were logged out`);
      break;
    }
    case 'create-admin': {
      const [username, given] = rest;
      if (!username || !/^[a-z][a-z0-9_-]{0,31}$/.test(username)) usage(2);
      if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) throw new Error(`"${username}" already exists`);
      const password = given || await askPassword(`Password for ${username}: `);
      if (password.length < 8) throw new Error('password must be at least 8 characters');
      db.prepare("INSERT INTO users (username, role, password_hash) VALUES (?, 'root', ?)").run(username, await crypto.hashPassword(password));
      console.log(`created root-level panel user ${username}`);
      break;
    }
    case 'unlock-ip': {
      const [ip] = rest;
      if (!ip) usage(2);
      const { changes } = db.prepare('DELETE FROM cphulk_blocks WHERE ip = ?').run(ip);
      console.log(`removed ${changes} block(s) for ${ip}`);
      break;
    }
    case 'superadmin': {
      const revoke = rest[0] === '--revoke';
      const username = revoke ? rest[1] : rest[0];
      if (!username || username.startsWith('-')) usage(2);
      const user = db.prepare('SELECT id, username, role, superadmin FROM users WHERE username = ?').get(username);
      if (!user) throw new Error(`no panel user "${username}"`);
      if (user.role !== 'root') throw new Error(`"${username}" is a ${user.role} user; only a root user can be the super admin`);
      await verifySetupPassword(config.superadminKeyFile);
      db.prepare('UPDATE users SET superadmin = ? WHERE id = ?').run(revoke ? 0 : 1, user.id);
      db.prepare("INSERT INTO audit_log (principal, role, ip, action, target, args_redacted, result) VALUES ('whm-cli', 'root', NULL, ?, ?, '{}', 'ok')").run(revoke ? 'auth.superadmin.revoke' : 'auth.superadmin.grant', username);
      console.log(revoke ? `${username} is no longer the super admin` : `${username} is now the super admin of this panel (sees the license hub and key)`);
      break;
    }
    default:
      usage(2);
  }
  db.close();
}

main().catch((err) => { console.error(`error: ${err.message}`); process.exit(1); });
