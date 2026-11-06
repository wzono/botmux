import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { authoritativeWorkerWorkspaceIdentity, backendMatchesFrozen, dispatchAdmittedBusinessTurn, frozenSessionWorkspace } from '../src/core/admitted-turn-dispatch.js';
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

  it('freezes an admitted home-relative session cwd using the launch-time expansion contract', () => {
    expect(frozenSessionWorkspace({
      session: { sessionId: 's', workingDir: '~', workingDirSource: 'explicit' },
      workingDir: '~',
    } as never)?.workspace.path).toBe(realpathSync(process.env.HOME!));
  });

  it('accepts a persisted absolute symlink alias when its canonical inode is unchanged', () => {
    const root = mkdtempSync(join(tmpdir(), 'admitted-group-alias-'));
    const actual = join(root, 'actual');
    const alias = join(root, 'alias');
    mkdirSync(actual);
    symlinkSync(actual, alias);
    const proof = probePathUsability(alias);
    expect(proof.ok).toBe(true);
    if (!proof.ok) throw new Error('expected usable alias');

    expect(frozenSessionWorkspace({
      session: {
        sessionId: 's', workingDir: alias, workingDirSource: 'group', groupWorkspaceRevision: 7,
        groupWorkspaceIdentity: { path: alias, ...proof.identity },
      },
      workingDir: alias,
    } as never)).toEqual({
      workspace: { path: alias, ...proof.identity },
      groupRevision: 7,
    });
  });

  it('accepts a group alias only when the backend proves its canonical target', () => {
    const root = mkdtempSync(join(tmpdir(), 'admitted-group-backend-alias-'));
    const actual = join(root, 'actual'); const alias = join(root, 'alias'); const other = join(root, 'other');
    mkdirSync(actual); mkdirSync(other); symlinkSync(actual, alias);
    const proof = probePathUsability(actual);
    expect(proof.ok).toBe(true);
    if (!proof.ok) throw new Error('expected usable target');
    const ds = { session: { workingDirSource: 'group' } } as never;
    expect(backendMatchesFrozen(ds, { path: realpathSync(actual), ...proof.identity },
      { path: alias, ...proof.identity })).toBe(true);
    expect(backendMatchesFrozen(ds, { path: realpathSync(other), ...proof.identity },
      { path: alias, ...proof.identity })).toBe(false);
  });

  it('rejects changed inode and retargeted group aliases', () => {
    const root = mkdtempSync(join(tmpdir(), 'admitted-group-retarget-'));
    const actual = join(root, 'actual'); const replacement = join(root, 'replacement'); const alias = join(root, 'alias');
    mkdirSync(actual); mkdirSync(replacement); symlinkSync(actual, alias);
    const proof = probePathUsability(alias);
    expect(proof.ok).toBe(true);
    if (!proof.ok) throw new Error('expected usable alias');
    const session = { sessionId: 's', workingDir: alias, workingDirSource: 'group', groupWorkspaceRevision: 7,
      groupWorkspaceIdentity: { path: alias, ...proof.identity } };
    expect(frozenSessionWorkspace({ session, workingDir: alias } as never)).toBeDefined();
    rmSync(alias); symlinkSync(replacement, alias);
    expect(frozenSessionWorkspace({ session, workingDir: alias } as never)).toBeUndefined();
  });

  it('rejects a different alias spelling even when it resolves to the same inode', () => {
    const root = mkdtempSync(join(tmpdir(), 'admitted-group-wrong-alias-'));
    const actual = join(root, 'actual');
    const sessionAlias = join(root, 'session-alias');
    const persistedAlias = join(root, 'persisted-alias');
    mkdirSync(actual);
    symlinkSync(actual, sessionAlias);
    symlinkSync(actual, persistedAlias);
    const proof = probePathUsability(sessionAlias);
    expect(proof.ok).toBe(true);
    if (!proof.ok) throw new Error('expected usable alias');
    expect(frozenSessionWorkspace({
      session: { sessionId: 's', workingDir: sessionAlias, workingDirSource: 'group', groupWorkspaceRevision: 7,
        groupWorkspaceIdentity: { path: persistedAlias, ...proof.identity } },
      workingDir: sessionAlias,
    } as never)).toBeUndefined();
  });

  it('keeps exact backend path matching for non-group sessions', () => {
    const frozen = { path: '/canonical/frozen', dev: '1', ino: '2' };
    expect(backendMatchesFrozen({ session: { workingDirSource: 'explicit' } } as never,
      { path: '/different/alias', dev: '1', ino: '2' }, frozen)).toBe(false);
    expect(backendMatchesFrozen({ session: { workingDirSource: 'explicit' } } as never,
      { ...frozen }, frozen)).toBe(true);
  });

  it('does not prove a blank worker ready when its backend path mismatches the frozen group alias', async () => {
    const root = mkdtempSync(join(tmpdir(), 'admitted-blank-backend-'));
    const actual = join(root, 'actual'); const alias = join(root, 'alias'); const other = join(root, 'other');
    mkdirSync(actual); mkdirSync(other); symlinkSync(actual, alias);
    const proof = probePathUsability(alias);
    expect(proof.ok).toBe(true);
    if (!proof.ok) throw new Error('expected usable alias');
    const ds: any = { session: { sessionId: 's', workingDir: alias, workingDirSource: 'group', groupWorkspaceRevision: 7,
      groupWorkspaceIdentity: { path: alias, ...proof.identity }, backendType: 'pty' },
      initConfig: { backendType: 'pty' }, workingDir: alias };
    const proveReady = vi.fn(async () => ({ status: 'issued' }));
    const accepted = await dispatchAdmittedBusinessTurn({
      ds, turnId: 'turn', payload: 'payload', options: { resume: false },
      boundary: {
        reserveGeneration: () => 1,
        forkBlank: async () => { ds.workerGeneration = 1; ds.workerReady = true; ds.cliReady = true; ds.lastWorkerReadyCwd = other; return 'started'; },
        submit: async () => true,
      },
      permitStore: {
        issueBlank: async input => ({ ...input, permitId: 'blank' }) as never,
        proveReady,
        issueBusiness: async () => undefined,
        abortBootstrap: async () => ({ status: 'aborted' }) as never,
        abortBusinessDispatch: async () => ({ status: 'aborted' }) as never,
      },
    });
    expect(accepted).toBe(false);
    expect(proveReady).not.toHaveBeenCalled();
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
