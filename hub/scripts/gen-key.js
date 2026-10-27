#!/usr/bin/env node
// gen-key.js --license | --plugin [--activate]  writes /etc/whm-hub/keys/<kid>.ed25519 (0600),
//                                              inserts the signing_keys row (purpose) and prints { kid, pub }
//            --master                           writes /etc/whm-hub/master.key (0600)
//            --hmac                             writes /etc/whm-hub/keys/download.hmac (32 random bytes, 0600)
// Options: --config <hub.conf> --dir <keys dir> --db-dir <dir> --json
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.js';
import { openDb } from '../shared/db.js';
import { loadSigningKeys } from '../shared/keys.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > 0) out[a.slice(2, eq)] = a.slice(eq + 1);
      else if (argv[i + 1] && !argv[i + 1].startsWith('--')) out[a.slice(2)] = argv[++i];
      else out[a.slice(2)] = true;
    } else out._.push(a);
  }
  return out;
}

export function main(argv = process.argv.slice(2), { stdout = process.stdout } = {}) {
  const args = parseArgs(argv);
  const config = loadConfig({ file: args.config, overrides: { ...(args['db-dir'] ? { db_dir: args['db-dir'] } : {}), ...(args.dir ? { keys: { dir: args.dir } } : {}) } });
  const print = (obj) => stdout.write(args.json ? JSON.stringify(obj) + '\n' : Object.entries(obj).map(([k, v]) => `${k}: ${typeof v === 'string' && v.includes('\n') ? '\n' + v : v}`).join('\n') + '\n');

  if (args.master) {
    const file = args.out || config.master_key_file;
    if (fs.existsSync(file) && !args.force) throw new Error(`${file} exists; pass --force to overwrite (this makes every stored secret unreadable)`);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o750 });
    fs.writeFileSync(file, crypto.randomBytes(32).toString('hex') + '\n', { mode: 0o600 });
    print({ written: file });
    return 0;
  }
  if (args.hmac) {
    const file = args.out || path.join(config.keys.dir, 'download.hmac');
    if (fs.existsSync(file) && !args.force) throw new Error(`${file} exists; pass --force to overwrite (existing download URLs stop verifying)`);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, crypto.randomBytes(32), { mode: 0o600 });
    print({ written: file, bytes: 32 });
    return 0;
  }
  const purpose = args.license ? 'license' : args.plugin ? 'plugin' : null;
  if (!purpose) throw new Error('usage: gen-key.js --license | --plugin [--activate] | --master | --hmac');
  const db = openDb(path.join(config.db_dir, 'license.db'), { migrationsDir: path.join(HERE, '../license/migrations') });
  try {
    const keys = loadSigningKeys(config.keys.dir, db, { activeKids: {} });
    const activate = !!args.activate || !keys.active(purpose);
    const created = keys.generate(purpose, { status: 'pending', activate });
    print({ kid: created.kid, purpose, status: created.status, file: path.join(config.keys.dir, `${created.kid}.ed25519`), pub: created.pub });
    if (!args.json) stdout.write(activate ? `\nThis key is now the active ${purpose} key.\n` : `\nPending: activate it with hub-cli.js activate-key ${created.kid} (or POST /v1/admin/signing-keys/${created.kid}/activate).\n`);
    if (purpose === 'license' && !args.json) stdout.write(`Add { "kid": "${created.kid}", "pub": "<pem>", "not_after": null } to server/src/services/license-keys.json before activating on the hub.\n`);
  } finally {
    db.close();
  }
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exit(main()); } catch (err) { console.error(err.message); process.exit(1); }
}
