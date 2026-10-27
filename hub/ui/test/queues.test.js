import { describe, it, expect, vi } from 'vitest';
import { decideVerification, decideReview, normalizeReasons, VERIFICATION_REJECT_CODES, REVIEW_REASON_CODES } from '../src/pages/admin/queues.js';
import { createApiClient } from '../src/api/client.js';
import { mockApi } from './support.jsx';

describe('developer verification queue flow', () => {
  it('approves with an optional note on the approve route', async () => {
    const api = mockApi({ 'POST /admin/market/verifications/dev_01/approve': { data: { id: 'dev_01', status: 'verified' } } });
    const out = await decideVerification(api, 'dev_01', 'approve', { note: 'evidence passed' });
    expect(out.status).toBe('verified');
    expect(api.calls).toEqual([{ method: 'POST', path: '/admin/market/verifications/dev_01/approve', body: { note: 'evidence passed' } }]);
    await decideVerification(api, 'dev_01', 'approve');
    expect(api.calls[1].body).toEqual({});
  });

  it('rejects only with one of the structured reason codes', async () => {
    const api = mockApi({ 'POST /admin/market/verifications/dev_01/reject': { data: { id: 'dev_01', status: 'rejected' } } });
    await expect(decideVerification(api, 'dev_01', 'reject', { text: 'nope' })).rejects.toMatchObject({ code: 'flow_invalid', fields: { code: expect.any(Array) } });
    await expect(decideVerification(api, 'dev_01', 'reject', { code: 'because' })).rejects.toMatchObject({ code: 'flow_invalid' });
    expect(api.calls).toHaveLength(0);
    const out = await decideVerification(api, 'dev_01', 'reject', { code: 'evidence_failed', text: 'TXT record missing' });
    expect(out.status).toBe('rejected');
    expect(api.calls[0].body).toEqual({ code: 'evidence_failed', text: 'TXT record missing' });
    expect(VERIFICATION_REJECT_CODES.map((c) => c.value)).toEqual(['duplicate_identity', 'evidence_failed', 'namespace_conflict', 'policy']);
  });

  it('requests more evidence and refuses unknown decisions or a missing id', async () => {
    const api = mockApi({ 'POST /admin/market/verifications/dev_01/request-evidence': { data: { requested: true } } });
    await decideVerification(api, 'dev_01', 'request-evidence', { text: 'Add the TXT record' });
    expect(api.calls[0].body).toEqual({ text: 'Add the TXT record' });
    await expect(decideVerification(api, 'dev_01', 'ban')).rejects.toThrow(/Unknown verification decision/);
    await expect(decideVerification(api, '', 'approve')).rejects.toThrow(/id is required/);
  });
});

describe('plugin review queue flow', () => {
  it('approves with notes and checklist and reports a pending second reviewer', async () => {
    const api = mockApi({ 'POST /admin/market/reviews/rev_01/approve': { data: { id: 'rev_01', state: 'open', pending_second_reviewer: true } } });
    const out = await decideReview(api, 'rev_01', 'approve', { notes: 'looks fine', checklist: { manifest_ok: true } });
    expect(out.pending_second_reviewer).toBe(true);
    expect(api.calls[0]).toEqual({ method: 'POST', path: '/admin/market/reviews/rev_01/approve', body: { notes: 'looks fine', checklist: { manifest_ok: true } } });
  });

  it('request-changes and reject need at least one well-formed reason', async () => {
    const api = mockApi({ 'POST /admin/market/reviews/rev_01/request-changes': { data: { state: 'changes_requested' } }, 'POST /admin/market/reviews/rev_01/reject': { data: { state: 'rejected' } } });
    await expect(decideReview(api, 'rev_01', 'request-changes', { reasons: [] })).rejects.toMatchObject({ code: 'flow_invalid', fields: { reasons: expect.any(Array) } });
    await expect(decideReview(api, 'rev_01', 'reject', { reasons: [{ code: 'Bad Code', text: 'x' }] })).rejects.toMatchObject({ code: 'flow_invalid' });
    await expect(decideReview(api, 'rev_01', 'reject', { reasons: [{ code: 'policy', text: '' }] })).rejects.toMatchObject({ code: 'flow_invalid' });
    expect(api.calls).toHaveLength(0);
    const out = await decideReview(api, 'rev_01', 'request-changes', { reasons: [{ code: 'undeclared_permission', path: 'main.js:88', text: 'declare net:outbound:cdn.acme.test' }, { code: '', path: '', text: '' }], notes: 'see line 88' });
    expect(out.state).toBe('changes_requested');
    expect(api.calls[0].body).toEqual({ reasons: [{ code: 'undeclared_permission', path: 'main.js:88', text: 'declare net:outbound:cdn.acme.test' }], notes: 'see line 88' });
    await decideReview(api, 'rev_01', 'reject', { reasons: [{ code: 'security', text: 'ships a miner' }] });
    expect(api.calls[1].body).toEqual({ reasons: [{ code: 'security', text: 'ships a miner' }] });
    expect(REVIEW_REASON_CODES).toContain('undeclared_permission');
    expect(normalizeReasons([{ code: 'other', text: 'x', path: '' }])).toEqual([{ code: 'other', text: 'x' }]);
  });

  it('runs end to end through the real client: step-up re-prompt, retry, then the decision lands', async () => {
    const answers = [
      { status: 403, body: { error: { code: 'totp_stepup_required', message: 'Confirm your TOTP code to continue' } } },
      { status: 200, body: { data: { id: 'rev_01', state: 'approved' } } },
    ];
    const fetchImpl = vi.fn(async () => { const a = answers.shift(); return { ok: a.status < 300, status: a.status, text: async () => JSON.stringify(a.body) }; });
    const api = createApiClient({ fetchImpl });
    const prompts = [];
    api.setStepUpHandler(async (err, info) => { prompts.push(info.path); return true; });
    const out = await decideReview(api, 'rev_01', 'approve', { notes: 'ok' });
    expect(out.state).toBe('approved');
    expect(prompts).toEqual(['/admin/market/reviews/rev_01/approve']);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
