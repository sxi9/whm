import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import { exec, hasBinary } from '../src/exec.js';
import { runOp, createContext, OpError } from '../src/lib.js';
import { parseDn, parseSans, parseX509Fields, parseOpensslDate, renderApacheTls, renderEximTls, renderDovecotCertInclude, serviceCopies, bundlePaths, groupId, parseEximTlsLibrary, writeEximInclude, eximLayout, parseUpdateExim4Conf, mergeEximBlock, readEximBlock, stripEximBlock, writeEximFragment, dovecotLayout, ftpLayout, VSFTPD_CONF_FILES, ACME_OP_TIMEOUT_MS, installPanelPair, PANEL_TLS_DIR, PANEL_TLS_NOTE } from '../src/ops/ssl.js';
import { catalog } from '../src/ops/index.js';

vi.mock('../src/exec.js', async (importOriginal) => {
  const mod = await importOriginal();
  return { ...mod, exec: vi.fn(mod.exec) };
});

const ctx = createContext();
const KEY = '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7\n-----END PRIVATE KEY-----\n';
const CERT = '-----BEGIN CERTIFICATE-----\nMIIDtestcertificatebody\n-----END CERTIFICATE-----\n';
const CHAIN = `${CERT}${CERT}`;

async function opError(promise) {
  try { await promise; } catch (err) { expect(err).toBeInstanceOf(OpError); return err; }
  throw new Error('expected the op to reject');
}

describe('ssl op schemas reject injection and traversal before anything runs', () => {
  it('unknown ops are refused', async () => {
    expect((await opError(runOp('ssl.nope', {}, ctx))).code).toBe('unknown_op');
  });

  it('key generation', async () => {
    exec.mockClear();
    for (const args of [{ type: 'dsa' }, { bits: 1024 }, { bits: '2048' }, { curve: 'secp112r1' }, { type: 'rsa', extra: 1 }]) {
      expect((await opError(runOp('ssl.key.generate', args, ctx))).code, JSON.stringify(args)).toBe('invalid_args');
    }
    expect(exec).not.toHaveBeenCalled();
  });

  it('subject fields and SANs (argv for openssl -subj / -addext)', async () => {
    exec.mockClear();
    for (const subject of [
      { CN: '-d' }, { CN: 'a;b.com' }, { CN: '../etc/passwd' }, { CN: 'example.com', O: 'Acme/CN=evil' }, { CN: 'example.com', O: 'Acme\\x' },
      { CN: 'example.com', O: '-rf' }, { CN: 'example.com', C: 'USA' }, { CN: 'example.com', emailAddress: 'a b@example.com' }, { CN: 'example.com', unknown: 'x' },
    ]) {
      expect((await opError(runOp('ssl.csr.generate', { keyPem: KEY, subject }, ctx))).code, JSON.stringify(subject)).toBe('invalid_args');
    }
    for (const sans of [['-d'], ['a;b.com'], ['../x'], ['a b.com'], ['*.*.example.com'], ['DNS:example.com']]) {
      expect((await opError(runOp('ssl.csr.generate', { keyPem: KEY, subject: { CN: 'example.com' }, sans }, ctx))).code, JSON.stringify(sans)).toBe('invalid_args');
      expect((await opError(runOp('ssl.selfsigned.generate', { subject: { CN: 'example.com' }, sans }, ctx))).code, JSON.stringify(sans)).toBe('invalid_args');
    }
    expect((await opError(runOp('ssl.selfsigned.generate', { subject: { CN: 'example.com' }, days: 0 }, ctx))).code).toBe('invalid_args');
    expect((await opError(runOp('ssl.selfsigned.generate', { subject: { CN: 'example.com' }, days: 99999 }, ctx))).code).toBe('invalid_args');
    expect(exec).not.toHaveBeenCalled();
  });

  it('PEM material must be PEM', async () => {
    exec.mockClear();
    const ENCRYPTED = '-----BEGIN ENCRYPTED PRIVATE KEY-----\nMIIFHDBOBgkqhkiG9w0BBQ0wQTApBgkqhkiG9w0BBQwwHAQI\n-----END ENCRYPTED PRIVATE KEY-----\n';
    for (const bad of ['not a key', `${KEY}; rm -rf /`, 'ssh-rsa AAAA', KEY.replace('PRIVATE KEY', 'CERTIFICATE'), `${KEY}${KEY}`, ENCRYPTED]) {
      expect((await opError(runOp('ssl.key.inspect', { keyPem: bad }, ctx))).code).toBe('invalid_args');
      expect((await opError(runOp('ssl.csr.generate', { keyPem: bad, subject: { CN: 'example.com' } }, ctx))).code).toBe('invalid_args');
    }
    // A passphrase-protected key would make openssl prompt on the terminal; the message says to decrypt it first.
    expect((await opError(runOp('ssl.key.inspect', { keyPem: ENCRYPTED }, ctx))).details.fields.keyPem[0]).toMatch(/decrypt/i);
    for (const bad of ['-----BEGIN CERTIFICATE-----\n$(id)\n-----END CERTIFICATE-----', KEY, 'MIIDxyz', `${CERT}${CERT}`]) {
      expect((await opError(runOp('ssl.cert.inspect', { certPem: bad }, ctx))).code).toBe('invalid_args');
    }
    expect((await opError(runOp('ssl.cert.verify_chain', { certPem: CERT, chainPem: 'x' }, ctx))).code).toBe('invalid_args');
    expect((await opError(runOp('ssl.cert.verify_chain', { certPem: CERT, hostname: '-verify_hostname' }, ctx))).code).toBe('invalid_args');
    expect((await opError(runOp('ssl.key.matches', { keyPem: KEY }, ctx))).code).toBe('invalid_args');
    expect((await opError(runOp('ssl.csr.inspect', { csrPem: CERT }, ctx))).code).toBe('invalid_args');
    expect(exec).not.toHaveBeenCalled();
  });

  it('domain bundles and service certificates', async () => {
    exec.mockClear();
    for (const domain of ['-d', 'a;b.com', '../etc', 'EXAMPLE.COM', 'example', 'a b.com', '*.example.com']) {
      expect((await opError(runOp('ssl.bundle.install_for_domain', { domain, certPem: CERT, keyPem: KEY }, ctx))).code, domain).toBe('invalid_args');
      expect((await opError(runOp('ssl.bundle.remove_for_domain', { domain }, ctx))).code, domain).toBe('invalid_args');
      expect((await opError(runOp('ssl.bundle.read_for_domain', { domain }, ctx))).code, domain).toBe('invalid_args');
    }
    expect((await opError(runOp('ssl.bundle.install_for_domain', { domain: 'example.com', certPem: CERT, keyPem: KEY, chainPem: 'junk' }, ctx))).code).toBe('invalid_args');
    expect((await opError(runOp('ssl.bundle.list', { knownDomains: ['-d'] }, ctx))).code).toBe('invalid_args');
    expect((await opError(runOp('ssl.bundle.list', { inspect: false }, ctx))).code).toBe('invalid_args');
    // The API validates hostnames with fields.hostname (numeric labels allowed); the bundle ops accept the same names.
    const bare = createContext({ allowedRoots: ['/home'] });
    for (const domain of ['host.example.123', '10.0.0.5', 'www.example.com']) {
      expect((await opError(runOp('ssl.bundle.remove_for_domain', { domain }, bare))).code, domain).toBe('path_not_allowed');
    }
    for (const service of ['nginx', 'exim; id', '../apache', 'EXIM']) {
      expect((await opError(runOp('ssl.service_cert.install', { service, certPem: CERT, keyPem: KEY }, ctx))).code, service).toBe('invalid_args');
    }
    expect((await opError(runOp('ssl.service_cert.install', { service: 'exim', certPem: CERT, keyPem: KEY, reload: true }, ctx))).code).toBe('invalid_args');
    expect(exec).not.toHaveBeenCalled();
  });

  it('ACME arguments', async () => {
    exec.mockClear();
    const base = { provider: 'certbot', domains: ['example.com'], method: 'webroot', webroot: '/home/user/public_html' };
    for (const args of [
      { ...base, provider: 'letsencrypt' }, { ...base, domains: [] }, { ...base, domains: ['-d'] }, { ...base, domains: ['a;b.com'] }, { ...base, domains: ['*.example.com'] },
      { ...base, webroot: 'public_html' }, { ...base, webroot: '/home/../etc' }, { ...base, method: 'dns' }, { ...base, method: 'webroot', webroot: undefined },
      { ...base, email: 'not-an-email' }, { ...base, email: '-x@example.com' }, { ...base, keyType: 'dsa' }, { ...base, staging: 'yes' }, { ...base, extra: true },
    ]) {
      expect((await opError(runOp('ssl.acme.issue', args, ctx))).code, JSON.stringify(args)).toBe('invalid_args');
    }
    expect((await opError(runOp('ssl.acme.remove', { provider: 'certbot', name: '--all' }, ctx))).code).toBe('invalid_args');
    expect((await opError(runOp('ssl.acme.remove', { provider: 'certbot', name: 'a;b' }, ctx))).code).toBe('invalid_args');
    expect(exec).not.toHaveBeenCalled();
  });

  it('keeps the ACME run inside the split-mode socket timeout and drops the ops nothing calls', () => {
    expect(ACME_OP_TIMEOUT_MS).toBeLessThan(600_000);
    expect(catalog.get('ssl.acme.issue').timeoutMs).toBe(ACME_OP_TIMEOUT_MS);
    expect(catalog.has('ssl.acme.renew_all')).toBe(false);
    expect(catalog.has('ssl.acme.list')).toBe(false);
    expect(catalog.get('ssl.acme.remove').destructive).toBe(true);
  });

  it('TLS policy', async () => {
    exec.mockClear();
    const policy = { protocols: ['TLSv1.2'], ciphers: 'HIGH:!aNULL', hsts: { enabled: false } };
    for (const bad of [
      { ...policy, protocols: ['SSLv3'] }, { ...policy, protocols: [] }, { ...policy, ciphers: 'HIGH; id' }, { ...policy, ciphers: 'HIGH\nSSLProtocol all' }, { ...policy, ciphers: '' },
      { ...policy, ciphersuites: 'TLS_AES_128_GCM_SHA256;x' }, { ...policy, hsts: { enabled: true, maxAge: -1 } }, { ...policy, hsts: { enabled: true, maxAge: 1e12 } }, { ...policy, hsts: { enabled: true, extra: 1 } }, { ...policy, extra: 1 },
    ]) {
      expect((await opError(runOp('ssl.tls_config.apply', { policy: bad }, ctx))).code, JSON.stringify(bad)).toBe('invalid_args');
    }
    expect((await opError(runOp('ssl.tls_config.apply', { policy, services: ['nginx'] }, ctx))).code).toBe('invalid_args');
    // Dovecot's protocol floor and ciphers belong to Service Configuration (97-whm-mailserver.conf); this op no longer takes it.
    expect((await opError(runOp('ssl.tls_config.apply', { policy, services: ['dovecot'] }, ctx))).code).toBe('invalid_args');
    expect((await opError(runOp('ssl.tls_config.apply', { policy, removeLegacy: ['apache'] }, ctx))).code).toBe('invalid_args');
    expect(exec).not.toHaveBeenCalled();
  });

  it('bundle paths are pinned under /etc/ssl/whm even with a permissive-looking domain', async () => {
    // A context without the ssl root refuses every write before touching the disk.
    const bare = createContext({ allowedRoots: ['/home'] });
    expect((await opError(runOp('ssl.bundle.install_for_domain', { domain: 'example.com', certPem: CERT, keyPem: KEY }, bare))).code).toBe('path_not_allowed');
    expect((await opError(runOp('ssl.bundle.remove_for_domain', { domain: 'example.com' }, bare))).code).toBe('path_not_allowed');
    expect((await opError(runOp('ssl.service_cert.install', { service: 'exim', certPem: CERT, keyPem: KEY }, bare))).code).toBe('path_not_allowed');
  });
});

describe('parsers and renderers', () => {
  it('parses RFC2253 DNs, SANs and x509 field output', () => {
    expect(parseDn('CN=example.com,O=Acme\\, Inc.,C=US')).toEqual({ CN: 'example.com', O: 'Acme, Inc.', C: 'US' });
    expect(parseSans('DNS:a.example.com, DNS:B.example.com, IP Address:10.0.0.1')).toEqual(['a.example.com', 'b.example.com']);
    const fields = parseX509Fields('subject=CN=example.com,O=Acme\nissuer=CN=R3,O=Let\'s Encrypt\nnotBefore=Oct 25 10:00:00 2026 GMT\nnotAfter=Jan 23 10:00:00 2027 GMT\nserial=0A\nsha256 Fingerprint=AA:BB:CC\nX509v3 Subject Alternative Name: \n    DNS:example.com, DNS:www.example.com\n', 'Signature Algorithm: sha256WithRSAEncryption\n        Public Key Algorithm: rsaEncryption\n            Public-Key: (2048 bit)\n');
    expect(fields).toMatchObject({ commonName: 'example.com', issuerCommonName: 'R3', issuerOrganization: "Let's Encrypt", sans: ['example.com', 'www.example.com'], fingerprintSha256: 'AA:BB:CC', serial: '0A', selfSigned: false, keyAlgorithm: 'RSA', keyBits: 2048, signatureAlgorithm: 'sha256WithRSAEncryption' });
    expect(fields.notAfter).toBe('2027-01-23T10:00:00.000Z');
    expect(parseOpensslDate('garbage')).toBeNull();
  });

  it('renders TLS policy includes', () => {
    const policy = { protocols: ['TLSv1.2', 'TLSv1.3'], ciphers: 'ECDHE-RSA-AES256-GCM-SHA384', ciphersuites: 'TLS_AES_256_GCM_SHA384', preferServerCiphers: true, hsts: { enabled: true, maxAge: 31536000, includeSubdomains: true, preload: false } };
    const apache = renderApacheTls(policy);
    expect(apache).toContain('SSLProtocol all -TLSv1 -TLSv1.1');
    expect(apache).toContain('SSLCipherSuite ECDHE-RSA-AES256-GCM-SHA384');
    expect(apache).toContain('SSLCipherSuite TLSv1.3 TLS_AES_256_GCM_SHA384');
    expect(apache).toContain('Strict-Transport-Security "max-age=31536000; includeSubDomains"');
    expect(renderApacheTls({ ...policy, hsts: { enabled: false } })).not.toContain('Strict-Transport-Security');
    const exim = renderEximTls(policy);
    expect(exim).toContain('openssl_options = +no_sslv2 +no_sslv3 +no_tlsv1 +no_tlsv1_1 +single_dh_use +no_ticket +cipher_server_preference');
    expect(exim).toContain('tls_require_ciphers = ECDHE-RSA-AES256-GCM-SHA384');
    expect(renderEximTls({ ...policy, preferServerCiphers: false })).not.toContain('cipher_server_preference');
  });

  it('the Dovecot drop-in names certificate files only and sorts before Mailserver Configuration\'s 97 file', () => {
    const paths = bundlePaths('/etc/ssl/whm/service/dovecot');
    const include = renderDovecotCertInclude(paths, { hasChain: true });
    const directives = include.trim().split('\n').filter((l) => !l.startsWith('#')).map((l) => l.split(' = ')[0]);
    expect(directives).toEqual(['ssl_cert', 'ssl_key', 'ssl_ca']);
    expect(include).toContain(`ssl_cert = <${paths.fullchain}`);
    expect(include).toContain(`ssl_key = <${paths.key}`);
    expect(include).toContain(`ssl_ca = <${paths.chain}`);
    expect(include).not.toMatch(/^ssl = /m);
    expect(include).not.toContain('ssl_min_protocol');
    expect(include).not.toContain('ssl_cipher_list');
    expect(renderDovecotCertInclude(paths).trim().split('\n').filter((l) => !l.startsWith('#')).map((l) => l.split(' = ')[0])).toEqual(['ssl_cert', 'ssl_key']);
    const dc = { confDir: '/etc/dovecot', dropinDir: '/etc/dovecot/conf.d', sslInclude: '/etc/dovecot/conf.d/90-whm-ssl-cert.conf', legacyIncludes: ['/etc/dovecot/conf.d/98-whm-tls.conf', '/etc/dovecot/conf.d/99-whm-ssl.conf'], units: ['dovecot'] };
    expect(path.basename(dc.sslInclude) < '97-whm-mailserver.conf').toBe(true);
    const copies = serviceCopies('dovecot', paths, { dovecot: dc }, { hasChain: false });
    expect(copies[0]).toEqual({ remove: dc.legacyIncludes });
    expect(copies[1]).toMatchObject({ include: dc.sslInclude, validate: 'dovecot' });
    expect(copies[1].content).not.toContain('ssl = ');
    expect(serviceCopies('dovecot', paths, { dovecot: null })).toEqual([]);
    if (fs.existsSync('/etc/dovecot')) expect(dovecotLayout().sslInclude).toBe(dc.sslInclude); else expect(dovecotLayout()).toBeNull();
  });

  it('renders only real Exim main options, for OpenSSL and GnuTLS builds', () => {
    // Exim's readconf aborts on an unknown main option and the reload then kills the MTA,
    // so every non-comment line must be one of the options Exim actually has.
    const EXIM_MAIN = new Set(['tls_require_ciphers', 'openssl_options']);
    const policy = { protocols: ['TLSv1.2', 'TLSv1.3'], ciphers: 'ECDHE-RSA-AES256-GCM-SHA384', ciphersuites: '', preferServerCiphers: true, hsts: { enabled: false } };
    for (const variant of [renderEximTls(policy), renderEximTls(policy, { library: 'openssl' }), renderEximTls(policy, { library: 'gnutls' }), renderEximTls({ ...policy, protocols: ['TLSv1', 'TLSv1.1', 'TLSv1.2', 'TLSv1.3'], preferServerCiphers: false }), renderEximTls({ ...policy, protocols: ['TLSv1.3'] }, { library: 'gnutls' })]) {
      const lines = variant.trim().split('\n').filter((l) => !l.startsWith('#'));
      expect(lines.length).toBeGreaterThan(0);
      for (const line of lines) {
        const m = line.match(/^([a-z_]+) = (.+)$/);
        expect(m, line).toBeTruthy();
        expect(EXIM_MAIN.has(m[1]), line).toBe(true);
        expect(m[2]).not.toMatch(/[\n;]/);
      }
      expect(variant).not.toContain('tls_prefer_server_ciphers');
    }
    const gnutls = renderEximTls(policy, { library: 'gnutls' });
    expect(gnutls).toContain('tls_require_ciphers = NORMAL:-VERS-ALL:+VERS-TLS1.2:+VERS-TLS1.3:%SERVER_PRECEDENCE');
    expect(gnutls).not.toContain('openssl_options');
    expect(gnutls).not.toContain('ECDHE-RSA');
    expect(renderEximTls({ ...policy, protocols: ['TLSv1', 'TLSv1.1', 'TLSv1.2', 'TLSv1.3'], preferServerCiphers: false }, { library: 'gnutls' })).toContain('tls_require_ciphers = NORMAL:-VERS-ALL:+VERS-TLS1.0:+VERS-TLS1.1:+VERS-TLS1.2:+VERS-TLS1.3\n');
    expect(renderEximTls({ ...policy, protocols: ['TLSv1.2'] })).toContain('+no_tlsv1_3');
  });

  it('detects the Exim TLS library from -bV output', () => {
    expect(parseEximTlsLibrary('Exim version 4.94.2 #2 built 13-Jul-2021\nSupport for: crypteq iconv() IPv6 GnuTLS move_frozen_messages DANE DKIM\nLibrary version: GnuTLS: Compile: 3.7.1\n')).toBe('gnutls');
    expect(parseEximTlsLibrary('Exim version 4.97 #2\nSupport for: crypteq iconv() IPv6 TLS=OpenSSL DKIM\n')).toBe('openssl');
    expect(parseEximTlsLibrary('Exim version 4.97 #2\nSupport for: crypteq iconv() IPv6 TLS=GnuTLS DKIM\n')).toBe('gnutls');
    expect(parseEximTlsLibrary('Exim version 4.90\nSupport for: crypteq iconv() IPv6\n')).toBeNull();
    expect(parseEximTlsLibrary('')).toBeNull();
  });

  it('resolves the daemon group from a group file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whm-ssl-group-'));
    const file = path.join(dir, 'group');
    fs.writeFileSync(file, 'root:x:0:\nDebian-exim:x:113:\nexim:x:93:mail\n');
    expect(groupId(['Debian-exim', 'exim'], file)).toEqual({ name: 'Debian-exim', gid: 113 });
    expect(groupId(['nope', 'exim'], file)).toEqual({ name: 'exim', gid: 93 });
    expect(groupId(['nope'], file)).toBeNull();
    expect(groupId(['exim'], path.join(dir, 'missing'))).toBeNull();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('service certificate wiring', () => {
  const paths = bundlePaths('/etc/ssl/whm/service/ftp');

  it('pure-ftpd gets a combined cert+key PEM and CertFile points at it', () => {
    const copies = serviceCopies('ftp', paths, { ftp: { flavor: 'pure-ftpd', confDir: '/etc/pure-ftpd', units: ['pure-ftpd'] } });
    const combined = copies.find((c) => c.combine);
    expect(combined).toEqual({ combine: '/etc/ssl/whm/service/ftp/pure-ftpd.pem', mode: 0o600 });
    const certFile = copies.find((c) => c.include === '/etc/pure-ftpd/conf/CertFile');
    expect(certFile.content).toBe('/etc/ssl/whm/service/ftp/pure-ftpd.pem\n');
    expect(copies.indexOf(combined)).toBeLessThan(copies.indexOf(certFile));
    expect(copies.find((c) => c.include === '/etc/pure-ftpd/conf/TLS').content).toBe('1\n');
    expect(copies.some((c) => c.include === '/etc/pure-ftpd/conf/KeyFile')).toBe(false);
  });

  it('proftpd and vsftpd keep separate cert and key files', () => {
    const proftpd = serviceCopies('ftp', paths, { ftp: { flavor: 'proftpd', confDir: '/etc/proftpd', units: ['proftpd'] } });
    expect(proftpd).toHaveLength(1);
    expect(proftpd[0].content).toContain(`TLSRSACertificateKeyFile ${paths.key}`);
    expect(serviceCopies('ftp', paths, { ftp: { flavor: 'vsftpd', confFile: '/etc/vsftpd.conf', units: ['vsftpd'] } })).toEqual([{ vsftpd: '/etc/vsftpd.conf' }]);
    expect(serviceCopies('ftp', paths, { ftp: { flavor: 'vsftpd', confFile: '/etc/vsftpd/vsftpd.conf', units: ['vsftpd'] } })).toEqual([{ vsftpd: '/etc/vsftpd/vsftpd.conf' }]);
    expect(serviceCopies('ftp', paths, { ftp: null })).toEqual([]);
  });

  it('ftpLayout finds vsftpd at the RHEL path as well as the Debian one and the agent may write both', () => {
    expect(VSFTPD_CONF_FILES).toEqual(['/etc/vsftpd.conf', '/etc/vsftpd/vsftpd.conf']);
    for (const file of VSFTPD_CONF_FILES) expect(ctx.assertAllowedPath(file, 'write')).toBe(file);

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whm-ftp-layout-'));
    const debian = path.join(dir, 'vsftpd.conf');
    const rhel = path.join(dir, 'vsftpd', 'vsftpd.conf');
    const opts = { pureDir: path.join(dir, 'pure-ftpd'), proftpdDir: path.join(dir, 'proftpd'), vsftpdFiles: [debian, rhel] };
    try {
      expect(ftpLayout(opts)).toBeNull();
      fs.mkdirSync(path.dirname(rhel), { recursive: true });
      fs.writeFileSync(rhel, 'listen=YES\n');
      expect(ftpLayout(opts)).toEqual({ flavor: 'vsftpd', confFile: rhel, units: ['vsftpd'] });
      expect(serviceCopies('ftp', paths, { ftp: ftpLayout(opts) })).toEqual([{ vsftpd: rhel }]);
      fs.writeFileSync(debian, 'listen=YES\n');
      expect(ftpLayout(opts).confFile).toBe(debian);
      fs.mkdirSync(opts.proftpdDir);
      expect(ftpLayout(opts).flavor).toBe('proftpd');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('exim gets a world-readable chain and a key shared with its run group', () => {
    const eximPaths = bundlePaths('/etc/ssl/whm/service/exim');
    const copies = serviceCopies('exim', eximPaths, { exim: { flavor: 'debian', cert: '/etc/exim4/exim.crt', key: '/etc/exim4/exim.key', groups: ['Debian-exim', 'exim'] } });
    expect(copies).toEqual([
      { from: eximPaths.fullchain, to: '/etc/exim4/exim.crt', mode: 0o644 },
      { from: eximPaths.key, to: '/etc/exim4/exim.key', mode: 0o640, groups: ['Debian-exim', 'exim'] },
    ]);
    expect(serviceCopies('exim', eximPaths, { exim: null })).toEqual([]);
  });

  it('writeEximInclude validates the configuration and restores the previous file on rejection', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whm-ssl-exim-'));
    const file = path.join(dir, '000_whm_tls');
    fs.writeFileSync(file, 'old = 1\n');
    const exim = { validate: ['exim4', ['-bV']] };
    exec.mockResolvedValueOnce({ code: 1, stdout: '', stderr: 'Exim configuration error in line 3 of /var/lib/exim4/config.autogenerated.tmp:\n  main option "tls_prefer_server_ciphers" unknown\n' });
    const err = await opError(writeEximInclude(exim, file, 'tls_prefer_server_ciphers = yes\n'));
    expect(err.code).toBe('config_invalid');
    expect(err.message).toContain('main option "tls_prefer_server_ciphers" unknown');
    expect(fs.readFileSync(file, 'utf8')).toBe('old = 1\n');
    expect(exec).toHaveBeenLastCalledWith('exim4', ['-bV'], expect.objectContaining({ allowFailure: true }));

    exec.mockResolvedValueOnce({ code: 0, stdout: 'Configuration file is /var/lib/exim4/config.autogenerated\n', stderr: '' });
    expect(await writeEximInclude(exim, file, 'tls_require_ciphers = NORMAL\n')).toEqual({ path: file, validated: true });
    expect(fs.readFileSync(file, 'utf8')).toBe('tls_require_ciphers = NORMAL\n');

    // A file that did not exist before is removed again on rejection.
    const fresh = path.join(dir, '000_whm_tls_enable');
    exec.mockResolvedValueOnce({ code: 1, stdout: '', stderr: 'Invalid new configfile, not installing\n' });
    await opError(writeEximInclude({ validate: ['update-exim4.conf', []] }, fresh, 'MAIN_TLS_ENABLE = true\n'));
    expect(fs.existsSync(fresh)).toBe(false);

    // Without a validator the fragment is written and reported as unvalidated.
    expect(await writeEximInclude({ validate: null }, fresh, 'MAIN_TLS_ENABLE = true\n')).toEqual({ path: fresh, validated: false });
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('panel certificate pair', () => {
  const mode = (file) => fs.statSync(file).mode & 0o777;
  const bundle = (root) => {
    const src = bundlePaths(path.join(root, 'bundle'));
    fs.mkdirSync(src.dir, { recursive: true });
    fs.writeFileSync(src.fullchain, CHAIN, { mode: 0o644 });
    fs.writeFileSync(src.key, KEY, { mode: 0o600 });
    return src;
  };

  it('hands key.pem to the TLS directory group (0640) so the non-root whm-panel service can load it, on first install and on replace', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'whm-ssl-panel-'));
    const src = bundle(root);
    const dest = path.join(root, 'tls');
    fs.mkdirSync(dest, { mode: 0o750 });
    // install.sh creates /etc/whm/tls root:whmpanel; root may hand the test directory to any group, anyone else to their own.
    const gid = process.getuid() === 0 ? 65534 : process.getgid();
    fs.chownSync(dest, -1, gid);
    const applied = installPanelPair(dest, src);
    expect(applied).toEqual([path.join(dest, 'cert.pem'), path.join(dest, 'key.pem')]);
    expect(fs.readFileSync(applied[0], 'utf8')).toBe(CHAIN);
    expect(fs.readFileSync(applied[1], 'utf8')).toBe(KEY);
    expect(mode(applied[0])).toBe(0o644);
    expect(mode(applied[1])).toBe(gid ? 0o640 : 0o600);
    expect(fs.statSync(applied[1]).gid).toBe(gid);
    expect(fs.statSync(applied[0]).gid).toBe(gid);
    // A renewal replaces the pair in place with the same ownership and modes.
    fs.chmodSync(applied[1], 0o600);
    expect(installPanelPair(dest, src)).toEqual(applied);
    expect(mode(applied[1])).toBe(gid ? 0o640 : 0o600);
    expect(fs.statSync(applied[1]).gid).toBe(gid);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('keeps the key root-only (0600) under a root-owned directory and creates a missing directory 0750', () => {
    if (process.getuid() !== 0) return;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'whm-ssl-panel-root-'));
    const src = bundle(root);
    const dest = path.join(root, 'missing', 'tls');
    const applied = installPanelPair(dest, src);
    expect(mode(dest)).toBe(0o750);
    expect(fs.statSync(dest).gid).toBe(0);
    expect(mode(applied[1])).toBe(0o600);
    expect(mode(applied[0])).toBe(0o644);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('the op writes the pair under /etc/whm/tls and its note says the listener reloads it in place', () => {
    expect(PANEL_TLS_DIR).toBe('/etc/whm/tls');
    expect(PANEL_TLS_NOTE).toMatch(/reloads \/etc\/whm\/tls\/cert\.pem and key\.pem in place/);
    expect(PANEL_TLS_NOTE).not.toMatch(/^Point WHM_TLS_CERT/);
  });
});

describe('Exim layout detection', () => {
  const fixture = (conf) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whm-ssl-exim4-'));
    // Debian's exim4-config ships conf.d/ in every mode; only the conf file decides whether it is read.
    fs.mkdirSync(path.join(dir, 'conf.d', 'main'), { recursive: true });
    if (conf != null) fs.writeFileSync(path.join(dir, 'update-exim4.conf.conf'), conf);
    return dir;
  };

  it('parses update-exim4.conf.conf like the shell that sources it', () => {
    expect(parseUpdateExim4Conf("# comment\ndc_eximconfig_configtype='internet'\ndc_use_split_config='false'\n  dc_local_interfaces=\"127.0.0.1 ; ::1\"\nCFILEMODE='644'\n")).toEqual({ dc_eximconfig_configtype: 'internet', dc_use_split_config: 'false', dc_local_interfaces: '127.0.0.1 ; ::1', CFILEMODE: '644' });
    expect(parseUpdateExim4Conf(null)).toEqual({});
  });

  it('treats conf.d as unused unless dc_use_split_config is true (stock Debian is unsplit)', () => {
    const unsplit = fixture("dc_eximconfig_configtype='internet'\ndc_use_split_config='false'\n");
    const layout = eximLayout({ debianDir: unsplit });
    expect(layout).toMatchObject({ flavor: 'debian', splitConfig: false, includeMode: 'localmacros', macroFile: `${unsplit}/exim4.conf.localmacros` });
    expect(layout.tlsInclude).toBe(layout.macroFile);
    expect(layout.tlsEnable).toBe(layout.macroFile);
    expect(layout.tlsBlock).toBeTruthy();
    expect(layout.tlsEnableBlock).toBeTruthy();
    expect(layout.tlsBlock).not.toBe(layout.tlsEnableBlock);
    expect(layout.tlsInclude).not.toContain('conf.d');

    // No conf file at all (hand-maintained exim4.conf.template) is unsplit as well.
    const bare = fixture(null);
    expect(eximLayout({ debianDir: bare })).toMatchObject({ splitConfig: false, includeMode: 'localmacros' });

    const split = fixture("dc_use_split_config='true'\n");
    expect(eximLayout({ debianDir: split })).toMatchObject({ flavor: 'debian', splitConfig: true, includeMode: 'split', tlsInclude: `${split}/conf.d/main/000_whm_tls`, tlsBlock: null, tlsEnable: `${split}/conf.d/main/000_whm_tls_enable`, tlsEnableBlock: null });

    const rhel = fs.mkdtempSync(path.join(os.tmpdir(), 'whm-ssl-exim-rhel-'));
    expect(eximLayout({ debianDir: path.join(unsplit, 'missing'), rhelDir: rhel })).toMatchObject({ flavor: 'rhel', splitConfig: false, includeMode: 'manual', tlsInclude: `${rhel}/whm-tls.conf`, tlsBlock: null, tlsEnable: null });
    expect(eximLayout({ debianDir: path.join(unsplit, 'missing'), rhelDir: path.join(rhel, 'missing') })).toBeNull();
    for (const d of [unsplit, bare, split, rhel]) fs.rmSync(d, { recursive: true, force: true });
  });

  it('managed blocks in localmacros leave the admin\'s and the Email category\'s lines alone', () => {
    const admin = "MAIN_TLS_ENABLE = true\n# BEGIN WHM panel (Email filters) - managed block, edits inside are overwritten\nCHECK_RCPT_LOCAL_ACL_FILE = /etc/exim4/whm/acl_rcpt.conf\n# END WHM panel (Email filters)\n";
    const once = mergeEximBlock(admin, 'TLS policy', 'tls_require_ciphers = NORMAL\n');
    expect(once.startsWith(admin)).toBe(true);
    expect(readEximBlock(once, 'TLS policy')).toBe('tls_require_ciphers = NORMAL\n');
    expect(readEximBlock(once, 'STARTTLS')).toBeNull();
    const twice = mergeEximBlock(mergeEximBlock(once, 'STARTTLS', '.ifndef MAIN_TLS_ENABLE\nMAIN_TLS_ENABLE = true\n.endif'), 'TLS policy', 'tls_require_ciphers = SECURE256\n');
    expect(twice.match(/BEGIN WHM panel \(SSL\/TLS: TLS policy\)/g)).toHaveLength(1);
    expect(readEximBlock(twice, 'TLS policy')).toBe('tls_require_ciphers = SECURE256\n');
    expect(readEximBlock(twice, 'STARTTLS')).toBe('.ifndef MAIN_TLS_ENABLE\nMAIN_TLS_ENABLE = true\n.endif\n');
    expect(twice).toContain('CHECK_RCPT_LOCAL_ACL_FILE = /etc/exim4/whm/acl_rcpt.conf');
    expect(twice.startsWith('MAIN_TLS_ENABLE = true\n')).toBe(true);
    expect(mergeEximBlock(null, 'STARTTLS', 'MAIN_TLS_ENABLE = true')).toBe('# BEGIN WHM panel (SSL/TLS: STARTTLS) - managed block, edits inside are overwritten\nMAIN_TLS_ENABLE = true\n# END WHM panel (SSL/TLS: STARTTLS)\n');
    expect(mergeEximBlock('no trailing newline', 'STARTTLS', 'x')).toMatch(/^no trailing newline\n# BEGIN/);
    // Stripping one block leaves everything else byte for byte.
    const stripped = stripEximBlock(twice, 'TLS policy');
    expect(readEximBlock(stripped, 'TLS policy')).toBeNull();
    expect(readEximBlock(stripped, 'STARTTLS')).toBe('.ifndef MAIN_TLS_ENABLE\nMAIN_TLS_ENABLE = true\n.endif\n');
    expect(stripped.startsWith(admin)).toBe(true);
    expect(stripEximBlock(admin, 'TLS policy')).toBe(admin);
  });

  it('writeEximFragment merges into localmacros, validates with update-exim4.conf and restores on rejection', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whm-ssl-exim4-'));
    const file = path.join(dir, 'exim4.conf.localmacros');
    fs.writeFileSync(file, 'ADMIN_MACRO = 1\n');
    const localCtx = createContext({ allowedRoots: [dir] });
    const exim = { validate: ['update-exim4.conf', []] };
    exec.mockResolvedValueOnce({ code: 0, stdout: '', stderr: '' });
    const ok = await writeEximFragment(exim, { path: file, block: 'STARTTLS' }, '.ifndef MAIN_TLS_ENABLE\nMAIN_TLS_ENABLE = true\n.endif\n', localCtx);
    expect(ok).toEqual({ path: file, validated: true, block: 'STARTTLS' });
    expect(exec).toHaveBeenLastCalledWith('update-exim4.conf', [], expect.objectContaining({ allowFailure: true }));
    const after = fs.readFileSync(file, 'utf8');
    expect(after.startsWith('ADMIN_MACRO = 1\n')).toBe(true);
    expect(readEximBlock(after, 'STARTTLS')).toContain('MAIN_TLS_ENABLE = true');

    exec.mockResolvedValueOnce({ code: 2, stdout: '', stderr: 'Invalid new configfile /var/lib/exim4/config.autogenerated.tmp, not installing\n' });
    const err = await opError(writeEximFragment(exim, { path: file, block: 'TLS policy' }, 'bogus_option = 1\n', localCtx));
    expect(err.code).toBe('config_invalid');
    expect(fs.readFileSync(file, 'utf8')).toBe(after);

    // Whole-file fragments (split mode) still write the file as given.
    const split = path.join(dir, '000_whm_tls');
    exec.mockResolvedValueOnce({ code: 0, stdout: '', stderr: '' });
    expect(await writeEximFragment(exim, { path: split, block: null }, 'tls_require_ciphers = NORMAL\n', localCtx)).toEqual({ path: split, validated: true, block: null });
    expect(fs.readFileSync(split, 'utf8')).toBe('tls_require_ciphers = NORMAL\n');
    expect((await opError(writeEximFragment(exim, { path: '/etc/shadow', block: null }, 'x', localCtx))).code).toBe('path_not_allowed');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

// These ops only compute (temp files are shredded afterwards), so they run for real.
describe.skipIf(!hasBinary('openssl'))('openssl-backed ops against the real binary', () => {
  it('generates keys, CSRs and self-signed certificates that inspect and match', async () => {
    const rsa = await runOp('ssl.key.generate', { type: 'rsa', bits: 2048 }, ctx);
    expect(rsa).toMatchObject({ type: 'rsa', bits: 2048 });
    expect(rsa.keyPem).toMatch(/^-----BEGIN PRIVATE KEY-----/);
    const ec = await runOp('ssl.key.generate', { type: 'ec', curve: 'secp384r1' }, ctx);
    expect(ec).toMatchObject({ type: 'ec', bits: 384, curve: 'secp384r1' });

    const csr = await runOp('ssl.csr.generate', { keyPem: rsa.keyPem, subject: { CN: 'example.com', O: 'Acme, Inc.', C: 'US', emailAddress: 'ops@example.com' }, sans: ['www.example.com', '*.shop.example.com'] }, ctx);
    expect(csr.csrPem).toMatch(/^-----BEGIN CERTIFICATE REQUEST-----/);
    const csrInfo = await runOp('ssl.csr.inspect', { csrPem: csr.csrPem }, ctx);
    expect(csrInfo).toMatchObject({ commonName: 'example.com', sans: ['example.com', 'www.example.com', '*.shop.example.com'], keyAlgorithm: 'RSA', keyBits: 2048 });
    expect(csrInfo.subject.O).toBe('Acme, Inc.');

    expect((await runOp('ssl.key.matches', { keyPem: rsa.keyPem, csrPem: csr.csrPem }, ctx)).matches).toBe(true);
    expect((await runOp('ssl.key.matches', { keyPem: ec.keyPem, csrPem: csr.csrPem }, ctx)).matches).toBe(false);

    const ss = await runOp('ssl.selfsigned.generate', { keyPem: rsa.keyPem, subject: { CN: 'example.com', O: 'Acme' }, sans: ['www.example.com'], days: 30 }, ctx);
    expect(ss.certificate).toMatchObject({ commonName: 'example.com', selfSigned: true, sans: ['example.com', 'www.example.com'], keyAlgorithm: 'RSA', keyBits: 2048, expired: false });
    expect(ss.certificate.daysRemaining).toBeGreaterThanOrEqual(29);
    const info = await runOp('ssl.cert.inspect', { certPem: ss.certPem }, ctx);
    expect(info.fingerprintSha256).toMatch(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
    expect((await runOp('ssl.key.matches', { keyPem: rsa.keyPem, certPem: ss.certPem }, ctx)).matches).toBe(true);

    const verify = await runOp('ssl.cert.verify_chain', { certPem: ss.certPem, hostname: 'example.com' }, ctx);
    expect(verify.ok).toBe(false);
    expect(verify.error).toMatch(/self[- ]signed/i);
    const generated = await runOp('ssl.selfsigned.generate', { subject: { CN: 'host.example.net' }, key: { type: 'ec' } }, ctx);
    expect(generated.keyPem).toMatch(/PRIVATE KEY/);
    expect((await runOp('ssl.key.inspect', { keyPem: generated.keyPem }, ctx)).type).toBe('ec');
  }, 60_000);

  it('reports a corrupt certificate as invalid_certificate rather than crashing', async () => {
    const err = await opError(runOp('ssl.cert.inspect', { certPem: CERT }, ctx));
    expect(err.code).toBe('invalid_certificate');
  });
});
