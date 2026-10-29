import type { TenantHumanId } from '../services/bot-admin-unions-store.js';
import { groupWorkspaceOperationKey, type GroupOperationKind } from '../services/group-workspace-store.js';
import type {
  GroupWorkspaceOperationStore,
  RepoGroupOperationJournal,
} from '../services/group-workspace-operation-store.js';

export type GroupCommitResult =
  | { status: 'committed'; resultingRevision: number }
  | { status: 'conflict'; currentRevision: number }
  | { status: 'store_unavailable' }
  | { status: 'unknown' };

export type GroupCommitReceipt = Exclude<GroupCommitResult, { status: 'unknown' }> & {
  operationKey: string;
  payloadDigest: string;
  chatId: string;
  targetWorkingDir: string;
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
  payloadDigest: string;
  chatId: string;
  sessionId: string;
  actor: TenantHumanId;
}

export type GroupWorkspaceOperationResult =
  | { status: 'group_committed'; journal?: RepoGroupOperationJournal; groupRevision: number }
  | { status: 'conflict'; journal?: RepoGroupOperationJournal; currentRevision?: number }
  | { status: 'store_unavailable'; journal?: RepoGroupOperationJournal }
  | { status: 'unknown'; journal?: RepoGroupOperationJournal }
  | { status: 'protocol_conflict'; journal?: RepoGroupOperationJournal };

export interface GroupWorkspaceOperationDependencies {
  journalStore: GroupWorkspaceOperationStore;
  now(): number;
  lookupGroupReceipt(operationKey: string): Promise<GroupReceiptLookupResult>;
  /** Under the group-store lock, establish-or-read and return the authoritative exact-operation receipt. */
  reconcileUnknownGroupReceipt(journal: RepoGroupOperationJournal): Promise<GroupReceiptLookupResult>;
  readCurrentGroupRevision(chatId: string): Promise<
    | { status: 'available'; revision: number }
    | { status: 'store_unavailable' }
  >;
  resolveCanonicalTarget(request: GroupWorkspaceOperationRequest): Promise<
    | { status: 'resolved'; workingDir: string }
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
  }): Promise<
    | { status: 'committed'; generation: number }
    | { status: 'store_unavailable' }
    | { status: 'unknown' }
  >;
  commitGroup(input: RepoGroupOperationJournal): Promise<GroupCommitResult>;
  convergeSession(input: {
    sessionId: string;
    expectedGeneration: number;
    source: 'explicit' | 'group';
    groupRevision?: number;
  }): Promise<void>;
  afterBoundary?(boundary:
    | 'prepared_before_switch'
    | 'session_persisted_before_advance'
    | 'group_committed_before_convergence'
    | 'receipt_before_response'
  ): Promise<void>;
}

function sameIntent(journal: RepoGroupOperationJournal, request: GroupWorkspaceOperationRequest): boolean {
  return journal.operationKey === request.operationKey
    && journal.sourceEventId === request.sourceEventId
    && journal.kind === request.kind
    && journal.payloadDigest === request.payloadDigest
    && journal.chatId === request.chatId
    && journal.sessionId === request.sessionId
    && journal.actor.tenantKey === request.actor.tenantKey
    && journal.actor.unionId === request.actor.unionId;
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
    const receiptLookup = await this.dependencies.lookupGroupReceipt(canonicalOperationKey);
    if (receiptLookup.status === 'store_unavailable') return { status: 'unknown' };
    if (receiptLookup.status === 'found') {
      if (receiptLookup.receipt.payloadDigest !== canonicalRequest.payloadDigest
        || receiptLookup.receipt.chatId !== canonicalRequest.chatId) {
        return { status: 'protocol_conflict', journal: existing.status === 'found' ? existing.journal : undefined };
      }
      // A canonical receipt is host-wide authority. Historical recovery may arrive
      // through another Bot and therefore have a different receiver-local session.
      if (existing.status !== 'found' || !sameIntent(existing.journal, canonicalRequest)) {
        return receiptLookup.receipt.status === 'committed'
          ? { status: 'group_committed', journal: existing.status === 'found' ? existing.journal : undefined,
            groupRevision: receiptLookup.receipt.resultingRevision }
          : receiptLookup.receipt.status === 'conflict'
            ? { status: 'conflict', journal: existing.status === 'found' ? existing.journal : undefined,
              currentRevision: receiptLookup.receipt.currentRevision }
            : { status: 'store_unavailable', journal: existing.status === 'found' ? existing.journal : undefined };
      }
      return this.convergeReceipt(existing.journal, receiptLookup.receipt);
    }
    if (existing.status === 'found' && !sameIntent(existing.journal, canonicalRequest)) {
      return { status: 'protocol_conflict', journal: existing.journal };
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
      journal = {
        ...canonicalRequest,
        expectedSessionGeneration: session.generation,
        expectedGroupRevision: revision.revision,
        targetWorkingDir: target.workingDir,
        phase: 'prepared',
        updatedAt: this.dependencies.now(),
      };
      const prepared = await this.dependencies.journalStore.prepare(journal);
      if (prepared.status === 'store_unavailable') return { status: 'store_unavailable' };
      if (prepared.status === 'protocol_conflict') return { status: 'protocol_conflict', journal: prepared.journal };
      journal = prepared.journal;
    }

    return this.advance(journal);
  }

  async recover(journal: RepoGroupOperationJournal): Promise<GroupWorkspaceOperationResult> {
    return this.advance(journal);
  }

  private async advance(journal: RepoGroupOperationJournal): Promise<GroupWorkspaceOperationResult> {
    const receiptLookup = await this.dependencies.lookupGroupReceipt(journal.operationKey);
    if (receiptLookup.status === 'store_unavailable') return { status: 'unknown', journal };
    if (receiptLookup.status === 'found') return this.convergeReceipt(journal, receiptLookup.receipt);
    if (journal.phase === 'unknown') {
      const readback = await this.dependencies.reconcileUnknownGroupReceipt(journal);
      if (readback.status === 'missing') return { status: 'unknown', journal };
      if (readback.status === 'store_unavailable') return { status: 'store_unavailable', journal };
      return this.convergeReceipt(journal, readback.receipt);
    }
    if (journal.phase === 'group_committed') return { status: 'unknown', journal };
    if (journal.phase === 'conflict') return { status: 'conflict', journal };
    if (journal.phase === 'store_unavailable') return { status: 'store_unavailable', journal };

    if (journal.phase === 'prepared') {
      await this.dependencies.afterBoundary?.('prepared_before_switch');
      const session = await this.dependencies.readSession(journal.sessionId);
      if (session.status === 'store_unavailable') return this.markUnknown(journal);
      const expectedAfter = journal.expectedSessionGeneration + 1;
      if (session.generation === journal.expectedSessionGeneration) {
        if (session.workingDir === journal.targetWorkingDir) return this.markUnknown(journal);
        const switched = await this.dependencies.switchSession({
          sessionId: journal.sessionId,
          expectedGeneration: journal.expectedSessionGeneration,
          targetWorkingDir: journal.targetWorkingDir,
        });
        if (switched.status === 'unknown') return this.markUnknown(journal);
        if (switched.status === 'store_unavailable') return { status: 'store_unavailable', journal };
        journal = { ...journal, sessionGenerationAfter: switched.generation };
        await this.dependencies.afterBoundary?.('session_persisted_before_advance');
      } else if (session.generation === expectedAfter && session.workingDir === journal.targetWorkingDir) {
        journal = { ...journal, sessionGenerationAfter: session.generation };
      } else {
        return this.markUnknown(journal);
      }
      const advanced = await this.dependencies.journalStore.transition(journal.operationKey, 'session_committed', {
        sessionGenerationAfter: journal.sessionGenerationAfter,
        updatedAt: this.dependencies.now(),
      });
      if (advanced.status !== 'updated') return { status: 'unknown', journal };
      journal = advanced.journal;
    }

    const groupResult = await this.dependencies.commitGroup(journal);
    if (groupResult.status === 'unknown') return this.markUnknown(journal);
    await this.dependencies.afterBoundary?.('group_committed_before_convergence');
    if (groupResult.status === 'committed') {
      const receiptReadback = await this.dependencies.lookupGroupReceipt(journal.operationKey);
      if (receiptReadback.status !== 'found'
        || receiptReadback.receipt.status !== 'committed'
        || receiptReadback.receipt.resultingRevision !== groupResult.resultingRevision) {
        return this.markUnknown(journal);
      }
      const advanced = await this.dependencies.journalStore.transition(journal.operationKey, 'group_committed', {
        groupRevisionAfter: groupResult.resultingRevision,
        updatedAt: this.dependencies.now(),
      });
      if (advanced.status !== 'updated') return this.markUnknown(journal);
      const completed = advanced.journal;
      await this.dependencies.convergeSession({
        sessionId: completed.sessionId,
        expectedGeneration: completed.sessionGenerationAfter!,
        source: 'group',
        groupRevision: groupResult.resultingRevision,
      });
      await this.dependencies.afterBoundary?.('receipt_before_response');
      return { status: 'group_committed', journal: completed, groupRevision: groupResult.resultingRevision };
    }

    await this.dependencies.convergeSession({
      sessionId: journal.sessionId,
      expectedGeneration: journal.sessionGenerationAfter!,
      source: 'explicit',
    });
    const phase = groupResult.status;
    const advanced = await this.dependencies.journalStore.transition(journal.operationKey, phase, {
      updatedAt: this.dependencies.now(),
    });
    const terminal = advanced.status === 'updated' ? advanced.journal : journal;
    return phase === 'conflict'
      ? { status: phase, journal: terminal, currentRevision: groupResult.currentRevision }
      : { status: phase, journal: terminal };
  }

  private async convergeReceipt(
    journal: RepoGroupOperationJournal | undefined,
    receipt: GroupCommitReceipt,
  ): Promise<GroupWorkspaceOperationResult> {
    if (!journal) return { status: 'store_unavailable' };
    if (receipt.operationKey !== journal.operationKey
      || receipt.payloadDigest !== journal.payloadDigest
      || receipt.chatId !== journal.chatId
      || receipt.targetWorkingDir !== journal.targetWorkingDir) {
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
          ? await this.dependencies.journalStore.convergeReceipt(journal.operationKey, 'group_committed', patch)
          : await this.dependencies.journalStore.transition(journal.operationKey, 'group_committed', patch);
        if (advanced.status !== 'updated') return { status: 'unknown', journal };
        completed = advanced.journal;
      }
      await this.dependencies.convergeSession({
        sessionId: completed.sessionId,
        expectedGeneration: completed.sessionGenerationAfter ?? completed.expectedSessionGeneration + 1,
        source: 'group',
        groupRevision: receipt.resultingRevision,
      });
      return { status: 'group_committed', journal: completed, groupRevision: receipt.resultingRevision };
    }
    await this.dependencies.convergeSession({
      sessionId: journal.sessionId,
      expectedGeneration: journal.sessionGenerationAfter ?? journal.expectedSessionGeneration + 1,
      source: 'explicit',
    });
    const phase = receipt.status;
    let terminal = journal;
    if (journal.phase === 'session_committed' || journal.phase === 'unknown') {
      const advanced = journal.phase === 'unknown'
        ? await this.dependencies.journalStore.convergeReceipt(journal.operationKey, phase, { updatedAt: this.dependencies.now() })
        : await this.dependencies.journalStore.transition(journal.operationKey, phase, { updatedAt: this.dependencies.now() });
      if (advanced.status !== 'updated') return { status: 'unknown', journal };
      terminal = advanced.journal;
    }
    return phase === 'conflict'
      ? { status: phase, journal: terminal, currentRevision: receipt.currentRevision }
      : { status: phase, journal: terminal };
  }

  private async markUnknown(journal: RepoGroupOperationJournal): Promise<GroupWorkspaceOperationResult> {
    if (journal.phase !== 'unknown') {
      const advanced = await this.dependencies.journalStore.transition(journal.operationKey, 'unknown', {
        sessionGenerationAfter: journal.sessionGenerationAfter,
        updatedAt: this.dependencies.now(),
      });
      if (advanced.status === 'updated') journal = advanced.journal;
    }
    return { status: 'unknown', journal };
  }
}
