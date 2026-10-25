import { json } from '../db/index.js';
import { DEFAULT_SETTINGS } from '../db/seed.js';

export function createSettingsService({ db }) {
  const get = db.prepare('SELECT value FROM settings WHERE key = ?');
  const byPrefix = db.prepare("SELECT key, value FROM settings WHERE key LIKE ? ORDER BY key");
  const put = db.prepare(`INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
    ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`);

  return {
    get(key, fallback = DEFAULT_SETTINGS[key]) {
      const row = get.get(key);
      return row ? json.parse(row.value, fallback) : fallback;
    },
    getPrefix(prefix) {
      const out = {};
      for (const row of byPrefix.all(`${prefix}%`)) out[row.key] = json.parse(row.value, null);
      return out;
    },
    set(key, value) { put.run(key, JSON.stringify(value ?? null)); return value; },
    setMany(values) {
      db.transaction(() => { for (const [k, v] of Object.entries(values)) put.run(k, JSON.stringify(v ?? null)); })();
      return values;
    },
  };
}
