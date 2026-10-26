import { describe, it, expect } from 'vitest';
import { NODE_EDITABLE_KEYS, EMPTY_NODE, nodeFormValues, nodeRequestBody } from '../src/pages/server-configuration/nodes.js';

const ROW = { id: 7, name: 'dns-2', hostname: 'node2.example.com', port: 2087, scheme: 'https', username: 'root', verifyTls: false, roles: ['dns'], enabled: true, hasToken: true, status: 'ok', lastCheckedAt: '2026-10-26T10:00:00.000Z', lastError: null, remote: { hostname: 'node2' }, createdAt: 'x', updatedAt: 'y' };

describe('Link Server Nodes form helpers', () => {
  it('seeds the edit form with editable keys only and an empty token', () => {
    expect(nodeFormValues(null)).toEqual(EMPTY_NODE);
    const values = nodeFormValues(ROW);
    expect(Object.keys(values).sort()).toEqual([...NODE_EDITABLE_KEYS, 'token'].sort());
    expect(values).toMatchObject({ name: 'dns-2', verifyTls: false, roles: ['dns'], token: '' });
  });

  it('sends only what the strict API schema accepts', () => {
    const form = { ...nodeFormValues(ROW), id: 7, status: 'ok', remote: {} };
    const update = nodeRequestBody(form, { editing: true });
    expect(Object.keys(update).sort()).toEqual([...NODE_EDITABLE_KEYS].sort());
    expect(nodeRequestBody({ ...form, token: 'new-token-value-1234' }, { editing: true }).token).toBe('new-token-value-1234');
    const create = nodeRequestBody({ ...EMPTY_NODE, name: 'n', hostname: 'h.example.com', token: 't'.repeat(20) }, { editing: false });
    expect(create.token).toBe('t'.repeat(20));
    expect(create).not.toHaveProperty('id');
  });
});
