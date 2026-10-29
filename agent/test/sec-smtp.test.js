import { describe, it, expect, vi } from 'vitest';
import { runOp, createContext } from '../src/lib.js';

// iptables-nft (iptables ≥ 1.8 on nf_tables) refuses a REJECT rule that uses
// --reject-with tcp-reset unless the rule itself carries -p tcp, even inside a
// chain only reachable for tcp/25: "RULE_APPEND failed (Invalid argument)".
vi.mock('../src/exec.js', async (importOriginal) => {
  const mod = await importOriginal();
  return {
    ...mod,
    hasBinary: vi.fn((name) => ['iptables', 'ip6tables'].includes(name)),
    exec: vi.fn(async (bin, argv) => ({ code: argv[0] === '-C' ? 1 : 0, stdout: '', stderr: '', bin, argv })),
  };
});
const { exec } = await import('../src/exec.js');

describe('sec.smtp_restrict.set on iptables', () => {
  it('appends the final REJECT with an explicit tcp match on both families', async () => {
    exec.mockClear();
    const result = await runOp('sec.smtp_restrict.set', { enabled: true }, createContext());
    expect(result.backend).toBe('iptables');
    const rejects = exec.mock.calls.filter(([, argv]) => argv[0] === '-A' && argv[1] === 'WHM_SMTP' && argv.includes('REJECT'));
    expect(rejects.map(([bin]) => bin).sort()).toEqual(['ip6tables', 'iptables']);
    for (const [, argv] of rejects) {
      expect(argv).toEqual(['-A', 'WHM_SMTP', '-p', 'tcp', '-j', 'REJECT', '--reject-with', 'tcp-reset']);
    }
    // The chain is still hooked from OUTPUT for tcp/25 only.
    const hooks = exec.mock.calls.filter(([, argv]) => argv[0] === '-I' && argv[1] === 'OUTPUT');
    expect(hooks).toHaveLength(2);
    for (const [, argv] of hooks) expect(argv).toEqual(['-I', 'OUTPUT', '1', '-p', 'tcp', '--dport', '25', '-j', 'WHM_SMTP']);
  });
});
