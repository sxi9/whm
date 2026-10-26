import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(here, '..', '..', '..');
const nodeRequire = createRequire(import.meta.url);

// plugins/sdk is CommonJS inside an ESM workspace, so it cannot be require()d
// directly; this evaluates a file with the CommonJS wrapper. Relative specifiers
// resolve to sibling files; `resolve(spec, fromFile)` decides everything else
// (default: Node's own require), which is how the plugin host sandboxes `require`.
export function loadCommonJs(file, cache = new Map(), { resolve } = {}) {
  const resolved = path.resolve(file);
  if (cache.has(resolved)) return cache.get(resolved).exports;
  const module = { exports: {} };
  cache.set(resolved, module);
  const localRequire = (spec) => {
    if (typeof spec !== 'string') throw new TypeError('require() expects a string');
    if (spec.startsWith('./') || spec.startsWith('../')) {
      let target = path.resolve(path.dirname(resolved), spec);
      if (!fs.existsSync(target) && fs.existsSync(`${target}.js`)) target = `${target}.js`;
      else if (fs.existsSync(target) && fs.statSync(target).isDirectory()) target = path.join(target, 'index.js');
      if (resolve) {
        const external = resolve(spec, resolved, target);
        if (external !== undefined) return external;
      }
      return loadCommonJs(target, cache, { resolve });
    }
    if (resolve) return resolve(spec, resolved, null);
    return nodeRequire(spec);
  };
  const source = fs.readFileSync(resolved, 'utf8');
  const wrapper = vm.compileFunction(source, ['exports', 'require', 'module', '__filename', '__dirname'], { filename: resolved });
  wrapper(module.exports, localRequire, module, resolved, path.dirname(resolved));
  return module.exports;
}

// Loads the bundled SDK once per call site. Returns null when the SDK is not
// shipped with this install (the panel must keep working without it).
export function loadPluginSdk(root = REPO_ROOT) {
  const dir = path.join(root, 'plugins', 'sdk');
  if (!fs.existsSync(path.join(dir, 'validate-manifest.js'))) return null;
  try {
    const cache = new Map();
    const validate = loadCommonJs(path.join(dir, 'validate-manifest.js'), cache);
    const errors = loadCommonJs(path.join(dir, 'errors.js'), cache);
    const semver = loadCommonJs(path.join(dir, 'semver.js'), cache);
    const cron = loadCommonJs(path.join(dir, 'cron.js'), cache);
    let index = null;
    try { index = loadCommonJs(path.join(dir, 'index.js'), cache); } catch { index = null; }
    const version = index?.SDK_VERSION || null;
    return { validate, errors, semver, cron, path: dir, version, index, loadCommonJs };
  } catch {
    return null;
  }
}
