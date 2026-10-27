// The two admin queues' decisions as plain functions over an api client, so
// the flows are testable without a DOM and the pages stay thin. Every call
// here hits a step-up (†) route: the client re-prompts for TOTP and retries.

export const VERIFICATION_REJECT_CODES = [
  { value: 'duplicate_identity', label: 'Duplicate identity' },
  { value: 'evidence_failed', label: 'Evidence failed' },
  { value: 'namespace_conflict', label: 'Namespace conflict' },
  { value: 'policy', label: 'Policy' },
];

export const REVIEW_REASON_CODES = ['undeclared_permission', 'unjustified_permission', 'scan_reject', 'scan_flag', 'typosquat', 'quality', 'policy', 'security', 'other'];

export class FlowError extends Error {
  constructor(message, fields = null) { super(message); this.code = 'flow_invalid'; this.fields = fields; }
}

export async function decideVerification(api, id, decision, { note, code, text } = {}) {
  if (!id) throw new FlowError('A verification id is required');
  switch (decision) {
    case 'approve':
      return (await api.post(`/admin/market/verifications/${id}/approve`, note ? { note } : {})).data;
    case 'reject':
      if (!VERIFICATION_REJECT_CODES.some((c) => c.value === code)) throw new FlowError('A rejection needs a structured reason code', { code: ['Pick one of the reason codes'] });
      return (await api.post(`/admin/market/verifications/${id}/reject`, text ? { code, text } : { code })).data;
    case 'request-evidence':
      return (await api.post(`/admin/market/verifications/${id}/request-evidence`, text ? { text } : {})).data;
    default:
      throw new FlowError(`Unknown verification decision "${decision}"`);
  }
}

// reasons: [{ code, path?, text }] — the hub requires ≥ 1 for request-changes/reject.
export function normalizeReasons(reasons) {
  const list = (Array.isArray(reasons) ? reasons : []).map((r) => ({ code: String(r.code || '').trim(), path: r.path ? String(r.path).trim() : undefined, text: String(r.text || '').trim() })).filter((r) => r.code || r.text);
  const bad = list.filter((r) => !/^[a-z_]{2,40}$/.test(r.code) || !r.text);
  if (!list.length) throw new FlowError('Give the developer at least one structured reason', { reasons: ['At least one reason is required'] });
  if (bad.length) throw new FlowError('Every reason needs a code (lower-case, underscores) and a text', { reasons: ['Fill in code and text for every reason'] });
  return list.map((r) => (r.path ? r : { code: r.code, text: r.text }));
}

export async function decideReview(api, id, decision, { notes, checklist, reasons } = {}) {
  if (!id) throw new FlowError('A review id is required');
  switch (decision) {
    case 'approve':
      return (await api.post(`/admin/market/reviews/${id}/approve`, { ...(notes ? { notes } : {}), ...(checklist ? { checklist } : {}) })).data;
    case 'request-changes':
      return (await api.post(`/admin/market/reviews/${id}/request-changes`, { reasons: normalizeReasons(reasons), ...(notes ? { notes } : {}) })).data;
    case 'reject':
      return (await api.post(`/admin/market/reviews/${id}/reject`, { reasons: normalizeReasons(reasons), ...(notes ? { notes } : {}) })).data;
    default:
      throw new FlowError(`Unknown review decision "${decision}"`);
  }
}
