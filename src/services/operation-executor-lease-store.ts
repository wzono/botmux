import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { withFileLock } from '../utils/file-lock.js';

export interface OperationExecutorLease { owner: string; leaseEpoch: number; fencingToken: number; leaseExpiresAt: number }
type Registry = { schemaVersion: 1; leases: Record<string, OperationExecutorLease> };
export class OperationExecutorLeaseStore {
  private readonly path: string; private readonly now: () => number;
  constructor(dataDir: string, options: { now?: () => number } = {}) { this.path = join(dataDir, 'operation-executor-leases.json'); this.now = options.now ?? Date.now; }
  private read(): Registry { try { return JSON.parse(readFileSync(this.path, 'utf8')) as Registry; } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { schemaVersion: 1, leases: {} }; throw e; } }
  private write(r: Registry) { atomicWriteFileSync(this.path, `${JSON.stringify(r, null, 2)}\n`, { mode: 0o600, durable: true, followTargetSymlink: false }); }
  private async locked<T>(fn: (r: Registry) => T): Promise<T> { mkdirSync(dirname(this.path), { recursive: true }); return withFileLock(this.path, async () => { const r = this.read(); const out = fn(r); this.write(r); return out; }); }
  async acquire(operationId: string, owner: string, ttlMs: number): Promise<{ status: 'acquired'; lease: OperationExecutorLease } | { status: 'observer'; lease: OperationExecutorLease }> { return this.locked(r => { const current = r.leases[operationId]; const now = this.now(); if (current && current.leaseExpiresAt > now) return current.owner === owner ? { status: 'acquired', lease: structuredClone(current) } : { status: 'observer', lease: structuredClone(current) }; const next = { owner, leaseEpoch: (current?.leaseEpoch ?? 0) + 1, fencingToken: (current?.fencingToken ?? 0) + 1, leaseExpiresAt: now + ttlMs }; r.leases[operationId] = next; return { status: 'acquired', lease: structuredClone(next) }; }); }
  async renew(operationId: string, lease: OperationExecutorLease, ttlMs: number): Promise<{ status: 'renewed'; lease: OperationExecutorLease } | { status: 'stale_fence' }> { return this.locked(r => { const current = r.leases[operationId]; if (!current || current.owner !== lease.owner || current.fencingToken !== lease.fencingToken) return { status: 'stale_fence' }; const next = { ...current, leaseEpoch: current.leaseEpoch + 1, fencingToken: current.fencingToken + 1, leaseExpiresAt: this.now() + ttlMs }; r.leases[operationId] = next; return { status: 'renewed', lease: structuredClone(next) }; }); }
  async assertCurrent(operationId: string, lease: OperationExecutorLease): Promise<{ status: 'current' } | { status: 'stale_fence' }> { return this.locked(r => { const current = r.leases[operationId]; return current && current.owner === lease.owner && current.fencingToken === lease.fencingToken && current.leaseExpiresAt > this.now() ? { status: 'current' } : { status: 'stale_fence' }; }); }
  async runFencedEffect<T>(operationId: string, lease: OperationExecutorLease, effect: () => Promise<T>): Promise<{ status: 'applied'; value: T } | { status: 'stale_fence' }> {
    mkdirSync(dirname(this.path), { recursive: true });
    return withFileLock(this.path, async () => {
      const current = this.read();
      if (!current.leases[operationId]
        || current.leases[operationId].owner !== lease.owner
        || current.leases[operationId].fencingToken !== lease.fencingToken
        || current.leases[operationId].leaseExpiresAt <= this.now()) return { status: 'stale_fence' };
      return { status: 'applied', value: await effect() };
    });
  }
}
