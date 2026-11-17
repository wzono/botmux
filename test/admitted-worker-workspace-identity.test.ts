import { mkdtempSync, mkdirSync, realpathSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { authoritativeWorkerWorkspaceIdentity, dispatchAdmittedBusinessTurn } from '../src/core/admitted-turn-dispatch.js';
import { probePathUsability } from '../src/core/path-usability.js';

function localSession(cwd: string) {
  return {
    session: { sessionId: 's', backendType: 'pty' },
    initConfig: { backendType: 'pty' },
    lastWorkerReadyCwd: cwd,
  } as never;
}

describe('authoritative existing-worker workspace identity', () => {
  it('canonicalizes local symlink aliases to the same real path and inode', () => {
    const root = mkdtempSync(join(tmpdir(), 'admitted-workspace-'));
    const actual = join(root, 'actual');
    const alias = join(root, 'alias');
    mkdirSync(actual);
    symlinkSync(actual, alias);
    const identity = authoritativeWorkerWorkspaceIdentity(localSession(alias));
    const expected = probePathUsability(actual);
    expect(expected.ok).toBe(true);
    if (!expected.ok) throw new Error('expected usable path');
    expect(identity).toEqual({ path: realpathSync(actual), ...expected.identity });
  });

  it('fails closed for remote-runner because broker cwd is not provider workspace proof', () => {
    const root = mkdtempSync(join(tmpdir(), 'admitted-remote-runner-'));
    const proof = probePathUsability(root);
    expect(proof.ok).toBe(true);
    if (!proof.ok) throw new Error('expected usable path');
    expect(authoritativeWorkerWorkspaceIdentity({
      session: { sessionId: 's', backendType: 'remote-runner' }, initConfig: { backendType: 'remote-runner' },
      lastWorkerReadyCwd: root,
    } as never)).toBeUndefined();
  });

  it('requires an authoritative host contract for remote execution backends', () => {
    const root = mkdtempSync(join(tmpdir(), 'admitted-remote-workspace-'));
    expect(authoritativeWorkerWorkspaceIdentity({
      session: { sessionId: 's', backendType: 'riff' }, initConfig: { backendType: 'riff' },
      lastWorkerReadyCwd: root,
    } as never)).toBeUndefined();
  });

  it('canonicalizes and validates a remote host contract identity', () => {
    const root = mkdtempSync(join(tmpdir(), 'admitted-remote-workspace-'));
    const actual = join(root, 'actual');
    const alias = join(root, 'alias');
    mkdirSync(actual);
    symlinkSync(actual, alias);
    const proof = probePathUsability(actual);
    expect(proof.ok).toBe(true);
    if (!proof.ok) throw new Error('expected usable path');
    expect(authoritativeWorkerWorkspaceIdentity({
      session: { sessionId: 's', backendType: 'mojo' }, initConfig: { backendType: 'mojo' },
      lastWorkerReadyHostWorkingDirContract: { workingDir: alias, identity: proof.identity },
    } as never)).toEqual({ path: realpathSync(actual), ...proof.identity });
    expect(authoritativeWorkerWorkspaceIdentity({
      session: { sessionId: 's', backendType: 'mojo' }, initConfig: { backendType: 'mojo' },
      lastWorkerReadyHostWorkingDirContract: { workingDir: alias, identity: { ...proof.identity, ino: 'wrong' } },
    } as never)).toBeUndefined();
  });

  it('fails closed when live-worker backend identity mismatches the frozen workspace', async () => {
    const root = mkdtempSync(join(tmpdir(), 'admitted-live-mismatch-'));
    const frozen = join(root, 'frozen');
    const other = join(root, 'other');
    mkdirSync(frozen); mkdirSync(other);
    const frozenProof = probePathUsability(frozen);
    expect(frozenProof.ok).toBe(true);
    if (!frozenProof.ok) throw new Error('expected usable path');
    const submit = async () => true;
    const accepted = await dispatchAdmittedBusinessTurn({
      ds: {
        session: { sessionId: 's', workingDir: frozen, backendType: 'pty', workerGeneration: 4 },
        initConfig: { backendType: 'pty' }, workingDir: frozen, workerGeneration: 4,
        worker: { killed: false }, workerReady: true, cliReady: true, lastWorkerReadyCwd: other,
      } as never,
      turnId: 'turn', payload: 'payload', options: { resume: true },
      boundary: { reserveGeneration: () => 5, forkBlank: async () => false, submit },
      permitStore: {
        issueBlank: async input => ({ ...input, permitId: 'blank' }) as never,
        proveReady: async () => ({ status: 'rejected' }) as never,
        issueBusiness: async input => ({ ...input, permitId: 'business', bootstrapPermitId: 'blank' }) as never,
        abortBootstrap: async () => ({ status: 'rejected' }) as never,
      } as never,
    });
    expect(accepted).toBe(false);
  });

  it('rejects remote host testimony on a local backend context', () => {
    const root = mkdtempSync(join(tmpdir(), 'admitted-local-workspace-'));
    const proof = probePathUsability(root);
    expect(proof.ok).toBe(true);
    if (!proof.ok) throw new Error('expected usable path');
    expect(authoritativeWorkerWorkspaceIdentity({
      session: { sessionId: 's', backendType: 'pty' }, initConfig: { backendType: 'pty' },
      lastWorkerReadyCwd: root,
      lastWorkerReadyHostWorkingDirContract: { workingDir: root, identity: proof.identity },
    } as never)).toBeUndefined();
  });
});
