export { catalog, OpError, defineOp, listOps, runOp, arg } from './registry.js';

// Importing a family registers its ops in the catalog as a side effect. The
// registry lives in its own module so that these imports never observe it half
// initialised (ES module imports are hoisted and evaluated before this body).
import './sys.js';
import './svc.js';
import './user.js';
import './fs.js';
