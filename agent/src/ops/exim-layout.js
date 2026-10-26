import fs from 'node:fs';
import { hasBinary } from '../exec.js';

// Shared Exim layout detection for the mail (Email) and web (Service
// Configuration) op families. Pure functions, no ops: the loader imports this
// file like any other family and nothing is registered.
//
// Debian ships exim4 with two configuration modes selected by
// dc_use_split_config in /etc/exim4/update-exim4.conf.conf:
//   'true'  → conf.d/ fragments are concatenated (main-section fragments under
//             conf.d/main/ are live without any include line);
//   'false' → the single exim4.conf.template is used and conf.d/ is ignored.
// In both modes update-exim4.conf prepends exim4.conf.localmacros, so macros
// written there (and ACL hooks wired through the CHECK_*_LOCAL_ACL_FILE macros
// the stock ACLs .include) work everywhere; the operator's choice is never
// flipped. RHEL/cPanel-style hosts use a monolithic /etc/exim/exim.conf (or
// /etc/exim.conf) where the panel's files need a one-time manual .include.

const DEFAULT_IO = {
  exists(file) { try { fs.accessSync(file); return true; } catch { return false; } },
  readText(file) { try { return fs.readFileSync(file, 'utf8'); } catch { return null; } },
  hasBinary,
};

// Debian's update-exim4.conf.conf is a sourced shell fragment of KEY='value' lines.
export function parseUpdateExim4Conf(text) {
  const out = {};
  for (const raw of (text || '').split('\n')) {
    const m = raw.trim().match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (m) out[m[1]] = m[2].trim().replace(/^(['"])(.*)\1$/, '$2');
  }
  return out;
}

// Items of dc_other_hostnames / dc_relay_domains (';' or ':' separated).
export function debianList(value) {
  return String(value || '').split(/[;:]/).map((s) => s.trim()).filter((s) => /^[A-Za-z0-9.*@_+-]+$/.test(s));
}

// File names both families agree on under <confdir>/whm/: service-configuration
// renders the RCPT ACL chain file (its own protections, ending with
// `.include_if_exists <emailAclFile>`), email renders only the filters file.
export const EXIM_WHM_FILES = {
  aclChain: 'acl-rcpt-local.conf',
  emailFilters: 'acl-email-filters.conf',
  legacyEmailAcl: 'acl_rcpt.conf',
};

export function eximBaseLayout(io = DEFAULT_IO) {
  const { exists, readText } = { ...DEFAULT_IO, ...io };
  const has = io.hasBinary || DEFAULT_IO.hasBinary;
  const bin = ['exim4', 'exim'].find(has) || null;
  let flavor = null;
  if (exists('/etc/exim4')) flavor = 'debian';
  else if (exists('/etc/exim') || exists('/etc/exim.conf')) flavor = 'rhel';
  const confDir = flavor === 'debian' ? '/etc/exim4' : flavor === 'rhel' ? '/etc/exim' : null;
  const whmDir = confDir ? `${confDir}/whm` : null;
  const debianConf = flavor === 'debian' ? parseUpdateExim4Conf(readText('/etc/exim4/update-exim4.conf.conf')) : {};
  const splitConfig = flavor === 'debian' ? debianConf.dc_use_split_config === 'true' : false;
  const mainConf = flavor === 'debian'
    ? (splitConfig ? null : '/etc/exim4/exim4.conf.template')
    : flavor === 'rhel' ? ['/etc/exim/exim.conf', '/etc/exim.conf'].find(exists) || '/etc/exim/exim.conf' : null;
  return {
    installed: Boolean(bin), bin, flavor, confDir, whmDir, splitConfig, mainConf, debianConf,
    updateConf: has('update-exim4.conf'),
    units: flavor === 'debian' ? ['exim4', 'exim'] : ['exim', 'exim4'],
    // Where main-section macros go on Debian (read in both config modes).
    macroFile: flavor === 'debian' ? '/etc/exim4/exim4.conf.localmacros' : null,
    // Where a plain main-section fragment is live without any include line.
    confdMainDir: flavor === 'debian' && splitConfig ? '/etc/exim4/conf.d/main' : null,
    // The stock Debian acl_check_rcpt lives here (split) or in the template (unsplit).
    rcptAclSource: flavor === 'debian' ? (splitConfig ? '/etc/exim4/conf.d/acl/30_exim4-config_check_rcpt' : '/etc/exim4/exim4.conf.template') : mainConf,
    aclChainFile: whmDir ? `${whmDir}/${EXIM_WHM_FILES.aclChain}` : null,
    emailAclFile: whmDir ? `${whmDir}/${EXIM_WHM_FILES.emailFilters}` : null,
    otherHostnames: debianList(debianConf.dc_other_hostnames),
    debianRelayDomains: debianList(debianConf.dc_relay_domains),
  };
}

// `.include` / `.include_if_exists` targets of an Exim configuration text.
export function eximIncludes(text) {
  return [...String(text || '').matchAll(/^\s*\.include(?:_if_exists)?\s+(\S+)\s*$/gm)].map((m) => m[1]);
}

// Whether `file` is reached from `entry`: directly included, or included by a
// file `entry` includes (one level: the ACL chain file). `readText` resolves
// the intermediate file.
export function includesFile(entryText, file, readText = DEFAULT_IO.readText) {
  const direct = eximIncludes(entryText);
  if (direct.includes(file)) return { hooked: true, via: null };
  for (const inc of direct) {
    const text = readText(inc);
    if (text != null && eximIncludes(text).includes(file)) return { hooked: true, via: inc };
  }
  return { hooked: false, via: null };
}
