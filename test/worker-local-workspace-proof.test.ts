import { describe, expect, it, vi } from 'vitest';
import { loadWorkerFunction } from './helpers/worker-function-harness.js';

function rejected(input: {
  backendType: 'pty' | 'tmux' | 'riff';
  validate: boolean;
  effectiveProof?: object;
}): boolean {
  const target = {
    validateWorkingDirBeforeBusinessInput: vi.fn(() => input.validate),
    effectiveWorkspaceProof: vi.fn(() => input.effectiveProof),
  };
  return loadWorkerFunction<(target: typeof target) => boolean>('writeBackendWorkingDirRejected', {
    lastInitConfig: { expectedWorkingDirIdentity: { dev: '1', ino: '2' }, backendType: input.backendType },
    backendRequiresEffectiveWorkspaceProof: (backendType: string | undefined) =>
      backendType === 'riff' || backendType === 'mojo' || backendType === 'remote-runner',
  })(target);
}

describe('local group workspace proof at worker write edge', () => {
  it.each(['pty', 'tmux'] as const)('accepts %s after exact local cwd validation without remote proof', backendType => {
    expect(rejected({ backendType, validate: true })).toBe(false);
  });

  it('still rejects a local backend whose cwd validation fails', () => {
    expect(rejected({ backendType: 'pty', validate: false })).toBe(true);
  });

  it('requires effective-context proof for a remote Riff backend', () => {
    expect(rejected({ backendType: 'riff', validate: true })).toBe(true);
    expect(rejected({ backendType: 'riff', validate: true, effectiveProof: { kind: 'riff-repository' } })).toBe(false);
  });
});
