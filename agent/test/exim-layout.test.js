import { describe, it, expect } from 'vitest';
import { eximBaseLayout, parseUpdateExim4Conf, debianList, eximIncludes, includesFile, EXIM_WHM_FILES } from '../src/ops/exim-layout.js';
import { catalog } from '../src/ops/registry.js';

// Fake host: which paths exist, what they contain, which binaries resolve.
function io({ files = {}, dirs = [], binaries = [] }) {
  return {
    exists: (p) => dirs.includes(p) || p in files,
    readText: (p) => (p in files ? files[p] : null),
    hasBinary: (b) => binaries.includes(b),
  };
}

describe('shared Exim layout detection (mail + web families)', () => {
  it('defines no ops of its own', () => {
    expect([...catalog.keys()].some((n) => n.includes('layout'))).toBe(false);
  });

  it('Debian: dc_use_split_config decides the config mode; macros always go to localmacros', () => {
    const split = eximBaseLayout(io({ dirs: ['/etc/exim4'], files: { '/etc/exim4/update-exim4.conf.conf': "dc_use_split_config='true'\ndc_other_hostnames='a.example;b.example'\ndc_relay_domains=''\n" }, binaries: ['exim4', 'update-exim4.conf'] }));
    expect(split).toMatchObject({ installed: true, bin: 'exim4', flavor: 'debian', confDir: '/etc/exim4', whmDir: '/etc/exim4/whm', splitConfig: true, mainConf: null, updateConf: true, macroFile: '/etc/exim4/exim4.conf.localmacros', confdMainDir: '/etc/exim4/conf.d/main', rcptAclSource: '/etc/exim4/conf.d/acl/30_exim4-config_check_rcpt', aclChainFile: `/etc/exim4/whm/${EXIM_WHM_FILES.aclChain}`, emailAclFile: '/etc/exim4/whm/acl-email-filters.conf', otherHostnames: ['a.example', 'b.example'], debianRelayDomains: [] });
    // The Debian default (unsplit): conf.d/ is ignored even when the directory exists.
    const unsplit = eximBaseLayout(io({ dirs: ['/etc/exim4', '/etc/exim4/conf.d'], files: { '/etc/exim4/update-exim4.conf.conf': "dc_use_split_config='false'\n" }, binaries: ['exim4'] }));
    expect(unsplit).toMatchObject({ splitConfig: false, mainConf: '/etc/exim4/exim4.conf.template', confdMainDir: null, macroFile: '/etc/exim4/exim4.conf.localmacros', rcptAclSource: '/etc/exim4/exim4.conf.template' });
    expect(eximBaseLayout(io({ dirs: ['/etc/exim4'], binaries: ['exim4'] })).splitConfig).toBe(false);
  });

  it('RHEL: monolithic exim.conf, no macro file', () => {
    const rhel = eximBaseLayout(io({ dirs: ['/etc/exim'], files: { '/etc/exim/exim.conf': '' }, binaries: ['exim'] }));
    expect(rhel).toMatchObject({ installed: true, bin: 'exim', flavor: 'rhel', confDir: '/etc/exim', whmDir: '/etc/exim/whm', splitConfig: false, mainConf: '/etc/exim/exim.conf', macroFile: null, confdMainDir: null, rcptAclSource: '/etc/exim/exim.conf', emailAclFile: '/etc/exim/whm/acl-email-filters.conf', units: ['exim', 'exim4'] });
    expect(eximBaseLayout(io({ files: { '/etc/exim.conf': '' }, binaries: ['exim'] })).mainConf).toBe('/etc/exim.conf');
    const none = eximBaseLayout(io({ binaries: ['exim'] }));
    expect(none).toMatchObject({ installed: true, flavor: null, confDir: null, whmDir: null, mainConf: null, aclChainFile: null, emailAclFile: null });
    expect(eximBaseLayout(io({})).installed).toBe(false);
  });

  it('parses update-exim4.conf.conf and list values', () => {
    expect(parseUpdateExim4Conf("# c\ndc_eximconfig_configtype='internet'\ndc_other_hostnames=\"a;b\"\nbroken line\n")).toEqual({ dc_eximconfig_configtype: 'internet', dc_other_hostnames: 'a;b' });
    expect(parseUpdateExim4Conf(null)).toEqual({});
    expect(debianList('a.example ; b.example:*.c.example;bad value')).toEqual(['a.example', 'b.example', '*.c.example']);
  });

  it('follows .include / .include_if_exists one level deep (the ACL chain)', () => {
    const chain = '# chain\ndeny hosts = x\n.include_if_exists /etc/exim4/whm/acl-email-filters.conf\n';
    const readText = (f) => (f === '/etc/exim4/whm/acl-rcpt-local.conf' ? chain : null);
    expect(eximIncludes('  .include /a\n.include_if_exists /b\n# .include /c\n')).toEqual(['/a', '/b']);
    expect(includesFile('.include /etc/exim4/whm/acl-email-filters.conf\n', '/etc/exim4/whm/acl-email-filters.conf', readText)).toEqual({ hooked: true, via: null });
    expect(includesFile('.include /etc/exim4/whm/acl-rcpt-local.conf\n', '/etc/exim4/whm/acl-email-filters.conf', readText)).toEqual({ hooked: true, via: '/etc/exim4/whm/acl-rcpt-local.conf' });
    expect(includesFile('.include /etc/exim4/whm/other.conf\n', '/etc/exim4/whm/acl-email-filters.conf', readText)).toEqual({ hooked: false, via: null });
    expect(includesFile('', '/x', readText).hooked).toBe(false);
  });
});
