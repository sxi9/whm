import fs from 'node:fs';
import zlib from 'node:zlib';
import { z } from 'zod';
import { exec, hasBinary } from '../exec.js';
import { defineOp } from './registry.js';
import { discoverPhp } from './pkg.js';

// Debian/Ubuntu and RHEL ship security fixes as patches to the packaged
// upstream release without bumping PHP_VERSION, so the Security Advisor's
// version matcher needs the package changelog to tell a backported fix from an
// unpatched build. The package name is derived here from the discovered PHP
// layout (never from the caller), only the distro layouts are consulted, and
// the other layouts answer `checked: false` so the version verdict stands.

const MAX_CHANGELOG = 32 * 1024 * 1024;
const phpVersionId = z.string().regex(/^[a-z0-9][a-z0-9.-]{0,31}$/, 'PHP version id');
const advisoryId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$/, 'advisory id');

export function changelogMentions(text, ids) {
  const hay = String(text || '');
  return ids.filter((id) => hay.includes(id));
}

export function debianChangelogPaths(packagePrefix) {
  return ['fpm', 'common', 'cli'].map((suffix) => ({ name: `${packagePrefix}${suffix}`, file: `/usr/share/doc/${packagePrefix}${suffix}/changelog.Debian.gz` }));
}

defineOp('pkg.php.backports', {
  description: 'Whether the distribution package of an installed PHP version records fixes for the given advisory ids in its changelog (read-only)',
  timeoutMs: 60_000,
  schema: z.object({ version: phpVersionId, ids: z.array(advisoryId).min(1).max(50) }).strict(),
  run: async ({ version, ids }) => {
    const v = discoverPhp().versions.find((x) => x.id === version);
    const base = { version, package: v ? `${v.packagePrefix}fpm` : null, layout: v?.layout ?? null, checked: false, installed: null, source: null, mentioned: [] };
    if (!v) return base;
    if (v.layout === 'debian') {
      for (const { name, file } of debianChangelogPaths(v.packagePrefix)) {
        if (!fs.existsSync(file)) continue;
        let text;
        try { text = zlib.gunzipSync(fs.readFileSync(file), { maxOutputLength: MAX_CHANGELOG }).toString('utf8'); } catch { continue; }
        let installed = null;
        if (hasBinary('dpkg-query')) {
          const r = await exec('dpkg-query', ['-W', '-f=${Version}', '--', name], { allowFailure: true, timeoutMs: 30_000 });
          if (r.code === 0) installed = r.stdout.trim() || null;
        }
        return { ...base, package: name, checked: true, installed, source: file, mentioned: changelogMentions(text, ids) };
      }
      return base;
    }
    if (v.layout === 'rhel' && hasBinary('rpm')) {
      const pkg = `${v.packagePrefix}fpm`;
      const r = await exec('rpm', ['-q', '--changelog', '--', pkg], { allowFailure: true, timeoutMs: 30_000, maxBuffer: MAX_CHANGELOG });
      if (r.code !== 0) return base;
      const i = await exec('rpm', ['-q', '--qf', '%{VERSION}-%{RELEASE}', '--', pkg], { allowFailure: true, timeoutMs: 30_000 });
      return { ...base, package: pkg, checked: true, installed: i.code === 0 ? i.stdout.trim() || null : null, source: `rpm -q --changelog ${pkg}`, mentioned: changelogMentions(r.stdout, ids) };
    }
    return base;
  },
});
