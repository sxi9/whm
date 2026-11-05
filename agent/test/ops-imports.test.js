import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const opsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'ops');

// ops/index.js awaits every op module at top level and lib.js imports ops/index.js:
// an op module that imports lib.js (directly or through exec/registry) deadlocks the
// agent at start (Node exits 13 "unsettled top-level await"). Shared constants live
// in src/managed-paths.js, which imports nothing.
describe('op modules never import lib.js', () => {
  it('no file under src/ops imports ../lib.js', () => {
    const offenders = fs.readdirSync(opsDir).filter((f) => f.endsWith('.js')).filter((f) => /from\s+['"]\.\.\/lib\.js['"]/.test(fs.readFileSync(path.join(opsDir, f), 'utf8')));
    expect(offenders).toEqual([]);
  });
  it('managed-paths.js has no imports', () => {
    const src = fs.readFileSync(path.join(opsDir, '..', 'managed-paths.js'), 'utf8');
    expect(/^\s*import\s/m.test(src)).toBe(false);
  });
});
