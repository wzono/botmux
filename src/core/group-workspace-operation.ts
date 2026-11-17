import type { TenantHumanId } from '../services/bot-admin-unions-store.js';
import {
  canonicalGroupOperationPayloadDigest,
  groupWorkspaceOperationKey,
  groupWorkspaceReceiptMatchesMutation,
  type GroupOperationKind,
  type GroupWorkspaceAuthorityEvidence,
  type GroupWorkspaceLockAuthorityContext,
  type GroupWorkspaceMutationResult,
  type GroupWorkspaceStore,
  type GroupWorkspaceUnbindMutation,
} from '../services/group-workspace-store.js';
import type {
  GroupWorkspaceOperationStore,
  RepoGroupOperationJournal,
} from '../services/group-workspace-operation-store.js';
import type { WorkspaceIdentity } from '../types.js';
import type { OperationExecutorLease, OperationExecutorLeaseStore } from '../services/operation-executor-lease-store.js';

export type GroupCommitResult =
  | { status: 'committed'; resultingRevision: number }
  | { status: 'conflict'; currentRevision: number }
  | { status: 'unauthorized' }
  | { status: 'store_unavailable' }
  | { status: 'unknown' };

export type GroupCommitReceipt = Exclude<GroupCommitResult, { status: 'unknown' }> & {
  operationKey: string;
  payloadDigest: string;
  chatId: string;
  targetWorkingDir: string;
  workspaceIdentity: WorkspaceIdentity;
};

export type GroupReceiptLookupResult =
  | { status: 'found'; receipt: GroupCommitReceipt }
  | { status: 'missing' }
  | { status: 'store_unavailable' };

export interface GroupWorkspaceOperationRequest {
  operationKey: string;
  sourceEventId: string;
  /** Task 5 coordinates the session-to-group set saga; unbind is wired separately in Task 6. */
  kind: Extract<GroupOperationKind, 'set'>;
  /** Normalized raw selection, before name/index target resolution. */
  requestIntentDigest: string;
  chatId: string;
  sessionId: string;
  actor: TenantHumanId;
  authorityFingerprint?: string;
  ownerLarkAppId?: string;
}

export type GroupWorkspaceOperationResult =
  | { status: 'group_committed'; journal?: RepoGroupOperationJournal; groupRevision: number }
  | { status: 'conflict'; journal?: RepoGroupOperationJournal; currentRevision?: number }
  | { status: 'unauthorized'; journal?: RepoGroupOperationJournal }
  | { status: 'store_unavailable'; journal?: RepoGroupOperationJournal }
  | { status: 'unknown'; journal?: RepoGroupOperationJournal }
  | { status: 'convergence_quarantined'; journal: RepoGroupOperationJournal; reason: 'session_missing' | 'generation_conflict' }
  | { status: 'observing'; journal: RepoGroupOperationJournal; receipt?: GroupCommitReceipt }
  | { status: 'protocol_conflict'; journal?: RepoGroupOperationJournal };

export interface GroupWorkspaceOperationDependencies {
  journalStore: GroupWorkspaceOperationStore;
  now(): number;
  revalidateAuthority?(journal: RepoGroupOperationJournal): Promise<GroupWorkspaceAuthorityEvidence & {
    revalidateUnderLock?: (context: GroupWorkspaceLockAuthorityContext) => GroupWorkspaceAuthorityEvidence;
    releasePublicationLease?: () => Promise<void>;
  }>;
  acquireExecutor?(operationKey: string): Promise<
    | { status: 'acquired'; lease: OperationExecutorLease }
    | { status: 'observer'; lease: OperationExecutorLease }
  >;
  renewExecutor?(operationKey: string, lease: OperationExecutorLease): Promise<OperationExecutorLease | undefined>;
  assertFence?(operationKey: string, lease: OperationExecutorLease): Promise<boolean>;
  runFencedEffect?<T>(operationKey: string, lease: OperationExecutorLease, effect: () => Promise<T>): Promise<
    | { status: 'applied'; value: T }
    | { status: 'stale_fence' }
  >;
  lookupGroupReceipt(operationKey: string): Promise<GroupReceiptLookupResult>;
  /** Under the group-store lock, establish-or-read and return the authoritative exact-operation receipt. */
  reconcileUnknownGroupReceipt(journal: RepoGroupOperationJournal): Promise<GroupReceiptLookupResult>;
  readCurrentGroupRevision(chatId: string): Promise<
    | { status: 'available'; revision: number }
    | { status: 'store_unavailable' }
  >;
  resolveCanonicalTarget(request: GroupWorkspaceOperationRequest): Promise<
    | { status: 'resolved'; workingDir: string; workspaceIdentity: WorkspaceIdentity }
    | { status: 'store_unavailable' }
  >;
  readSession(sessionId: string): Promise<
    | { status: 'available'; generation: number; workingDir: string }
    | { status: 'store_unavailable' }
  >;
  switchSession(input: {
    sessionId: string;
    expectedGeneration: number;
    targetWorkingDir: string;
    workspaceIdentity: WorkspaceIdentity;
    fencingToken?: number;
  }): Promise<
    | { status: 'committed'; generation: number }
    | { status: 'store_unavailable' }
    | { status: 'unknown' }
  >;
  commitGroup(
    input: RepoGroupOperationJournal,
    fencingToken?: number,
  ): Promise<GroupCommitResult>;
  convergeSession(input: {
    sessionId: string;
    expectedGeneration: number;
    source: 'explicit' | 'group';
    groupRevision?: number;
    workspaceIdentity?: WorkspaceIdentity;
  }): Promise<void | 'converged' | 'session_missing' | 'generation_conflict'>;
  fencingToken?(): number | undefined;
  afterBoundary?(boundary:
    | 'prepared_before_switch'
    | 'session_persisted_before_advance'
    | 'group_committed_before_convergence'
    | 'receipt_before_response'
  ): Promise<void>;
}

export function createGroupWorkspaceSetCoordinator(options: {
  journalStore: GroupWorkspaceOperationStore;
  groupStore: Pick<GroupWorkspaceStore, 'read' | 'readReceipt' | 'reconcileExactOperation' | 'mutate'>;
  now(): number;
  resolveCanonicalTarget: GroupWorkspaceOperationDependencies['resolveCanonicalTarget'];
  readSession: GroupWorkspaceOperationDependencies['readSession'];
  switchSession: GroupWorkspaceOperationDependencies['switchSession'];
  convergeSession: GroupWorkspaceOperationDependencies['convergeSession'];
  originMessageId?: string;
  authorityFingerprint?: string;
  revalidateAuthority?: GroupWorkspaceOperationDependencies['revalidateAuthority'];
  executorLeaseStore?: OperationExecutorLeaseStore;
  executorOwner?: string;
  executorLeaseTtlMs?: number;
  afterBoundary?: GroupWorkspaceOperationDependencies['afterBoundary'];
}): GroupWorkspaceOperationCoordinator {
  let currentLease: OperationExecutorLease | undefined;
  const receiptFor = (receipt: import('../services/group-workspace-store.js').GroupOperationReceipt): GroupCommitReceipt | undefined => {
    if (receipt.kind !== 'set' || !receipt.canonicalTargetWorkingDir) return undefined;
    const identity = {
      operationKey: receipt.operationKey, payloadDigest: receipt.payloadDigest,
      chatId: receipt.chatId, targetWorkingDir: receipt.canonicalTargetWorkingDir,
      workspaceIdentity: receipt.workspaceIdentity!,
    };
    if (receipt.outcome === 'committed') return { ...identity, status: 'committed', resultingRevision: receipt.resultingRevision! };
    if (receipt.outcome === 'conflict') return { ...identity, status: 'conflict', currentRevision: receipt.resultingRevision ?? receipt.expectedRevision };
    return { ...identity, status: 'store_unavailable' };
  };
  const dependencies: GroupWorkspaceOperationDependencies = {
    journalStore: options.journalStore,
    now: options.now,
    ...(options.revalidateAuthority ? { revalidateAuthority: options.revalidateAuthority } : {}),
    ...(options.executorLeaseStore && options.executorOwner ? {
      acquireExecutor: async (operationKey: string) => {
        const acquired = await options.executorLeaseStore!.acquire(
          operationKey, options.executorOwner!, options.executorLeaseTtlMs ?? 30_000,
        );
        if (acquired.status === 'acquired') currentLease = acquired.lease;
        return acquired;
      },
      renewExecutor: async (operationKey: string, lease: OperationExecutorLease) => {
        const renewed = await options.executorLeaseStore!.renew(
          operationKey, lease, options.executorLeaseTtlMs ?? 30_000,
        );
        if (renewed.status !== 'renewed') return undefined;
        currentLease = renewed.lease;
        return renewed.lease;
      },
      assertFence: async (operationKey: string, lease: OperationExecutorLease) =>
        (await options.executorLeaseStore!.assertCurrent(operationKey, lease)).status === 'current',
      runFencedEffect: <T>(operationKey: string, lease: OperationExecutorLease, effect: () => Promise<T>) =>
        options.executorLeaseStore!.runFencedEffect(operationKey, lease, effect),
      fencingToken: () => currentLease?.fencingToken,
    } : {}),
    lookupGroupReceipt: async operationKey => {
      const found = await options.groupStore.readReceipt(operationKey);
      if (found.status !== 'found') return found;
      const receipt = receiptFor(found.receipt);
      return receipt ? { status: 'found', receipt } : { status: 'missing' };
    },
    reconcileUnknownGroupReceipt: async journal => {
      const result = await options.groupStore.reconcileExactOperation({
        kind: 'set', chatId: journal.chatId, sourceEventId: journal.sourceEventId,
        requestedWorkingDir: journal.targetWorkingDir!, expectedWorkspaceIdentity: journal.targetWorkspaceIdentity,
        expectedRevision: journal.expectedGroupRevision,
        expectedSessionGeneration: journal.expectedSessionGeneration, actor: journal.actor,
        authorized: true, directoryValid: true, now: journal.updatedAt,
      });
      if (!('receipt' in result)) return result.outcome === 'store_unavailable'
        ? { status: 'store_unavailable' } : { status: 'missing' };
      const receipt = receiptFor(result.receipt);
      return receipt ? { status: 'found', receipt } : { status: 'missing' };
    },
    readCurrentGroupRevision: async chatId => {
      const current = await options.groupStore.read(chatId);
      return current.status === 'available'
        ? { status: 'available', revision: current.record?.revision ?? 0 }
        : current;
    },
    resolveCanonicalTarget: options.resolveCanonicalTarget,
    readSession: options.readSession,
    switchSession: options.switchSession,
    commitGroup: async journal => {
      if (isQuarantinedSetJournal(journal)) return { status: 'unknown' };
      const authority = options.revalidateAuthority
        ? await options.revalidateAuthority(journal)
        : { status: 'authorized' as const };
      let result: GroupWorkspaceMutationResult;
      try {
        result = await options.groupStore.mutate({
          kind: 'set', chatId: journal.chatId, sourceEventId: journal.sourceEventId,
          ...(options.originMessageId ? { originMessageId: options.originMessageId } : {}),
          requestedWorkingDir: journal.targetWorkingDir!, expectedWorkspaceIdentity: journal.targetWorkspaceIdentity,
          expectedRevision: journal.expectedGroupRevision,
          expectedSessionGeneration: journal.expectedSessionGeneration, actor: journal.actor,
          authorized: true, directoryValid: true, now: options.now(),
        }, authority, authority.status === 'authorized' ? authority.revalidateUnderLock : undefined);
      } finally {
        await authority.releasePublicationLease?.();
      }
      if (result.outcome === 'authorization_revoked') return { status: 'unauthorized' };
      if (result.outcome === 'committed') return { status: 'committed', resultingRevision: result.receipt.resultingRevision! };
      if (result.outcome === 'conflict') return { status: 'conflict', currentRevision: result.receipt.expectedRevision };
      if (result.outcome === 'unknown') return { status: 'unknown' };
      return { status: 'store_unavailable' };
    },
    convergeSession: options.convergeSession,
    ...(options.afterBoundary ? { afterBoundary: options.afterBoundary } : {}),
  };
  return new GroupWorkspaceOperationCoordinator(dependencies);
}

function sameIntent(journal: RepoGroupOperationJournal, request: GroupWorkspaceOperationRequest): boolean {
  return journal.operationKey === request.operationKey
    && journal.sourceEventId === request.sourceEventId
    && journal.kind === request.kind
    && journal.requestIntentDigest === request.requestIntentDigest
    && journal.chatId === request.chatId
    && journal.actor.tenantKey === request.actor.tenantKey
    && journal.actor.unionId === request.actor.unionId
    && journal.authorityFingerprint === request.authorityFingerprint
    && journal.ownerLarkAppId === request.ownerLarkAppId;
}

function receiptMatchesJournal(receipt: GroupCommitReceipt, journal: RepoGroupOperationJournal): boolean {
  const targetIdentity = journal.target.kind === 'workspace'
    ? journal.target.identity
    : journal.targetWorkspaceIdentity;
  return receipt.operationKey === journal.operationKey
    && receipt.payloadDigest === journal.payloadDigest
    && receipt.chatId === journal.chatId
    && receipt.targetWorkingDir === journal.targetWorkingDir
    && targetIdentity !== undefined
    && receipt.workspaceIdentity !== undefined
    && receipt.workspaceIdentity.path === targetIdentity.path
    && receipt.workspaceIdentity.dev === targetIdentity.dev
    && receipt.workspaceIdentity.ino === targetIdentity.ino;
}

function isQuarantinedSetJournal(journal: RepoGroupOperationJournal): boolean {
  return journal.kind === 'set'
    && (journal.phase === 'migration_blocked_identity_missing'
      || journal.target.kind === 'legacy_identity_missing'
      || journal.targetWorkspaceIdentity === undefined);
}

export type GroupWorkspaceUnbindResult =
  | { status: 'group_committed'; groupRevision: number }
  | { status: 'conflict' | 'invalid_dir' | 'unauthorized' | 'store_unavailable' | 'unknown' | 'protocol_conflict' };

/** Deterministic daemon ownership gate for startup recovery of shared journals. */
export function daemonOwnsGroupWorkspaceRecovery(
  journal: RepoGroupOperationJournal,
  daemonLarkAppId: string,
  durableSession?: { larkAppId: string },
): boolean {
  if (journal.ownerLarkAppId !== undefined) return journal.ownerLarkAppId === daemonLarkAppId;
  if (journal.kind === 'unbind') return false;
  return durableSession?.larkAppId === daemonLarkAppId;
}

export interface GroupWorkspaceUnbindDependencies {
  journalStore: GroupWorkspaceOperationStore;
  revalidateAuthority(journal: RepoGroupOperationJournal): Promise<GroupWorkspaceAuthorityEvidence & {
    revalidateUnderLock?: (context: GroupWorkspaceLockAuthorityContext) => GroupWorkspaceAuthorityEvidence;
    releasePublicationLease?: () => Promise<void>;
  }>;
  readReceipt(operationKey: string): Promise<
    | { status: 'found'; receipt: import('../services/group-workspace-store.js').GroupOperationReceipt }
    | { status: 'missing' | 'store_unavailable' }
  >;
  readCurrentRevision(chatId: string): Promise<{ status: 'available'; revision: number } | { status: 'store_unavailable' }>;
  mutate(
    input: GroupWorkspaceUnbindMutation,
    authorityEvidence: GroupWorkspaceAuthorityEvidence,
    revalidateUnderLock?: (context: GroupWorkspaceLockAuthorityContext) => GroupWorkspaceAuthorityEvidence,
  ): Promise<GroupWorkspaceMutationResult>;
  executorLeaseStore?: OperationExecutorLeaseStore;
  executorOwner?: string;
  executorLeaseTtlMs?: number;
  now(): number;
  afterBoundary?(boundary: 'commit_before_readback' | 'readback_before_convergence' | 'convergence_before_persisted_readback'): Promise<void>;
}

const GROUP_WORKSPACE_UNBIND_NO_SESSION_ID = 'group-workspace-unbind';

export function isPreparedNoSessionUnbindJournal(journal: RepoGroupOperationJournal): boolean {
  return journal.phase === 'prepared'
    && journal.kind === 'unbind'
    && journal.sessionId === GROUP_WORKSPACE_UNBIND_NO_SESSION_ID
    && journal.expectedSessionGeneration === 0
    && journal.target.kind === 'absent';
}

export async function executeGroupWorkspaceUnbind(
  request: { sourceEventId: string; chatId: string; actor: TenantHumanId; authorityFingerprint?: string; originMessageId?: string; ownerLarkAppId?: string },
  dependencies: GroupWorkspaceUnbindDependencies,
): Promise<GroupWorkspaceUnbindResult> {
  const operationKey = groupWorkspaceOperationKey(request.sourceEventId, 'unbind');
  const prior = await dependencies.journalStore.getByIntent(request.sourceEventId, 'unbind');
  if (prior.status === 'store_unavailable') return { status: 'store_unavailable' };
  let journal = prior.status === 'found' ? prior.journal : undefined;
  if (journal && (journal.chatId !== request.chatId || journal.actor.tenantKey !== request.actor.tenantKey
    || journal.actor.unionId !== request.actor.unionId
    || journal.authorityFingerprint !== request.authorityFingerprint
    || journal.originMessageId !== request.originMessageId
    || journal.ownerLarkAppId !== request.ownerLarkAppId)) return { status: 'protocol_conflict' };
  const frozenOriginMessageId = journal?.originMessageId ?? request.originMessageId;
  const intent = { kind: 'unbind' as const, chatId: request.chatId, sourceEventId: request.sourceEventId,
    ...(frozenOriginMessageId !== undefined ? { originMessageId: frozenOriginMessageId } : {}), actor: request.actor };
  if (!journal) {
    const current = await dependencies.readCurrentRevision(request.chatId);
    if (current.status === 'store_unavailable') return { status: 'store_unavailable' };
    const prepared = await dependencies.journalStore.prepare({
      operationKey, sourceEventId: request.sourceEventId, kind: 'unbind',
      requestIntentDigest: canonicalGroupOperationPayloadDigest({
        ...intent, expectedRevision: 0, authorized: true, now: 0,
      }),
      payloadDigest: canonicalGroupOperationPayloadDigest({
        ...intent, expectedRevision: current.revision, authorized: true, now: 0,
      }), chatId: request.chatId, sessionId: GROUP_WORKSPACE_UNBIND_NO_SESSION_ID, expectedSessionGeneration: 0,
      expectedGroupRevision: current.revision, target: { kind: 'absent' }, actor: request.actor,
      ...(request.originMessageId !== undefined ? { originMessageId: request.originMessageId } : {}),
      ...(request.ownerLarkAppId !== undefined ? { ownerLarkAppId: request.ownerLarkAppId } : {}),
      authorityFingerprint: request.authorityFingerprint, phase: 'prepared', updatedAt: dependencies.now(),
    });
    if (prepared.status === 'store_unavailable') return { status: 'store_unavailable' };
    if (prepared.status === 'protocol_conflict') return { status: 'protocol_conflict' };
    journal = prepared.journal;
  }
  let lease: OperationExecutorLease | undefined;
  if (dependencies.executorLeaseStore && dependencies.executorOwner) {
    const acquired = await dependencies.executorLeaseStore.acquire(
      operationKey, dependencies.executorOwner, dependencies.executorLeaseTtlMs ?? 30_000,
    );
    if (acquired.status === 'observer') {
      const observed = await dependencies.readReceipt(operationKey);
      if (observed.status !== 'found') return { status: 'unknown' };
      const mutation = {
        ...intent, expectedRevision: journal.expectedGroupRevision, authorized: true,
        now: observed.receipt.completedAt,
      };
      if (!groupWorkspaceReceiptMatchesMutation(observed.receipt, mutation)) return { status: 'unknown' };
      return observed.receipt.outcome === 'committed'
        ? { status: 'group_committed', groupRevision: observed.receipt.resultingRevision! }
        : { status: observed.receipt.outcome };
    }
    lease = acquired.lease;
  }
  const hasFence = async (): Promise<boolean> => !lease || !dependencies.executorLeaseStore
    || (await dependencies.executorLeaseStore.assertCurrent(operationKey, lease)).status === 'current';
  if (isPreparedNoSessionUnbindJournal(journal)) {
    const advanced = await dependencies.journalStore.transition(operationKey, 'session_committed', {
      sessionGenerationAfter: 0, updatedAt: dependencies.now(),
    }, hasFence);
    if (advanced.status !== 'updated') return { status: 'unknown' };
    journal = advanced.journal;
  }
  const receiptLookup = await dependencies.readReceipt(operationKey);
  if (receiptLookup.status === 'store_unavailable') return { status: 'unknown' };
  let receipt = receiptLookup.status === 'found' ? receiptLookup.receipt : undefined;
  if (!receipt) {
    if (journal.phase !== 'session_committed') return { status: 'unknown' };
    const authority = await dependencies.revalidateAuthority(journal);
    await authority.releasePublicationLease?.();
    if (authority.status === 'unavailable') return { status: 'store_unavailable' };
    if (authority.status === 'denied' || authority.status === 'unauthorized') {
      const denied = await dependencies.journalStore.transition(operationKey, 'unauthorized', {
        updatedAt: dependencies.now(),
      }, hasFence);
      return denied.status === 'updated' ? { status: 'unauthorized' } : { status: 'unknown' };
    }
    const mutation = { ...intent, expectedRevision: journal.expectedGroupRevision, authorized: true, now: dependencies.now() };
    if (lease && dependencies.executorLeaseStore) {
      const renewed = await dependencies.executorLeaseStore.renew(
        operationKey, lease, dependencies.executorLeaseTtlMs ?? 30_000,
      );
      if (renewed.status !== 'renewed') return { status: 'unknown' };
      lease = renewed.lease;
    }
    const fenced = lease && dependencies.executorLeaseStore
      ? await dependencies.executorLeaseStore.runFencedEffect(
        operationKey, lease, async () => {
          const commitAuthority = await dependencies.revalidateAuthority(journal);
          try {
            return await dependencies.mutate(mutation, commitAuthority,
              commitAuthority.status === 'authorized' ? commitAuthority.revalidateUnderLock : undefined);
          } finally {
            await commitAuthority.releasePublicationLease?.();
          }
        },
      )
      : { status: 'applied' as const, value: await (async () => {
        const commitAuthority = await dependencies.revalidateAuthority(journal);
        try {
          return await dependencies.mutate(mutation, commitAuthority,
            commitAuthority.status === 'authorized' ? commitAuthority.revalidateUnderLock : undefined);
        } finally {
          await commitAuthority.releasePublicationLease?.();
        }
      })() };
    if (fenced.status === 'stale_fence') return { status: 'unknown' };
    const result = fenced.value;
    if (result.outcome === 'authorization_revoked') {
      const denied = await dependencies.journalStore.transition(operationKey, 'unauthorized', {
        updatedAt: dependencies.now(),
      }, hasFence);
      return denied.status === 'updated' ? { status: 'unauthorized' } : { status: 'unknown' };
    }
    if (result.outcome === 'protocol_conflict') return { status: 'protocol_conflict' };
    if (result.outcome === 'unknown') {
      await dependencies.journalStore.transition(
        operationKey,
        'unknown',
        { updatedAt: dependencies.now() },
        hasFence,
      );
      return { status: 'unknown' };
    }
    if (result.outcome === 'store_unavailable') return { status: 'store_unavailable' };
    if (!('receipt' in result)) return { status: 'unknown' };
    await dependencies.afterBoundary?.('commit_before_readback');
    const readback = await dependencies.readReceipt(operationKey);
    if (readback.status !== 'found' || !groupWorkspaceReceiptMatchesMutation(readback.receipt, mutation)
      || readback.receipt.outcome !== result.outcome
      || readback.receipt.resultingRevision !== result.receipt.resultingRevision) return { status: 'unknown' };
    receipt = readback.receipt;
  }
  const mutation = { ...intent, expectedRevision: journal.expectedGroupRevision, authorized: true, now: receipt.completedAt };
  if (!groupWorkspaceReceiptMatchesMutation(receipt, mutation)) return { status: 'unknown' };
  await dependencies.afterBoundary?.('readback_before_convergence');
  const phase = receipt.outcome === 'committed' ? 'group_committed' : receipt.outcome;
  const patch = { ...(receipt.outcome === 'committed' ? { groupRevisionAfter: receipt.resultingRevision } : {}),
    updatedAt: dependencies.now() };
  const converged = journal.phase === phase
    ? { status: 'updated' as const, journal }
    : journal.phase === 'unknown'
      ? await dependencies.journalStore.convergeReceipt(operationKey, phase, patch, hasFence)
      : await dependencies.journalStore.transition(operationKey, phase, patch, hasFence);
  if (converged.status !== 'updated') return { status: 'unknown' };
  await dependencies.afterBoundary?.('convergence_before_persisted_readback');
  const persisted = await dependencies.journalStore.get(operationKey);
  if (persisted.status !== 'found' || persisted.journal.phase !== phase
    || (receipt.outcome === 'committed' && persisted.journal.groupRevisionAfter !== receipt.resultingRevision)) return { status: 'unknown' };
  return receipt.outcome === 'committed'
    ? { status: 'group_committed', groupRevision: receipt.resultingRevision! }
    : { status: receipt.outcome };
}

export class GroupWorkspaceOperationCoordinator {
  constructor(private readonly dependencies: GroupWorkspaceOperationDependencies) {}

  async execute(request: GroupWorkspaceOperationRequest): Promise<GroupWorkspaceOperationResult> {
    if (request.kind !== 'set') return { status: 'protocol_conflict' };
    // Canonical source/kind lookup and semantic validation must precede every mutable read.
    // The caller-provided operationKey is never an authority.
    const canonicalOperationKey = groupWorkspaceOperationKey(request.sourceEventId, request.kind);
    const canonicalRequest = { ...request, operationKey: canonicalOperationKey };
    const existing = await this.dependencies.journalStore.getByIntent(request.sourceEventId, request.kind);
    if (existing.status === 'store_unavailable') return { status: 'store_unavailable' };
    if (existing.status === 'found' && existing.journal.phase === 'convergence_quarantined') {
      return { status: 'convergence_quarantined', journal: existing.journal,
        reason: existing.journal.convergenceFailure! };
    }
    if (existing.status === 'found' && isQuarantinedSetJournal(existing.journal)) {
      return { status: 'protocol_conflict', journal: existing.journal };
    }
    const receiptLookup = await this.dependencies.lookupGroupReceipt(canonicalOperationKey);
    if (receiptLookup.status === 'store_unavailable') return { status: 'unknown' };
    if (receiptLookup.status === 'found') {
      if (existing.status !== 'found' || !sameIntent(existing.journal, canonicalRequest)
        || receiptLookup.receipt.payloadDigest !== existing.journal.payloadDigest
        || receiptLookup.receipt.chatId !== existing.journal.chatId
        || receiptLookup.receipt.targetWorkingDir !== existing.journal.targetWorkingDir) {
        return { status: 'protocol_conflict', journal: existing.status === 'found' ? existing.journal : undefined };
      }
      const executor = await this.dependencies.acquireExecutor?.(existing.journal.operationKey);
      if (executor?.status === 'observer') {
        return { status: 'observing', journal: existing.journal, receipt: receiptLookup.receipt };
      }
      return this.convergeReceipt(existing.journal, receiptLookup.receipt, executor?.lease);
    }
    if (existing.status === 'found' && !sameIntent(existing.journal, canonicalRequest)) {
      return { status: 'protocol_conflict', journal: existing.journal };
    }
    if (existing.status === 'found' && existing.journal.sessionId !== request.sessionId) {
      return { status: 'unknown', journal: existing.journal };
    }

    let journal: RepoGroupOperationJournal;
    if (existing.status === 'found') journal = existing.journal;
    else {
      const revision = await this.dependencies.readCurrentGroupRevision(request.chatId);
      if (revision.status === 'store_unavailable') return { status: 'store_unavailable' };
      const target = await this.dependencies.resolveCanonicalTarget(canonicalRequest);
      if (target.status === 'store_unavailable') return { status: 'store_unavailable' };
      const session = await this.dependencies.readSession(request.sessionId);
      if (session.status === 'store_unavailable') return { status: 'store_unavailable' };
      const payloadDigest = canonicalGroupOperationPayloadDigest({
        kind: 'set', chatId: canonicalRequest.chatId, sourceEventId: canonicalRequest.sourceEventId,
        requestedWorkingDir: target.workingDir, expectedRevision: revision.revision,
        actor: canonicalRequest.actor, authorized: true, directoryValid: true, now: 0,
      });
      journal = {
        ...canonicalRequest, payloadDigest,
        expectedSessionGeneration: session.generation,
        expectedGroupRevision: revision.revision,
        target: { kind: 'workspace', identity: target.workspaceIdentity },
        targetWorkingDir: target.workingDir, targetWorkspaceIdentity: target.workspaceIdentity,
        phase: 'prepared',
        updatedAt: this.dependencies.now(),
      };
      const prepared = await this.dependencies.journalStore.prepareOrAdopt(journal);
      if (prepared.status === 'store_unavailable') return { status: 'store_unavailable' };
      if (prepared.status === 'protocol_conflict') return { status: 'protocol_conflict', journal: prepared.journal };
      journal = prepared.journal;
    }

    const executor = await this.dependencies.acquireExecutor?.(journal.operationKey);
    if (executor?.status === 'observer') {
      const observed = await this.dependencies.lookupGroupReceipt(journal.operationKey);
      return observed.status === 'found'
        ? { status: 'observing', journal, receipt: observed.receipt }
        : { status: 'observing', journal };
    }
    return this.advance(journal, executor?.lease);
  }

  async recover(journal: RepoGroupOperationJournal): Promise<GroupWorkspaceOperationResult> {
    if (isQuarantinedSetJournal(journal)) return { status: 'protocol_conflict', journal };
    const executor = await this.dependencies.acquireExecutor?.(journal.operationKey);
    if (executor?.status === 'observer') {
      const observed = await this.dependencies.lookupGroupReceipt(journal.operationKey);
      return observed.status === 'found'
        ? { status: 'observing', journal, receipt: observed.receipt }
        : { status: 'observing', journal };
    }
    return this.advance(journal, executor?.lease);
  }

  private async advance(
    journal: RepoGroupOperationJournal,
    lease?: OperationExecutorLease,
  ): Promise<GroupWorkspaceOperationResult> {
    if (isQuarantinedSetJournal(journal)) return { status: 'protocol_conflict', journal };
    const receiptLookup = await this.dependencies.lookupGroupReceipt(journal.operationKey);
    if (receiptLookup.status === 'store_unavailable') return { status: 'unknown', journal };
    if (receiptLookup.status === 'found') return this.convergeReceipt(journal, receiptLookup.receipt, lease);
    if (journal.phase === 'unknown') {
      const readback = await this.dependencies.reconcileUnknownGroupReceipt(journal);
      if (readback.status === 'missing') return { status: 'unknown', journal };
      if (readback.status === 'store_unavailable') return { status: 'store_unavailable', journal };
      return this.convergeReceipt(journal, readback.receipt, lease);
    }
    if (journal.phase === 'group_committed') {
      const readback = await this.dependencies.reconcileUnknownGroupReceipt(journal);
      if (readback.status === 'found') return this.convergeReceipt(journal, readback.receipt, lease);
      return { status: readback.status === 'store_unavailable' ? 'store_unavailable' : 'unknown', journal };
    }
    if (journal.phase === 'conflict') return { status: 'conflict', journal };
    if (journal.phase === 'store_unavailable') return { status: 'store_unavailable', journal };
    if (journal.phase === 'convergence_quarantined') {
      return { status: 'convergence_quarantined', journal, reason: journal.convergenceFailure! };
    }

    if (journal.phase === 'prepared') {
      const initialAuthority = await this.authority(journal);
      if (initialAuthority === 'unavailable') return { status: 'store_unavailable', journal };
      if (initialAuthority === 'denied') return this.markUnauthorized(journal, lease);
      if (lease && this.dependencies.renewExecutor) {
        lease = await this.dependencies.renewExecutor(journal.operationKey, lease);
        if (!lease) return { status: 'unknown', journal };
      }
      if (!(await this.hasFence(journal.operationKey, lease))) return { status: 'unknown', journal };
      await this.dependencies.afterBoundary?.('prepared_before_switch');
      // The boundary hook models time spent between prepare and the externally
      // visible replacement effect. Authority may be revoked while that work is
      // pending, so the proof used above cannot authorize the switch itself.
      const session = await this.dependencies.readSession(journal.sessionId);
      if (session.status === 'store_unavailable') return this.markUnknown(journal, lease);
      const expectedAfter = journal.expectedSessionGeneration + 1;
      if (session.generation === journal.expectedSessionGeneration) {
        if (session.workingDir === journal.targetWorkingDir) return this.markUnknown(journal, lease);
        const switchAuthority = await this.authority(journal);
        if (switchAuthority === 'unavailable') return { status: 'store_unavailable', journal };
        if (switchAuthority === 'denied') return this.markUnauthorized(journal, lease);
        const switchInput = {
          sessionId: journal.sessionId,
          expectedGeneration: journal.expectedSessionGeneration,
          targetWorkingDir: journal.targetWorkingDir!,
          workspaceIdentity: journal.targetWorkspaceIdentity!,
          ...(lease ? { fencingToken: lease.fencingToken } : {}),
        };
        const fencedSwitch = lease && this.dependencies.runFencedEffect
          ? await this.dependencies.runFencedEffect(journal.operationKey, lease, () => this.dependencies.switchSession(switchInput))
          : { status: 'applied' as const, value: await this.dependencies.switchSession(switchInput) };
        if (fencedSwitch.status === 'stale_fence') return { status: 'unknown', journal };
        const switched = fencedSwitch.value;
        if (switched.status === 'unknown') return this.markUnknown(journal, lease);
        if (switched.status === 'store_unavailable') return { status: 'store_unavailable', journal };
        journal = { ...journal, sessionGenerationAfter: switched.generation };
        await this.dependencies.afterBoundary?.('session_persisted_before_advance');
      } else if (session.generation === expectedAfter && session.workingDir === journal.targetWorkingDir) {
        journal = { ...journal, sessionGenerationAfter: session.generation };
      } else {
        return this.markUnknown(journal, lease);
      }
      const advanced = await this.dependencies.journalStore.transition(journal.operationKey, 'session_committed', {
        sessionGenerationAfter: journal.sessionGenerationAfter,
        updatedAt: this.dependencies.now(),
      }, lease ? () => this.hasFence(journal.operationKey, lease) : undefined);
      if (advanced.status !== 'updated') return { status: 'unknown', journal };
      journal = advanced.journal;
    }

    const commitAuthority = await this.authority(journal);
    if (commitAuthority === 'unavailable') return { status: 'store_unavailable', journal };
    if (commitAuthority === 'denied') return this.markUnauthorized(journal, lease);
    if (lease && this.dependencies.renewExecutor) {
      lease = await this.dependencies.renewExecutor(journal.operationKey, lease);
      if (!lease) return { status: 'unknown', journal };
    }
    if (!(await this.hasFence(journal.operationKey, lease))) return { status: 'unknown', journal };
    const fencedCommit = lease && this.dependencies.runFencedEffect
      ? await this.dependencies.runFencedEffect(
        journal.operationKey, lease, () => this.dependencies.commitGroup(
          journal,
          lease?.fencingToken,
        ),
      )
      : { status: 'applied' as const, value: await this.dependencies.commitGroup(
        journal,
        lease?.fencingToken,
      ) };
    if (fencedCommit.status === 'stale_fence') return { status: 'unknown', journal };
    const groupResult = fencedCommit.value;
    if (groupResult.status === 'unauthorized') return this.markUnauthorized(journal, lease);
    if (groupResult.status === 'unknown') return this.markUnknown(journal, lease);
    await this.dependencies.afterBoundary?.('group_committed_before_convergence');
    if (groupResult.status === 'committed') {
      const receiptReadback = await this.dependencies.lookupGroupReceipt(journal.operationKey);
      if (receiptReadback.status !== 'found'
        || !receiptMatchesJournal(receiptReadback.receipt, journal)
        || receiptReadback.receipt.status !== 'committed'
        || receiptReadback.receipt.resultingRevision !== groupResult.resultingRevision) {
        return this.markUnknown(journal, lease);
      }
      const advanced = await this.dependencies.journalStore.transition(journal.operationKey, 'group_committed', {
        groupRevisionAfter: groupResult.resultingRevision,
        updatedAt: this.dependencies.now(),
      }, lease ? () => this.hasFence(journal.operationKey, lease) : undefined);
      if (advanced.status !== 'updated') return this.markUnknown(journal, lease);
      const completed = advanced.journal;
      const convergenceInput = {
        sessionId: completed.sessionId,
        expectedGeneration: completed.sessionGenerationAfter!,
        source: 'group' as const,
        groupRevision: groupResult.resultingRevision,
        workspaceIdentity: completed.targetWorkspaceIdentity,
      };
      const sessionConvergence = lease && this.dependencies.runFencedEffect
        ? await this.dependencies.runFencedEffect(journal.operationKey, lease,
          () => this.dependencies.convergeSession(convergenceInput))
        : { status: 'applied' as const, value: await this.dependencies.convergeSession(convergenceInput) };
      if (sessionConvergence.status === 'stale_fence') return { status: 'observing', journal: completed, receipt: receiptReadback.receipt };
      if (sessionConvergence.value !== undefined && sessionConvergence.value !== 'converged') {
        return this.quarantineConvergence(completed, sessionConvergence.value, lease);
      }
      await this.dependencies.afterBoundary?.('receipt_before_response');
      return { status: 'group_committed', journal: completed, groupRevision: groupResult.resultingRevision };
    }

    const explicitConvergence = lease && this.dependencies.runFencedEffect
      ? await this.dependencies.runFencedEffect(journal.operationKey, lease, () => this.dependencies.convergeSession({
        sessionId: journal.sessionId,
        expectedGeneration: journal.sessionGenerationAfter!,
        source: 'explicit',
      }))
      : { status: 'applied' as const, value: await this.dependencies.convergeSession({
        sessionId: journal.sessionId,
        expectedGeneration: journal.sessionGenerationAfter!,
        source: 'explicit',
      }) };
    if (explicitConvergence.status === 'stale_fence') return { status: 'observing', journal };
    const phase = groupResult.status;
    const advanced = await this.dependencies.journalStore.transition(journal.operationKey, phase, {
      updatedAt: this.dependencies.now(),
    }, lease ? () => this.hasFence(journal.operationKey, lease) : undefined);
    const terminal = advanced.status === 'updated' ? advanced.journal : journal;
    return phase === 'conflict'
      ? { status: phase, journal: terminal, currentRevision: groupResult.currentRevision }
      : { status: phase, journal: terminal };
  }

  private async convergeReceipt(
    journal: RepoGroupOperationJournal | undefined,
    receipt: GroupCommitReceipt,
    lease?: OperationExecutorLease,
  ): Promise<GroupWorkspaceOperationResult> {
    if (!journal) return { status: 'store_unavailable' };
    if (this.dependencies.acquireExecutor && !lease) return { status: 'observing', journal, receipt };
    if (lease && !(await this.hasFence(journal.operationKey, lease))) return { status: 'observing', journal, receipt };
    if (!receiptMatchesJournal(receipt, journal)) {
      return { status: 'unknown', journal };
    }
    if (journal.phase === 'group_committed' && (receipt.status !== 'committed'
      || receipt.resultingRevision !== journal.groupRevisionAfter)) {
      return { status: 'unknown', journal };
    }
    if (receipt.status === 'committed') {
      let completed = journal;
      if (journal.phase === 'session_committed' || journal.phase === 'unknown') {
        const patch = { groupRevisionAfter: receipt.resultingRevision, updatedAt: this.dependencies.now() };
        const advanced = journal.phase === 'unknown'
          ? await this.dependencies.journalStore.convergeReceipt(journal.operationKey, 'group_committed', patch,
            lease ? () => this.hasFence(journal.operationKey, lease) : undefined)
          : await this.dependencies.journalStore.transition(journal.operationKey, 'group_committed', patch,
            lease ? () => this.hasFence(journal.operationKey, lease) : undefined);
        if (advanced.status !== 'updated') return { status: 'unknown', journal };
        completed = advanced.journal;
      }
      const convergenceInput = {
        sessionId: completed.sessionId,
        expectedGeneration: completed.sessionGenerationAfter ?? completed.expectedSessionGeneration + 1,
        source: 'group' as const,
        groupRevision: receipt.resultingRevision,
        workspaceIdentity: completed.targetWorkspaceIdentity,
      };
      const fencedConvergence = lease && this.dependencies.runFencedEffect
        ? await this.dependencies.runFencedEffect(journal.operationKey, lease,
          () => this.dependencies.convergeSession(convergenceInput))
        : { status: 'applied' as const, value: await this.dependencies.convergeSession(convergenceInput) };
      if (fencedConvergence.status === 'stale_fence') return { status: 'observing', journal, receipt };
      const convergence = fencedConvergence.value;
      if (convergence === 'session_missing' && completed.phase === 'group_committed') {
        const terminal = await this.dependencies.journalStore.transition(completed.operationKey, 'no_session_complete', {
          updatedAt: this.dependencies.now(),
        }, lease ? () => this.hasFence(journal.operationKey, lease) : undefined);
        if (terminal.status !== 'updated') return { status: 'unknown', journal: completed };
        completed = terminal.journal;
      } else if (convergence !== undefined && convergence !== 'converged') {
        return this.quarantineConvergence(completed, convergence, lease);
      }
      return { status: 'group_committed', journal: completed, groupRevision: receipt.resultingRevision };
    }
    const explicitInput = {
      sessionId: journal.sessionId,
      expectedGeneration: journal.sessionGenerationAfter ?? journal.expectedSessionGeneration + 1,
      source: 'explicit' as const,
    };
    const explicitConvergence = lease && this.dependencies.runFencedEffect
      ? await this.dependencies.runFencedEffect(journal.operationKey, lease,
        () => this.dependencies.convergeSession(explicitInput))
      : { status: 'applied' as const, value: await this.dependencies.convergeSession(explicitInput) };
    if (explicitConvergence.status === 'stale_fence') return { status: 'observing', journal, receipt };
    const phase = receipt.status;
    let terminal = journal;
    if (journal.phase === 'session_committed' || journal.phase === 'unknown') {
      const advanced = journal.phase === 'unknown'
        ? await this.dependencies.journalStore.convergeReceipt(journal.operationKey, phase, { updatedAt: this.dependencies.now() },
          lease ? () => this.hasFence(journal.operationKey, lease) : undefined)
        : await this.dependencies.journalStore.transition(journal.operationKey, phase, { updatedAt: this.dependencies.now() },
          lease ? () => this.hasFence(journal.operationKey, lease) : undefined);
      if (advanced.status !== 'updated') return { status: 'unknown', journal };
      terminal = advanced.journal;
    }
    return phase === 'conflict'
      ? { status: phase, journal: terminal, currentRevision: receipt.currentRevision }
      : { status: phase, journal: terminal };
  }

  private async authority(journal: RepoGroupOperationJournal): Promise<'authorized' | 'denied' | 'unavailable'> {
    if (!this.dependencies.revalidateAuthority) return 'authorized';
    const authority = await this.dependencies.revalidateAuthority(journal);
    await authority.releasePublicationLease?.();
    return authority.status === 'unauthorized' ? 'denied' : authority.status;
  }

  private async quarantineConvergence(
    journal: RepoGroupOperationJournal,
    reason: 'session_missing' | 'generation_conflict',
    lease?: OperationExecutorLease,
  ): Promise<GroupWorkspaceOperationResult> {
    if (journal.phase === 'convergence_quarantined') {
      return { status: 'convergence_quarantined', journal, reason: journal.convergenceFailure! };
    }
    const advanced = await this.dependencies.journalStore.transition(journal.operationKey, 'convergence_quarantined', {
      convergenceFailure: reason,
      updatedAt: this.dependencies.now(),
    }, lease ? () => this.hasFence(journal.operationKey, lease) : undefined);
    if (advanced.status !== 'updated') return { status: 'unknown', journal };
    return { status: 'convergence_quarantined', journal: advanced.journal, reason };
  }

  private async hasFence(operationKey: string, lease?: OperationExecutorLease): Promise<boolean> {
    return !lease || !this.dependencies.assertFence
      || this.dependencies.assertFence(operationKey, lease);
  }

  private async markUnauthorized(
    journal: RepoGroupOperationJournal,
    lease?: OperationExecutorLease,
  ): Promise<GroupWorkspaceOperationResult> {
    if (journal.phase === 'session_committed') {
      const input = {
        sessionId: journal.sessionId,
        expectedGeneration: journal.sessionGenerationAfter!,
        source: 'explicit' as const,
      };
      const convergence = lease && this.dependencies.runFencedEffect
        ? await this.dependencies.runFencedEffect(journal.operationKey, lease,
          () => this.dependencies.convergeSession(input))
        : { status: 'applied' as const, value: await this.dependencies.convergeSession(input) };
      if (convergence.status === 'stale_fence') return { status: 'observing', journal };
    }
    const advanced = await this.dependencies.journalStore.transition(
      journal.operationKey,
      'unauthorized',
      { updatedAt: this.dependencies.now() },
      lease ? () => this.hasFence(journal.operationKey, lease) : undefined,
    );
    return advanced.status === 'updated'
      ? { status: 'unauthorized', journal: advanced.journal }
      : lease ? { status: 'observing', journal } : { status: 'unauthorized', journal };
  }

  private async markUnknown(
    journal: RepoGroupOperationJournal,
    lease?: OperationExecutorLease,
  ): Promise<GroupWorkspaceOperationResult> {
    if (journal.phase !== 'unknown') {
      const advanced = await this.dependencies.journalStore.transition(journal.operationKey, 'unknown', {
        sessionGenerationAfter: journal.sessionGenerationAfter,
        updatedAt: this.dependencies.now(),
      }, lease ? () => this.hasFence(journal.operationKey, lease) : undefined);
      if (advanced.status === 'updated') journal = advanced.journal;
      else if (lease) return { status: 'observing', journal };
    }
    return { status: 'unknown', journal };
  }
}
