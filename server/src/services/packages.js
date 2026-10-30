import { json, paginate } from '../db/index.js';
import { notFound, conflict, forbidden, unprocessable } from '../lib/errors.js';
import { isRoot } from '../middleware/rbac.js';

const LIMIT_COLUMNS = ['disk_mb', 'bandwidth_mb', 'max_domains', 'max_subdomains', 'max_addons', 'max_parked', 'max_db', 'max_email', 'max_ftp', 'max_email_per_hour', 'quota_inodes'];
const COLUMNS = [...LIMIT_COLUMNS, 'php_version', 'feature_list_id', 'has_shell', 'has_dedicated_ip', 'cgi', 'digest_auth', 'theme'];

export function createPackagesService(ctx) {
  const { db } = ctx;
  const stmts = {
    byName: db.prepare('SELECT p.*, f.name AS feature_list FROM packages p LEFT JOIN feature_lists f ON f.id = p.feature_list_id WHERE p.name = ?'),
    usage: db.prepare('SELECT COUNT(*) AS n FROM accounts WHERE package_id = ?'),
    insert: db.prepare(`INSERT INTO packages (name, owner_id, ${COLUMNS.join(', ')}) VALUES (@name, @owner_id, ${COLUMNS.map((c) => '@' + c).join(', ')})`),
    update: db.prepare(`UPDATE packages SET ${COLUMNS.map((c) => `${c} = @${c}`).join(', ')}, updated_at = datetime('now') WHERE name = @name`),
    rename: db.prepare("UPDATE packages SET name = @newName, updated_at = datetime('now') WHERE name = @name"),
    renameAccounts: db.prepare('UPDATE accounts SET package_name = @newName WHERE package_name = @name'),
    remove: db.prepare('DELETE FROM packages WHERE name = ?'),
    featureLists: db.prepare('SELECT * FROM feature_lists ORDER BY name'),
    featureList: db.prepare('SELECT * FROM feature_lists WHERE name = ?'),
    insertFeatureList: db.prepare('INSERT INTO feature_lists (name, features_json) VALUES (?, ?)'),
    updateFeatureList: db.prepare('UPDATE feature_lists SET features_json = ? WHERE name = ?'),
    removeFeatureList: db.prepare('DELETE FROM feature_lists WHERE name = ?'),
    featureListUsage: db.prepare('SELECT COUNT(*) AS n FROM packages WHERE feature_list_id = ?'),
  };

  function shape(row) {
    if (!row) return null;
    const out = { ...row };
    for (const col of ['has_shell', 'has_dedicated_ip', 'cgi', 'digest_auth']) out[col] = Boolean(row[col]);
    out.accounts = stmts.usage.get(row.id).n;
    return out;
  }

  function fromInput(input, current = {}) {
    const row = { ...current };
    for (const col of COLUMNS) {
      if (col in input) row[col] = ['has_shell', 'has_dedicated_ip', 'cgi', 'digest_auth'].includes(col) ? (input[col] ? 1 : 0) : input[col];
      else if (!(col in row)) row[col] = col === 'cgi' ? 1 : ['has_shell', 'has_dedicated_ip', 'digest_auth'].includes(col) ? 0 : col === 'theme' ? 'jupiter' : null;
    }
    if (input.theme && ctx.themes?.isEnabledSlug && !ctx.themes.isEnabledSlug(input.theme)) throw unprocessable('Theme is not enabled on this server', { theme: ['not an enabled theme'] });
    if (input.feature_list) {
      const fl = stmts.featureList.get(input.feature_list);
      if (!fl) throw notFound('Feature list');
      row.feature_list_id = fl.id;
    }
    return row;
  }

  // Reads let a reseller see root's global packages; writes are confined to its own.
  function assertVisible(pkg, user) {
    if (!isRoot(user) && pkg.owner_id && pkg.owner_id !== user.id) throw forbidden('That package belongs to another reseller');
  }
  function assertOwned(pkg, user) {
    if (!isRoot(user) && pkg.owner_id !== user.id) throw forbidden('That package belongs to root or another reseller');
  }
  // Turning on shell access or a dedicated IP in a package needs the same reseller
  // privileges as granting them to an account; resubmitted unchanged values are not grants.
  function assertPrivileges(input, current, user) {
    if (isRoot(user) || !ctx.resellers?.assertAcl) return;
    if (input.has_shell && !current.has_shell) {
      if (ctx.resellers.aclsFor?.(user.id)?.has('disallow-shell')) throw forbidden('Your reseller privileges forbid granting shell access (Disallow Shell Access)');
      ctx.resellers.assertAcl(user, 'add-pkg-shell');
    }
    if (input.has_dedicated_ip && !current.has_dedicated_ip) ctx.resellers.assertAcl(user, 'add-pkg-ip');
  }

  return {
    list(query, user) {
      const where = [];
      const params = {};
      if (!isRoot(user)) { where.push('(p.owner_id IS NULL OR p.owner_id = @owner)'); params.owner = user.id; }
      if (query.q) { where.push('p.name LIKE @q'); params.q = `%${query.q}%`; }
      const result = paginate(db, {
        select: 'p.*, f.name AS feature_list', from: 'packages p LEFT JOIN feature_lists f ON f.id = p.feature_list_id',
        where, params, sortable: { name: 'p.name', disk_mb: 'p.disk_mb', bandwidth_mb: 'p.bandwidth_mb', created_at: 'p.created_at' }, defaultSort: 'name', query,
      });
      return { ...result, data: result.data.map(shape) };
    },
    get(name, user) {
      const pkg = stmts.byName.get(name);
      if (!pkg) throw notFound('Package');
      assertVisible(pkg, user);
      return shape(pkg);
    },
    create(input, user) {
      if (!isRoot(user)) ctx.resellers?.assertAcl?.(user, 'add-pkg');
      assertPrivileges(input, {}, user);
      if (stmts.byName.get(input.name)) throw conflict(`A package named "${input.name}" already exists`);
      const row = fromInput(input);
      stmts.insert.run({ ...row, name: input.name, owner_id: isRoot(user) ? null : user.id });
      return shape(stmts.byName.get(input.name));
    },
    update(name, input, user) {
      const pkg = stmts.byName.get(name);
      if (!pkg) throw notFound('Package');
      assertOwned(pkg, user);
      if (!isRoot(user)) ctx.resellers?.assertAcl?.(user, 'edit-pkg');
      assertPrivileges(input, pkg, user);
      const row = fromInput(input, pkg);
      db.transaction(() => {
        stmts.update.run({ ...row, name });
        if (input.newName && input.newName !== name) {
          if (stmts.byName.get(input.newName)) throw conflict(`A package named "${input.newName}" already exists`);
          stmts.rename.run({ name, newName: input.newName });
          stmts.renameAccounts.run({ name, newName: input.newName });
        }
      })();
      return shape(stmts.byName.get(input.newName || name));
    },
    remove(name, user) {
      const pkg = stmts.byName.get(name);
      if (!pkg) throw notFound('Package');
      assertOwned(pkg, user);
      if (!isRoot(user)) ctx.resellers?.assertAcl?.(user, 'add-pkg');
      if (stmts.usage.get(pkg.id).n > 0) throw conflict('Package is in use by one or more accounts; move them to another package first');
      stmts.remove.run(name);
    },
    // Resolve a package into the concrete limits an account is created with.
    snapshot(name) {
      const pkg = stmts.byName.get(name);
      if (!pkg) throw notFound('Package');
      const fl = pkg.feature_list_id ? db.prepare('SELECT features_json FROM feature_lists WHERE id = ?').get(pkg.feature_list_id) : null;
      const limits = Object.fromEntries(LIMIT_COLUMNS.map((c) => [c, pkg[c]]));
      return { ...limits, php_version: pkg.php_version, has_shell: Boolean(pkg.has_shell), has_dedicated_ip: Boolean(pkg.has_dedicated_ip), cgi: Boolean(pkg.cgi), theme: ctx.themes?.resolveForPackage?.(pkg) ?? pkg.theme, features: json.parse(fl?.features_json, {}) };
    },

    featureLists: {
      list: () => stmts.featureLists.all().map((r) => ({ id: r.id, name: r.name, features: json.parse(r.features_json, {}), packages: stmts.featureListUsage.get(r.id).n })),
      get(name) {
        const r = stmts.featureList.get(name);
        if (!r) throw notFound('Feature list');
        return { id: r.id, name: r.name, features: json.parse(r.features_json, {}) };
      },
      create(name, features) {
        if (stmts.featureList.get(name)) throw conflict(`Feature list "${name}" already exists`);
        stmts.insertFeatureList.run(name, JSON.stringify(features));
        return { name, features };
      },
      update(name, features) {
        if (!stmts.featureList.get(name)) throw notFound('Feature list');
        stmts.updateFeatureList.run(JSON.stringify(features), name);
        return { name, features };
      },
      remove(name) {
        const r = stmts.featureList.get(name);
        if (!r) throw notFound('Feature list');
        if (['default', 'disabled'].includes(name)) throw conflict('Built-in feature lists cannot be deleted');
        if (stmts.featureListUsage.get(r.id).n > 0) throw conflict('Feature list is used by one or more packages');
        stmts.removeFeatureList.run(name);
      },
    },
  };
}
