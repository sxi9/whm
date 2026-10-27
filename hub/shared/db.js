import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';

// openDb(path, { migrationsDir, logger }) -> better-sqlite3 handle with WAL and
// foreign keys on. Migrations are 0NN_<name>.sql files, applied once in name
// order and never edited after they are committed.
export function openDb(dbPath, { migrationsDir, logger } = {}) {
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true, mode: 0o750 });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  if (migrationsDir) migrate(db, migrationsDir, logger);
  return db;
}

// SQLite has no ADD COLUMN IF NOT EXISTS: a follow-up migration (0NNb_*) that
// adds columns stays idempotent because every single-line
// `ALTER TABLE t ADD COLUMN c ...;` statement is dropped when t already has c,
// so a database whose schema_migrations ledger lags its schema still boots.
const ALTER_ADD_COLUMN = /^[ \t]*ALTER\s+TABLE\s+(\w+)\s+ADD\s+COLUMN\s+(\w+)[^;]*;[ \t]*$/gim;

export function hasColumn(db, table, column) {
  if (!/^\w+$/.test(table)) throw new Error('invalid table name');
  return db.prepare(`PRAGMA table_info("${table}")`).all().some((c) => c.name.toLowerCase() === String(column).toLowerCase());
}

export function skipExistingColumns(db, sql) {
  return sql.replace(ALTER_ADD_COLUMN, (stmt, table, column) => (hasColumn(db, table, column) ? '' : stmt));
}

export function migrate(db, migrationsDir, logger) {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  const applied = new Set(db.prepare('SELECT name FROM schema_migrations').all().map((r) => r.name));
  const files = fs.readdirSync(migrationsDir).filter((f) => /^\d{3}[a-z]?_.+\.sql$/.test(f)).sort();
  const record = db.prepare('INSERT INTO schema_migrations (name) VALUES (?)');
  const names = [];
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = skipExistingColumns(db, fs.readFileSync(path.join(migrationsDir, file), 'utf8'));
    db.transaction(() => { db.exec(sql); record.run(file); })();
    names.push(file);
    logger?.info({ migration: file }, 'applied database migration');
  }
  return names;
}

// Shared list helper: `from` is a single FROM clause the COUNT can reuse;
// `where` fragments are ANDed; `sortable` maps query sort names to columns.
export function paginate(db, { select = '*', from, where = [], params = {}, sortable = {}, defaultSort, query = {} }) {
  const { page = 1, pageSize = 50, sort, dir = 'asc' } = query;
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = db.prepare(`SELECT COUNT(*) AS n FROM ${from} ${whereSql}`).get(params).n;
  const orderCol = sortable[sort] || sortable[defaultSort] || Object.values(sortable)[0] || '1';
  const rows = db.prepare(`SELECT ${select} FROM ${from} ${whereSql} ORDER BY ${orderCol} ${dir === 'desc' ? 'DESC' : 'ASC'} LIMIT @limit OFFSET @offset`)
    .all({ ...params, limit: pageSize, offset: (page - 1) * pageSize });
  return { data: rows, meta: { page, pageSize, total } };
}

export const json = {
  parse(value, fallback) {
    if (value == null) return fallback;
    try { return JSON.parse(value); } catch { return fallback; }
  },
  stringify: (value) => JSON.stringify(value ?? null),
};

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

// ULID-style identifiers: <prefix>_<10 time chars><8 random chars>, sortable
// by creation time and safe in URLs and logs.
export function newId(prefix, now = Date.now()) {
  let t = BigInt(now);
  let time = '';
  for (let i = 0; i < 10; i++) { time = CROCKFORD[Number(t % 32n)] + time; t /= 32n; }
  const rnd = crypto.randomBytes(8);
  let rand = '';
  for (let i = 0; i < 8; i++) rand += CROCKFORD[rnd[i] % 32];
  return `${prefix}_${time}${rand}`;
}

export const nowIso = (ms = Date.now()) => new Date(ms).toISOString();
