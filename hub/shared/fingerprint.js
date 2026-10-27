import crypto from 'node:crypto';

// Component weights of §16.5, kept in tenths so drift sums are exact.
export const WEIGHTS = { machine_id: 0.5, mac: 0.3, disk: 0.2 };
const TENTHS = { machine_id: 5, mac: 3, disk: 2 };
export const COMPONENTS = Object.keys(WEIGHTS);
export const DRIFT_THRESHOLD = 0.5;

// drift(stored, next) -> sum of the weights of the components that changed. A
// component missing on either side counts as changed.
export function drift(stored = {}, next = {}) {
  let tenths = 0;
  for (const c of COMPONENTS) {
    if (!stored?.[c] || !next?.[c] || stored[c] !== next[c]) tenths += TENTHS[c];
  }
  return tenths / 10;
}

// Composite fingerprint over the already-hashed components (the panel hashes
// raw identifiers before they leave the server, so no raw value reaches here).
export function composite(components) {
  const h = crypto.createHash('sha256').update(`whmfp1|${components.machine_id}|${components.mac}|${components.disk}`).digest('hex');
  return `sha256:${h}`;
}

export function isSameServer(score) {
  return score <= DRIFT_THRESHOLD;
}
