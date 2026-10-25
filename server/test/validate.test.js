import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import { fields, pagination, validate, z } from '../src/lib/validate.js';
import { errorHandler } from '../src/middleware/error.js';

const ok = (schema, value) => schema.safeParse(value).success;
const parsed = (schema, value) => schema.parse(value);

describe('fields', () => {
  it('username only allows safe lowercase identifiers', () => {
    expect(ok(fields.username, 'web01')).toBe(true);
    expect(ok(fields.username, 'a')).toBe(true);
    expect(ok(fields.username, 'a_b-c9')).toBe(true);
    expect(ok(fields.username, 'a'.repeat(32))).toBe(true);
    expect(ok(fields.username, '-r')).toBe(false);
    expect(ok(fields.username, 'Root')).toBe(false);
    expect(ok(fields.username, 'a;b')).toBe(false);
    expect(ok(fields.username, 'a b')).toBe(false);
    expect(ok(fields.username, '1abc')).toBe(false);
    expect(ok(fields.username, '')).toBe(false);
    expect(ok(fields.username, 'a'.repeat(33))).toBe(false);
    expect(ok(fields.username, 'a\nb')).toBe(false);
  });

  it('domain requires a fully-qualified name and lowercases it', () => {
    expect(ok(fields.domain, 'example.com')).toBe(true);
    expect(ok(fields.domain, 'a.b.example.co.uk')).toBe(true);
    expect(parsed(fields.domain, 'Sub.Example.COM')).toBe('sub.example.com');
    expect(ok(fields.domain, 'localhost')).toBe(false);
    expect(ok(fields.domain, '-bad.com')).toBe(false);
    expect(ok(fields.domain, 'bad-.com')).toBe(false);
    expect(ok(fields.domain, 'exa mple.com')).toBe(false);
    expect(ok(fields.domain, 'example.c0m')).toBe(false);
    expect(ok(fields.domain, 'example.com;ls')).toBe(false);
    expect(ok(fields.domain, `${'a'.repeat(64)}.com`)).toBe(false);
  });

  it('hostname accepts numeric last labels but still needs a dot', () => {
    expect(ok(fields.hostname, 'host1.example.com')).toBe(true);
    expect(ok(fields.hostname, 'a.b')).toBe(true);
    expect(ok(fields.hostname, 'srv.lan1')).toBe(true);
    expect(ok(fields.hostname, 'server')).toBe(false);
    expect(ok(fields.hostname, 'a..b')).toBe(false);
    expect(ok(fields.hostname, 'a.b c')).toBe(false);
    expect(ok(fields.hostname, 'srv.-x')).toBe(false);
    expect(ok(fields.hostname, 'srv.x-')).toBe(false);
    expect(ok(fields.hostname, '-srv.example.com')).toBe(false);
  });

  it('ip, ipv4 and ipv6 validate addresses', () => {
    expect(ok(fields.ip, '10.0.0.5')).toBe(true);
    expect(ok(fields.ip, '::1')).toBe(true);
    expect(ok(fields.ip, '999.1.1.1')).toBe(false);
    expect(ok(fields.ip, '10.0.0.5 ')).toBe(false);
    expect(ok(fields.ipv4, '192.168.1.1')).toBe(true);
    expect(ok(fields.ipv4, '::1')).toBe(false);
    expect(ok(fields.ipv6, '2001:db8::1')).toBe(true);
    expect(ok(fields.ipv6, '10.0.0.5')).toBe(false);
  });

  it('email and password have sane bounds', () => {
    expect(ok(fields.email, 'a@b.co')).toBe(true);
    expect(ok(fields.email, 'nope')).toBe(false);
    expect(ok(fields.email, `${'a'.repeat(250)}@b.co`)).toBe(false);
    expect(ok(fields.password, 'Secret-1')).toBe(true);
    expect(ok(fields.password, 'short')).toBe(false);
    expect(ok(fields.password, 'x'.repeat(129))).toBe(false);
  });

  it('absPath rejects relative paths and ".." segments', () => {
    expect(ok(fields.absPath, '/home/x')).toBe(true);
    expect(ok(fields.absPath, '/')).toBe(true);
    expect(ok(fields.absPath, '/home/x/..hidden')).toBe(true);
    expect(ok(fields.absPath, '/home/x/../etc')).toBe(false);
    expect(ok(fields.absPath, '/home/x/..')).toBe(false);
    expect(ok(fields.absPath, '/../etc')).toBe(false);
    expect(ok(fields.absPath, '/..')).toBe(false);
    expect(ok(fields.absPath, '/home/x\n/../etc')).toBe(false);
    expect(ok(fields.absPath, 'home/x')).toBe(false);
    expect(ok(fields.absPath, '')).toBe(false);
    expect(ok(fields.absPath, '/home/x\0y')).toBe(false);
  });

  it('cron requires five whitespace-separated fields', () => {
    expect(ok(fields.cron, '0 2 * * *')).toBe(true);
    expect(ok(fields.cron, '0  2 * * *')).toBe(true);
    expect(ok(fields.cron, '*/5 9-17 * * mon-fri')).toBe(true);
    expect(ok(fields.cron, '0 2 * *')).toBe(false);
    expect(ok(fields.cron, '0 2 * * * *')).toBe(false);
    expect(ok(fields.cron, '')).toBe(false);
  });

  it('packageName, dbName, shell and id', () => {
    expect(ok(fields.packageName, 'Gold Plan 2.0')).toBe(true);
    expect(ok(fields.packageName, '-gold')).toBe(false);
    expect(ok(fields.packageName, 'gold;rm')).toBe(false);
    expect(ok(fields.dbName, 'web01_shop')).toBe(true);
    expect(ok(fields.dbName, 'Web01')).toBe(false);
    expect(ok(fields.shell, '/bin/bash')).toBe(true);
    expect(ok(fields.shell, '/bin/zsh')).toBe(false);
    expect(parsed(fields.id, '42')).toBe(42);
    expect(ok(fields.id, '0')).toBe(false);
    expect(ok(fields.id, 'x')).toBe(false);
  });

  it('pagination coerces and defaults', () => {
    expect(parsed(pagination, {})).toEqual({ page: 1, pageSize: 50, dir: 'asc' });
    expect(parsed(pagination, { page: '3', pageSize: '10', q: '  web ', sort: 'username', dir: 'desc' })).toEqual({ page: 3, pageSize: 10, q: 'web', sort: 'username', dir: 'desc' });
    expect(ok(pagination, { pageSize: '501' })).toBe(false);
    expect(ok(pagination, { sort: 'name; drop' })).toBe(false);
    expect(ok(pagination, { dir: 'sideways' })).toBe(false);
  });
});

describe('validate() middleware', () => {
  const silentLogger = { error() {}, warn() {}, info() {}, debug() {} };
  const app = express();
  app.use(express.json());
  app.post('/users', validate({ body: z.object({ username: fields.username, email: fields.email, nested: z.object({ ip: fields.ip }).optional() }).strict() }), (req, res) => res.json({ data: req.body }));
  app.get('/list', validate({ query: pagination }), (req, res) => res.json({ data: req.query }));
  app.get('/items/:id', validate({ params: z.object({ id: fields.id }) }), (req, res) => res.json({ data: req.params }));
  app.use(errorHandler(silentLogger));

  it('returns 422 with field-level errors for an invalid body', async () => {
    const res = await request(app).post('/users').send({ username: 'Bad User', email: 'nope', nested: { ip: '1.2.3' }, extra: true });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('validation_failed');
    expect(res.body.error.fields.username).toEqual([expect.stringContaining('Lowercase')]);
    expect(res.body.error.fields.email).toHaveLength(1);
    expect(res.body.error.fields['nested.ip']).toHaveLength(1);
    expect(res.body.error.fields._).toEqual([expect.stringMatching(/unrecognized/i)]);
  });

  it('passes a valid body through unchanged', async () => {
    const res = await request(app).post('/users').send({ username: 'web01', email: 'a@b.co' });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ username: 'web01', email: 'a@b.co' });
  });

  it('replaces query and params with coerced, defaulted values', async () => {
    const list = await request(app).get('/list?page=2&pageSize=10&q=web');
    expect(list.status).toBe(200);
    expect(list.body.data).toEqual({ page: 2, pageSize: 10, q: 'web', dir: 'asc' });

    const item = await request(app).get('/items/7');
    expect(item.body.data).toEqual({ id: 7 });

    const bad = await request(app).get('/items/seven');
    expect(bad.status).toBe(422);
    expect(bad.body.error.fields.id).toHaveLength(1);
  });

  it('rejects malformed JSON with 400 bad_json', async () => {
    const res = await request(app).post('/users').set('Content-Type', 'application/json').send('{"username":');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('bad_json');
  });
});
