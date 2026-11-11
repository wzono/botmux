import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  WORKSPACE_FENCE_PROTOCOL,
  WorkspaceMigrationSupervisorFence,
  publishWorkspaceFenceAck,
  publishWorkspaceFenceHeartbeat,
  readWorkspaceFenceCommand,
  readWorkspaceRestartBlock,
  workspaceRestartBlocked,
} from '../src/core/workspace-migration-supervisor.js';

const roots: string[] = [];
const root = () => { const value = mkdtempSync(join(tmpdir(), 'workspace-supervisor-')); roots.push(value); return value; };
afterEach(() => { for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true }); });
const target = { larkAppId: 'cli_a', pid: 321, processStart: 'birth-1', generation: 7 };
function capable(dataDir: string): void {
  publishWorkspaceFenceHeartbeat(dataDir, {
    ...target, protocol: WORKSPACE_FENCE_PROTOCOL, schemaVersion: 1,
    sqlite: { open: true, writers: 0, inflight: 0, checkpointed: false }, at: Date.now(),
  });
}

describe('workspace migration supervisor fence', () => {
  it('acquires exact-generation quiescence proof, blocks restart, then releases', async () => {
    const dataDir = root(); capable(dataDir);
    const fence = new WorkspaceMigrationSupervisorFence(dataDir, 99);
    const acquiring = fence.acquire(4, () => [target], { timeoutMs: 1000, alive: () => true, signal: () => {
      const command = readWorkspaceFenceCommand(dataDir, target.larkAppId)!;
      publishWorkspaceFenceAck(dataDir, target.larkAppId, {
        ...command, pid: target.pid, processStart: target.processStart,
        sqlite: { open: false, writers: 0, inflight: 0, checkpointed: true }, at: Date.now(),
      });
    } });
    const acquired = await acquiring;
    expect(readWorkspaceRestartBlock(dataDir)).toMatchObject({ phase: 'quiesced', epoch: 4, targets: [target] });
    expect(workspaceRestartBlocked(dataDir)).toBe(true);
    await fence.release(acquired.proofToken, { signal: () => {
      const command = readWorkspaceFenceCommand(dataDir, target.larkAppId)!;
      publishWorkspaceFenceAck(dataDir, target.larkAppId, { ...command, pid: target.pid,
        processStart: target.processStart, sqlite: { open: true, writers: 0, inflight: 0, checkpointed: false }, at: Date.now() });
    }, alive: () => true });
    expect(workspaceRestartBlocked(dataDir)).toBe(false);
    expect(readWorkspaceFenceCommand(dataDir, target.larkAppId)).toMatchObject({ action: 'release', epoch: 4 });
  });

  it('fails closed for legacy, stale generation, stale ACK and timeout while preserving rollback block', async () => {
    const legacyDir = root();
    await expect(new WorkspaceMigrationSupervisorFence(legacyDir).acquire(1, () => [target], { timeoutMs: 20, alive: () => true }))
      .rejects.toThrow('capability/generation unavailable');

    const staleDir = root(); capable(staleDir);
    publishWorkspaceFenceHeartbeat(staleDir, {
      ...target, generation: 6, protocol: WORKSPACE_FENCE_PROTOCOL, schemaVersion: 1,
      sqlite: { open: true, writers: 0, inflight: 0, checkpointed: false }, at: Date.now(),
    });
    await expect(new WorkspaceMigrationSupervisorFence(staleDir).acquire(1, () => [target], { timeoutMs: 20, alive: () => true }))
      .rejects.toThrow('capability/generation unavailable');

    const timeoutDir = root(); capable(timeoutDir);
    await expect(new WorkspaceMigrationSupervisorFence(timeoutDir).acquire(2, () => [target], { timeoutMs: 40, alive: () => true, signal: () => {
      const command = readWorkspaceFenceCommand(timeoutDir, target.larkAppId)!;
      publishWorkspaceFenceAck(timeoutDir, target.larkAppId, {
        ...command, generation: 6, pid: target.pid, processStart: target.processStart,
        sqlite: { open: false, writers: 0, inflight: 0, checkpointed: true }, at: Date.now(),
      });
    } })).rejects.toThrow('quiescence timeout');
    expect(readWorkspaceRestartBlock(timeoutDir)?.phase).toBe('rollback');
    expect(workspaceRestartBlocked(timeoutDir)).toBe(true);
  });

  it('rejects release without the durable supervisor proof token', async () => {
    const dataDir = root(); capable(dataDir);
    const fence = new WorkspaceMigrationSupervisorFence(dataDir, 99);
    const acquired = await fence.acquire(8, () => [target], { alive: () => true, signal: () => {
      const command = readWorkspaceFenceCommand(dataDir, target.larkAppId)!;
      publishWorkspaceFenceAck(dataDir, target.larkAppId, { ...command, pid: target.pid,
        processStart: target.processStart, sqlite: { open: false, writers: 0, inflight: 0, checkpointed: true }, at: Date.now() });
    } });
    await expect(fence.release('wrong')).rejects.toThrow('invalid supervisor proof token');
    expect(JSON.parse(readFileSync(join(dataDir, 'workspace-fence', 'workspace-restart-block.json'), 'utf8')).phase).toBe('quiesced');
    await fence.release(acquired.proofToken, { signal: () => {
      const command = readWorkspaceFenceCommand(dataDir, target.larkAppId)!;
      publishWorkspaceFenceAck(dataDir, target.larkAppId, { ...command, pid: target.pid,
        processStart: target.processStart, sqlite: { open: true, writers: 0, inflight: 0, checkpointed: false }, at: Date.now() });
    }, alive: () => true });
  });
});
