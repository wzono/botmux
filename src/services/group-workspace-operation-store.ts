import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import type { TenantHumanId } from './bot-admin-unions-store.js';
import { groupWorkspaceOperationKey, type GroupOperationKind } from './group-workspace-store.js';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { withFileLock } from '../utils/file-lock.js';

export const GROUP_WORKSPACE_OPERATION_STORE_FILE = 'group-workspace-operations.json';
const SCHEMA_VERSION = 1;

export type RepoGroupOperationPhase =
  | 'prepared'
  | 'session_committed'
  | 'group_committed'
  | 'conflict'
  | 'invalid_dir'
  | 'unauthorized'
  | 'store_unavailable'
  | 'unknown';

export interface RepoGroupOperationJournal {
  operationKey: string;
  sourceEventId: string;
  kind: GroupOperationKind;
  payloadDigest: string;
  chatId: string;
  sessionId: string;
  expectedSessionGeneration: number;
  expectedGroupRevision: number;
  targetWorkingDir: string;
  actor: TenantHumanId;
  phase: RepoGroupOperationPhase;
  sessionGenerationAfter?: number;
  groupRevisionAfter?: number;
  updatedAt: number;
}

interface OperationRegistry {
  schemaVersion: 1;
  operations: Record<string, RepoGroupOperationJournal>;
  sourceIndex: Record<string, string>;
}

export type OperationReadResult =
  | { status: 'found'; journal: RepoGroupOperationJournal }
  | { status: 'missing' }
  | { status: 'store_unavailable' };

export type OperationPrepareResult =
  | { status: 'created'; journal: RepoGroupOperationJournal }
  | { status: 'existing'; journal: RepoGroupOperationJournal }
  | { status: 'protocol_conflict'; journal: RepoGroupOperationJournal }
  | { status: 'store_unavailable' };

export type OperationTransitionResult =
  | { status: 'updated'; journal: RepoGroupOperationJournal }
  | { status: 'invalid_transition'; journal: RepoGroupOperationJournal }
  | { status: 'missing' }
  | { status: 'store_unavailable' };

export interface GroupWorkspaceOperationStoreOptions {
  lockTimeoutMs?: number;
  writer?: typeof atomicWriteFileSync;
}

function emptyRegistry(): OperationRegistry {
  return {
    schemaVersion: SCHEMA_VERSION,
    operations: Object.create(null) as Record<string, RepoGroupOperationJournal>,
    sourceIndex: Object.create(null) as Record<string, string>,
  };
}

function sourceIndexKey(sourceEventId: string, kind: GroupOperationKind): string {
  return JSON.stringify([sourceEventId, kind]);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isActor(value: unknown): value is TenantHumanId {
  return isObject(value)
    && typeof value.tenantKey === 'string' && value.tenantKey.trim() === value.tenantKey && !!value.tenantKey
    && typeof value.unionId === 'string' && /^on_\S+$/.test(value.unionId);
}

const PHASES = new Set<RepoGroupOperationPhase>([
  'prepared', 'session_committed', 'group_committed', 'conflict', 'invalid_dir', 'unauthorized', 'store_unavailable', 'unknown',
]);

function validNonnegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function validateJournal(value: unknown, key: string): asserts value is RepoGroupOperationJournal {
  if (!isObject(value)
    || value.operationKey !== key || typeof value.operationKey !== 'string' || !value.operationKey
    || typeof value.sourceEventId !== 'string' || !value.sourceEventId
    || (value.kind !== 'set' && value.kind !== 'unbind')
    || value.operationKey !== groupWorkspaceOperationKey(value.sourceEventId as string, value.kind as GroupOperationKind)
    || typeof value.payloadDigest !== 'string' || !value.payloadDigest
    || typeof value.chatId !== 'string' || !value.chatId
    || typeof value.sessionId !== 'string' || !value.sessionId
    || !validNonnegativeInteger(value.expectedSessionGeneration)
    || !validNonnegativeInteger(value.expectedGroupRevision)
    || typeof value.targetWorkingDir !== 'string' || !isAbsolute(value.targetWorkingDir)
    || !isActor(value.actor)
    || !PHASES.has(value.phase as RepoGroupOperationPhase)
    || !Number.isFinite(value.updatedAt)
    || (value.sessionGenerationAfter !== undefined && !validNonnegativeInteger(value.sessionGenerationAfter))
    || (value.groupRevisionAfter !== undefined && (!Number.isSafeInteger(value.groupRevisionAfter) || (value.groupRevisionAfter as number) < 1))
    || (value.phase === 'prepared' && (value.sessionGenerationAfter !== undefined || value.groupRevisionAfter !== undefined))
    || (value.phase === 'session_committed' && value.sessionGenerationAfter === undefined)
    || (value.phase === 'group_committed' && (value.sessionGenerationAfter === undefined || value.groupRevisionAfter === undefined))
    || ((value.phase === 'conflict' || value.phase === 'invalid_dir' || value.phase === 'unauthorized'
      || value.phase === 'store_unavailable') && value.sessionGenerationAfter === undefined)) {
    throw new Error(`invalid group workspace operation journal: ${key}`);
  }
}

function readRegistry(path: string): OperationRegistry {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyRegistry();
    throw error;
  }
  const value: unknown = JSON.parse(raw);
  if (!isObject(value) || value.schemaVersion !== SCHEMA_VERSION
    || !isObject(value.operations)
    || (value.sourceIndex !== undefined && !isObject(value.sourceIndex))) {
    throw new Error('invalid group workspace operation store schema');
  }
  for (const [key, operation] of Object.entries(value.operations)) validateJournal(operation, key);
  const expectedIndex = Object.create(null) as Record<string, string>;
  for (const operation of Object.values(value.operations)) {
    const item = operation as RepoGroupOperationJournal;
    const indexKey = sourceIndexKey(item.sourceEventId, item.kind);
    if (expectedIndex[indexKey]) throw new Error(`duplicate group workspace operation source: ${indexKey}`);
    expectedIndex[indexKey] = item.operationKey;
  }
  const sourceIndex = (value.sourceIndex ?? expectedIndex) as Record<string, unknown>;
  if (Object.keys(sourceIndex).length !== Object.keys(expectedIndex).length
    || Object.entries(expectedIndex).some(([key, operationKey]) => sourceIndex[key] !== operationKey)) {
    throw new Error('invalid group workspace operation source index');
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    operations: Object.assign(Object.create(null), value.operations) as Record<string, RepoGroupOperationJournal>,
    sourceIndex: Object.assign(Object.create(null), sourceIndex) as Record<string, string>,
  };
}

function sameFrozenIntent(left: RepoGroupOperationJournal, right: RepoGroupOperationJournal): boolean {
  return left.operationKey === right.operationKey
    && left.sourceEventId === right.sourceEventId
    && left.kind === right.kind
    && left.payloadDigest === right.payloadDigest
    && left.chatId === right.chatId
    && left.sessionId === right.sessionId
    && left.actor.tenantKey === right.actor.tenantKey
    && left.actor.unionId === right.actor.unionId;
}

function mayTransition(from: RepoGroupOperationPhase, to: RepoGroupOperationPhase): boolean {
  if (from === 'prepared') return to === 'session_committed' || to === 'unknown';
  if (from === 'session_committed') {
    return to === 'group_committed' || to === 'conflict' || to === 'invalid_dir' || to === 'unauthorized'
      || to === 'store_unavailable' || to === 'unknown';
  }
  return false;
}

export class GroupWorkspaceOperationStore {
  private readonly path: string;
  private readonly lockTimeoutMs: number | undefined;
  private readonly writer: typeof atomicWriteFileSync;

  constructor(dataDir: string, options: GroupWorkspaceOperationStoreOptions = {}) {
    this.path = join(dataDir, GROUP_WORKSPACE_OPERATION_STORE_FILE);
    this.lockTimeoutMs = options.lockTimeoutMs;
    this.writer = options.writer ?? atomicWriteFileSync;
  }

  async get(operationKey: string): Promise<OperationReadResult> {
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      return await withFileLock(this.path, async () => {
        const journal = readRegistry(this.path).operations[operationKey];
        return journal
          ? { status: 'found' as const, journal: structuredClone(journal) }
          : { status: 'missing' as const };
      }, { maxWaitMs: this.lockTimeoutMs });
    } catch {
      return { status: 'store_unavailable' };
    }
  }

  async getByIntent(sourceEventId: string, kind: GroupOperationKind): Promise<OperationReadResult> {
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      return await withFileLock(this.path, async () => {
        const registry = readRegistry(this.path);
        const operationKey = registry.sourceIndex[sourceIndexKey(sourceEventId, kind)];
        const journal = operationKey ? registry.operations[operationKey] : undefined;
        return journal
          ? { status: 'found' as const, journal: structuredClone(journal) }
          : { status: 'missing' as const };
      }, { maxWaitMs: this.lockTimeoutMs });
    } catch {
      return { status: 'store_unavailable' };
    }
  }

  async prepare(journal: RepoGroupOperationJournal): Promise<OperationPrepareResult> {
    try {
      validateJournal(journal, journal.operationKey);
      if (journal.phase !== 'prepared') return { status: 'store_unavailable' };
      mkdirSync(dirname(this.path), { recursive: true });
      return await withFileLock(this.path, async () => {
        const registry = readRegistry(this.path);
        const existing = registry.operations[journal.operationKey];
        if (existing) {
          return sameFrozenIntent(existing, journal)
            ? { status: 'existing' as const, journal: structuredClone(existing) }
            : { status: 'protocol_conflict' as const, journal: structuredClone(existing) };
        }
        const sourceReuse = Object.values(registry.operations)
          .find(item => item.sourceEventId === journal.sourceEventId && item.kind === journal.kind);
        if (sourceReuse) {
          return sameFrozenIntent(sourceReuse, journal)
            ? { status: 'existing' as const, journal: structuredClone(sourceReuse) }
            : { status: 'protocol_conflict' as const, journal: structuredClone(sourceReuse) };
        }
        registry.operations[journal.operationKey] = structuredClone(journal);
        registry.sourceIndex[sourceIndexKey(journal.sourceEventId, journal.kind)] = journal.operationKey;
        this.write(registry);
        return { status: 'created' as const, journal: structuredClone(journal) };
      }, { maxWaitMs: this.lockTimeoutMs });
    } catch {
      return { status: 'store_unavailable' };
    }
  }

  async transition(
    operationKey: string,
    phase: RepoGroupOperationPhase,
    patch: Pick<RepoGroupOperationJournal, 'updatedAt'>
      & Partial<Pick<RepoGroupOperationJournal, 'sessionGenerationAfter' | 'groupRevisionAfter'>>,
  ): Promise<OperationTransitionResult> {
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      return await withFileLock(this.path, async () => {
        const registry = readRegistry(this.path);
        const existing = registry.operations[operationKey];
        if (!existing) return { status: 'missing' as const };
        if (!mayTransition(existing.phase, phase)) {
          return { status: 'invalid_transition' as const, journal: structuredClone(existing) };
        }
        const updated: RepoGroupOperationJournal = { ...existing, ...patch, phase };
        validateJournal(updated, operationKey);
        registry.operations[operationKey] = updated;
        this.write(registry);
        return { status: 'updated' as const, journal: structuredClone(updated) };
      }, { maxWaitMs: this.lockTimeoutMs });
    } catch {
      return { status: 'store_unavailable' };
    }
  }

  async convergeReceipt(
    operationKey: string,
    phase: Extract<RepoGroupOperationPhase, 'group_committed' | 'conflict' | 'invalid_dir' | 'unauthorized' | 'store_unavailable'>,
    patch: Pick<RepoGroupOperationJournal, 'updatedAt'>
      & Partial<Pick<RepoGroupOperationJournal, 'groupRevisionAfter'>>,
  ): Promise<OperationTransitionResult> {
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      return await withFileLock(this.path, async () => {
        const registry = readRegistry(this.path);
        const existing = registry.operations[operationKey];
        if (!existing) return { status: 'missing' as const };
        if (existing.phase !== 'unknown') {
          return { status: 'invalid_transition' as const, journal: structuredClone(existing) };
        }
        const updated: RepoGroupOperationJournal = { ...existing, ...patch, phase };
        validateJournal(updated, operationKey);
        registry.operations[operationKey] = updated;
        this.write(registry);
        return { status: 'updated' as const, journal: structuredClone(updated) };
      }, { maxWaitMs: this.lockTimeoutMs });
    } catch {
      return { status: 'store_unavailable' };
    }
  }

  async listUnresolved(): Promise<{ status: 'available'; journals: RepoGroupOperationJournal[] } | { status: 'store_unavailable' }> {
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      return await withFileLock(this.path, async () => ({
        status: 'available' as const,
        journals: Object.values(readRegistry(this.path).operations)
          .filter(item => item.phase === 'prepared' || item.phase === 'session_committed' || item.phase === 'unknown')
          .map(item => structuredClone(item)),
      }), { maxWaitMs: this.lockTimeoutMs });
    } catch {
      return { status: 'store_unavailable' };
    }
  }

  private write(registry: OperationRegistry): void {
    this.writer(this.path, `${JSON.stringify(registry, null, 2)}\n`, {
      mode: 0o600, durable: true, followTargetSymlink: false,
    });
  }
}
