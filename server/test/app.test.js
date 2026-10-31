import { describe, it, expect } from 'vitest';
import { redactUrl } from '../src/app.js';

describe('access log URL redaction', () => {
  it('replaces one-time credentials in the query string and leaves every other part alone', () => {
    expect(redactUrl('/api/backup/destinations/oauth/gdrive/callback?code=4%2FabcDEF&state=xyz&scope=drive.file'))
      .toBe('/api/backup/destinations/oauth/gdrive/callback?code=[redacted]&state=[redacted]&scope=drive.file');
    expect(redactUrl('/api/auth/external/okta/callback?state=s1&code=c1&error='))
      .toBe('/api/auth/external/okta/callback?state=[redacted]&code=[redacted]&error=');
    for (const key of ['code', 'state', 'token', 'id_token', 'access_token', 'refresh_token', 'password', 'secret', 'CODE', 'State']) {
      expect(redactUrl(`/x?${key}=v`), key).toBe(`/x?${key}=[redacted]`);
    }
    expect(redactUrl('/x?%63ode=v')).toBe('/x?%63ode=[redacted]');
    expect(redactUrl('/x?code')).toBe('/x?code=[redacted]');
    expect(redactUrl('/x?a=1&code=2&code=3&b=4')).toBe('/x?a=1&code=[redacted]&code=[redacted]&b=4');
  });

  it('keeps look-alike names, paths without a query, fragments and undecodable keys', () => {
    expect(redactUrl('/api/accounts?page=2&q=code&codex=1&token_type=bearer&secret_name=x')).toBe('/api/accounts?page=2&q=code&codex=1&token_type=bearer&secret_name=x');
    expect(redactUrl('/api/accounts')).toBe('/api/accounts');
    expect(redactUrl('/x?')).toBe('/x?');
    expect(redactUrl('/x?a=1#code=2')).toBe('/x?a=1#code=2');
    expect(redactUrl('/x?%E0%A4%A=1&code=2')).toBe('/x?%E0%A4%A=1&code=[redacted]');
    expect(redactUrl(undefined)).toBe('');
    expect(redactUrl(null)).toBe('');
  });
});
