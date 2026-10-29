import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import type { TenantHumanId } from './bot-admin-unions-store.js';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { withFileLock } from '../utils/file-lock.js';

export const GROUP_WORKSPACE_STORE_FILE = 'group-workspaces.json';
const SCHEMA_VERSION = 1;
const SOURCE_VERSION = 1;
const PAYLOAD_VERSION = 1;
const OPERATION_KEY_VERSION = 1;

export type GroupDirectoryState =
  | { kind: 'bound'; workingDir: string }
  | { kind: 'unbound' };

export interface GroupWorkspaceRecord {
  chatId: string;
  revision: number;
  directory: GroupDirectoryState;
  workspaceManagers?: TenantHumanId[];
  updatedAt: number;
  updatedBy: TenantHumanId;
}

export type GroupOperationKind = 'set' | 'unbind';
export type GroupOperationTerminalOutcome =
  | 'committed'
  | 'conflict'
  | 'invalid_dir'
  | 'unauthorized'
  | 'store_unavailable';

export interface GroupOperationReceipt {
  operationKey: string;
  sourceEventId: string;
  originMessageId?: string;
  kind: GroupOperationKind;
  payloadDigest: string;
  chatId: string;
  outcome: GroupOperationTerminalOutcome;
  resultingRevision?: number;
  resultingDirectory?: GroupDirectoryState;
  actor: TenantHumanId;
  completedAt: number;
  /** Values frozen on first sight; later saga coordination must never rebase them. */
  expectedRevision: number;
  expectedSessionGeneration?: number;
  canonicalTargetWorkingDir?: string;
}

interface GroupWorkspaceRegistry {
  schemaVersion: 1;
  records: Record<string, GroupWorkspaceRecord>;
  receipts: Record<string, GroupOperationReceipt>;
}

interface StableTenantInput {
  tenantKey?: string;
  verifiedTenantMapping?: {
    tenantKey: string;
    verifiedAcrossApps: boolean;
  };
}

export interface CanonicalTextSourceInput extends StableTenantInput {
  chatId: string;
  messageId: string;
  /** Audit-only; deliberately excluded from the identity digest. */
  deliveryEventId?: string;
  /** Audit-only; deliberately excluded from the identity digest. */
  deliveryAttemptId?: string;
}

export interface CanonicalCardSourceInput extends StableTenantInput {
  chatId: string;
  originMessageId: string;
  actionId: string;
  /** Audit-only; deliberately excluded from the identity digest. */
  deliveryAttemptId?: string;
}

export type CanonicalSourceResult =
  | { ok: true; sourceEventId: string }
  | { ok: false; reason: 'unverifiable_tenant' | 'invalid_source' };

export interface GroupWorkspaceSetMutation {
  kind: 'set';
  chatId: string;
  sourceEventId: string;
  originMessageId?: string;
  requestedWorkingDir: string;
  expectedRevision: number;
  expectedSessionGeneration?: number;
  actor: TenantHumanId;
  authorized: boolean;
  directoryValid: boolean;
  now: number;
}

export interface GroupWorkspaceUnbindMutation {
  kind: 'unbind';
  chatId: string;
  sourceEventId: string;
  originMessageId?: string;
  expectedRevision: number;
  actor: TenantHumanId;
  authorized: boolean;
  now: number;
}

export type GroupWorkspaceMutation = GroupWorkspaceSetMutation | GroupWorkspaceUnbindMutation;

export type GroupWorkspaceMutationResult =
  | { outcome: GroupOperationTerminalOutcome; receipt: GroupOperationReceipt }
  | { outcome: 'protocol_conflict'; existingReceipt: GroupOperationReceipt }
  | { outcome: 'store_unavailable' };

export type GroupWorkspaceReadResult =
  | { status: 'available'; record: GroupWorkspaceRecord | undefined }
  | { status: 'store_unavailable' };

export interface GroupWorkspaceStoreOptions {
  lockTimeoutMs?: number;
}

function digest(domain: string, value: unknown): string {
  return `${domain}:sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}

function stableTenantKey(input: StableTenantInput): string | undefined {
  const direct = input.tenantKey?.trim();
  if (direct) return direct;
  const fallback = input.verifiedTenantMapping;
  if (!fallback?.verifiedAcrossApps) return undefined;
  return fallback.tenantKey.trim() || undefined;
}

/** Stable across receiving Bots, delivery attempts, and historical recovery. */
export function canonicalTextSourceEventId(input: CanonicalTextSourceInput): CanonicalSourceResult {
  const tenantKey = stableTenantKey(input);
  if (!tenantKey) return { ok: false, reason: 'unverifiable_tenant' };
  const chatId = input.chatId.trim();
  const messageId = input.messageId.trim();
  if (!chatId || !messageId) return { ok: false, reason: 'invalid_source' };
  return {
    ok: true,
    sourceEventId: digest('group-workspace-text-source-v1', [SOURCE_VERSION, tenantKey, chatId, messageId]),
  };
}

/** One immutable card action is one operation; redelivery attempt IDs are audit-only. */
export function canonicalCardSourceEventId(input: CanonicalCardSourceInput): CanonicalSourceResult {
  const tenantKey = stableTenantKey(input);
  if (!tenantKey) return { ok: false, reason: 'unverifiable_tenant' };
  const chatId = input.chatId.trim();
  const originMessageId = input.originMessageId.trim();
  const actionId = input.actionId.trim();
  if (!chatId || !originMessageId || !actionId) return { ok: false, reason: 'invalid_source' };
  return {
    ok: true,
    sourceEventId: digest(
      'group-workspace-card-source-v1',
      [SOURCE_VERSION, tenantKey, chatId, originMessageId, actionId],
    ),
  };
}

function canonicalWorkingDir(path: string): string {
  return resolve(path);
}

/** Semantic intent only: expectedRevision and session generation are deliberately excluded. */
export function canonicalGroupOperationPayloadDigest(input: GroupWorkspaceMutation): string {
  return digest('group-workspace-payload-v1', input.kind === 'set'
    ? [PAYLOAD_VERSION, input.chatId, input.kind, canonicalWorkingDir(input.requestedWorkingDir)]
    : [PAYLOAD_VERSION, input.chatId, input.kind, 'tombstone']);
}

export function groupWorkspaceOperationKey(sourceEventId: string, kind: GroupOperationKind): string {
  return digest('group-workspace-operation-v1', [OPERATION_KEY_VERSION, sourceEventId, kind]);
}

function emptyRegistry(): GroupWorkspaceRegistry {
  return { schemaVersion: SCHEMA_VERSION, records: {}, receipts: {} };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isTenantHumanId(value: unknown): value is TenantHumanId {
  return isObject(value)
    && typeof value.tenantKey === 'string'
    && value.tenantKey.length > 0
    && typeof value.unionId === 'string'
    && value.unionId.startsWith('on_');
}

function isDirectoryState(value: unknown): value is GroupDirectoryState {
  return isObject(value) && (
    (value.kind === 'unbound' && Object.keys(value).length === 1)
    || (value.kind === 'bound' && typeof value.workingDir === 'string' && isAbsolute(value.workingDir))
  );
}

function validManagers(value: unknown): value is TenantHumanId[] | undefined {
  return value === undefined || (Array.isArray(value) && value.every(isTenantHumanId));
}

function validateRecord(value: unknown, key: string): asserts value is GroupWorkspaceRecord {
  if (!isObject(value)
    || value.chatId !== key
    || !Number.isSafeInteger(value.revision) || (value.revision as number) < 1
    || !isDirectoryState(value.directory)
    || !validManagers(value.workspaceManagers)
    || !Number.isFinite(value.updatedAt)
    || !isTenantHumanId(value.updatedBy)) {
    throw new Error(`invalid group workspace record: ${key}`);
  }
}

const TERMINAL_OUTCOMES = new Set<GroupOperationTerminalOutcome>([
  'committed', 'conflict', 'invalid_dir', 'unauthorized', 'store_unavailable',
]);

function validateReceipt(value: unknown, key: string): asserts value is GroupOperationReceipt {
  if (!isObject(value)
    || value.operationKey !== key
    || typeof value.sourceEventId !== 'string' || !value.sourceEventId
    || (value.kind !== 'set' && value.kind !== 'unbind')
    || value.operationKey !== groupWorkspaceOperationKey(value.sourceEventId, value.kind)
    || typeof value.payloadDigest !== 'string' || !value.payloadDigest
    || typeof value.chatId !== 'string' || !value.chatId
    || !TERMINAL_OUTCOMES.has(value.outcome as GroupOperationTerminalOutcome)
    || !isTenantHumanId(value.actor)
    || !Number.isFinite(value.completedAt)
    || !Number.isSafeInteger(value.expectedRevision) || (value.expectedRevision as number) < 0
    || (value.expectedSessionGeneration !== undefined
      && (!Number.isSafeInteger(value.expectedSessionGeneration) || (value.expectedSessionGeneration as number) < 0))
    || (value.canonicalTargetWorkingDir !== undefined
      && (typeof value.canonicalTargetWorkingDir !== 'string' || !isAbsolute(value.canonicalTargetWorkingDir)))
    || (value.resultingRevision !== undefined
      && (!Number.isSafeInteger(value.resultingRevision) || (value.resultingRevision as number) < 1))
    || (value.resultingDirectory !== undefined && !isDirectoryState(value.resultingDirectory))) {
    throw new Error(`invalid group workspace receipt: ${key}`);
  }
  const committed = value.outcome === 'committed';
  if (committed !== (value.resultingRevision !== undefined && value.resultingDirectory !== undefined)) {
    throw new Error(`invalid group workspace receipt outcome shape: ${key}`);
  }
  if (value.kind === 'set') {
    if (typeof value.canonicalTargetWorkingDir !== 'string') {
      throw new Error(`invalid group workspace set receipt target: ${key}`);
    }
    const expectedDigest = digest('group-workspace-payload-v1', [
      PAYLOAD_VERSION, value.chatId, value.kind, value.canonicalTargetWorkingDir,
    ]);
    if (value.payloadDigest !== expectedDigest
      || (committed && (value.resultingDirectory?.kind !== 'bound'
        || value.resultingDirectory.workingDir !== value.canonicalTargetWorkingDir))) {
      throw new Error(`invalid group workspace set receipt payload: ${key}`);
    }
  } else {
    const expectedDigest = digest('group-workspace-payload-v1', [
      PAYLOAD_VERSION, value.chatId, value.kind, 'tombstone',
    ]);
    if (value.payloadDigest !== expectedDigest
      || value.canonicalTargetWorkingDir !== undefined
      || value.expectedSessionGeneration !== undefined
      || (committed && value.resultingDirectory?.kind !== 'unbound')) {
      throw new Error(`invalid group workspace unbind receipt payload: ${key}`);
    }
  }
}

function readRegistry(path: string): GroupWorkspaceRegistry {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyRegistry();
    throw error;
  }
  const parsed: unknown = JSON.parse(raw);
  if (!isObject(parsed)
    || parsed.schemaVersion !== SCHEMA_VERSION
    || !isObject(parsed.records)
    || !isObject(parsed.receipts)) {
    throw new Error('invalid group workspace store schema');
  }
  for (const [key, value] of Object.entries(parsed.records)) validateRecord(value, key);
  for (const [key, value] of Object.entries(parsed.receipts)) validateReceipt(value, key);
  const registry = parsed as unknown as GroupWorkspaceRegistry;
  for (const receipt of Object.values(registry.receipts)) {
    if (receipt.outcome !== 'committed') continue;
    const record = registry.records[receipt.chatId];
    if (!record || receipt.resultingRevision! > record.revision) {
      throw new Error(`committed group workspace receipt is ahead of record: ${receipt.operationKey}`);
    }
    if (receipt.resultingRevision === record.revision
      && JSON.stringify(receipt.resultingDirectory) !== JSON.stringify(record.directory)) {
      throw new Error(`latest group workspace receipt disagrees with record: ${receipt.operationKey}`);
    }
  }
  return registry;
}

function cloneRecord(record: GroupWorkspaceRecord | undefined): GroupWorkspaceRecord | undefined {
  return record ? structuredClone(record) : undefined;
}

function sameActor(left: TenantHumanId, right: TenantHumanId): boolean {
  return left.tenantKey === right.tenantKey && left.unionId === right.unionId;
}

function actorAllowed(input: GroupWorkspaceMutation, current: GroupWorkspaceRecord | undefined): boolean {
  if (!input.authorized) return false;
  const managers = current?.workspaceManagers;
  return !managers?.length || managers.some(manager => sameActor(manager, input.actor));
}

export class GroupWorkspaceStore {
  private readonly path: string;
  private readonly lockTimeoutMs: number | undefined;

  constructor(dataDir: string, options: GroupWorkspaceStoreOptions = {}) {
    this.path = join(dataDir, GROUP_WORKSPACE_STORE_FILE);
    this.lockTimeoutMs = options.lockTimeoutMs;
  }

  async read(chatId: string): Promise<GroupWorkspaceReadResult> {
    try {
      mkdirSync(resolve(this.path, '..'), { recursive: true });
      return await withFileLock(this.path, async () => {
        const registry = readRegistry(this.path);
        return { status: 'available' as const, record: cloneRecord(registry.records[chatId]) };
      }, { maxWaitMs: this.lockTimeoutMs });
    } catch {
      return { status: 'store_unavailable' };
    }
  }

  async mutate(input: GroupWorkspaceMutation): Promise<GroupWorkspaceMutationResult> {
    const operationKey = groupWorkspaceOperationKey(input.sourceEventId, input.kind);
    const payloadDigest = canonicalGroupOperationPayloadDigest(input);
    try {
      mkdirSync(resolve(this.path, '..'), { recursive: true });
      return await withFileLock(this.path, async () => {
        const registry = readRegistry(this.path);

        // Replay is intentionally decided before reading the current record/revision.
        const existing = registry.receipts[operationKey];
        if (existing) {
          if (existing.payloadDigest !== payloadDigest || existing.chatId !== input.chatId) {
            return { outcome: 'protocol_conflict' as const, existingReceipt: structuredClone(existing) };
          }
          return { outcome: existing.outcome, receipt: structuredClone(existing) };
        }
        const conflictingKind = Object.values(registry.receipts)
          .find(receipt => receipt.sourceEventId === input.sourceEventId && receipt.kind !== input.kind);
        if (conflictingKind) {
          return {
            outcome: 'protocol_conflict' as const,
            existingReceipt: structuredClone(conflictingKind),
          };
        }

        const current = registry.records[input.chatId];
        let outcome: Exclude<GroupOperationTerminalOutcome, 'store_unavailable'>;
        let resultingRevision: number | undefined;
        let resultingDirectory: GroupDirectoryState | undefined;

        if (!actorAllowed(input, current)) outcome = 'unauthorized';
        else if (input.kind === 'set' && (!input.directoryValid || !isAbsolute(input.requestedWorkingDir))) {
          outcome = 'invalid_dir';
        } else if ((current?.revision ?? 0) !== input.expectedRevision) outcome = 'conflict';
        else {
          const previousRevision = current?.revision ?? 0;
          if (previousRevision >= Number.MAX_SAFE_INTEGER) {
            throw new Error('group workspace revision exhausted');
          }
          outcome = 'committed';
          resultingRevision = previousRevision + 1;
          resultingDirectory = input.kind === 'set'
            ? { kind: 'bound', workingDir: canonicalWorkingDir(input.requestedWorkingDir) }
            : { kind: 'unbound' };
          registry.records[input.chatId] = {
            chatId: input.chatId,
            revision: resultingRevision,
            directory: resultingDirectory,
            ...(current?.workspaceManagers?.length
              ? { workspaceManagers: current.workspaceManagers.map(manager => ({ ...manager })) }
              : {}),
            updatedAt: input.now,
            updatedBy: { ...input.actor },
          };
        }

        const receipt: GroupOperationReceipt = {
          operationKey,
          sourceEventId: input.sourceEventId,
          ...(input.originMessageId ? { originMessageId: input.originMessageId } : {}),
          kind: input.kind,
          payloadDigest,
          chatId: input.chatId,
          outcome,
          ...(resultingRevision !== undefined ? { resultingRevision } : {}),
          ...(resultingDirectory ? { resultingDirectory } : {}),
          actor: { ...input.actor },
          completedAt: input.now,
          expectedRevision: input.expectedRevision,
          ...(input.kind === 'set' && input.expectedSessionGeneration !== undefined
            ? { expectedSessionGeneration: input.expectedSessionGeneration }
            : {}),
          ...(input.kind === 'set'
            ? { canonicalTargetWorkingDir: canonicalWorkingDir(input.requestedWorkingDir) }
            : {}),
        };
        registry.receipts[operationKey] = receipt;
        atomicWriteFileSync(this.path, `${JSON.stringify(registry, null, 2)}\n`, {
          mode: 0o600,
          durable: true,
          followTargetSymlink: false,
        });
        return { outcome, receipt: structuredClone(receipt) };
      }, { maxWaitMs: this.lockTimeoutMs });
    } catch {
      return { outcome: 'store_unavailable' };
    }
  }
}
