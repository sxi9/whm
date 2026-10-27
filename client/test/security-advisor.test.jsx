import { describe, it, expect } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { FindingRow, AdvisoryListEditor } from '../src/pages/fn/security-center/security-advisor.jsx';
import { PhpAdvisoryBadge } from '../src/pages/fn/software/multiphp-manager.jsx';

React.useLayoutEffect = React.useEffect;
const render = (el) => renderToStaticMarkup(<MemoryRouter>{el}</MemoryRouter>);

const finding = {
  id: 'php.advisory.CVE-2026-109619', grade: 'critical', title: 'PHP 8.3.35 (default) is affected by CVE-2026-109619', detail: 'PHP2Shell\nPHP 8.3.35: update to 8.3.36',
  url: 'https://github.com/php/php-src/security/advisories/GHSA-6wmf-4rv5-p3rp', advisory: 'CVE-2026-109619',
  versions: [{ id: '8.3', version: '8.3.35', minor: '8.3', unknown: false, fixedIn: '8.3.36', isDefault: true }, { id: '8.1', version: null, minor: '8.1', unknown: false, fixedIn: null, isDefault: false }],
  fix: { label: 'MultiPHP Manager', path: '/software/multiphp-manager' },
};

describe('Security Advisor PHP advisory finding', () => {
  it('lists each affected version with its fix, the upstream advisory and the MultiPHP link', () => {
    const html = render(<table><tbody><FindingRow finding={finding} /></tbody></table>);
    expect(html).toContain('is affected by CVE-2026-109619');
    expect(html).toContain('8.3.35 → 8.3.36');
    expect(html).toContain('8.1.x · no fix for this branch');
    expect(html).toContain('href="https://github.com/php/php-src/security/advisories/GHSA-6wmf-4rv5-p3rp"');
    expect(html).toContain('rel="noreferrer noopener"');
    expect(html).toContain('href="/software/multiphp-manager"');
    expect(html).toContain('MultiPHP Manager');
  });

  it('renders plain findings without an advisory column', () => {
    const html = render(<table><tbody><FindingRow finding={{ id: 'ssh.password', grade: 'warning', title: 'SSH password authentication is enabled' }} /></tbody></table>);
    expect(html).toContain('SSH password authentication is enabled');
    expect(html).not.toContain('href="http');
    expect(html).not.toContain('no fix for this branch');
  });
});

describe('Advisory list editor', () => {
  it('shows the stored list as editable JSON with the entry shape documented', () => {
    const html = render(<AdvisoryListEditor value={[{ id: 'CVE-2026-109619', severity: 'critical', affected: { '8.3': '<8.3.36' } }]} onSave={() => {}} />);
    expect(html).toContain('1 advisory on file');
    expect(html).toContain('CVE-2026-109619');
    expect(html).toContain('&lt;8.3.36');
    expect(html).toContain('id="advisories"');
    expect(html).toContain('Save list');
  });
});

describe('MultiPHP Manager advisory badge', () => {
  it('shows nothing for a clean version and a critical badge with the fix version otherwise', () => {
    expect(render(<PhpAdvisoryBadge advisories={[]} />)).toBe('');
    expect(render(<PhpAdvisoryBadge />)).toBe('');
    const html = render(<PhpAdvisoryBadge advisories={[{ id: 'CVE-2026-109619', severity: 'critical', grade: 'critical', title: 'PHP2Shell', url: 'https://example.test', fixedIn: '8.3.36', unknown: false }]} />);
    expect(html).toContain('CVE-2026-109619 · update to 8.3.36');
    expect(html).toContain('bad');
    expect(html).toContain('href="/security-center/security-advisor"');
    const eol = render(<PhpAdvisoryBadge advisories={[{ id: 'CVE-2026-109619', severity: 'critical', grade: 'critical', title: 'PHP2Shell', url: null, fixedIn: null, unknown: false }, { id: 'CVE-X', severity: 'medium', grade: 'warning', title: 'x', url: null, fixedIn: null, unknown: false }]} />);
    expect(eol).toContain('2 advisories · no fix for this branch');
  });
});
