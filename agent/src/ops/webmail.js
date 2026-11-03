import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { defineOp } from './registry.js';

// Read-only probe for a webmail client installed from the distribution. Only
// fixed paths are stat'ed; a client's own configuration (database password,
// DES key) is never opened — its presence is all the panel needs to know.

export const WEBMAIL_CANDIDATES = [
  { flavor: 'roundcube', path: '/usr/share/roundcube', config: '/etc/roundcube/config.inc.php' },
  { flavor: 'roundcube', path: '/var/lib/roundcube', config: '/etc/roundcube/config.inc.php' },
  { flavor: 'roundcube', path: '/usr/share/nginx/html/roundcube', config: null },
  { flavor: 'roundcube', path: '/var/www/roundcube', config: null },
  { flavor: 'rainloop', path: '/usr/share/rainloop', config: null },
  { flavor: 'snappymail', path: '/usr/share/snappymail', config: null },
];

// Web-server fragments that commonly publish the client under an alias.
const ALIAS_FILES = [
  '/etc/apache2/conf-enabled/roundcube.conf', '/etc/apache2/conf-available/roundcube.conf', '/etc/apache2/conf.d/roundcube.conf',
  '/etc/httpd/conf.d/roundcubemail.conf', '/etc/httpd/conf.d/roundcube.conf',
  '/etc/apache2/conf-enabled/rainloop.conf', '/etc/apache2/conf-enabled/snappymail.conf',
];
const MAX_READ = 256 * 1024;

function isDir(p) { try { return fs.statSync(p).isDirectory(); } catch { return false; } }
function isFile(p) { try { return fs.statSync(p).isFile(); } catch { return false; } }

function readHead(file, max = MAX_READ) {
  let fd = null;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const st = fs.fstatSync(fd);
    if (!st.isFile()) return null;
    const buf = Buffer.alloc(Math.min(st.size, max));
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    return buf.subarray(0, n).toString('utf8');
  } catch { return null; } finally { if (fd != null) fs.closeSync(fd); }
}

export function roundcubeVersion(text) {
  const m = String(text || '').match(/RCMAIL_VERSION'\s*,\s*'([0-9][0-9A-Za-z.-]{0,30})'/) || String(text || '').match(/\bVersion\s+([0-9]+\.[0-9]+(?:\.[0-9]+)?)/);
  return m ? m[1] : null;
}

function versionedDirs(base) {
  try { return fs.readdirSync(path.join(base, 'v')).filter((d) => /^[0-9][0-9A-Za-z.-]{0,30}$/.test(d)).sort().pop() || null; } catch { return null; }
}

export function detectVersion(flavor, root) {
  if (flavor === 'roundcube') return roundcubeVersion(readHead(path.join(root, 'program', 'include', 'iniset.php'), 64 * 1024)) || roundcubeVersion(readHead(path.join(root, 'index.php'), 16 * 1024));
  return versionedDirs(path.join(root, flavor)) || versionedDirs(root);
}

// "Alias /roundcube /usr/share/roundcube" → "/roundcube" when the target is the
// detected install root.
export function aliasFor(text, root) {
  for (const raw of String(text || '').split('\n')) {
    const m = raw.trim().match(/^Alias\s+(\/[A-Za-z0-9._-]*)\s+"?([^\s"]+)"?\s*$/i);
    if (m && path.resolve(m[2]) === path.resolve(root)) return m[1];
  }
  return null;
}

defineOp('web.webmail.detect', {
  description: 'Detect a distribution-installed webmail client (Roundcube, RainLoop, SnappyMail): flavor, path, version and the web-server alias it is published under',
  schema: z.object({}).strict(),
  run: async (_args, ctx) => {
    const hit = WEBMAIL_CANDIDATES.find((c) => isDir(c.path));
    if (!hit) return { installed: false, flavor: null, path: null, version: null, configured: null, apacheAlias: null };
    let apacheAlias = null;
    for (const file of ALIAS_FILES) {
      try { ctx.assertAllowedPath(file, 'read'); } catch { continue; }
      if (!isFile(file)) continue;
      apacheAlias = aliasFor(readHead(file), hit.path);
      if (apacheAlias) break;
    }
    return {
      installed: true,
      flavor: hit.flavor,
      path: hit.path,
      version: detectVersion(hit.flavor, hit.path),
      configured: hit.config ? isFile(hit.config) : null,
      apacheAlias,
    };
  },
});
