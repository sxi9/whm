import { z } from 'zod';
import { exec, hasBinary } from '../exec.js';
import { defineOp, OpError } from './registry.js';

// Post-install steps for the stack installer (server/src/lib/stack-catalog.js).
// Module names are checked against a2enmod's own naming before they become an
// argument; the RHEL family loads modules from conf.modules.d, so there the op
// reports skipped instead of failing.
const moduleName = z.string().regex(/^[a-z][a-z0-9_]{0,39}$/);

defineOp('stack.apache_enmod', {
  description: 'Enable Apache modules with a2enmod (Debian family), validate the configuration and reload Apache when something changed',
  timeoutMs: 180_000,
  schema: z.object({ modules: z.array(moduleName).min(1).max(20) }).strict(),
  run: async ({ modules }) => {
    if (!hasBinary('a2enmod') || !hasBinary('a2query')) return { skipped: true, reason: 'a2enmod is not available on this host (Apache modules load from conf.modules.d on the RHEL family)', enabled: [], alreadyEnabled: [], failed: [], reloaded: false };
    const enabled = []; const alreadyEnabled = []; const failed = [];
    for (const m of modules) {
      const query = await exec('a2query', ['-q', '-m', m], { allowFailure: true });
      if (query.code === 0) { alreadyEnabled.push(m); continue; }
      const r = await exec('a2enmod', ['-q', m], { allowFailure: true, timeoutMs: 60_000 });
      if (r.code === 0) enabled.push(m);
      else failed.push({ module: m, error: (r.stderr || r.stdout).trim().split('\n').pop() || `a2enmod exited with status ${r.code}` });
    }
    let reloaded = false;
    if (enabled.length) {
      const ctl = hasBinary('apache2ctl') ? 'apache2ctl' : hasBinary('apachectl') ? 'apachectl' : null;
      if (ctl) {
        const test = await exec(ctl, ['-t'], { allowFailure: true });
        if (test.code !== 0) throw new OpError('config_invalid', `Apache rejected the configuration after enabling ${enabled.join(', ')}: ${test.stderr.trim().split('\n').pop() || 'configtest failed'}`, { enabled });
      }
      if (hasBinary('systemctl')) {
        const active = await exec('systemctl', ['is-active', '--quiet', 'apache2.service'], { allowFailure: true });
        if (active.code === 0) { await exec('systemctl', ['reload', 'apache2.service'], { allowFailure: true, timeoutMs: 60_000 }); reloaded = true; }
      }
    }
    return { skipped: false, enabled, alreadyEnabled, failed, reloaded };
  },
});
