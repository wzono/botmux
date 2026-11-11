import { describe, expect, it, vi } from 'vitest';
import { loadWorkerFunction } from './helpers/worker-function-harness.js';
import { workerSubmitHarness } from './helpers/worker-submit-harness.js';
import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

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
    canWriteTerminalBytes: () => true,
    lastInitConfig: { expectedWorkingDirIdentity: { dev: '1', ino: '2' }, backendType: input.backendType },
    backendRequiresEffectiveWorkspaceProof: (backendType: string | undefined) =>
      backendType === 'riff' || backendType === 'mojo' || backendType === 'remote-runner',
  })(target);
}

describe('local group workspace proof at worker write edge', () => {
  it.each(['revision', 'expiry'] as const)('withholds adopt Enter after %s changes following pasted text without claiming unsent', async change => {
    const directory = mkdtempSync(join(tmpdir(), 'worker-adopt-partial-'));
    vi.useFakeTimers();
    try {
      const st = statSync(directory, { bigint: true });
      const workspaceIdentity = { path: realpathSync(directory), dev: String(st.dev), ino: String(st.ino) };
      const { scope } = workerSubmitHarness();
      const target = { getChildPid: () => 123, sendText: vi.fn(), sendSpecialKeys: vi.fn() };
      Object.assign(scope, { backend: target, readCwd: () => directory,
        lastInitConfig: { sessionId: 'session', cliId: 'claude-code', workingDir: directory, workerGeneration: 7,
          terminalWorkspaceFence: { source: 'group', groupRevision: 1, workspaceIdentity } },
        currentTerminalWorkspaceFence: { source: 'group', groupRevision: 1, workspaceIdentity },
        rememberTurnLinkRefMode: vi.fn(), captureAdoptWriteFence: () => ({ backend: target }),
        adoptWriteFenceIsCurrent: () => true, adoptComposerConflict: () => undefined,
        isStructuredBridgeAdoptInputCli: () => false, codexBridgeFallbackActive: () => false,
      });
      const control = change === 'expiry' ? {
        controlDispatchId: 'dispatch', controlReplyDigest: 'digest',
        controlReplyGrant: { replyDigest: 'digest', payloadDigest: createHash('sha256').update('answer').digest('hex'),
          permit: { permitId: 'permit', sessionId: 'session', originalTurnId: 'original', expectedGeneration: 7,
            expiresAt: Date.now() + 100, controlDispatchId: 'dispatch', wait: { kind: 'ask', askId: 'ask' }, workspace: workspaceIdentity } },
      } : undefined;
      const write = loadWorkerFunction('writeAdoptMessage', scope);
      const writing = write('answer', 'turn', 1, undefined, undefined, undefined, undefined, control);
      expect(target.sendText).toHaveBeenCalledWith('answer');
      if (change === 'revision') scope.currentTerminalWorkspaceFence.groupRevision = 2;
      await vi.advanceTimersByTimeAsync(200);
      await writing;
      expect(target.sendSpecialKeys).not.toHaveBeenCalled();
      expect(scope.emitTurnTerminal).toHaveBeenCalledWith('turn', 'ambiguous', 'write_input_threw', 1);
      expect(scope.send).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'control_reply_rejected' }));
      expect(scope.send).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'turn_input_committed' }));
    } finally { vi.useRealTimers(); rmSync(directory, { recursive: true, force: true }); }
  });

  it('binds an explicitly launched inode only after authorized group convergence and flushes ordinary input', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'worker-convergence-'));
    try {
      const st = statSync(directory, { bigint: true });
      const workspaceIdentity = { path: realpathSync(directory), dev: String(st.dev), ino: String(st.ino) };
      const { scope, flush } = workerSubmitHarness();
      Object.assign(scope, {
        readCwd: () => directory,
        backend: { getChildPid: () => 123 },
        lastInitConfig: { sessionId: 'session', cliId: 'traex', workingDir: directory,
          workerGeneration: 7, launchWorkingDirSource: 'explicit', launchWorkspaceIdentity: workspaceIdentity },
        currentTerminalWorkspaceFence: { source: 'group', groupRevision: 2, workspaceIdentity,
          workerGeneration: 7, adoptLaunchIdentity: true },
      });
      scope.cliAdapter.writeInput.mockResolvedValue({ submitted: true });
      await flush();
      expect(scope.lastInitConfig.terminalWorkspaceFence).toEqual({ source: 'group', groupRevision: 2, workspaceIdentity });
      expect(scope.cliAdapter.writeInput).toHaveBeenCalledTimes(1);
      scope.currentTerminalWorkspaceFence.groupRevision = 3;
      expect(scope.canWriteTerminalBytes()).toBe(false);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it.each(['generation', 'inode', 'authority'] as const)('does not adopt a convergence with changed %s', change => {
    const directory = mkdtempSync(join(tmpdir(), 'worker-convergence-refused-'));
    try {
      const st = statSync(directory, { bigint: true });
      const workspaceIdentity = { path: realpathSync(directory), dev: String(st.dev), ino: String(st.ino) };
      const { scope } = workerSubmitHarness();
      Object.assign(scope, { readCwd: () => directory, backend: { getChildPid: () => 123 },
        lastInitConfig: { workingDir: directory, workerGeneration: 7,
          launchWorkingDirSource: 'explicit', launchWorkspaceIdentity: workspaceIdentity },
        currentTerminalWorkspaceFence: { source: 'group', groupRevision: 2, workspaceIdentity: { ...workspaceIdentity },
          workerGeneration: 7, adoptLaunchIdentity: true },
      });
      if (change === 'generation') scope.currentTerminalWorkspaceFence.workerGeneration = 8;
      if (change === 'authority') scope.currentTerminalWorkspaceFence.adoptLaunchIdentity = false;
      if (change === 'inode') scope.currentTerminalWorkspaceFence.workspaceIdentity.ino = 'different';
      expect(scope.canWriteTerminalBytes()).toBe(false);
      expect(scope.lastInitConfig.terminalWorkspaceFence).toBeUndefined();
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it('allows only an exact control grant on a retained worker after its group revision changes', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'worker-retained-control-'));
    try {
      const st = statSync(directory, { bigint: true });
      const workspaceIdentity = { path: realpathSync(directory), dev: String(st.dev), ino: String(st.ino) };
      const { scope, flush } = workerSubmitHarness();
      Object.assign(scope, { readCwd: () => directory, backend: { getChildPid: () => 123 },
        lastInitConfig: { sessionId: 'session', cliId: 'traex', workingDir: directory, workerGeneration: 7,
          terminalWorkspaceFence: { source: 'group', groupRevision: 1, workspaceIdentity } },
        currentTerminalWorkspaceFence: { source: 'group', groupRevision: 2, workspaceIdentity },
      });
      expect(scope.canWriteTerminalBytes()).toBe(false);
      await flush();
      expect(scope.cliAdapter.writeInput).not.toHaveBeenCalled();
      Object.assign(scope.pendingMessages[0], {
        controlDispatchId: 'dispatch', controlReplyDigest: 'reply',
        controlReplyGrant: { replyDigest: 'reply', payloadDigest: createHash('sha256').update('payload').digest('hex'),
          permit: { permitId: 'permit', sessionId: 'session', originalTurnId: 'original', expectedGeneration: 7,
            expiresAt: Date.now() + 60_000, controlDispatchId: 'dispatch', wait: { kind: 'ask', askId: 'ask' }, workspace: workspaceIdentity } },
      });
      scope.cliAdapter.writeInput.mockResolvedValue({ submitted: true });
      await flush();
      expect(scope.cliAdapter.writeInput).toHaveBeenCalledTimes(1);
      expect(scope.canWriteTerminalBytes()).toBe(false);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it('retains the control receipt tuple while the input waits in the normal queue', () => {
    const pendingMessages: unknown[] = [];
    const sendToPty = loadWorkerFunction('sendToPty', {
      rememberTurnLinkRefMode: vi.fn(), traexAutoModelRuntimeEligible: () => false,
      initPromptMaterialized: false, pendingMessages, log: vi.fn(),
    });
    expect(sendToPty('reply', 'codex-async-answer-dispatch', {
      controlDispatchId: 'dispatch', controlReplyDigest: 'digest', atMostOnce: true,
    })).toBe(true);
    expect(pendingMessages).toEqual([expect.objectContaining({
      turnId: 'codex-async-answer-dispatch', controlDispatchId: 'dispatch', controlReplyDigest: 'digest', noReplay: true,
    })]);
  });

  it.each(['inode', 'revision', 'source'] as const)('holds queued ordinary input when %s changes before actual flush', async change => {
    const root = mkdtempSync(join(tmpdir(), 'worker-queued-workspace-'));
    try {
      const directory = join(root, 'cwd'); mkdirSync(directory);
      const st = statSync(directory, { bigint: true });
      const workspaceIdentity = { path: directory, dev: String(st.dev), ino: String(st.ino) };
      const { scope, flush } = workerSubmitHarness();
      Object.assign(scope, { realpathSync, statSync,
        lastInitConfig: { cliId: 'traex', workingDir: directory, backendType: 'pty',
          expectedWorkingDirIdentity: workspaceIdentity,
          terminalWorkspaceFence: { source: 'group', groupRevision: 1, workspaceIdentity } },
        currentTerminalWorkspaceFence: { source: 'group', groupRevision: 1, workspaceIdentity },
      });
      scope.pendingMessages[0].queueAfterActiveTurn = true;
      scope.activeTurnBlocks = () => true;
      await flush();
      expect(scope.cliAdapter.writeInput).not.toHaveBeenCalled();
      if (change === 'inode') { renameSync(directory, directory + '-old'); mkdirSync(directory); }
      if (change === 'revision') scope.currentTerminalWorkspaceFence.groupRevision = 2;
      if (change === 'source') scope.currentTerminalWorkspaceFence.source = 'explicit';
      scope.activeTurnBlocks = () => false;
      await flush();
      expect(scope.cliAdapter.writeInput).not.toHaveBeenCalled();
      expect(scope.pendingMessages).toHaveLength(1);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('rechecks inode after the adapter transaction await, before the actual write', async () => {
    const root = mkdtempSync(join(tmpdir(), 'worker-write-workspace-'));
    try {
      const directory = join(root, 'cwd'); mkdirSync(directory);
      const st = statSync(directory, { bigint: true });
      const workspaceIdentity = { path: directory, dev: String(st.dev), ino: String(st.ino) };
      const { scope, flush } = workerSubmitHarness();
      Object.assign(scope, { realpathSync, statSync,
        lastInitConfig: { cliId: 'traex', workingDir: directory, backendType: 'pty',
          terminalWorkspaceFence: { source: 'group', groupRevision: 1, workspaceIdentity } },
        currentTerminalWorkspaceFence: { source: 'group', groupRevision: 1, workspaceIdentity },
      });
      scope.runAmbiguousSubmissionTransaction = async (_backend: unknown, write: () => Promise<unknown>,
        _accepted: unknown, prepare: () => void) => {
        prepare(); await Promise.resolve();
        renameSync(directory, directory + '-old'); mkdirSync(directory);
        return { result: await write() };
      };
      await flush();
      expect(scope.cliAdapter.writeInput).not.toHaveBeenCalled();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

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
