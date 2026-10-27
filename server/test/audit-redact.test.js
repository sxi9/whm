import { describe, it, expect } from 'vitest';
import { redact } from '../src/middleware/audit.js';

describe('audit redaction', () => {
  it('summarises raw upload bodies instead of serialising every byte', () => {
    expect(redact(Buffer.alloc(512 * 1024))).toEqual({ bytes: 524288 });
    expect(redact({ logo: new Uint8Array(16), name: 'x' })).toEqual({ logo: { bytes: 16 }, name: 'x' });
  });

  it('still masks secret-looking keys and truncates long strings', () => {
    const out = redact({ password: 'hunter2', note: 'a'.repeat(600) });
    expect(out.password).toBe('[redacted]');
    expect(out.note.length).toBeLessThan(600);
  });
});
