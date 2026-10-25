import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export { catalog, OpError, defineOp, listOps, runOp, arg } from './registry.js';

// Every other file in this directory is an op family (sys.js, svc.js, user.js,
// fs.js, dns.js, ...). Importing one registers its ops in the catalog as a side
// effect, so adding a family is just adding a file. The registry lives in its own
// module so families never observe it half-initialised.
const dir = path.dirname(fileURLToPath(import.meta.url));
const families = fs.readdirSync(dir).filter((f) => f.endsWith('.js') && !['index.js', 'registry.js'].includes(f)).sort();
await Promise.all(families.map((f) => import(pathToFileURL(path.join(dir, f)).href)));
