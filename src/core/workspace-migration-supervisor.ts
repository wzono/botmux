import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { withFileLock } from '../utils/file-lock.js';

export const WORKSPACE_FENCE_PROTOCOL = 'workspace-fence-v1';
export const WORKSPACE_FENCE_SCHEMA_VERSION = 1;
const LEASE_FILE = 'workspace-restart-block.json';

export interface WorkspaceDaemonFenceHeartbeat {
  larkAppId: string; pid: number; processStart: string; generation: number;
  protocol: typeof WORKSPACE_FENCE_PROTOCOL; schemaVersion: 1;
  sqlite: { open: boolean; writers: number; inflight: number; checkpointed: boolean };
  migrationEpoch?: number; at: number;
}
export interface WorkspaceRestartBlockLease {
  leaseId: string; epoch: number; supervisorPid: number; acquiredAt: number;
  phase: 'quiescing' | 'quiesced' | 'releasing' | 'rollback';
  targets: Array<{ larkAppId: string; pid: number; processStart: string; generation: number }>;
}
export interface WorkspaceFenceCommand { leaseId: string; epoch: number; action: 'quiesce' | 'release'; generation: number }
export interface WorkspaceFenceAck extends WorkspaceFenceCommand {
  pid: number; processStart: string; sqlite: WorkspaceDaemonFenceHeartbeat['sqlite']; at: number;
}

const fenceDir = (dataDir: string) => join(dataDir, 'workspace-fence');
const leasePath = (dataDir: string) => join(fenceDir(dataDir), LEASE_FILE);
const safe = (value: string) => value.replace(/[^A-Za-z0-9._-]/g, '_');
export const workspaceFenceHeartbeatPath = (dataDir: string, appId: string) => join(fenceDir(dataDir), `heartbeat-${safe(appId)}.json`);
export const workspaceFenceCommandPath = (dataDir: string, appId: string) => join(fenceDir(dataDir), `command-${safe(appId)}.json`);
export const workspaceFenceAckPath = (dataDir: string, appId: string) => join(fenceDir(dataDir), `ack-${safe(appId)}.json`);
function readJson<T>(path: string): T | undefined { try { return JSON.parse(readFileSync(path, 'utf8')) as T; } catch { return undefined; } }
function writeFenceJson(dataDir: string, path: string, value: unknown): void { mkdirSync(fenceDir(dataDir), { recursive: true }); atomicWriteFileSync(path, `${JSON.stringify(value)}\n`, { mode: 0o600, durable: true }); }

export function readWorkspaceRestartBlock(dataDir: string): WorkspaceRestartBlockLease | undefined { return readJson(leasePath(dataDir)); }
export function workspaceRestartBlocked(dataDir: string): boolean { return !!readWorkspaceRestartBlock(dataDir); }
export function publishWorkspaceFenceHeartbeat(dataDir: string, heartbeat: WorkspaceDaemonFenceHeartbeat): void {
  writeFenceJson(dataDir, workspaceFenceHeartbeatPath(dataDir, heartbeat.larkAppId), heartbeat);
}
export function readWorkspaceFenceCommand(dataDir: string, appId: string): WorkspaceFenceCommand | undefined {
  return readJson(workspaceFenceCommandPath(dataDir, appId));
}
export function publishWorkspaceFenceAck(dataDir: string, appId: string, ack: WorkspaceFenceAck): void {
  writeFenceJson(dataDir, workspaceFenceAckPath(dataDir, appId), ack);
}

export class WorkspaceMigrationSupervisorFence {
  constructor(private readonly dataDir: string, private readonly supervisorPid = process.pid) {}
  async acquire(epoch: number, active: WorkspaceRestartBlockLease['targets'], options: {
    timeoutMs?: number; signal?: (pid: number) => void; now?: () => number;
  } = {}): Promise<{ lease: WorkspaceRestartBlockLease; proofToken: string }> {
    const now = options.now ?? Date.now;
    const timeoutMs = options.timeoutMs ?? 15_000;
    mkdirSync(fenceDir(this.dataDir), { recursive: true, mode: 0o700 });
    return withFileLock(leasePath(this.dataDir), async () => {
      if (readWorkspaceRestartBlock(this.dataDir)) throw new Error('workspace restart block already held');
      const heartbeats = new Map<string, WorkspaceDaemonFenceHeartbeat>();
      for (const file of existsSync(fenceDir(this.dataDir)) ? readdirSync(fenceDir(this.dataDir)) : []) {
        if (!file.startsWith('heartbeat-')) continue;
        const beat = readJson<WorkspaceDaemonFenceHeartbeat>(join(fenceDir(this.dataDir), file));
        if (beat) heartbeats.set(beat.larkAppId, beat);
      }
      for (const target of active) {
        const beat = heartbeats.get(target.larkAppId);
        if (!beat || beat.protocol !== WORKSPACE_FENCE_PROTOCOL || beat.schemaVersion !== WORKSPACE_FENCE_SCHEMA_VERSION
          || beat.pid !== target.pid || beat.processStart !== target.processStart || beat.generation !== target.generation) {
          throw new Error(`daemon fence capability/generation unavailable: ${target.larkAppId}`);
        }
      }
      const lease: WorkspaceRestartBlockLease = { leaseId: randomUUID(), epoch, supervisorPid: this.supervisorPid,
        acquiredAt: now(), phase: 'quiescing', targets: structuredClone(active) };
      writeFenceJson(this.dataDir, leasePath(this.dataDir), lease);
      for (const target of active) {
        writeFenceJson(this.dataDir, workspaceFenceCommandPath(this.dataDir, target.larkAppId), {
          leaseId: lease.leaseId, epoch, action: 'quiesce', generation: target.generation,
        } satisfies WorkspaceFenceCommand);
        options.signal?.(target.pid);
      }
      const deadline = now() + timeoutMs;
      while (now() <= deadline) {
        const exact = active.every(target => {
          const ack = readJson<WorkspaceFenceAck>(workspaceFenceAckPath(this.dataDir, target.larkAppId));
          return ack?.leaseId === lease.leaseId && ack.epoch === epoch && ack.action === 'quiesce'
            && ack.generation === target.generation && ack.pid === target.pid && ack.processStart === target.processStart
            && !ack.sqlite.open && ack.sqlite.writers === 0 && ack.sqlite.inflight === 0 && ack.sqlite.checkpointed;
        });
        if (exact) {
          lease.phase = 'quiesced'; writeFenceJson(this.dataDir, leasePath(this.dataDir), lease);
          return { lease, proofToken: `${lease.leaseId}:${epoch}:${this.supervisorPid}` };
        }
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      lease.phase = 'rollback'; writeFenceJson(this.dataDir, leasePath(this.dataDir), lease);
      throw new Error('workspace daemon quiescence timeout');
    });
  }
  async release(proofToken: string): Promise<void> {
    await withFileLock(leasePath(this.dataDir), async () => {
      const lease = readWorkspaceRestartBlock(this.dataDir);
      if (!lease || proofToken !== `${lease.leaseId}:${lease.epoch}:${lease.supervisorPid}`) throw new Error('invalid supervisor proof token');
      lease.phase = 'releasing'; writeFenceJson(this.dataDir, leasePath(this.dataDir), lease);
      for (const target of lease.targets) writeFenceJson(this.dataDir, workspaceFenceCommandPath(this.dataDir, target.larkAppId), {
        leaseId: lease.leaseId, epoch: lease.epoch, action: 'release', generation: target.generation,
      } satisfies WorkspaceFenceCommand);
      unlinkSync(leasePath(this.dataDir));
    });
  }
}
