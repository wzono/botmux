import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, unlinkSync } from 'node:fs';
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
  phase: 'blocking' | 'quiescing' | 'quiesced' | 'migrating' | 'releasing' | 'rollback';
  targets: Array<{ larkAppId: string; pid: number; processStart: string; generation: number }>;
}
export interface WorkspaceFenceCommand {
  leaseId: string; epoch: number; action: 'quiesce' | 'release'; generation: number;
}
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
function writeFenceJson(dataDir: string, path: string, value: unknown): void {
  mkdirSync(fenceDir(dataDir), { recursive: true, mode: 0o700 });
  atomicWriteFileSync(path, `${JSON.stringify(value)}\n`, { mode: 0o600, durable: true });
}
const proofToken = (lease: WorkspaceRestartBlockLease) => `${lease.leaseId}:${lease.epoch}:${lease.supervisorPid}`;

export function readWorkspaceRestartBlock(dataDir: string): WorkspaceRestartBlockLease | undefined {
  const path = leasePath(dataDir);
  if (!existsSync(path)) return undefined;
  const lease = readJson<WorkspaceRestartBlockLease>(path);
  if (!lease || typeof lease.leaseId !== 'string' || !lease.leaseId
    || !Number.isSafeInteger(lease.epoch) || lease.epoch < 1
    || !Number.isSafeInteger(lease.supervisorPid) || lease.supervisorPid < 1
    || !Array.isArray(lease.targets)
    || !['blocking', 'quiescing', 'quiesced', 'migrating', 'releasing', 'rollback'].includes(lease.phase)) {
    throw new Error('malformed workspace restart block');
  }
  return lease;
}
export function workspaceSupervisorProofValid(dataDir: string, token: string): boolean {
  const lease = readWorkspaceRestartBlock(dataDir);
  return !!lease && token === proofToken(lease);
}

export function workspaceSupervisorProofSupersedes(dataDir: string, priorToken: string, token: string): boolean {
  const lease = readWorkspaceRestartBlock(dataDir);
  if (!lease || token !== proofToken(lease)) return false;
  const prior = priorToken.split(':');
  return prior.length === 3 && prior[0] === lease.leaseId && prior[1] === String(lease.epoch)
    && Number.isSafeInteger(Number(prior[2])) && Number(prior[2]) > 0;
}

export function workspaceRestartBlocked(dataDir: string): boolean {
  // A malformed on-disk lease is still a block: callers must fail closed rather
  // than treating unreadable coordination state as permission to spawn.
  try { return !!readWorkspaceRestartBlock(dataDir); } catch { return true; }
}
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

  /** Persist the restart block before observing the fleet. Enumeration under the
   * block closes the snapshot→lease race: no spawn/restart path may create a new
   * generation after the returned target set is sampled. */
  async acquire(epoch: number, enumerateActive: () => WorkspaceRestartBlockLease['targets'], options: {
    timeoutMs?: number; signal?: (pid: number) => void; now?: () => number;
    alive?: (pid: number) => boolean; readIdentity?: (pid: number) => string | undefined;
  } = {}): Promise<{ lease: WorkspaceRestartBlockLease; proofToken: string }> {
    const now = options.now ?? Date.now;
    const alive = options.alive ?? (pid => { try { process.kill(pid, 0); return true; } catch { return false; } });
    const exactAlive = (target: WorkspaceRestartBlockLease['targets'][number]) => alive(target.pid)
      && (options.readIdentity === undefined || options.readIdentity(target.pid) === target.processStart);
    const timeoutMs = options.timeoutMs ?? 15_000;
    mkdirSync(fenceDir(this.dataDir), { recursive: true, mode: 0o700 });
    return withFileLock(leasePath(this.dataDir), async () => {
      let lease = readWorkspaceRestartBlock(this.dataDir);
      if (lease) {
        // Before migration starts, a successor must refresh the fleet snapshot
        // under the already-durable restart block. Otherwise a daemon replaced
        // after an interrupted quiesce can leave this lease targeting its dead
        // predecessor forever. Once quiesced/migrating/releasing, keep the exact
        // proven generations so their ACKs and proof remain attributable.
        if (lease.phase === 'blocking' || lease.phase === 'quiescing' || lease.phase === 'rollback') {
          const targets = enumerateActive();
          if (targets.some(target => !target.larkAppId || !target.processStart || target.generation < 1 || !exactAlive(target))) {
            lease.phase = 'rollback'; writeFenceJson(this.dataDir, leasePath(this.dataDir), lease);
            throw new Error('active daemon identity/liveness is unprovable');
          }
          lease.epoch = epoch;
          lease.targets = structuredClone(targets);
        }
        lease.supervisorPid = this.supervisorPid;
        writeFenceJson(this.dataDir, leasePath(this.dataDir), lease);
        if (lease.phase === 'quiesced' || lease.phase === 'migrating' || lease.phase === 'releasing') {
          return { lease, proofToken: proofToken(lease) };
        }
      } else {
        lease = { leaseId: randomUUID(), epoch, supervisorPid: this.supervisorPid,
          acquiredAt: now(), phase: 'blocking', targets: [] };
        // The durable restart block is visible before enumeration. Any exception
        // after this point leaves a recoverable rollback lease rather than opening
        // a spawn window.
        writeFenceJson(this.dataDir, leasePath(this.dataDir), lease);
        const targets = enumerateActive();
        if (targets.some(target => !target.larkAppId || !target.processStart || target.generation < 1 || !exactAlive(target))) {
          lease.phase = 'rollback'; writeFenceJson(this.dataDir, leasePath(this.dataDir), lease);
          throw new Error('active daemon identity/liveness is unprovable');
        }
        lease.targets = structuredClone(targets);
      }
      lease.phase = 'quiescing';
      writeFenceJson(this.dataDir, leasePath(this.dataDir), lease);
      for (const target of lease.targets) {
        const heartbeat = readJson<WorkspaceDaemonFenceHeartbeat>(workspaceFenceHeartbeatPath(this.dataDir, target.larkAppId));
        if (!heartbeat || heartbeat.protocol !== WORKSPACE_FENCE_PROTOCOL || heartbeat.schemaVersion !== WORKSPACE_FENCE_SCHEMA_VERSION
          || heartbeat.pid !== target.pid || heartbeat.processStart !== target.processStart
          || heartbeat.generation !== target.generation || !exactAlive(target)) {
          lease.phase = 'rollback'; writeFenceJson(this.dataDir, leasePath(this.dataDir), lease);
          throw new Error(`daemon fence capability/generation unavailable: ${target.larkAppId}`);
        }
        const command: WorkspaceFenceCommand = { leaseId: lease.leaseId, epoch: lease.epoch,
          action: 'quiesce', generation: target.generation };
        writeFenceJson(this.dataDir, workspaceFenceCommandPath(this.dataDir, target.larkAppId), command);
        options.signal?.(target.pid);
      }
      const deadline = now() + timeoutMs;
      while (now() <= deadline) {
        const exact = lease.targets.every(target => {
          const ack = readJson<WorkspaceFenceAck>(workspaceFenceAckPath(this.dataDir, target.larkAppId));
          return ack?.leaseId === lease!.leaseId && ack.epoch === lease!.epoch && ack.action === 'quiesce'
            && ack.generation === target.generation && ack.pid === target.pid && ack.processStart === target.processStart
            && exactAlive(target) && !ack.sqlite.open && ack.sqlite.writers === 0
            && ack.sqlite.inflight === 0 && ack.sqlite.checkpointed;
        });
        if (exact) {
          lease.phase = 'quiesced'; writeFenceJson(this.dataDir, leasePath(this.dataDir), lease);
          return { lease, proofToken: proofToken(lease) };
        }
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      lease.phase = 'rollback'; writeFenceJson(this.dataDir, leasePath(this.dataDir), lease);
      throw new Error('workspace daemon quiescence timeout');
    });
  }

  markMigrating(token: string): void {
    const lease = readWorkspaceRestartBlock(this.dataDir);
    if (!lease || token !== proofToken(lease) || lease.phase !== 'quiesced') throw new Error('invalid supervisor migration proof');
    lease.phase = 'migrating'; writeFenceJson(this.dataDir, leasePath(this.dataDir), lease);
  }

  /** Release remains blocked until every exact daemon generation ACKs that it
   * reopened the post-migration SQLite file. A crash cannot silently unlink the
   * lease; the successor supervisor resumes this durable releasing phase. */
  async release(token: string, options: { timeoutMs?: number; signal?: (pid: number) => void; now?: () => number;
    alive?: (pid: number) => boolean; readIdentity?: (pid: number) => string | undefined;
    dead?: (target: WorkspaceRestartBlockLease['targets'][number]) => boolean } = {}): Promise<void> {
    const now = options.now ?? Date.now;
    const alive = options.alive ?? (pid => { try { process.kill(pid, 0); return true; } catch { return false; } });
    const exactAlive = (target: WorkspaceRestartBlockLease['targets'][number]) => alive(target.pid)
      && (options.readIdentity === undefined || options.readIdentity(target.pid) === target.processStart);
    await withFileLock(leasePath(this.dataDir), async () => {
      const lease = readWorkspaceRestartBlock(this.dataDir);
      if (!lease || token !== proofToken(lease)) throw new Error('invalid supervisor proof token');
      lease.phase = 'releasing'; writeFenceJson(this.dataDir, leasePath(this.dataDir), lease);
      for (const target of lease.targets) {
        if (!exactAlive(target) && options.dead?.(target) === true) continue;
        const command: WorkspaceFenceCommand = { leaseId: lease.leaseId, epoch: lease.epoch,
          action: 'release', generation: target.generation };
        writeFenceJson(this.dataDir, workspaceFenceCommandPath(this.dataDir, target.larkAppId), command);
        options.signal?.(target.pid);
      }
      const deadline = now() + (options.timeoutMs ?? 15_000);
      while (now() <= deadline) {
        const reopened = lease.targets.every(target => {
          // An attested-dead original generation has nothing left to reopen. It
          // stays blocked from replacement until the lease is removed, then the
          // supervisor's deferred restart can create a fresh generation.
          if (!exactAlive(target) && options.dead?.(target) === true) return true;
          const ack = readJson<WorkspaceFenceAck>(workspaceFenceAckPath(this.dataDir, target.larkAppId));
          return ack?.leaseId === lease.leaseId && ack.epoch === lease.epoch && ack.action === 'release'
            && ack.generation === target.generation && ack.pid === target.pid && ack.processStart === target.processStart
            && exactAlive(target) && ack.sqlite.open && ack.sqlite.writers === 0 && ack.sqlite.inflight === 0;
        });
        if (reopened) { unlinkSync(leasePath(this.dataDir)); return; }
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      throw new Error('workspace daemon reopen timeout');
    });
  }
}
