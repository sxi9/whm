import { Router } from 'express';
import { validate, z, fields, pagination } from '../../lib/validate.js';
import { requireRoot, requireReseller } from '../../middleware/rbac.js';
import { createDatabaseServicesService, PRIVILEGES, PG_PRIVILEGES } from '../../services/database-services.js';

const dbName = fields.dbName;
const dbUser = z.string().regex(/^[A-Za-z0-9_.-]{1,80}$/, 'Letters, digits, "_", "." or "-"; max 80 chars');
const newName = z.string().regex(/^[a-z0-9_]{1,54}$/, 'Lowercase letters, digits or "_"; max 54 chars (the account prefix is added)');
const accessHost = z.string().trim().regex(/^[A-Za-z0-9.%:_-]{1,255}$/, 'IP address, hostname or wildcard such as 203.0.113.% or %.example.com');
// Privileges are upper-cased and checked against the engine's list in the service.
const privilege = z.string().trim().toUpperCase().max(40);
const grant = z.object({ database: dbName, privileges: z.array(privilege).min(1).max(PRIVILEGES.length + PG_PRIVILEGES.length) }).strict();
const profileName = z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,39}$/, 'Letters, digits, spaces, ".", "_" or "-"; max 40 chars');
const configKey = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/, 'Lowercase option name such as max-connections');
const configValue = z.string().regex(/^[A-Za-z0-9_./:%,+=-]{0,255}$/, 'Letters, digits and . / : % , + = - _ only');
const idParam = z.object({ id: fields.id });
const boolQuery = z.enum(['true', 'false']).transform((v) => v === 'true').optional();

export async function register(ctx) {
  ctx.databases = createDatabaseServicesService(ctx);
  ctx.jobs.register('db.repair', (job) => ctx.databases.runRepair(job));
  ctx.jobs.register('db.upgrade', (job) => ctx.databases.runUpgrade(job));
  ctx.capabilities.register('mysql', { binaries: ['mysql', 'mariadb', 'mysqld', 'mariadbd', 'mysqlcheck', 'mariadb-check', 'mysqldump', 'mariadb-dump', 'mysql_upgrade', 'mariadb-upgrade'], required: ['mysqld', 'mariadbd', 'mysql', 'mariadb'] });
  ctx.capabilities.register('postgres', { binaries: ['psql', 'pg_dump', 'runuser'], required: ['psql'] });

  const r = Router();
  const wrap = (fn, status = 200) => (req, res, next) => Promise.resolve(fn(req, res)).then((d) => res.status(status).json(d?.meta ? d : { data: d })).catch(next);
  const dbs = () => ctx.databases;
  const listQuery = pagination.extend({ account: fields.username.optional(), system: boolQuery });

  // Overview --------------------------------------------------------------
  r.get('/status', requireReseller, wrap((req) => dbs().status(req.user)));
  r.get('/accounts/:username', requireReseller, validate({ params: z.object({ username: fields.username }) }), wrap((req) => dbs().forAccount(req.params.username, req.user)));

  // Manage Databases -----------------------------------------------------
  r.get('/databases', requireReseller, validate({ query: listQuery }), wrap((req) => dbs().listDatabases(req.query, req.user)));
  r.post('/databases', requireReseller, validate({ body: z.object({ name: z.union([newName, dbName]), account: fields.username.optional(), charset: z.string().regex(/^[a-z0-9_]{1,32}$/).optional(), collation: z.string().regex(/^[a-z0-9_]{1,64}$/).optional() }).strict() }),
    wrap((req) => dbs().createDatabase(req.body, req.user, req), 201));
  r.delete('/databases/:name', requireReseller, validate({ params: z.object({ name: dbName }) }), wrap((req) => dbs().dropDatabase(req.params.name, req.user, req)));

  // Manage Database Users + grants ---------------------------------------
  r.get('/users', requireReseller, validate({ query: listQuery }), wrap((req) => dbs().listUsers(req.query, req.user)));
  r.post('/users', requireReseller, validate({ body: z.object({ name: z.union([newName, dbUser]), password: fields.password, account: fields.username.optional(), hosts: z.array(accessHost).max(50).optional(), databases: z.array(dbName).max(100).optional() }).strict() }),
    wrap((req) => dbs().createUser(req.body, req.user, req), 201));
  r.delete('/users/:name', requireReseller, validate({ params: z.object({ name: dbUser }) }), wrap((req) => dbs().dropUser(req.params.name, req.user, req)));
  r.put('/users/:name/password', requireReseller, validate({ params: z.object({ name: dbUser }), body: z.object({ password: fields.password }).strict() }),
    wrap((req) => dbs().setUserPassword(req.params.name, req.body.password, req.user, req)));
  r.get('/users/:name/grants', requireReseller, validate({ params: z.object({ name: dbUser }) }), wrap((req) => dbs().grantsFor(req.params.name, req.user)));
  r.put('/users/:name/grants', requireReseller, validate({ params: z.object({ name: dbUser }), body: z.object({ grants: z.array(grant).max(200) }).strict() }),
    wrap((req) => dbs().setGrants(req.params.name, req.body.grants, req.user, req)));

  // Change Database Root Password ----------------------------------------
  r.put('/root-password', requireRoot, validate({ body: z.object({ password: fields.password }).strict() }), wrap((req) => dbs().setRootPassword(req.body.password, req.user, req)));

  // Database Map Tool ----------------------------------------------------
  r.get('/map', requireRoot, wrap((req) => dbs().map(req.user)));
  r.post('/map/assign', requireRoot, validate({ body: z.object({ kind: z.enum(['database', 'user']), name: z.union([dbName, dbUser]), account: fields.username.nullable().optional() }).strict() }),
    wrap((req) => (req.body.account ? dbs().assign(req.body, req.user, req) : dbs().unassign(req.body, req.user, req))));

  // Manage Database Access Hosts -----------------------------------------
  r.get('/access-hosts', requireReseller, validate({ query: z.object({ account: fields.username.optional() }) }), wrap((req) => dbs().listAccessHosts(req.query, req.user)));
  r.post('/access-hosts', requireReseller, validate({ body: z.object({ host: accessHost, account: fields.username.optional() }).strict() }), wrap((req) => dbs().addAccessHost(req.body, req.user, req), 201));
  r.delete('/access-hosts/:id', requireReseller, validate({ params: idParam }), wrap((req) => dbs().removeAccessHost(req.params.id, req.user, req)));

  // Manage Database Profiles ---------------------------------------------
  const profileBody = z.object({
    profile_name: profileName, engine: z.enum(['mysql', 'mariadb', 'postgres']), host: z.union([fields.hostname, fields.ip, z.literal('localhost')]),
    port: z.number().int().min(1).max(65535).nullable().optional(), is_local: z.boolean().optional(),
    admin_user: dbUser.nullable().optional(), admin_password: z.string().max(256).regex(/^[^\n\r\0]*$/).nullable().optional(),
  }).strict();
  r.get('/profiles', requireRoot, wrap((req) => dbs().listProfiles(req.user)));
  r.post('/profiles', requireRoot, validate({ body: profileBody }), wrap((req) => dbs().createProfile(req.body, req.user, req), 201));
  r.put('/profiles/:id', requireRoot, validate({ params: idParam, body: profileBody.partial() }), wrap((req) => dbs().updateProfile(req.params.id, req.body, req.user, req)));
  r.delete('/profiles/:id', requireRoot, validate({ params: idParam }), wrap((req) => dbs().removeProfile(req.params.id, req.user, req)));
  r.post('/profiles/:id/test', requireRoot, validate({ params: idParam }), wrap((req) => dbs().testProfile(req.params.id, req.user, req)));
  r.post('/profiles/:id/activate', requireRoot, validate({ params: idParam }), wrap((req) => dbs().activateProfile(req.params.id, req.user, req)));

  // Edit Database Configuration ------------------------------------------
  r.get('/config', requireRoot, wrap((req) => dbs().getConfig(req.user)));
  r.put('/config', requireRoot, validate({ body: z.object({ settings: z.record(configKey, configValue.nullable()), replace: z.boolean().optional(), restart: z.boolean().optional() }).strict() }),
    wrap((req) => dbs().setConfig(req.body, req.user, req)));
  r.post('/restart', requireRoot, wrap((req) => dbs().restart(req.user, req)));
  r.get('/variables', requireRoot, wrap((req) => dbs().variables(req.user)));

  // Repair Databases -----------------------------------------------------
  r.get('/repair', requireReseller, wrap((req) => dbs().repairHistory(req.user)));
  r.post('/repair', requireReseller, validate({ body: z.object({ action: z.enum(['check', 'repair', 'optimize', 'analyze']).optional(), databases: z.array(dbName).max(500).optional(), autoRepair: z.boolean().optional() }).strict() }),
    wrap((req) => dbs().enqueueRepair(req.body, req.user, req), 202));

  // Show Database Processes ----------------------------------------------
  r.get('/processes', requireRoot, wrap((req) => dbs().processes(req.user)));
  r.post('/processes/:id/kill', requireRoot, validate({ params: z.object({ id: z.coerce.number().int().positive() }), body: z.object({ queryOnly: z.boolean().optional() }).strict() }),
    wrap((req) => dbs().kill(req.params.id, req.body.queryOnly, req.user, req)));

  // Upgrade Database Version ---------------------------------------------
  r.get('/upgrade', requireRoot, wrap((req) => dbs().upgradeStatus(req.user)));
  r.post('/upgrade', requireRoot, validate({ body: z.object({ target: z.string().regex(/^[a-z0-9][a-z0-9+._-]{0,80}$/, 'Package name such as mariadb-server'), backup: z.boolean().optional() }).strict() }),
    wrap((req) => dbs().enqueueUpgrade(req.body, req.user, req), 202));

  // phpMyAdmin -----------------------------------------------------------
  r.get('/phpmyadmin', requireReseller, wrap((req) => dbs().phpMyAdmin(req.user)));
  // A protocol-relative "//host/..." value would send every reseller to a foreign
  // origin, so the path form must start with exactly one slash.
  r.put('/phpmyadmin', requireRoot, validate({ body: z.object({ url: z.string().trim().max(2048).regex(/^(https?:\/\/[^\s/][^\s]*|\/(?!\/)[^\s]*|)$/, 'Absolute http(s) URL or a path on this server') }).strict() }),
    wrap((req) => dbs().setPhpMyAdminUrl(req.body.url, req.user, req)));

  return { path: '/databases', router: r };
}
