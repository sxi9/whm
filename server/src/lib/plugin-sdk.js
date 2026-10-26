import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(here, '..', '..', '..');
const nodeRequire = createRequire(import.meta.url);

// Names a plugin wrapper shadows no matter what the context global holds: the
// panel's process object (env, binding, dlopen, exit), its global alias and the
// unscoped fetch. Plugins reach the network through ctx.net.fetch only.
const SHADOWED = ['process', 'global', 'fetch'];

// plugins/sdk is CommonJS inside an ESM workspace, so it cannot be require()d
// directly; this evaluates a file with the CommonJS wrapper. Relative specifiers
// resolve to sibling files; `resolve(spec, fromFile)` decides everything else
// (default: Node's own require), which is how the plugin host sandboxes `require`.
// With `context` (a vm context from createPluginContext) the code is compiled in
// that context: its globals are the sandbox's, not the panel's.
export function loadCommonJs(file, cache = new Map(), { resolve, context } = {}) {
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
      return loadCommonJs(target, cache, { resolve, context });
    }
    if (resolve) return resolve(spec, resolved, null);
    return nodeRequire(spec);
  };
  const source = fs.readFileSync(resolved, 'utf8');
  const params = ['exports', 'require', 'module', '__filename', '__dirname'];
  const options = { filename: resolved };
  if (context) { params.push(...SHADOWED); options.parsingContext = context; }
  const wrapper = vm.compileFunction(source, params, options);
  wrapper(module.exports, localRequire, module, resolved, path.dirname(resolved));
  return module.exports;
}

// A vm context for plugin code: ECMAScript intrinsics plus the few host globals a
// CommonJS module reasonably expects. No process, no fetch, no eval/Function from
// strings. The host objects handed over (Buffer, timers, URL, ...) are the panel's
// own, so this is a convenience barrier, not a security boundary (see
// docs/design/plugin-host.md "Trust model").
export function createPluginContext({ console: pluginConsole } = {}) {
  const sandbox = {
    Buffer, URL, URLSearchParams, TextEncoder, TextDecoder, AbortController, AbortSignal,
    setTimeout, clearTimeout, setInterval, clearInterval, setImmediate, clearImmediate, queueMicrotask,
    structuredClone, atob, btoa, performance,
    console: pluginConsole || Object.freeze({ log() {}, info() {}, warn() {}, error() {}, debug() {} }),
  };
  const context = vm.createContext(sandbox, { codeGeneration: { strings: false, wasm: false } });
  return context;
}

// Freezes an exports object, every function in it and each function's prototype,
// so one plugin cannot patch what the host and the other plugins share.
export function freezeExports(obj, seen = new Set()) {
  if (obj === null || (typeof obj !== 'object' && typeof obj !== 'function') || seen.has(obj)) return obj;
  seen.add(obj);
  if (ArrayBuffer.isView(obj)) return obj;
  if (typeof obj === 'function' && obj.prototype && typeof obj.prototype === 'object') freezeExports(obj.prototype, seen);
  for (const key of Object.getOwnPropertyNames(obj)) {
    if (key === 'caller' || key === 'arguments' || key === 'callee') continue;
    const d = Object.getOwnPropertyDescriptor(obj, key);
    if (d && 'value' in d) freezeExports(d.value, seen);
  }
  return Object.freeze(obj);
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
