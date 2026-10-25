import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const migrationsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');

export function openDatabase(dbPath, logger) {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  migrate(db, logger);
  return db;
}

export function migrate(db, logger) {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  const applied = new Set(db.prepare('SELECT name FROM schema_migrations').all().map((r) => r.name));
  const files = fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort();
  const record = db.prepare('INSERT INTO schema_migrations (name) VALUES (?)');
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
    db.transaction(() => {
      db.exec(sql);
      record.run(file);
    })();
    logger?.info({ migration: file }, 'applied database migration');
  }
}

// Shared list helper: `sql` must select from a single FROM clause that the
// COUNT can reuse. `where` is an array of SQL fragments ANDed together.
export function paginate(db, { select, from, where = [], params = {}, sortable = {}, defaultSort, query }) {
  const { page = 1, pageSize = 50, sort, dir = 'asc' } = query;
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = db.prepare(`SELECT COUNT(*) AS n FROM ${from} ${whereSql}`).get(params).n;
  const orderCol = sortable[sort] || sortable[defaultSort] || Object.values(sortable)[0] || '1';
  const orderSql = `ORDER BY ${orderCol} ${dir === 'desc' ? 'DESC' : 'ASC'}`;
  const rows = db
    .prepare(`SELECT ${select} FROM ${from} ${whereSql} ${orderSql} LIMIT @limit OFFSET @offset`)
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
