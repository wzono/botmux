import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import type { TenantHumanId } from './bot-admin-unions-store.js';
import {
  probePathUsability,
  type PathIdentity,
  type PathUsabilityProbeOptions,
  type PathUsabilityResult,
} from '../core/path-usability.js';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { fsyncFilesAndDirectorySync } from '../utils/fs-durability.js';
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
  directoryIdentity?: PathIdentity;
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
  | { outcome: 'store_unavailable' | 'unknown' };

export type GroupWorkspaceReadResult =
  | { status: 'available'; record: GroupWorkspaceRecord | undefined }
  | { status: 'store_unavailable' };

type GroupWorkspaceWriter = typeof atomicWriteFileSync;
type DurabilityReestablisher = (filePath: string) => void;
export type GroupWorkspacePathProbe = (
  path: string,
  options?: PathUsabilityProbeOptions,
) => PathUsabilityResult;

export type GroupWorkspaceConsumptionResult =
  | { status: 'available'; record: undefined }
  | { status: 'unbound'; record: GroupWorkspaceRecord }
  | { status: 'usable'; record: GroupWorkspaceRecord; usability: Extract<PathUsabilityResult, { ok: true }> }
  | { status: 'unusable'; record: GroupWorkspaceRecord; usability: Extract<PathUsabilityResult, { ok: false }> }
  | { status: 'store_unavailable' };

export interface GroupWorkspaceStoreOptions {
  lockTimeoutMs?: number;
  writer?: GroupWorkspaceWriter;
  durabilityReestablisher?: DurabilityReestablisher;
  pathProbe?: GroupWorkspacePathProbe;
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

/** Stable semantic request identity before a repo name/index is resolved to a path. */
export function canonicalGroupWorkspaceRequestIntentDigest(input: {
  chatId: string;
  kind: 'set';
  selection: string;
}): string {
  return digest('group-workspace-request-intent-v1', [PAYLOAD_VERSION, input.chatId, input.kind, input.selection.trim()]);
}

export function groupWorkspaceOperationKey(sourceEventId: string, kind: GroupOperationKind): string {
  return digest('group-workspace-operation-v1', [OPERATION_KEY_VERSION, sourceEventId, kind]);
}

function nullMap<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>;
}

function emptyRegistry(): GroupWorkspaceRegistry {
  return { schemaVersion: SCHEMA_VERSION, records: nullMap(), receipts: nullMap() };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function own<T>(map: Record<string, T>, key: string): T | undefined {
  return Object.prototype.hasOwnProperty.call(map, key) ? map[key] : undefined;
}

function toNullMap<T>(value: Record<string, T>): Record<string, T> {
  return Object.assign(nullMap<T>(), value);
}

function isTenantHumanId(value: unknown): value is TenantHumanId {
  return isObject(value)
    && typeof value.tenantKey === 'string'
    && value.tenantKey.length > 0
    && value.tenantKey.trim() === value.tenantKey
    && typeof value.unionId === 'string'
    && /^on_\S+$/.test(value.unionId);
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

function isPathIdentity(value: unknown): value is PathIdentity {
  return isObject(value)
    && typeof value.dev === 'string' && /^\d+$/.test(value.dev)
    && typeof value.ino === 'string' && /^\d+$/.test(value.ino);
}

function validateRecord(value: unknown, key: string): asserts value is GroupWorkspaceRecord {
  if (!isObject(value)
    || value.chatId !== key
    || !Number.isSafeInteger(value.revision) || (value.revision as number) < 1
    || !isDirectoryState(value.directory)
    || (value.directory.kind === 'bound'
      && value.directoryIdentity !== undefined && !isPathIdentity(value.directoryIdentity))
    || (value.directory.kind === 'unbound' && value.directoryIdentity !== undefined)
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
    || (value.originMessageId !== undefined && !isStableOpaqueId(value.originMessageId))
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
  if (committed && value.resultingRevision !== (value.expectedRevision as number) + 1) {
    throw new Error(`invalid group workspace committed revision: ${key}`);
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

function parseRegistry(path: string): GroupWorkspaceRegistry {
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
  return {
    schemaVersion: SCHEMA_VERSION,
    records: toNullMap(parsed.records as Record<string, GroupWorkspaceRecord>),
    receipts: toNullMap(parsed.receipts as Record<string, GroupOperationReceipt>),
  };
}

function validateRegistryHistory(registry: GroupWorkspaceRegistry): void {
  const committedByChatRevision = new Map<string, GroupOperationReceipt>();
  for (const receipt of Object.values(registry.receipts)) {
    if (receipt.outcome !== 'committed') continue;
    const record = own(registry.records, receipt.chatId);
    if (!record || receipt.resultingRevision! > record.revision) {
      throw new Error(`committed group workspace receipt is ahead of record: ${receipt.operationKey}`);
    }
    const historyKey = JSON.stringify([receipt.chatId, receipt.resultingRevision]);
    if (committedByChatRevision.has(historyKey)) {
      throw new Error(`duplicate committed group workspace revision: ${historyKey}`);
    }
    committedByChatRevision.set(historyKey, receipt);
  }
  for (const record of Object.values(registry.records)) {
    for (let revision = 1; revision <= record.revision; revision += 1) {
      if (!committedByChatRevision.has(JSON.stringify([record.chatId, revision]))) {
        throw new Error(`missing committed group workspace revision: ${record.chatId}:${revision}`);
      }
    }
    const latest = committedByChatRevision.get(JSON.stringify([record.chatId, record.revision]));
    if (!latest
      || JSON.stringify(latest.resultingDirectory) !== JSON.stringify(record.directory)
      || !sameActor(latest.actor, record.updatedBy)
      || latest.completedAt !== record.updatedAt) {
      throw new Error(`latest group workspace receipt disagrees with record: ${record.chatId}`);
    }
  }
}

function readRegistry(path: string): GroupWorkspaceRegistry {
  const registry = parseRegistry(path);
  validateRegistryHistory(registry);
  return registry;
}

function cloneRecord(record: GroupWorkspaceRecord | undefined): GroupWorkspaceRecord | undefined {
  return record ? structuredClone(record) : undefined;
}

function sameActor(left: TenantHumanId, right: TenantHumanId): boolean {
  return left.tenantKey === right.tenantKey && left.unionId === right.unionId;
}

/** Exact authoritative receipt match for a frozen mutation intent. */
export function groupWorkspaceReceiptMatchesMutation(
  receipt: GroupOperationReceipt,
  input: GroupWorkspaceMutation,
): boolean {
  return receipt.operationKey === groupWorkspaceOperationKey(input.sourceEventId, input.kind)
    && receipt.sourceEventId === input.sourceEventId
    && receipt.kind === input.kind
    && receipt.payloadDigest === canonicalGroupOperationPayloadDigest(input)
    && receipt.chatId === input.chatId
    && receipt.expectedRevision === input.expectedRevision
    && receipt.originMessageId === input.originMessageId
    && sameActor(receipt.actor, input.actor)
    && (input.kind === 'unbind'
      ? receipt.canonicalTargetWorkingDir === undefined
        && receipt.expectedSessionGeneration === undefined
        && (receipt.outcome !== 'committed' || receipt.resultingDirectory?.kind === 'unbound')
      : receipt.canonicalTargetWorkingDir === canonicalWorkingDir(input.requestedWorkingDir)
        && receipt.expectedSessionGeneration === input.expectedSessionGeneration
        && (receipt.outcome !== 'committed'
          || (receipt.resultingDirectory?.kind === 'bound'
            && receipt.resultingDirectory.workingDir === canonicalWorkingDir(input.requestedWorkingDir))));
}

function actorAllowed(input: GroupWorkspaceMutation, current: GroupWorkspaceRecord | undefined): boolean {
  if (!input.authorized) return false;
  const managers = current?.workspaceManagers;
  return !managers?.length || managers.some(manager => sameActor(manager, input.actor));
}

function isStableOpaqueId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.trim() === value;
}

function validMutation(input: unknown): input is GroupWorkspaceMutation {
  if (!isObject(input)
    || (input.kind !== 'set' && input.kind !== 'unbind')
    || !isStableOpaqueId(input.chatId)
    || !isStableOpaqueId(input.sourceEventId)
    || !/^group-workspace-(?:text-source|card-source)-v1:sha256:[0-9a-f]{64}$/.test(input.sourceEventId as string)
    || !isTenantHumanId(input.actor)
    || typeof input.authorized !== 'boolean'
    || !Number.isSafeInteger(input.expectedRevision) || (input.expectedRevision as number) < 0
    || !Number.isFinite(input.now) || (input.now as number) < 0
    || (input.originMessageId !== undefined && !isStableOpaqueId(input.originMessageId))) {
    return false;
  }
  if (input.kind === 'unbind') return input.expectedSessionGeneration === undefined;
  if (typeof input.directoryValid !== 'boolean'
    || typeof input.requestedWorkingDir !== 'string'
    || !input.requestedWorkingDir
    || (input.directoryValid && !isAbsolute(input.requestedWorkingDir))
    || (input.directoryValid && !isAbsolute(canonicalWorkingDir(input.requestedWorkingDir)))
    || (input.expectedSessionGeneration !== undefined
      && (!Number.isSafeInteger(input.expectedSessionGeneration)
        || (input.expectedSessionGeneration as number) < 0))) {
    return false;
  }
  return true;
}

export class GroupWorkspaceStore {
  private readonly path: string;
  private readonly lockTimeoutMs: number | undefined;
  private readonly writer: GroupWorkspaceWriter;
  private readonly durabilityReestablisher: DurabilityReestablisher;
  private readonly pathProbe: GroupWorkspacePathProbe;

  constructor(dataDir: string, options: GroupWorkspaceStoreOptions = {}) {
    this.path = join(dataDir, GROUP_WORKSPACE_STORE_FILE);
    this.lockTimeoutMs = options.lockTimeoutMs;
    this.writer = options.writer ?? atomicWriteFileSync;
    this.durabilityReestablisher = options.durabilityReestablisher
      ?? (filePath => fsyncFilesAndDirectorySync(dirname(filePath), [filePath]));
    this.pathProbe = options.pathProbe ?? probePathUsability;
  }

  async readReceipt(operationKey: string): Promise<
    | { status: 'found'; receipt: GroupOperationReceipt }
    | { status: 'missing' }
    | { status: 'store_unavailable' }
  > {
    try {
      mkdirSync(resolve(this.path, '..'), { recursive: true });
      return await withFileLock(this.path, async () => {
        const receipt = own(readRegistry(this.path).receipts, operationKey);
        return receipt
          ? { status: 'found' as const, receipt: structuredClone(receipt) }
          : { status: 'missing' as const };
      }, { maxWaitMs: this.lockTimeoutMs });
    } catch {
      return { status: 'store_unavailable' };
    }
  }

  async read(chatId: string): Promise<GroupWorkspaceReadResult> {
    try {
      mkdirSync(resolve(this.path, '..'), { recursive: true });
      return await withFileLock(this.path, async () => {
        const registry = readRegistry(this.path);
        return { status: 'available' as const, record: cloneRecord(own(registry.records, chatId)) };
      }, { maxWaitMs: this.lockTimeoutMs });
    } catch {
      return { status: 'store_unavailable' };
    }
  }

  async probeBoundDirectoryForConsumption(chatId: string): Promise<GroupWorkspaceConsumptionResult> {
    const readResult = await this.read(chatId);
    if (readResult.status === 'store_unavailable') return readResult;
    const { record } = readResult;
    if (!record) return { status: 'available', record: undefined };
    if (record.directory.kind === 'unbound') return { status: 'unbound', record };
    const usability = this.pathProbe(record.directory.workingDir, record.directoryIdentity
      ? { expectedIdentity: record.directoryIdentity }
      : undefined);
    return usability.ok
      ? { status: 'usable', record, usability }
      : { status: 'unusable', record, usability };
  }

  async reconcileExactOperation(input: GroupWorkspaceMutation): Promise<GroupWorkspaceMutationResult> {
    if (!validMutation(input)) return { outcome: 'store_unavailable' };
    const operationKey = groupWorkspaceOperationKey(input.sourceEventId, input.kind);
    const payloadDigest = canonicalGroupOperationPayloadDigest(input);
    try {
      mkdirSync(resolve(this.path, '..'), { recursive: true });
      return await withFileLock(this.path, async () => {
        const registry = parseRegistry(this.path);
        const existing = own(registry.receipts, operationKey);
        if (existing) {
          if (existing.payloadDigest !== payloadDigest || existing.chatId !== input.chatId
            || !sameActor(existing.actor, input.actor)) {
            return { outcome: 'protocol_conflict' as const, existingReceipt: structuredClone(existing) };
          }
          validateRegistryHistory(registry);
          try {
            this.durabilityReestablisher(this.path);
          } catch {
            return { outcome: 'unknown' as const };
          }
          return { outcome: existing.outcome, receipt: structuredClone(existing) };
        }
        const current = own(registry.records, input.chatId);
        const target = input.kind === 'set'
          ? { kind: 'bound' as const, workingDir: canonicalWorkingDir(input.requestedWorkingDir) }
          : { kind: 'unbound' as const };
        const exact = current
          && current.revision === input.expectedRevision + 1
          && JSON.stringify(current.directory) === JSON.stringify(target)
          && sameActor(current.updatedBy, input.actor)
          && current.updatedAt === input.now;
        if (!exact) return { outcome: 'store_unavailable' as const };
        const receipt: GroupOperationReceipt = {
          operationKey,
          sourceEventId: input.sourceEventId,
          ...(input.originMessageId ? { originMessageId: input.originMessageId } : {}),
          kind: input.kind,
          payloadDigest,
          chatId: input.chatId,
          outcome: 'committed',
          resultingRevision: current.revision,
          resultingDirectory: structuredClone(current.directory),
          actor: { ...input.actor },
          completedAt: input.now,
          expectedRevision: input.expectedRevision,
          ...(input.kind === 'set' && input.expectedSessionGeneration !== undefined
            ? { expectedSessionGeneration: input.expectedSessionGeneration }
            : {}),
          ...(input.kind === 'set' ? { canonicalTargetWorkingDir: target.workingDir } : {}),
        };
        registry.receipts[operationKey] = receipt;
        validateRegistryHistory(registry);
        try {
          this.writer(this.path, `${JSON.stringify(registry, null, 2)}\n`, {
            mode: 0o600, durable: true, followTargetSymlink: false,
          });
        } catch {
          let readback: GroupWorkspaceRegistry;
          try {
            readback = readRegistry(this.path);
          } catch {
            return { outcome: 'unknown' as const };
          }
          const durableReceipt = own(readback.receipts, operationKey);
          if (!durableReceipt || durableReceipt.payloadDigest !== payloadDigest
            || durableReceipt.chatId !== input.chatId || !sameActor(durableReceipt.actor, input.actor)) {
            return { outcome: 'unknown' as const };
          }
          try {
            this.durabilityReestablisher(this.path);
          } catch {
            return { outcome: 'unknown' as const };
          }
          return { outcome: durableReceipt.outcome, receipt: structuredClone(durableReceipt) };
        }
        return { outcome: 'committed', receipt: structuredClone(receipt) };
      }, { maxWaitMs: this.lockTimeoutMs });
    } catch {
      return { outcome: 'store_unavailable' };
    }
  }

  async mutate(input: GroupWorkspaceMutation): Promise<GroupWorkspaceMutationResult> {
    if (!validMutation(input)) return { outcome: 'store_unavailable' };
    const operationKey = groupWorkspaceOperationKey(input.sourceEventId, input.kind);
    const payloadDigest = canonicalGroupOperationPayloadDigest(input);
    try {
      mkdirSync(resolve(this.path, '..'), { recursive: true });
      return await withFileLock(this.path, async () => {
        const registry = readRegistry(this.path);

        // Replay is intentionally decided before reading the current record/revision.
        const existing = own(registry.receipts, operationKey);
        if (existing) {
          if (existing.payloadDigest !== payloadDigest || existing.chatId !== input.chatId) {
            return { outcome: 'protocol_conflict' as const, existingReceipt: structuredClone(existing) };
          }
          try {
            this.durabilityReestablisher(this.path);
          } catch {
            return { outcome: 'unknown' as const };
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

        const current = own(registry.records, input.chatId);
        let outcome: Exclude<GroupOperationTerminalOutcome, 'store_unavailable'>;
        let resultingRevision: number | undefined;
        let resultingDirectory: GroupDirectoryState | undefined;
        let validatedIdentity: PathIdentity | undefined;

        if (!actorAllowed(input, current)) outcome = 'unauthorized';
        else if (input.kind === 'set') {
          if (!input.directoryValid || !isAbsolute(input.requestedWorkingDir)) {
            outcome = 'invalid_dir';
          } else {
            const usability = this.pathProbe(input.requestedWorkingDir);
            if (!usability.ok) outcome = 'invalid_dir';
            else {
              validatedIdentity = usability.identity;
              outcome = (current?.revision ?? 0) !== input.expectedRevision ? 'conflict' : 'committed';
            }
          }
        } else outcome = (current?.revision ?? 0) !== input.expectedRevision ? 'conflict' : 'committed';

        if (outcome === 'committed') {
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
            ...(validatedIdentity ? { directoryIdentity: validatedIdentity } : {}),
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
        try {
          this.writer(this.path, `${JSON.stringify(registry, null, 2)}\n`, {
            mode: 0o600,
            durable: true,
            followTargetSymlink: false,
          });
        } catch {
          // The atomic writer can throw after rename while fsyncing the directory.
          // Reconcile exactly once under the same lock; never retry the mutation.
          let reconciled: GroupWorkspaceRegistry;
          try {
            reconciled = readRegistry(this.path);
          } catch {
            return { outcome: 'unknown' as const };
          }
          const durableReceipt = own(reconciled.receipts, operationKey);
          if (!durableReceipt) return { outcome: 'store_unavailable' as const };
          if (durableReceipt.payloadDigest !== payloadDigest || durableReceipt.chatId !== input.chatId) {
            return { outcome: 'unknown' as const };
          }
          try {
            this.durabilityReestablisher(this.path);
          } catch {
            return { outcome: 'unknown' as const };
          }
          return { outcome: durableReceipt.outcome, receipt: structuredClone(durableReceipt) };
        }
        return { outcome, receipt: structuredClone(receipt) };
      }, { maxWaitMs: this.lockTimeoutMs });
    } catch {
      return { outcome: 'store_unavailable' };
    }
  }
}
