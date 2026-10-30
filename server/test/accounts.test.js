import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestApp, createMockAgent } from './support/app.js';

// A production host with the quota package installed but quotas not enabled on
// the home filesystem (no usrquota mount option / quotaon): setquota exits 1.
// The limit is recorded and reported; it never costs the account.
function hostAgent() {
  const bins = { useradd: true, usermod: true, userdel: true, chpasswd: true, setquota: true, repquota: true, quotacheck: true };
  const agent = createMockAgent({ 'sys.binaries': ({ names }) => Object.fromEntries(names.map((n) => [n, Boolean(bins[n])])) });
  agent.fail('user.set_quota', 'command_failed', '"setquota" exited with status 1: setquota: Mountpoint (or device) / not found or has no quota enabled.');
  return agent;
}

describe('accounts on a production host whose quotas are not enabled', () => {
  let app;
  let csrf;
  const post = (path, body) => app.http.post(`/api${path}`).set('X-CSRF-Token', csrf).send(body);
  const patch = (path, body) => app.http.patch(`/api${path}`).set('X-CSRF-Token', csrf).send(body);

  beforeAll(async () => {
    app = await createTestApp({ agent: hostAgent(), overrides: { env: 'production' } });
    csrf = await app.login();
  });
  afterAll(() => app.close());

  it('keeps the created account and reports the quota step instead of rolling back', async () => {
    expect(app.ctx.capabilities.has('quota')).toBe(true);
    const res = await post('/accounts', { username: 'alice', domain: 'alice.com' });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ username: 'alice', disk_quota_mb: 10240, systemUser: true });
    expect(res.body.data.provisioning.quota).toBe('failed');
    expect(res.body.data.provisioning.steps.quota).toMatchObject({ status: 'failed', filesystem: '/' });
    expect(res.body.data.provisioning.steps.quota.detail).toMatch(/has no quota enabled/);
    expect(res.body.data.provisioning.steps.quota.detail).toMatch(/Initial Quota Setup/);
    expect(app.agent.callsTo('user.set_quota').map((c) => c.args)).toEqual([{ username: 'alice', softMb: 10240, hardMb: 10752, filesystem: '/' }]);
    expect(app.agent.callsTo('user.delete')).toEqual([]);
    expect(app.ctx.db.prepare('SELECT disk_quota_mb, uid FROM accounts WHERE username = ?').get('alice')).toEqual({ disk_quota_mb: 10240, uid: 30001 });
    const audit = JSON.parse(app.ctx.db.prepare("SELECT args_redacted FROM audit_log WHERE action = 'account.create' AND target = 'alice'").get().args_redacted);
    expect(audit.provisioning.quota).toBe('failed');
  });

  it('records a package change whose quota cannot be applied yet', async () => {
    await post('/packages', { name: 'bigger', disk_mb: 20480 }).expect(201);
    const res = await patch('/accounts/alice', { package: 'bigger' });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ package_name: 'bigger', disk_quota_mb: 20480, quota: { status: 'failed', filesystem: '/' } });
    expect(res.body.data.quota.detail).toMatch(/Initial Quota Setup/);
    expect(app.ctx.db.prepare('SELECT package_name, disk_quota_mb FROM accounts WHERE username = ?').get('alice')).toEqual({ package_name: 'bigger', disk_quota_mb: 20480 });
    const audit = JSON.parse(app.ctx.db.prepare("SELECT args_redacted FROM audit_log WHERE action = 'account.modify' AND target = 'alice'").get().args_redacted);
    expect(audit.quota).toBe('failed');
  });

  it('reports the quota as applied once setquota succeeds', async () => {
    app.agent.set('user.set_quota', (args) => args);
    const res = await patch('/accounts/alice', { diskQuotaMb: 4096 });
    expect(res.status).toBe(200);
    expect(res.body.data.quota).toEqual({ status: 'applied', detail: '4096 MB on /', filesystem: '/' });
    expect(app.agent.callsTo('user.set_quota').at(-1).args).toEqual({ username: 'alice', softMb: 4096, hardMb: 4301, filesystem: '/' });
    const unchanged = await patch('/accounts/alice', { contactEmail: 'alice@alice.com' });
    expect(unchanged.status).toBe(200);
    expect(unchanged.body.data.quota).toBeUndefined();
  });

  it('still rolls back when another provisioning step fails', async () => {
    app.agent.fail('fs.mkdir', 'command_failed', '"mkdir" exited with status 1: disk full');
    try {
      const res = await post('/accounts', { username: 'bob', domain: 'bob.com' });
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.body.error.code).toBe('command_failed');
      expect(app.agent.callsTo('user.delete').map((c) => c.args)).toEqual([{ username: 'bob', removeHome: true }]);
      expect(app.ctx.db.prepare('SELECT 1 FROM accounts WHERE username = ?').get('bob')).toBeUndefined();
    } finally {
      app.agent.reset('fs.mkdir');
    }
  });
});
