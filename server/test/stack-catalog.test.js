import { describe, it, expect } from 'vitest';
import { STACK_COMPONENTS, STACK_PROFILES, PACKAGE_FAMILIES, componentByKey, componentForCapability, profileComponents } from '../src/lib/stack-catalog.js';
import { CAPABILITY_BINARIES } from '../src/lib/capabilities.js';

const PKG_RE = /^[a-z0-9][a-z0-9+._-]*$/;

describe('stack catalog components', () => {
  it('have unique keys, both package families and one capability each', () => {
    const keys = STACK_COMPONENTS.map((c) => c.key);
    expect(new Set(keys).size).toBe(keys.length);
    const caps = STACK_COMPONENTS.map((c) => c.capability);
    expect(new Set(caps).size).toBe(caps.length);
    for (const c of STACK_COMPONENTS) {
      expect(typeof c.capability, c.key).toBe('string');
      expect(typeof c.recommended, c.key).toBe('boolean');
      expect(Array.isArray(c.units), c.key).toBe(true);
      expect(Array.isArray(c.postInstall), c.key).toBe(true);
      for (const family of PACKAGE_FAMILIES) {
        expect(Array.isArray(c.packages[family]), `${c.key}.${family}`).toBe(true);
        expect(c.packages[family].length, `${c.key}.${family}`).toBeGreaterThan(0);
        for (const pkg of c.packages[family]) expect(pkg, `${c.key}.${family}`).toMatch(PKG_RE);
      }
      if (c.requires) for (const family of Object.keys(c.requires)) expect(PACKAGE_FAMILIES).toContain(family);
    }
    for (const p of STACK_PROFILES) for (const k of p.components) expect(componentByKey(k), `${p.key}: ${k}`).toBeTruthy();
  });

  it('offer rclone for the cloud backup destinations: both families, EPEL on RHEL, no unit, part of the full stack', () => {
    const rclone = componentByKey('rclone');
    expect(rclone).toMatchObject({ label: 'rclone (cloud storage client)', capability: 'rclone', service: null, recommended: true, packages: { debian: ['rclone'], rhel: ['rclone'] }, units: [], postInstall: [] });
    expect(rclone.requires.rhel).toMatch(/EPEL/);
    expect(rclone.requires.debian).toBeUndefined();
    expect(componentForCapability('rclone').key).toBe('rclone');
    expect(profileComponents('full')).toContain('rclone');
    expect(profileComponents('web')).not.toContain('rclone');
  });

  it('are detectable: the static capability map names the programs the backup category probes for', () => {
    expect(CAPABILITY_BINARIES.rclone).toEqual(['rclone']);
    expect(CAPABILITY_BINARIES.rsync).toEqual(['rsync']);
    for (const cap of Object.keys(CAPABILITY_BINARIES)) expect(Array.isArray(CAPABILITY_BINARIES[cap]), cap).toBe(true);
  });
});
