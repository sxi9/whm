import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { json } from '../db/index.js';
import { notFound, conflict, unprocessable } from '../lib/errors.js';
import { buildLocaleXml, parseLocaleXml, LOCALE_CODE_RE } from './locales-xml.js';

// Locales. Attached as ctx.locales; other categories may call:
//   locales.defaultCode()                 -> 'en' | 'es' | ...
//   locales.enabledCodes()                -> ['en', ...]
//   locales.t(key, fallback, code?)       -> translated string for the default (or given) locale
//   locales.baseCatalog()                 -> { key: englishText } (client/src/i18n/en.json)
// "en" is built in: it mirrors the base catalog and is read-only.

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
export const BASE_CATALOG_PATH = path.join(REPO_ROOT, 'client/src/i18n/en.json');
export const BUILTIN_CODE = 'en';
// Where glibc-based distributions record the system-wide locale; read through the agent.
export const SYSTEM_LOCALE_FILES = ['/etc/default/locale', '/etc/locale.conf'];

export function parseSystemLocaleFile(content) {
  const vars = {};
  for (const raw of String(content ?? '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^(?:export\s+)?(LANG|LANGUAGE|LC_[A-Z_]+)=(?:"([^"]*)"|'([^']*)'|(\S*))\s*$/);
    if (m) vars[m[1]] = m[2] ?? m[3] ?? m[4] ?? '';
  }
  return vars;
}

// Keys in `strings` that the base catalog knows, and how many have a non-empty value.
export function catalogStats(base, strings) {
  const baseKeys = Object.keys(base);
  let translated = 0;
  let extra = 0;
  for (const [key, value] of Object.entries(strings)) {
    if (!(key in base)) { extra++; continue; }
    if (typeof value === 'string' && value.trim() !== '') translated++;
  }
  return { total: baseKeys.length, translated, untranslated: baseKeys.length - translated, extra, percent: baseKeys.length ? Math.round((translated / baseKeys.length) * 100) : 100 };
}

export function createLocalesService(ctx) {
  const { db, agent, capabilities, settings, logger } = ctx;

  const stmts = {
    all: db.prepare('SELECT l.code, l.name, l.enabled, l.strings_json, m.builtin, m.copied_from, m.source, m.created_at, m.updated_at FROM locales l LEFT JOIN locale_meta m ON m.code = l.code ORDER BY m.builtin DESC, l.code'),
    byCode: db.prepare('SELECT l.code, l.name, l.enabled, l.strings_json, m.builtin, m.copied_from, m.source, m.created_at, m.updated_at FROM locales l LEFT JOIN locale_meta m ON m.code = l.code WHERE l.code = ?'),
    insert: db.prepare('INSERT INTO locales (code, name, strings_json, enabled) VALUES (?, ?, ?, ?)'),
    insertMeta: db.prepare('INSERT OR REPLACE INTO locale_meta (code, builtin, copied_from, source) VALUES (?, 0, ?, ?)'),
    update: db.prepare('UPDATE locales SET name = ?, strings_json = ? WHERE code = ?'),
    touch: db.prepare(`UPDATE locale_meta SET updated_at = datetime('now') WHERE code = ?`),
    setEnabled: db.prepare('UPDATE locales SET enabled = ? WHERE code = ?'),
    remove: db.prepare('DELETE FROM locales WHERE code = ?'),
    removeMeta: db.prepare('DELETE FROM locale_meta WHERE code = ?'),
    syncBuiltin: db.prepare('UPDATE locales SET strings_json = ? WHERE code = ? AND strings_json <> ?'),
  };

  // --- base catalog ------------------------------------------------------
  let cache = { mtimeMs: -1, catalog: null };
  function baseCatalog() {
    try {
      const st = fs.statSync(BASE_CATALOG_PATH);
      if (st.mtimeMs !== cache.mtimeMs) {
        const parsed = JSON.parse(fs.readFileSync(BASE_CATALOG_PATH, 'utf8'));
        const catalog = {};
        for (const [k, v] of Object.entries(parsed)) if (typeof v === 'string') catalog[k] = v;
        cache = { mtimeMs: st.mtimeMs, catalog };
        const encoded = JSON.stringify(catalog);
        stmts.syncBuiltin.run(encoded, BUILTIN_CODE, encoded);
      }
      return cache.catalog;
    } catch (err) {
      if (!cache.catalog) {
        logger.warn({ err, path: BASE_CATALOG_PATH }, 'base locale catalog unreadable; using the stored en strings');
        const row = stmts.byCode.get(BUILTIN_CODE);
        cache = { mtimeMs: -1, catalog: json.parse(row?.strings_json, {}) };
      }
      return cache.catalog;
    }
  }

  const defaultCode = () => { const code = settings.get('locales.default', BUILTIN_CODE); return typeof code === 'string' && stmts.byCode.get(code) ? code : BUILTIN_CODE; };
  const stringsOf = (row) => (row.code === BUILTIN_CODE ? baseCatalog() : json.parse(row.strings_json, {}));

  function shape(row, { withStrings = false } = {}) {
    const base = baseCatalog();
    const strings = stringsOf(row);
    const out = {
      code: row.code, name: row.name, enabled: Boolean(row.enabled), builtin: Boolean(row.builtin), isDefault: row.code === defaultCode(),
      copiedFrom: row.copied_from ?? null, source: row.source ?? (row.builtin ? 'builtin' : 'custom'), createdAt: row.created_at ?? null, updatedAt: row.updated_at ?? null,
      stats: catalogStats(base, strings),
    };
    if (withStrings) out.strings = strings;
    return out;
  }

  const load = (code) => { const row = stmts.byCode.get(code); if (!row) throw notFound(`Locale "${code}"`); return row; };
  const assertEditable = (row) => { if (row.builtin) throw conflict(`"${row.code}" is the built-in locale and cannot be changed; copy it to customise`); };

  function writeStrings(code, name, strings) {
    db.transaction(() => { stmts.update.run(name, JSON.stringify(strings), code); stmts.touch.run(code); })();
  }

  const service = {
    baseCatalog,
    defaultCode,
    enabledCodes: () => stmts.all.all().filter((r) => r.enabled).map((r) => r.code),
    t(key, fallback, code = defaultCode()) {
      const row = stmts.byCode.get(code);
      const value = row ? stringsOf(row)[key] : undefined;
      return typeof value === 'string' && value !== '' ? value : fallback ?? baseCatalog()[key] ?? key;
    },

    list({ q } = {}) {
      const needle = q?.trim().toLowerCase();
      const rows = stmts.all.all().map((r) => shape(r)).filter((l) => !needle || l.code.includes(needle) || l.name.toLowerCase().includes(needle));
      return { data: rows, meta: { page: 1, pageSize: rows.length, total: rows.length, default: defaultCode(), baseKeys: Object.keys(baseCatalog()).length } };
    },
    get(code) { return shape(load(code), { withStrings: true }); },
    keys() { const base = baseCatalog(); return { count: Object.keys(base).length, strings: base }; },

    // What the browser loads on start: the default locale, or a requested one when it is enabled.
    active({ code } = {}) {
      const def = defaultCode();
      let row = code ? stmts.byCode.get(code) : null;
      if (row && !row.enabled && row.code !== def) row = null;
      row ||= load(def);
      return { code: row.code, name: row.name, default: def, enabled: service.enabledCodes(), strings: stringsOf(row) };
    },

    configure({ default: nextDefault, enabled }, req) {
      const rows = stmts.all.all();
      const known = new Set(rows.map((r) => r.code));
      const def = nextDefault ?? defaultCode();
      if (!known.has(def)) throw unprocessable(`Locale "${def}" does not exist`, { default: ['Pick an installed locale'] });
      const enabledSet = new Set(enabled ?? rows.filter((r) => r.enabled).map((r) => r.code));
      for (const code of enabledSet) if (!known.has(code)) throw unprocessable(`Locale "${code}" does not exist`, { enabled: [`"${code}" is not installed`] });
      enabledSet.add(def);
      db.transaction(() => {
        for (const r of rows) stmts.setEnabled.run(enabledSet.has(r.code) ? 1 : 0, r.code);
        settings.set('locales.default', def);
      })();
      req?.audit?.({ action: 'locales.configure', target: def, args: { default: def, enabled: [...enabledSet] } });
      return service.list();
    },

    copy(from, { code, name }, req) {
      const src = load(from);
      if (stmts.byCode.get(code)) throw conflict(`A locale with code "${code}" already exists`);
      const strings = stringsOf(src);
      db.transaction(() => {
        stmts.insert.run(code, name || `${src.name} (copy)`, JSON.stringify(strings), 0);
        stmts.insertMeta.run(code, src.code, 'copy');
      })();
      req?.audit?.({ action: 'locales.copy', target: code, args: { from: src.code, name, keys: Object.keys(strings).length } });
      return service.get(code);
    },

    remove(code, req) {
      const row = load(code);
      assertEditable(row);
      if (code === defaultCode()) throw conflict(`"${code}" is the default locale; choose another default first (Configure Application Locales)`);
      db.transaction(() => { stmts.removeMeta.run(code); stmts.remove.run(code); })();
      req?.audit?.({ action: 'locales.delete', target: code, args: { name: row.name } });
      return { code, deleted: true };
    },

    update(code, { name, strings }, req) {
      const row = load(code);
      assertEditable(row);
      const next = json.parse(row.strings_json, {});
      let changed = 0;
      let removed = 0;
      for (const [key, value] of Object.entries(strings ?? {})) {
        if (value === null || value === '') { if (key in next) { delete next[key]; removed++; } continue; }
        if (next[key] !== value) { next[key] = value; changed++; }
      }
      writeStrings(code, name ?? row.name, next);
      req?.audit?.({ action: 'locales.update', target: code, args: { name: name ?? row.name, changed, removed, keys: Object.keys(strings ?? {}).slice(0, 50) } });
      return { ...service.get(code), changed, removed };
    },

    exportXml(code) {
      const row = load(code);
      const content = buildLocaleXml({ code: row.code, name: row.name, base: BUILTIN_CODE, strings: stringsOf(row) });
      return { code: row.code, filename: `${row.code}.xml`, contentType: 'application/xml', bytes: Buffer.byteLength(content, 'utf8'), content };
    },

    // mode: create (fail when it exists), merge (overlay), replace (strings become exactly the file).
    importXml({ xml, code: codeOverride, name: nameOverride, mode = 'merge', dryRun = false }, req) {
      const parsed = parseLocaleXml(xml);
      if (!parsed.ok) throw unprocessable('The locale XML is not valid', { xml: parsed.errors.slice(0, 50) });
      const code = codeOverride || parsed.locale.code;
      if (!LOCALE_CODE_RE.test(code)) throw unprocessable(`"${code}" is not a locale code`, { code: ['Use a code like "es" or "pt_br"'] });
      const existing = stmts.byCode.get(code);
      if (existing?.builtin) throw conflict(`"${code}" is the built-in locale and cannot be overwritten; import under another code`);
      if (existing && mode === 'create') throw conflict(`A locale with code "${code}" already exists; choose merge or replace`);
      const base = baseCatalog();
      const current = existing ? json.parse(existing.strings_json, {}) : {};
      const incoming = parsed.locale.strings;
      const next = mode === 'replace' ? { ...incoming } : { ...current, ...incoming };
      const summary = {
        code, name: nameOverride || parsed.locale.name || existing?.name || code, mode, exists: Boolean(existing), dryRun,
        keys: Object.keys(incoming).length,
        added: Object.keys(incoming).filter((k) => !(k in current)).length,
        changed: Object.keys(incoming).filter((k) => k in current && current[k] !== incoming[k]).length,
        removed: mode === 'replace' ? Object.keys(current).filter((k) => !(k in incoming)).length : 0,
        unknownKeys: Object.keys(incoming).filter((k) => !(k in base)).slice(0, 100),
        stats: catalogStats(base, next),
      };
      if (dryRun) return summary;
      db.transaction(() => {
        if (existing) { stmts.update.run(summary.name, JSON.stringify(next), code); stmts.touch.run(code); stmts.insertMeta.run(code, existing.copied_from ?? null, 'import'); }
        else { stmts.insert.run(code, summary.name, JSON.stringify(next), 0); stmts.insertMeta.run(code, null, 'import'); }
      })();
      req?.audit?.({ action: 'locales.import', target: code, args: { mode, keys: summary.keys, added: summary.added, changed: summary.changed, removed: summary.removed, created: !existing } });
      return { ...summary, locale: service.get(code) };
    },

    // The operating system's own locale (LANG and friends) for the View page. Never throws:
    // a host without the glibc locale tools or without the config file reports what is missing.
    async system() {
      const out = { capability: capabilities.has('glibc-locales'), config: null, lang: null, files: SYSTEM_LOCALE_FILES, panelDefault: defaultCode() };
      for (const file of SYSTEM_LOCALE_FILES) {
        try {
          const res = await agent.op('sys.read_file', { path: file, maxBytes: 64 * 1024, tail: false });
          if (typeof res?.content !== 'string') continue;
          const vars = parseSystemLocaleFile(res.content);
          out.config = { path: file, vars };
          out.lang = vars.LC_ALL || vars.LANG || vars.LANGUAGE || null;
          break;
        } catch (err) {
          logger.debug({ err, file }, 'system locale file not readable');
        }
      }
      return out;
    },
  };

  baseCatalog();
  return service;
}
