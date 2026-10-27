import fs from 'node:fs';
import path from 'node:path';
import { json } from '../db/index.js';
import { notFound, conflict, unprocessable, forbidden } from '../lib/errors.js';
import { isRoot } from '../middleware/rbac.js';

// Themes. Attached as ctx.themes; other categories may call:
//   themes.defaultSlug()                 -> theme the panel shows when a user has no override
//   themes.accountDefault()              -> theme recorded for new hosting accounts when their package's theme is disabled/missing
//   themes.resolve(slug)                 -> { slug, name, base, variables, css } or null
//   themes.resolveForPackage(pkg)        -> slug for a package row ({ theme }) falling back to the account default;
//                                           core's packages.snapshot() records this in new accounts (integration-contracts §22)
//   themes.slugs()                       -> every enabled theme slug
//   themes.isEnabledSlug(slug)           -> true when slug names an enabled theme (packages.theme validation)
//   themes.activeFor(user)               -> what the browser applies for that user
// Uploaded CSS overrides live under $WHM_DATA_DIR/themes/<slug>.css.
// `tweak.login_theme` (Tweak Settings) predates this table and is not consulted: the login
// screen paints the last active theme cached in the browser. It is kept only as a legacy key.

export const SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
// Route segments under /api/themes that would shadow a theme record of the same name.
export const RESERVED_SLUGS = new Set(['active', 'variables', 'packages', 'preference', 'config']);
export const BASES = ['light', 'dark'];
export const MAX_CSS_BYTES = 256 * 1024;

// The design tokens a theme may override (names without the leading "--").
const color = (label, group) => ({ kind: 'color', label, group });
const length = (label, group) => ({ kind: 'length', label, group });
export const VARIABLE_CATALOG = {
  bg: color('Page background', 'Workspace'),
  surface: color('Card surface', 'Workspace'),
  'surface-2': color('Secondary surface', 'Workspace'),
  border: color('Border', 'Workspace'),
  'border-strong': color('Strong border', 'Workspace'),
  text: color('Text', 'Workspace'),
  'text-muted': color('Muted text', 'Workspace'),
  'text-faint': color('Faint text', 'Workspace'),
  chrome: color('Chrome background', 'Chrome'),
  'chrome-2': color('Chrome secondary', 'Chrome'),
  'chrome-text': color('Chrome text', 'Chrome'),
  'chrome-muted': color('Chrome muted text', 'Chrome'),
  'chrome-hover': color('Chrome hover', 'Chrome'),
  'chrome-active': color('Chrome active item', 'Chrome'),
  primary: color('Primary', 'Brand'),
  'primary-hover': color('Primary hover', 'Brand'),
  'primary-text': color('Text on primary', 'Brand'),
  'primary-soft': color('Primary tint', 'Brand'),
  ok: color('Success', 'Status'),
  'ok-soft': color('Success tint', 'Status'),
  warn: color('Warning', 'Status'),
  'warn-soft': color('Warning tint', 'Status'),
  bad: color('Error', 'Status'),
  'bad-soft': color('Error tint', 'Status'),
  info: color('Info', 'Status'),
  'info-soft': color('Info tint', 'Status'),
  radius: length('Corner radius', 'Shape'),
  'radius-lg': length('Large corner radius', 'Shape'),
  'sidebar-w': length('Sidebar width', 'Shape'),
};

const COLOR_RE = /^(#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})|rgba?\(\s*[\d.]+%?(?:\s*[,/ ]\s*[\d.]+%?){2,3}\s*\)|hsla?\(\s*[\d.]+(?:deg)?(?:\s*[,/ ]\s*[\d.]+%?){2,3}\s*\)|[a-z]{3,20}|transparent)$/i;
const LENGTH_RE = /^\d{1,3}(?:\.\d{1,2})?px$/;

// Returns { ok, variables, errors } where variables only contains catalog keys with
// normalised values; "" or null removes a key.
export function validateVariables(input) {
  const errors = {};
  const variables = {};
  for (const [key, raw] of Object.entries(input ?? {})) {
    const def = VARIABLE_CATALOG[key];
    if (!def) { errors[key] = ['Unknown design token']; continue; }
    if (raw === null || raw === '') continue;
    const value = String(raw).trim();
    const ok = def.kind === 'color' ? COLOR_RE.test(value) : LENGTH_RE.test(value);
    if (!ok) { errors[key] = [def.kind === 'color' ? 'Use a hex, rgb(), hsl() or named colour' : 'Use a pixel length like "6px"']; continue; }
    variables[key] = value;
  }
  return { ok: Object.keys(errors).length === 0, variables, errors };
}

// Author-supplied CSS is served inside the panel for every viewer, so anything that
// could pull remote resources or run script is refused rather than silently stripped.
const CSS_FORBIDDEN = [
  [/@import\b/i, '@import is not allowed'],
  [/@charset\b/i, '@charset is not allowed'],
  [/@namespace\b/i, '@namespace is not allowed'],
  [/expression\s*\(/i, 'expression() is not allowed'],
  [/-moz-binding\b/i, '-moz-binding is not allowed'],
  [/behavior\s*:/i, 'behavior: is not allowed'],
  [/javascript\s*:/i, 'javascript: URLs are not allowed'],
  [/<\s*\/?\s*(script|style|iframe|object|embed)\b/i, 'HTML tags are not allowed'],
];
// Fetchable targets: protocol-relative, any hierarchical scheme, or an opaque scheme a
// browser resolves without "//". Relative paths and inline images are the only allowed forms.
const REMOTE_TARGET_RE = /^(?:\/\/|[a-z][a-z0-9+.-]*:\/\/|(?:data|javascript|vbscript|blob|filesystem|about):)/i;
const isRemoteTarget = (target) => REMOTE_TARGET_RE.test(target) && !/^data:image\//i.test(target);

// CSS Syntax §4.3.7: "\" + 1-6 hex digits (+ one optional whitespace) is a code point,
// "\" + newline inside a string is a continuation, "\" + anything else is that character.
// Browsers decode these before matching keywords and schemes, so the checks below run on
// the decoded text as well as the literal one.
export function decodeCssEscapes(text) {
  return text.replace(/\\(?:([0-9a-f]{1,6})(?:\r\n|[ \t\n\f\r])?|(\r\n|[\n\f\r])|([\s\S]))/gi, (_m, hex, newline, ch) => {
    if (hex) {
      const cp = parseInt(hex, 16);
      return cp === 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff) ? '�' : String.fromCodePoint(cp);
    }
    return newline ? '' : ch;
  });
}

function checkCssText(text, errors) {
  const seen = new Set(errors);
  const push = (message) => { if (!seen.has(message)) { seen.add(message); errors.push(message); } };
  for (const [re, message] of CSS_FORBIDDEN) if (re.test(text)) push(message);
  for (const m of text.matchAll(/url\(\s*['"]?\s*([^'")]*)/gi)) {
    if (isRemoteTarget(m[1].trim())) { push('url() may only reference relative paths or data:image resources'); break; }
  }
  // image-set("…"), src("…"), @import "…" and custom-property fallbacks all fetch a bare
  // string, so a quoted remote reference is refused wherever it appears.
  for (const m of text.matchAll(/(["'])\s*([^"'\n]*)/g)) {
    if (isRemoteTarget(m[2].trim())) { push('Quoted strings may not reference remote resources'); break; }
  }
}

export function sanitizeCss(css) {
  const errors = [];
  const text = String(css ?? '');
  if (Buffer.byteLength(text, 'utf8') > MAX_CSS_BYTES) errors.push(`CSS exceeds ${MAX_CSS_BYTES / 1024} KB`);
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(text)) errors.push('CSS contains control characters');
  const decoded = decodeCssEscapes(text);
  checkCssText(text, errors);
  if (decoded !== text) checkCssText(decoded, errors);
  let depth = 0;
  for (const ch of text) { if (ch === '{') depth++; else if (ch === '}') depth--; if (depth < 0) break; }
  if (depth !== 0) errors.push('Unbalanced braces');
  return { ok: errors.length === 0, errors, bytes: Buffer.byteLength(text, 'utf8') };
}

export function createThemesService(ctx) {
  const { db, settings, config, logger } = ctx;
  const cssDir = path.join(config.dataDir, 'themes');

  const stmts = {
    all: db.prepare('SELECT * FROM themes ORDER BY builtin DESC, name'),
    bySlug: db.prepare('SELECT * FROM themes WHERE slug = ?'),
    insert: db.prepare('INSERT INTO themes (slug, name, base, builtin, copied_from, variables_json, enabled) VALUES (?, ?, ?, 0, ?, ?, 1)'),
    update: db.prepare(`UPDATE themes SET name = ?, base = ?, variables_json = ?, enabled = ?, updated_at = datetime('now') WHERE slug = ?`),
    setCss: db.prepare(`UPDATE themes SET css_file = ?, css_bytes = ?, updated_at = datetime('now') WHERE slug = ?`),
    remove: db.prepare('DELETE FROM themes WHERE slug = ?'),
    prefOf: db.prepare('SELECT theme FROM theme_user_prefs WHERE user_id = ?'),
    prefCount: db.prepare('SELECT COUNT(*) AS n FROM theme_user_prefs WHERE theme = ?'),
    setPref: db.prepare(`INSERT INTO theme_user_prefs (user_id, theme, updated_at) VALUES (?, ?, datetime('now')) ON CONFLICT (user_id) DO UPDATE SET theme = excluded.theme, updated_at = excluded.updated_at`),
    clearPref: db.prepare('DELETE FROM theme_user_prefs WHERE user_id = ?'),
    clearPrefsFor: db.prepare('DELETE FROM theme_user_prefs WHERE theme = ?'),
    packagesUsing: db.prepare('SELECT COUNT(*) AS n FROM packages WHERE theme = ?'),
    packageList: db.prepare('SELECT p.id, p.name, p.owner_id, p.theme, (SELECT COUNT(*) FROM accounts a WHERE a.package_id = p.id) AS accounts FROM packages p ORDER BY p.name'),
    accountsUsing: db.prepare(`SELECT COUNT(*) AS n FROM accounts WHERE json_extract(plan_snapshot_json, '$.theme') = ?`),
  };

  const settingSlug = (key, fallback) => { const v = settings.get(key, fallback); return typeof v === 'string' && stmts.bySlug.get(v) ? v : fallback; };
  const defaultSlug = () => settingSlug('themes.default', 'jupiter');
  const accountDefault = () => settingSlug('themes.account_default', 'jupiter');
  const allowUserOverride = () => settings.get('themes.allow_user_override', true) !== false;

  const cssPath = (row) => (row.css_file ? path.join(cssDir, path.basename(row.css_file)) : null);
  function readCss(row) {
    const file = cssPath(row);
    if (!file) return '';
    try { return fs.readFileSync(file, 'utf8'); } catch (err) {
      logger.warn({ err, theme: row.slug, file }, 'theme CSS override unreadable');
      return '';
    }
  }

  // The stock built-in theme keeps the pre-themes behaviour of following the OS colour scheme;
  // every other theme pins its base.
  const schemeOf = (row) => (row.builtin && row.slug === 'jupiter' ? 'auto' : row.base);

  function shape(row, { withCss = false } = {}) {
    const out = {
      slug: row.slug, name: row.name, base: row.base, scheme: schemeOf(row), builtin: Boolean(row.builtin), enabled: Boolean(row.enabled),
      copiedFrom: row.copied_from ?? null, variables: json.parse(row.variables_json, {}),
      hasCss: Boolean(row.css_file), cssBytes: row.css_bytes ?? 0,
      isDefault: row.slug === defaultSlug(), isAccountDefault: row.slug === accountDefault(),
      usage: { packages: stmts.packagesUsing.get(row.slug).n, accounts: stmts.accountsUsing.get(row.slug).n, users: stmts.prefCount.get(row.slug).n },
      createdAt: row.created_at, updatedAt: row.updated_at,
    };
    if (withCss) out.css = readCss(row);
    return out;
  }

  const load = (slug) => { const row = stmts.bySlug.get(slug); if (!row) throw notFound(`Theme "${slug}"`); return row; };
  const assertEditable = (row) => { if (row.builtin) throw conflict(`"${row.slug}" is a built-in theme and cannot be changed; copy it to customise`); };

  const meta = () => ({ default: defaultSlug(), accountDefault: accountDefault(), allowUserOverride: allowUserOverride() });

  const service = {
    defaultSlug,
    accountDefault,
    allowUserOverride,
    slugs: () => stmts.all.all().filter((r) => r.enabled).map((r) => r.slug),
    isEnabledSlug: (slug) => typeof slug === 'string' && Boolean(stmts.bySlug.get(slug)?.enabled),
    catalog: () => VARIABLE_CATALOG,
    resolve(slug) {
      const row = slug ? stmts.bySlug.get(slug) : null;
      if (!row) return null;
      return { slug: row.slug, name: row.name, base: row.base, scheme: schemeOf(row), variables: json.parse(row.variables_json, {}), css: readCss(row) };
    },
    resolveForPackage(pkg) {
      const slug = pkg?.theme;
      const row = slug ? stmts.bySlug.get(slug) : null;
      return row?.enabled ? row.slug : accountDefault();
    },

    list({ q } = {}) {
      const needle = q?.trim().toLowerCase();
      const rows = stmts.all.all().map((r) => shape(r)).filter((t) => !needle || t.slug.includes(needle) || t.name.toLowerCase().includes(needle));
      return { data: rows, meta: { page: 1, pageSize: rows.length, total: rows.length, ...meta(), variables: VARIABLE_CATALOG } };
    },
    get(slug) { return shape(load(slug), { withCss: true }); },

    // What the browser applies on load: the user's own choice when overrides are allowed, else the
    // default. `preference` is only the stored choice when it is what gets applied; a stored choice
    // that is ignored (overrides disabled, theme disabled) is reported as `ignoredPreference`.
    activeFor(user) {
      const pref = user?.id ? stmts.prefOf.get(user.id)?.theme ?? null : null;
      let row = null;
      let source = 'default';
      if (pref && (isRoot(user) || allowUserOverride())) {
        const candidate = stmts.bySlug.get(pref);
        if (candidate?.enabled) { row = candidate; source = 'user'; }
      }
      row ||= stmts.bySlug.get(defaultSlug()) ?? stmts.bySlug.get('jupiter') ?? stmts.all.all()[0];
      if (!row) throw notFound('Theme');
      const applied = source === 'user';
      return { slug: row.slug, name: row.name, base: row.base, scheme: schemeOf(row), variables: json.parse(row.variables_json, {}), css: readCss(row), source, preference: applied ? pref : null, ignoredPreference: !applied && pref ? pref : null, ...meta() };
    },

    create({ slug, name, base, variables, copyFrom }, req) {
      if (RESERVED_SLUGS.has(slug)) throw unprocessable(`"${slug}" is reserved`, { slug: ['Pick another slug'] });
      if (stmts.bySlug.get(slug)) throw conflict(`A theme with slug "${slug}" already exists`);
      const src = copyFrom ? load(copyFrom) : null;
      const vars = validateVariables({ ...(src ? json.parse(src.variables_json, {}) : {}), ...(variables ?? {}) });
      if (!vars.ok) throw unprocessable('Some design tokens are invalid', vars.errors);
      const resolvedBase = base ?? src?.base ?? 'light';
      let cssBytes = 0;
      db.transaction(() => {
        stmts.insert.run(slug, name || (src ? `${src.name} (copy)` : slug), resolvedBase, src?.slug ?? null, JSON.stringify(vars.variables));
        if (src?.css_file) {
          const css = readCss(src);
          if (css) { writeCssFile(slug, css); cssBytes = Buffer.byteLength(css, 'utf8'); stmts.setCss.run(`${slug}.css`, cssBytes, slug); }
        }
      })();
      req?.audit?.({ action: 'themes.create', target: slug, args: { name, base: resolvedBase, copyFrom: src?.slug ?? null, variables: Object.keys(vars.variables).length, cssBytes } });
      return service.get(slug);
    },

    update(slug, { name, base, variables, enabled }, req) {
      const row = load(slug);
      assertEditable(row);
      const vars = variables === undefined ? { ok: true, variables: json.parse(row.variables_json, {}) } : validateVariables(variables);
      if (!vars.ok) throw unprocessable('Some design tokens are invalid', vars.errors);
      const nextEnabled = enabled ?? Boolean(row.enabled);
      if (!nextEnabled && (slug === defaultSlug() || slug === accountDefault())) throw conflict(`"${slug}" is a default theme and cannot be disabled; choose another default first`);
      db.transaction(() => {
        stmts.update.run(name ?? row.name, base ?? row.base, JSON.stringify(vars.variables), nextEnabled ? 1 : 0, slug);
        if (!nextEnabled) stmts.clearPrefsFor.run(slug);
      })();
      req?.audit?.({ action: 'themes.update', target: slug, args: { name: name ?? row.name, base: base ?? row.base, enabled: nextEnabled, variables: Object.keys(vars.variables) } });
      return service.get(slug);
    },

    setCss(slug, css, req) {
      const row = load(slug);
      assertEditable(row);
      const check = sanitizeCss(css);
      if (!check.ok) throw unprocessable('The CSS override was rejected', { css: check.errors });
      writeCssFile(slug, css);
      stmts.setCss.run(`${slug}.css`, check.bytes, slug);
      req?.audit?.({ action: 'themes.css.upload', target: slug, args: { bytes: check.bytes } });
      return service.get(slug);
    },

    clearCss(slug, req) {
      const row = load(slug);
      assertEditable(row);
      removeCssFile(row);
      stmts.setCss.run(null, 0, slug);
      req?.audit?.({ action: 'themes.css.remove', target: slug });
      return service.get(slug);
    },

    remove(slug, req) {
      const row = load(slug);
      assertEditable(row);
      if (slug === defaultSlug() || slug === accountDefault()) throw conflict(`"${slug}" is a default theme; choose another default first`);
      const packages = stmts.packagesUsing.get(slug).n;
      if (packages > 0) throw conflict(`"${slug}" is assigned to ${packages} package(s); reassign them first`);
      db.transaction(() => { stmts.clearPrefsFor.run(slug); stmts.remove.run(slug); })();
      removeCssFile(row);
      req?.audit?.({ action: 'themes.delete', target: slug, args: { name: row.name } });
      return { slug, deleted: true };
    },

    configure({ default: nextDefault, accountDefault: nextAccountDefault, allowUserOverride: nextAllow }, req) {
      const values = {};
      for (const [key, slug] of [['themes.default', nextDefault], ['themes.account_default', nextAccountDefault]]) {
        if (slug === undefined) continue;
        const row = stmts.bySlug.get(slug);
        if (!row) throw unprocessable(`Theme "${slug}" does not exist`, { [key === 'themes.default' ? 'default' : 'accountDefault']: ['Pick an installed theme'] });
        if (!row.enabled) throw unprocessable(`Theme "${slug}" is disabled`, { [key === 'themes.default' ? 'default' : 'accountDefault']: ['Enable the theme first'] });
        values[key] = slug;
      }
      if (nextAllow !== undefined) values['themes.allow_user_override'] = Boolean(nextAllow);
      settings.setMany(values);
      req?.audit?.({ action: 'themes.configure', target: values['themes.default'] ?? defaultSlug(), args: values });
      return meta();
    },

    setPreference(user, slug, req) {
      if (!user?.id) throw forbidden();
      if (slug === null) {
        stmts.clearPref.run(user.id);
      } else {
        if (!isRoot(user) && !allowUserOverride()) throw forbidden('The administrator has disabled per-user theme overrides');
        const row = load(slug);
        if (!row.enabled) throw unprocessable(`Theme "${slug}" is disabled`, { theme: ['Pick an enabled theme'] });
        stmts.setPref.run(user.id, slug);
      }
      req?.audit?.({ action: 'themes.preference', target: user.username, args: { theme: slug } });
      return service.activeFor(user);
    },

    packages(user) {
      const rows = stmts.packageList.all().filter((p) => isRoot(user) || p.owner_id == null || p.owner_id === user.id);
      const known = new Set(stmts.all.all().map((r) => r.slug));
      return rows.map((p) => ({ id: p.id, name: p.name, theme: p.theme, accounts: p.accounts, themeKnown: known.has(p.theme), effective: service.resolveForPackage(p), owned: isRoot(user) || p.owner_id === user.id }));
    },

    // Resellers see root's shared packages but may only retheme the ones they own: a shared
    // package's theme lands in every account any reseller creates from it.
    assignPackage(name, slug, user, req) {
      const row = load(slug);
      if (!row.enabled) throw unprocessable(`Theme "${slug}" is disabled`, { theme: ['Pick an enabled theme'] });
      if (!ctx.packages) throw notFound('Package');
      const current = ctx.packages.get(name, user);
      if (!isRoot(user) && current.owner_id !== user.id) throw forbidden('Only the owner of a package can change its theme');
      const pkg = ctx.packages.update(name, { theme: slug }, user);
      req?.audit?.({ action: 'themes.package', target: name, args: { theme: slug } });
      return { name: pkg.name, theme: pkg.theme, accounts: pkg.accounts };
    },
  };

  function writeCssFile(slug, css) {
    fs.mkdirSync(cssDir, { recursive: true, mode: 0o750 });
    fs.writeFileSync(path.join(cssDir, `${slug}.css`), css, { encoding: 'utf8', mode: 0o640 });
  }
  function removeCssFile(row) {
    const file = cssPath(row);
    if (file) fs.rmSync(file, { force: true });
  }

  return service;
}
