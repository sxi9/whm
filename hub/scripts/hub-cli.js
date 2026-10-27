#!/usr/bin/env node
// hub-cli.js create-admin <email> [--password <pw>]      vendor_admin portal user (password from --password, WHM_HUB_ADMIN_PASSWORD or generated)
//            issue <sku> <email> [--months N] [--name N]  issues a license and prints the key once
//            revoke <license_id> [--reason text]
//            status [<license_id> | <WHM-XXXX prefix>]     hub health or license status
//            activate-key <kid>                            make a pending key the active one of its purpose
// Options: --config <hub.conf> --db-dir <dir> --json
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pino from 'pino';
import { bootstrap } from '../src/index.js';

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      if (argv[i + 1] && !argv[i + 1].startsWith('--')) out[a.slice(2)] = argv[++i];
      else out[a.slice(2)] = true;
    } else out._.push(a);
  }
  return out;
}

export async function main(argv = process.argv.slice(2), { stdout = process.stdout, env = process.env } = {}) {
  const args = parseArgs(argv);
  const [cmd, ...rest] = args._;
  if (args.config) env.WHM_HUB_CONFIG = args.config;
  const ctx = await bootstrap({ config: { log_level: 'silent', ...(args['db-dir'] ? { db_dir: args['db-dir'] } : {}), ...(args['keys-dir'] ? { keys: { dir: args['keys-dir'] } } : {}) }, logger: pino({ level: 'silent' }) });
  const out = (obj) => stdout.write((args.json ? JSON.stringify(obj) : JSON.stringify(obj, null, 2)) + '\n');
  const actor = { principal: 'cli', ip: null };
  try {
    switch (cmd) {
      case 'create-admin': {
        const email = rest[0];
        if (!email) throw new Error('usage: create-admin <email>');
        const password = args.password || env.WHM_HUB_ADMIN_PASSWORD || ctx.crypto.randomPassword(20);
        const user = await ctx.portalUsers.create({ email, password, role: args.role || 'vendor_admin' });
        ctx.audit.record({ principal: 'cli', ip: null, action: 'portal.user_create', target: user.id, args: { email, role: user.role }, result: 'ok' });
        out({ ...user, password: args.password || env.WHM_HUB_ADMIN_PASSWORD ? '(as given)' : password });
        return 0;
      }
      case 'issue': {
        const [sku, email] = rest;
        if (!sku || !email) throw new Error('usage: issue <sku> <email> [--months N]');
        const { license, key } = ctx.licenses.issue({ sku, customer: { email, name: args.name || email }, term_months: args.months ? Number(args.months) : undefined, notify: false }, { actor });
        out({ license_id: license.id, key, edition: license.edition, expires_at: license.expires_at, max_activations: license.max_activations });
        return 0;
      }
      case 'revoke': {
        if (!rest[0]) throw new Error('usage: revoke <license_id> [--reason text]');
        out(ctx.licenses.revoke(rest[0], { reason: args.reason || 'revoked from CLI' }, { actor }));
        return 0;
      }
      case 'status': {
        if (!rest[0]) { out({ health: ctx.health(), keys: ctx.keys.list(), schedules: ctx.scheduler.list().map((s) => s.name) }); return 0; }
        if (rest[0].startsWith('lic_')) {
          const l = ctx.licenses.get(rest[0]);
          out({ ...l, status_now: ctx.licenses.statusAt(l), activations: ctx.activations.listForLicense(l.id), usage: ctx.licenses.lastUsage(l.id) });
        } else out(ctx.licenses.statusByPrefix(rest[0]));
        return 0;
      }
      case 'activate-key': {
        if (!rest[0]) throw new Error('usage: activate-key <kid>');
        out(ctx.signingKeys.activate(rest[0], { actor }));
        return 0;
      }
      default:
        stdout.write('commands: create-admin <email> | issue <sku> <email> | revoke <license_id> | status [id|prefix] | activate-key <kid>\n');
        return cmd ? 1 : 0;
    }
  } finally {
    await ctx.close();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => process.exit(code), (err) => { console.error(err.message); process.exit(1); });
}
