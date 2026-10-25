#!/usr/bin/env node
// Administrative command line for the WHM panel (run as root or the whmpanel user).
//
//   whm-cli status                      show panel/agent state and counts
//   whm-cli reset-password <user> [pw]  set a panel user's password (prompts if omitted)
//   whm-cli create-admin <user> [pw]    create another root-level panel user
//   whm-cli list-users                  list panel users
//   whm-cli unlock-ip <ip>              remove cPHulk blocks for an address
//
// Reads the same configuration as the panel (WHM_CONFIG / env / defaults).
import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { loadConfig } from '../server/src/config.js';
import { openDatabase } from '../server/src/db/index.js';
import { createCrypto } from '../server/src/lib/crypto.js';

const [cmd, ...rest] = process.argv.slice(2);

function usage(code = 0) {
  console.log(`Usage:
  whm-cli status
  whm-cli reset-password <username> [password]
  whm-cli create-admin <username> [password]
  whm-cli list-users
  whm-cli unlock-ip <ip>`);
  process.exit(code);
}

async function askPassword(prompt) {
  const rl = readline.createInterface({ input: stdin, output: stdout, terminal: true });
  const value = await rl.question(prompt);
  rl.close();
  return value;
}

async function main() {
  if (!cmd || cmd === '-h' || cmd === '--help') usage(0);
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
        jobsRunning: n("SELECT COUNT(*) AS n FROM jobs WHERE status = 'running'"),
        activeBlocks: n("SELECT COUNT(*) AS n FROM cphulk_blocks WHERE expires_at IS NULL OR expires_at > datetime('now')"),
      }, null, 2));
      break;
    }
    case 'list-users':
      console.table(db.prepare('SELECT id, username, role, totp_enabled, suspended, last_login_at FROM users ORDER BY id').all());
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
    default:
      usage(2);
  }
  db.close();
}

main().catch((err) => { console.error(`error: ${err.message}`); process.exit(1); });
