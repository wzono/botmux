import { randomUUID } from 'node:crypto';
import type { FrozenSessionReplyContext, PersistedTurnFeedback, ReplyTargetEntry, Session } from '../types.js';
import { cronPinnedTurnIds, pruneReplyTargets } from '../core/reply-target.js';
import { isDeepStrictEqual } from 'node:util';
import { reactionForPhase, type TurnFeedbackPhase } from './turn-feedback-state.js';
import type {
  OwnReactionListResult,
  ReactionCreationResult,
  ReactionRemovalResult,
} from '../im/lark/client.js';
import type { TurnFeedbackTerminalRecord } from './turn-feedback-terminal-outbox.js';
import {
  addReactionOnce,
  listOwnReactionsDetailed,
  removeReactionDetailed,
} from '../im/lark/client.js';
import { getBot } from '../bot-registry.js';
import * as sessionStore from './session-store.js';

export interface TurnFeedbackTarget {
  session: Session;
  larkAppId: string;
}

export interface TurnFeedbackDeps {
  /** Mutate and commit the fresh owned Session row before publishing it in memory. */
  commit(target: TurnFeedbackTarget, mutate: (fresh: Session) => void): Session;
  read?(target: TurnFeedbackTarget): Session;
  now(): number;
  addReactionOnce?(appId: string, messageId: string, emojiType: string): Promise<ReactionCreationResult>;
  removeReactionDetailed?(appId: string, messageId: string, reactionId: string): Promise<ReactionRemovalResult>;
  listOwnReactionsDetailed?(appId: string, messageId: string, emojiType?: string): Promise<OwnReactionListResult>;
  policy?(target: TurnFeedbackTarget): TurnReactionPolicy;
}

export interface TurnReactionPolicy {
  silent?: boolean;
  processing?: string;
  capacityWaiting?: string;
  capacityStale?: string;
  needsUser?: string;
  completed?: string;
  failed?: string;
}

export interface TurnFeedbackPruneOptions {
  desiredReaction(record: PersistedTurnFeedback): string | undefined;
}

const TERMINAL_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
const TERMINAL_RETENTION_MAX = 512;
const DIAGNOSTIC_RETENTION_MAX = 128;

function terminalPhase(phase: TurnFeedbackPhase): boolean {
  return phase === 'completed' || phase === 'failed';
}

function durableDiagnostic(record: PersistedTurnFeedback): boolean {
  const operation = record.reactionOperation;
  return operation?.phase === 'failed' && operation.failureReason !== undefined
    || operation?.phase === 'blocked' && operation.retryExhausted === true;
}

/** Pure bounded retention. Invalid timestamps and unresolved obligations fail closed. */
export function pruneTurnFeedback(
  records: Record<string, PersistedTurnFeedback>,
  nowMs: number,
  options: TurnFeedbackPruneOptions = { desiredReaction: () => undefined },
): Record<string, PersistedTurnFeedback> {
  const retained = new Map<string, PersistedTurnFeedback>();
  const settled: Array<[string, PersistedTurnFeedback, number]> = [];
  const diagnostics: Array<[string, PersistedTurnFeedback, number]> = [];

  for (const [key, record] of Object.entries(records)) {
    const updatedAtMs = Date.parse(record.updatedAt);
    if (!terminalPhase(record.phase) || !Number.isFinite(updatedAtMs) || updatedAtMs > nowMs) {
      retained.set(key, record);
      continue;
    }
    if (durableDiagnostic(record)) {
      diagnostics.push([key, record, updatedAtMs]);
      continue;
    }
    const desired = options.desiredReaction(record);
    const unresolved = record.reactionReconcilePending === true
      || record.reactionOperation !== undefined
      || record.attention !== undefined
      || record.capacity !== undefined
      || record.capacityClearedAt !== undefined
      || record.capacitySidebandCursor !== undefined
      || record.capacityBinding !== undefined
      || (record.reminder !== undefined && record.reminder.closed !== true)
      || (record.reaction !== undefined && record.reaction.type !== desired);
    if (unresolved) {
      retained.set(key, record);
      continue;
    }
    settled.push([key, record, updatedAtMs]);
  }

  const newest = (left: typeof settled[number], right: typeof settled[number]) =>
    right[2] - left[2] || left[0].localeCompare(right[0]);
  for (const [key, record] of settled
    .filter(entry => entry[2] >= nowMs - TERMINAL_RETENTION_MS)
    .sort(newest)
    .slice(0, TERMINAL_RETENTION_MAX)) {
    retained.set(key, record);
  }
  for (const [key, record] of diagnostics
    .filter(entry => entry[2] >= nowMs - TERMINAL_RETENTION_MS)
    .sort(newest)
    .slice(0, DIAGNOSTIC_RETENTION_MAX)) {
    retained.set(key, record);
  }
  return Object.fromEntries(retained);
}

export interface TurnFeedbackAdmission {
  turnId: string;
  messageId?: string;
  receivedReactionEmoji?: string;
  silent?: boolean;
  background?: boolean;
  /** Daemon-derived folded roots created for this exact turn immediately before admission. */
  ownedReplyAliasRoots?: readonly string[];
}

type CurrentReplyTarget = NonNullable<Session['currentReplyTarget']>;
type DocCommentTarget = NonNullable<Session['docCommentTargets']>[string];
type ReplyThreadAlias = NonNullable<Session['replyThreadAliases']>[string];

interface ExactTurnRoutingSnapshot {
  replyTarget?: ReplyTargetEntry;
  replyContext?: FrozenSessionReplyContext;
  docCommentTarget?: DocCommentTarget;
  currentReplyTarget?: CurrentReplyTarget;
  replyThreadAliases: Array<{ rootMessageId: string; value: ReplyThreadAlias }>;
  ownedReplyAliasRoots: readonly string[];
  quoteTarget?: { id: string; senderOpenId?: string; senderIsBot?: boolean };
}

type ReplyTargets = NonNullable<Session['replyTargets']>;
type TurnReplyContexts = NonNullable<Session['turnReplyContexts']>;
type DocCommentTargets = NonNullable<Session['docCommentTargets']>;
type ReplyThreadAliases = NonNullable<Session['replyThreadAliases']>;

interface LiveRoutingSnapshot {
  replyTargets?: ReplyTargets;
  turnReplyContexts?: TurnReplyContexts;
  docCommentTargets?: DocCommentTargets;
  currentReplyTarget?: CurrentReplyTarget;
  replyThreadAliases?: ReplyThreadAliases;
  quoteTargetId?: string;
  quoteTargetSenderOpenId?: string;
  quoteTargetSenderIsBot?: boolean;
}

function requesterSnapshot(replyTarget: ReplyTargetEntry | undefined): {
  requesterOpenId?: string;
  requesterIsBot?: boolean;
} {
  const requesterOpenId = replyTarget?.senderOpenId;
  const requester = requesterOpenId
    ? replyTarget?.participants?.find(participant => participant.openId === requesterOpenId)
    : undefined;
  return {
    ...(requesterOpenId ? { requesterOpenId } : {}),
    ...(requester?.isBot === true || requester?.isBot === false
      ? { requesterIsBot: requester.isBot }
      : {}),
  };
}

function freezeLiveRouting(session: Session): LiveRoutingSnapshot {
  return structuredClone({
    ...(session.replyTargets ? { replyTargets: session.replyTargets } : {}),
    ...(session.turnReplyContexts ? { turnReplyContexts: session.turnReplyContexts } : {}),
    ...(session.docCommentTargets ? { docCommentTargets: session.docCommentTargets } : {}),
    ...(session.currentReplyTarget ? { currentReplyTarget: session.currentReplyTarget } : {}),
    ...(session.replyThreadAliases ? { replyThreadAliases: session.replyThreadAliases } : {}),
    ...(session.quoteTargetId ? { quoteTargetId: session.quoteTargetId } : {}),
    ...(session.quoteTargetSenderOpenId
      ? { quoteTargetSenderOpenId: session.quoteTargetSenderOpenId }
      : {}),
    ...(session.quoteTargetSenderIsBot === true || session.quoteTargetSenderIsBot === false
      ? { quoteTargetSenderIsBot: session.quoteTargetSenderIsBot }
      : {}),
  });
}

function freezeExactTurnRouting(
  session: LiveRoutingSnapshot,
  turnId: string,
  ownedReplyAliasRoots: readonly string[] = [],
): ExactTurnRoutingSnapshot {
  const replyTarget = session.replyTargets?.[turnId];
  const replyContext = session.turnReplyContexts?.[turnId];
  const docCommentTarget = session.docCommentTargets?.[turnId];
  const currentReplyTarget = session.currentReplyTarget?.turnId === turnId
    ? session.currentReplyTarget
    : undefined;
  const rootMessageIds = new Set<string>();
  if (currentReplyTarget?.rootMessageId) rootMessageIds.add(currentReplyTarget.rootMessageId);
  if (replyTarget?.rootMessageId) rootMessageIds.add(replyTarget.rootMessageId);
  if (replyContext && replyContext.target.mode !== 'plain') {
    rootMessageIds.add(replyContext.target.rootMessageId);
  }
  const explicitAliasRoots = [...new Set(ownedReplyAliasRoots)]
    .filter(rootMessageId => session.replyThreadAliases?.[rootMessageId] !== undefined);
  for (const rootMessageId of explicitAliasRoots) rootMessageIds.add(rootMessageId);
  const replyThreadAliases = [...rootMessageIds].flatMap(rootMessageId => {
    const value = session.replyThreadAliases?.[rootMessageId];
    return value ? [{ rootMessageId, value: structuredClone(value) }] : [];
  });
  const quoteTargetId = session.quoteTargetId;
  const ownsQuoteTarget = quoteTargetId !== undefined
    && (quoteTargetId === turnId
      || (replyContext?.quoteTargetId === quoteTargetId
        && replyContext.replyTargetSenderOpenId === session.quoteTargetSenderOpenId
        && replyContext.replyTargetSenderIsBot === session.quoteTargetSenderIsBot));
  return {
    ...(replyTarget ? { replyTarget: structuredClone(replyTarget) } : {}),
    ...(replyContext ? { replyContext: structuredClone(replyContext) } : {}),
    ...(docCommentTarget ? { docCommentTarget: structuredClone(docCommentTarget) } : {}),
    ...(currentReplyTarget ? { currentReplyTarget: structuredClone(currentReplyTarget) } : {}),
    replyThreadAliases,
    ownedReplyAliasRoots: explicitAliasRoots,
    ...(ownsQuoteTarget
      ? {
          quoteTarget: {
            id: quoteTargetId,
            ...(session.quoteTargetSenderOpenId
              ? { senderOpenId: session.quoteTargetSenderOpenId }
              : {}),
            ...(session.quoteTargetSenderIsBot === true || session.quoteTargetSenderIsBot === false
              ? { senderIsBot: session.quoteTargetSenderIsBot }
              : {}),
          },
        }
      : {}),
  };
}

function mergeReplyThreadAlias(
  existing: ReplyThreadAlias | undefined,
  incoming: ReplyThreadAlias,
): ReplyThreadAlias {
  if (!existing) return incoming;
  return {
    createdAt: existing.createdAt < incoming.createdAt ? existing.createdAt : incoming.createdAt,
    lastUsedAt: existing.lastUsedAt > incoming.lastUsedAt ? existing.lastUsedAt : incoming.lastUsedAt,
  };
}

function quoteOwnerUpdatedAt(session: Session): string | undefined {
  const quoteTargetId = session.quoteTargetId;
  if (!quoteTargetId) return undefined;
  const timestamps: string[] = [];
  const direct = session.replyTargets?.[quoteTargetId]?.updatedAt;
  if (direct) timestamps.push(direct);
  for (const [turnId, context] of Object.entries(session.turnReplyContexts ?? {})) {
    if (context.quoteTargetId !== quoteTargetId
      || context.replyTargetSenderOpenId !== session.quoteTargetSenderOpenId
      || context.replyTargetSenderIsBot !== session.quoteTargetSenderIsBot) continue;
    const updatedAt = session.replyTargets?.[turnId]?.updatedAt;
    if (updatedAt) timestamps.push(updatedAt);
  }
  return timestamps.sort().at(-1);
}

function liveQuoteOwnedByTurn(session: LiveRoutingSnapshot, turnId: string): boolean {
  const quoteTargetId = session.quoteTargetId;
  if (!quoteTargetId) return false;
  const context = session.turnReplyContexts?.[turnId];
  return quoteTargetId === turnId
    || (context?.quoteTargetId === quoteTargetId
      && context.replyTargetSenderOpenId === session.quoteTargetSenderOpenId
      && context.replyTargetSenderIsBot === session.quoteTargetSenderIsBot);
}

function throwForeignRoutingConflict(field: string, owner: string): never {
  throw new Error(`foreign live routing conflict: ${field} (${owner})`);
}

function persistenceEquivalent(left: unknown, right: unknown): boolean {
  const normalize = (value: unknown) => value === undefined
    ? undefined
    : JSON.parse(JSON.stringify(value)) as unknown;
  return isDeepStrictEqual(normalize(left), normalize(right));
}

function turnRootIds(session: LiveRoutingSnapshot, turnId: string): Set<string> {
  const roots = new Set<string>();
  const replyRoot = session.replyTargets?.[turnId]?.rootMessageId;
  if (replyRoot) roots.add(replyRoot);
  const contextTarget = session.turnReplyContexts?.[turnId]?.target;
  if (contextTarget && contextTarget.mode !== 'plain') roots.add(contextTarget.rootMessageId);
  if (session.currentReplyTarget?.turnId === turnId) {
    roots.add(session.currentReplyTarget.rootMessageId);
  }
  return roots;
}

function aliasOwnerTurnIds(session: LiveRoutingSnapshot, rootMessageId: string): string[] {
  const turnIds = new Set([
    ...Object.keys(session.replyTargets ?? {}),
    ...Object.keys(session.turnReplyContexts ?? {}),
    ...(session.currentReplyTarget ? [session.currentReplyTarget.turnId] : []),
  ]);
  return [...turnIds].filter(turnId => turnRootIds(session, turnId).has(rootMessageId));
}

function turnUpdatedAt(session: LiveRoutingSnapshot, turnId: string): string | undefined {
  return session.replyTargets?.[turnId]?.updatedAt
    ?? (session.currentReplyTarget?.turnId === turnId
      ? session.currentReplyTarget.updatedAt
      : undefined);
}

function obsoleteForeignAlias(
  fresh: Session,
  live: LiveRoutingSnapshot,
  rootMessageId: string,
  admittedTurnId: string,
): boolean {
  const owners = aliasOwnerTurnIds(live, rootMessageId)
    .filter(turnId => turnId !== admittedTurnId);
  return owners.length > 0 && owners.every(turnId => {
    const liveAt = turnUpdatedAt(live, turnId);
    const durableAt = turnUpdatedAt(fresh, turnId);
    if (!liveAt || !durableAt || durableAt <= liveAt) return false;
    return !turnRootIds(fresh, turnId).has(rootMessageId);
  });
}

function assertNoForeignLiveRouting(
  fresh: Session,
  live: LiveRoutingSnapshot,
  admittedTurnId: string,
  admitted: ExactTurnRoutingSnapshot,
): void {
  for (const [turnId, entry] of Object.entries(live.replyTargets ?? {})) {
    if (turnId === admittedTurnId) continue;
    const durable = fresh.replyTargets?.[turnId];
    if (!durable
      || durable.updatedAt < entry.updatedAt
      || (durable.updatedAt === entry.updatedAt && !persistenceEquivalent(durable, entry))) {
      throwForeignRoutingConflict('replyTargets', turnId);
    }
  }
  for (const [field, liveMap, durableMap] of [
    ['turnReplyContexts', live.turnReplyContexts, fresh.turnReplyContexts],
    ['docCommentTargets', live.docCommentTargets, fresh.docCommentTargets],
  ] as const) {
    for (const [turnId, entry] of Object.entries(liveMap ?? {})) {
      if (turnId === admittedTurnId || persistenceEquivalent(durableMap?.[turnId], entry)) continue;
      const liveAt = live.replyTargets?.[turnId]?.updatedAt;
      const durableAt = fresh.replyTargets?.[turnId]?.updatedAt;
      if (liveAt && durableAt && durableAt > liveAt) continue;
      throwForeignRoutingConflict(field, turnId);
    }
  }
  const admittedRoots = new Set(admitted.replyThreadAliases.map(alias => alias.rootMessageId));
  for (const [rootMessageId, alias] of Object.entries(live.replyThreadAliases ?? {})) {
    const owners = aliasOwnerTurnIds(live, rootMessageId);
    const admittedOwnsAlias = admitted.ownedReplyAliasRoots.includes(rootMessageId)
      || (admittedRoots.has(rootMessageId) && owners.includes(admittedTurnId));
    if (admittedOwnsAlias
      || persistenceEquivalent(fresh.replyThreadAliases?.[rootMessageId], alias)) continue;
    const durable = fresh.replyThreadAliases?.[rootMessageId];
    if (durable && durable.lastUsedAt > alias.lastUsedAt) continue;
    if (obsoleteForeignAlias(fresh, live, rootMessageId, admittedTurnId)) continue;
    throwForeignRoutingConflict('replyThreadAliases', rootMessageId);
  }
  const liveCurrent = live.currentReplyTarget;
  if (liveCurrent && liveCurrent.turnId !== admittedTurnId
    && !persistenceEquivalent(fresh.currentReplyTarget, liveCurrent)) {
    if (!fresh.currentReplyTarget || fresh.currentReplyTarget.updatedAt <= liveCurrent.updatedAt) {
      throwForeignRoutingConflict('currentReplyTarget', liveCurrent.turnId);
    }
  }
  const liveQuote = {
    id: live.quoteTargetId,
    senderOpenId: live.quoteTargetSenderOpenId,
    senderIsBot: live.quoteTargetSenderIsBot,
  };
  const durableQuote = {
    id: fresh.quoteTargetId,
    senderOpenId: fresh.quoteTargetSenderOpenId,
    senderIsBot: fresh.quoteTargetSenderIsBot,
  };
  if (live.quoteTargetId && !liveQuoteOwnedByTurn(live, admittedTurnId)
    && !persistenceEquivalent(liveQuote, durableQuote)) {
    const liveOwnerAt = quoteOwnerUpdatedAt(live as Session);
    const durableOwnerAt = quoteOwnerUpdatedAt(fresh);
    if (!liveOwnerAt || !durableOwnerAt || durableOwnerAt <= liveOwnerAt) {
      throwForeignRoutingConflict('quoteTarget', live.quoteTargetId);
    }
  }
}

function applyExactTurnRouting(
  fresh: Session,
  turnId: string,
  snapshot: ExactTurnRoutingSnapshot,
): void {
  const durableQuoteOwnerAt = quoteOwnerUpdatedAt(fresh);
  const incomingAt = snapshot.currentReplyTarget?.updatedAt ?? snapshot.replyTarget?.updatedAt;
  const durableTurnAt = fresh.replyTargets?.[turnId]?.updatedAt
    ?? (fresh.currentReplyTarget?.turnId === turnId ? fresh.currentReplyTarget.updatedAt : undefined);
  const liveWinsExactTurn = incomingAt !== undefined
    && (durableTurnAt === undefined || durableTurnAt < incomingAt);
  if (liveWinsExactTurn && snapshot.replyTarget) {
    const replyTargets = fresh.replyTargets ??= {};
    const existing = replyTargets[turnId];
    if (!existing || existing.updatedAt < snapshot.replyTarget.updatedAt) {
      replyTargets[turnId] = snapshot.replyTarget;
      fresh.replyTargetsPrunedThrough = pruneReplyTargets(
        replyTargets,
        fresh.replyTargetsPrunedThrough,
        cronPinnedTurnIds(fresh.cronTaskReplyAnchors),
      );
    }
  }
  if (liveWinsExactTurn && snapshot.replyContext) {
    const contexts = fresh.turnReplyContexts ??= {};
    contexts[turnId] = snapshot.replyContext;
    const overflow = Object.keys(contexts).length - 256;
    if (overflow > 0) {
      for (const staleTurnId of Object.keys(contexts).slice(0, overflow)) delete contexts[staleTurnId];
    }
  }
  if (liveWinsExactTurn && snapshot.docCommentTarget) {
    const targets = fresh.docCommentTargets ??= {};
    targets[turnId] = snapshot.docCommentTarget;
  }
  if (liveWinsExactTurn) {
    for (const alias of snapshot.replyThreadAliases) {
      const aliases = fresh.replyThreadAliases ??= {};
      aliases[alias.rootMessageId] = mergeReplyThreadAlias(aliases[alias.rootMessageId], alias.value);
    }
  }
  if (liveWinsExactTurn
    && snapshot.currentReplyTarget
    && (!fresh.currentReplyTarget
      || fresh.currentReplyTarget.updatedAt < snapshot.currentReplyTarget.updatedAt)) {
    fresh.currentReplyTarget = snapshot.currentReplyTarget;
  }
  if (liveWinsExactTurn
    && snapshot.quoteTarget
    && (fresh.quoteTargetId === undefined
      || (incomingAt !== undefined
        && durableQuoteOwnerAt !== undefined
        && durableQuoteOwnerAt < incomingAt))) {
    fresh.quoteTargetId = snapshot.quoteTarget.id;
    fresh.quoteTargetSenderOpenId = snapshot.quoteTarget.senderOpenId;
    fresh.quoteTargetSenderIsBot = snapshot.quoteTarget.senderIsBot;
  }
}

export function createTurnFeedbackReconciler(deps: TurnFeedbackDeps) {
  const inFlight = new Map<string, Promise<void>>();
  const permanentProbes = new Set<string>();
  const blockedRepairs = new Map<string, {
    opId: string;
    attempt: number;
    probing: boolean;
    timer?: ReturnType<typeof setTimeout>;
  }>();
  const transientRepairs = new Map<string, {
    opId: string;
    attempt: number;
    timer?: ReturnType<typeof setTimeout>;
  }>();

  const keyFor = (target: TurnFeedbackTarget, turnId: string) =>
    JSON.stringify([target.larkAppId, target.session.sessionId, turnId]);

  function readRow(
    target: TurnFeedbackTarget,
    turnId: string,
  ): PersistedTurnFeedback | undefined {
    const fresh = deps.read?.(target) ?? target.session;
    if (fresh !== target.session) target.session.turnFeedback = fresh.turnFeedback;
    return fresh.turnFeedback?.[turnId];
  }

  function desiredReaction(
    target: TurnFeedbackTarget,
    record: PersistedTurnFeedback,
  ): string | undefined {
    if (record.reactionMessageGone) return undefined;
    const policy = deps.policy?.(target) ?? {};
    if (policy.silent || record.silent) return undefined;
    if (record.phase === 'processing' && record.receivedReactionEmoji) {
      return record.receivedReactionEmoji;
    }
    const configured = {
      processing: policy.processing,
      capacity_waiting: policy.capacityWaiting,
      capacity_stale: policy.capacityStale,
      needs_user: policy.needsUser,
      completed: policy.completed,
      failed: policy.failed,
    }[record.phase];
    return configured ?? reactionForPhase(record.phase);
  }

  function cancelRepair(target: TurnFeedbackTarget, turnId: string): void {
    const key = keyFor(target, turnId);
    const blocked = blockedRepairs.get(key);
    if (blocked?.timer) clearTimeout(blocked.timer);
    blockedRepairs.delete(key);
    const transient = transientRepairs.get(key);
    if (transient?.timer) clearTimeout(transient.timer);
    transientRepairs.delete(key);
    for (const probe of permanentProbes) {
      if (probe.startsWith(`${key}:`)) permanentProbes.delete(probe);
    }
  }

  function sweepRepairMemory(target: TurnFeedbackTarget): void {
    const currentOperations = new Map(
      Object.values(target.session.turnFeedback ?? {})
        .filter(record => record.reactionOperation !== undefined)
        .map(record => [keyFor(target, record.turnId), record.reactionOperation!.opId]),
    );
    const currentProbes = new Set(
      [...currentOperations].map(([key, opId]) => `${key}:${opId}`),
    );
    for (const probe of permanentProbes) {
      if (!currentProbes.has(probe)) permanentProbes.delete(probe);
    }
    for (const [key, repair] of blockedRepairs) {
      if (currentOperations.get(key) === repair.opId) continue;
      if (repair.timer) clearTimeout(repair.timer);
      blockedRepairs.delete(key);
    }
    for (const [key, repair] of transientRepairs) {
      if (currentOperations.get(key) === repair.opId) continue;
      if (repair.timer) clearTimeout(repair.timer);
      transientRepairs.delete(key);
    }
  }

  function prunePersisted(target: TurnFeedbackTarget): void {
    const records = target.session.turnFeedback;
    if (!records) return;
    const projected = pruneTurnFeedback(records, deps.now(), {
      desiredReaction: record => desiredReaction(target, record),
    });
    if (Object.keys(projected).length === Object.keys(records).length) {
      sweepRepairMemory(target);
      return;
    }
    deps.commit(target, fresh => {
      if (!fresh.turnFeedback) return;
      fresh.turnFeedback = pruneTurnFeedback(fresh.turnFeedback, deps.now(), {
        desiredReaction: record => desiredReaction(target, record),
      });
    });
    sweepRepairMemory(target);
  }

  function clearGone(
    target: TurnFeedbackTarget,
    turnId: string,
    opId?: string,
  ): void {
    deps.commit(target, fresh => {
      const current = fresh.turnFeedback?.[turnId];
      if (!current || (opId && current.reactionOperation?.opId !== opId)) return;
      delete current.reaction;
      delete current.reactionOperation;
      delete current.reactionReconcilePending;
      current.reactionMessageGone = true;
    });
    cancelRepair(target, turnId);
  }

  function scheduleTransientRepair(
    target: TurnFeedbackTarget,
    turnId: string,
    opId: string,
  ): void {
    const key = keyFor(target, turnId);
    let repair = transientRepairs.get(key);
    if (repair?.opId !== opId) {
      if (repair?.timer) clearTimeout(repair.timer);
      repair = { opId, attempt: 0 };
      transientRepairs.set(key, repair);
    }
    if (repair.timer) return;
    const delay = [1_000, 5_000, 15_000][repair.attempt++];
    if (delay === undefined) {
      transientRepairs.delete(key);
      return;
    }
    const captured = repair;
    captured.timer = setTimeout(() => {
      captured.timer = undefined;
      if (transientRepairs.get(key) !== captured) return;
      if (readRow(target, turnId)?.reactionOperation?.opId !== captured.opId) {
        transientRepairs.delete(key);
        return;
      }
      void reconcile(target, turnId).catch(() => undefined).finally(() => {
        if (transientRepairs.get(key) !== captured) return;
        if (readRow(target, turnId)?.reactionOperation?.opId !== captured.opId) {
          transientRepairs.delete(key);
        }
      });
    }, delay);
    captured.timer.unref?.();
  }

  function scheduleBlockedRepair(
    target: TurnFeedbackTarget,
    turnId: string,
    opId: string,
  ): void {
    const key = keyFor(target, turnId);
    let repair = blockedRepairs.get(key);
    if (repair?.opId !== opId) {
      if (repair?.timer) clearTimeout(repair.timer);
      repair = { opId, attempt: 0, probing: false };
      blockedRepairs.set(key, repair);
    }
    if (repair.timer || repair.probing) return;
    const delay = [300_000, 1_800_000, 7_200_000][repair.attempt++];
    if (delay === undefined) {
      deps.commit(target, fresh => {
        const operation = fresh.turnFeedback?.[turnId]?.reactionOperation;
        if (operation?.opId === opId && operation.phase === 'blocked') {
          operation.retryExhausted = true;
        }
      });
      permanentProbes.add(`${key}:${opId}`);
      blockedRepairs.delete(key);
      prunePersisted(target);
      return;
    }
    const captured = repair;
    captured.timer = setTimeout(() => {
      captured.timer = undefined;
      if (blockedRepairs.get(key) !== captured) return;
      captured.probing = true;
      void reconcile(target, turnId)
        .catch(() => undefined)
        .finally(() => {
          captured.probing = false;
          const operation = readRow(target, turnId)?.reactionOperation;
          if (operation?.opId === opId && operation.phase === 'blocked') {
            scheduleBlockedRepair(target, turnId, opId);
          }
        });
    }, delay);
    captured.timer.unref?.();
  }

  function admit(target: TurnFeedbackTarget, input: TurnFeedbackAdmission): Session {
    const liveRouting = freezeLiveRouting(target.session);
    const routing = freezeExactTurnRouting(
      liveRouting,
      input.turnId,
      input.ownedReplyAliasRoots,
    );
    const committed = deps.commit(target, fresh => {
      assertNoForeignLiveRouting(fresh, liveRouting, input.turnId, routing);
      applyExactTurnRouting(fresh, input.turnId, routing);
      const requester = requesterSnapshot(fresh.replyTargets?.[input.turnId]);
      const records = fresh.turnFeedback ??= {};
      const existing = records[input.turnId];
      if (!existing) {
        records[input.turnId] = {
          version: 1,
          turnId: input.turnId,
          ...(input.messageId === undefined ? {} : { messageId: input.messageId }),
          ...requester,
          phase: 'processing',
          updatedAt: new Date(deps.now()).toISOString(),
          ...(input.receivedReactionEmoji === undefined
            ? {}
            : { receivedReactionEmoji: input.receivedReactionEmoji }),
          ...(input.silent === undefined ? {} : { silent: input.silent }),
          ...(input.background === undefined ? {} : { background: input.background }),
        };
        return;
      }

      if (existing.turnId !== input.turnId) {
        throw new Error(`turn feedback key mismatch for ${input.turnId}`);
      }
      if (existing.messageId !== undefined
        && input.messageId !== undefined
        && existing.messageId !== input.messageId) {
        throw new Error(`turn feedback message conflict for ${input.turnId}`);
      }

      // Duplicate admission may complete missing immutable admission metadata,
      // but it never rewrites phase, capacity, attention, reaction, or time.
      existing.messageId ??= input.messageId;
      if (existing.requesterOpenId === undefined && requester.requesterOpenId !== undefined) {
        existing.requesterOpenId = requester.requesterOpenId;
        existing.requesterIsBot = requester.requesterIsBot;
      } else if (existing.requesterOpenId === requester.requesterOpenId
        && existing.requesterIsBot === undefined) {
        existing.requesterIsBot = requester.requesterIsBot;
      }
      existing.receivedReactionEmoji ??= input.receivedReactionEmoji;
      existing.silent ??= input.silent;
      existing.background ??= input.background;
    });
    prunePersisted(target);
    return committed;
  }

  async function listOwn(
    target: TurnFeedbackTarget,
    messageId: string,
  ): Promise<OwnReactionListResult> {
    if (!deps.listOwnReactionsDetailed) return { status: 'ambiguous' };
    try {
      return await deps.listOwnReactionsDetailed(target.larkAppId, messageId);
    } catch {
      return { status: 'ambiguous' };
    }
  }

  async function run(target: TurnFeedbackTarget, turnId: string): Promise<void> {
    for (;;) {
      const row = readRow(target, turnId);
      if (!row || row.reactionMessageGone) return;
      if (!row.messageId?.startsWith('om_')) {
        if (row.reactionReconcilePending || row.reactionOperation) {
          deps.commit(target, fresh => {
            const current = fresh.turnFeedback?.[turnId];
            if (!current || current.messageId?.startsWith('om_')) return;
            delete current.reaction;
            delete current.reactionOperation;
            delete current.reactionReconcilePending;
          });
        }
        cancelRepair(target, turnId);
        return;
      }

      const wanted = desiredReaction(target, row);
      const operation = row.reactionOperation;
      if (!operation) {
        if (row.reaction?.type === wanted && !row.reactionReconcilePending) return;
        const matchingReaction = row.reaction;
        if (matchingReaction !== undefined
          && matchingReaction.type === wanted
          && row.reactionReconcilePending) {
          const receipt = await listOwn(target, row.messageId);
          if (receipt.status === 'gone') {
            clearGone(target, turnId);
            return;
          }
          if (receipt.status !== 'ok') return;
          if (receipt.items.length === 1
            && receipt.items[0].id === matchingReaction.id
            && receipt.items[0].type === matchingReaction.type) {
            deps.commit(target, fresh => {
              const current = fresh.turnFeedback?.[turnId];
              if (current?.reaction?.id === matchingReaction.id
                && current.reaction.type === wanted
                && !current.reactionOperation) {
                delete current.reactionReconcilePending;
              }
            });
            return;
          }
        }
        if (!row.reaction && wanted === undefined) {
          if (row.reactionReconcilePending) {
            deps.commit(target, fresh => {
              const current = fresh.turnFeedback?.[turnId];
              if (current && !current.reaction && desiredReaction(target, current) === undefined) {
                delete current.reactionReconcilePending;
              }
            });
          }
          return;
        }
        deps.commit(target, fresh => {
          const current = fresh.turnFeedback?.[turnId];
          if (!current || current.reactionOperation || current.reactionMessageGone) return;
          const desiredType = desiredReaction(target, current);
          current.reactionReconcilePending = true;
          current.reactionOperation = {
            opId: randomUUID(),
            messageId: current.messageId!,
            ...(desiredType ? { desiredType } : {}),
            createdAt: new Date(deps.now()).toISOString(),
            phase: current.reaction ? 'remove_pending' : 'add_pending',
            ...(current.reaction ? { old: { ...current.reaction } } : {}),
          };
        });
        continue;
      }

      if (operation.desiredType !== wanted
        && (operation.phase === 'failed' || operation.phase === 'blocked')) {
        cancelRepair(target, turnId);
        deps.commit(target, fresh => {
          const current = fresh.turnFeedback?.[turnId];
          if (current?.reactionOperation?.opId !== operation.opId) return;
          delete current.reactionOperation;
          current.reactionReconcilePending = true;
        });
        continue;
      }

      const key = keyFor(target, turnId);
      const blocked = blockedRepairs.get(key);
      if (operation.phase === 'blocked' && blocked?.opId === operation.opId
        && !blocked.probing) return;
      if (operation.phase === 'blocked' && operation.retryExhausted && !blocked) {
        const probeKey = `${key}:${operation.opId}`;
        if (permanentProbes.has(probeKey)) return;
        permanentProbes.add(probeKey);
      }
      if (operation.phase === 'failed') {
        const probeKey = `${key}:${operation.opId}`;
        if (permanentProbes.has(probeKey)) return;
        permanentProbes.add(probeKey);
      }

      const receipt = await listOwn(target, operation.messageId);
      if (receipt.status === 'gone') {
        clearGone(target, turnId, operation.opId);
        return;
      }
      if (receipt.status !== 'ok') {
        if (operation.phase !== 'failed' && operation.phase !== 'blocked') {
          scheduleTransientRepair(target, turnId, operation.opId);
        }
        return;
      }
      const own = receipt.items;
      const stillCurrent = () =>
        readRow(target, turnId)?.reactionOperation?.opId === operation.opId;
      if (!stillCurrent()) continue;

      if (operation.phase === 'remove_pending') {
        if (!operation.old) return;
        const present = own.find(item => item.id === operation.old!.id);
        if (present) {
          if (present.type !== operation.old.type || !deps.removeReactionDetailed) return;
          let removed: ReactionRemovalResult;
          try {
            removed = await deps.removeReactionDetailed(
              target.larkAppId, operation.messageId, present.id,
            );
          } catch {
            scheduleTransientRepair(target, turnId, operation.opId);
            return;
          }
          if (removed === 'gone') {
            clearGone(target, turnId, operation.opId);
            return;
          }
          if (removed !== 'deleted') {
            scheduleTransientRepair(target, turnId, operation.opId);
            return;
          }
        }
        deps.commit(target, fresh => {
          const current = fresh.turnFeedback?.[turnId];
          if (current?.reactionOperation?.opId !== operation.opId) return;
          if (current.reaction?.id === operation.old!.id) delete current.reaction;
          delete current.reactionOperation;
          current.reactionReconcilePending = true;
        });
        continue;
      }

      if (operation.phase === 'cleanup_pending') {
        if (!operation.adopted || !operation.duplicateIds) return;
        const duplicateId = operation.duplicateIds[0];
        if (duplicateId) {
          const present = own.find(item => item.id === duplicateId);
          if (present) {
            if (present.type !== operation.adopted.type || !deps.removeReactionDetailed) return;
            let removed: ReactionRemovalResult;
            try {
              removed = await deps.removeReactionDetailed(
                target.larkAppId, operation.messageId, duplicateId,
              );
            } catch {
              scheduleTransientRepair(target, turnId, operation.opId);
              return;
            }
            if (removed === 'gone') {
              clearGone(target, turnId, operation.opId);
              return;
            }
            if (removed !== 'deleted') {
              scheduleTransientRepair(target, turnId, operation.opId);
              return;
            }
          }
          deps.commit(target, fresh => {
            const current = fresh.turnFeedback?.[turnId];
            if (current?.reactionOperation?.opId !== operation.opId) return;
            current.reactionOperation = {
              ...current.reactionOperation,
              duplicateIds: current.reactionOperation.duplicateIds?.slice(1),
            };
          });
          continue;
        }
        deps.commit(target, fresh => {
          const current = fresh.turnFeedback?.[turnId];
          if (current?.reactionOperation?.opId !== operation.opId) return;
          const adoptedPresent = own.some(item =>
            item.id === operation.adopted!.id && item.type === operation.adopted!.type);
          if (adoptedPresent) {
            current.reaction = { ...operation.adopted! };
            delete current.reactionOperation;
            if (desiredReaction(target, current) === operation.adopted!.type) {
              delete current.reactionReconcilePending;
            } else {
              current.reactionReconcilePending = true;
            }
          } else {
            delete current.reaction;
            current.reactionOperation = {
              ...current.reactionOperation,
              phase: 'add_pending',
              adopted: undefined,
              duplicateIds: undefined,
            };
            current.reactionReconcilePending = true;
          }
        });
        continue;
      }

      if (!operation.desiredType) {
        deps.commit(target, fresh => {
          const current = fresh.turnFeedback?.[turnId];
          if (current?.reactionOperation?.opId !== operation.opId) return;
          delete current.reactionOperation;
          current.reactionReconcilePending = true;
        });
        continue;
      }

      const matches = own
        .filter(item => item.type === operation.desiredType)
        .sort((left, right) => left.id.localeCompare(right.id));
      if (matches.length > 0) {
        const adopted = matches[0];
        const duplicateIds = matches.slice(1).map(item => item.id);
        deps.commit(target, fresh => {
          const current = fresh.turnFeedback?.[turnId];
          if (current?.reactionOperation?.opId !== operation.opId) return;
          current.reaction = { ...adopted };
          if (duplicateIds.length > 0) {
            current.reactionOperation = {
              ...current.reactionOperation,
              phase: 'cleanup_pending',
              adopted: { ...adopted },
              duplicateIds,
            };
          } else {
            delete current.reactionOperation;
            if (desiredReaction(target, current) === adopted.type) {
              delete current.reactionReconcilePending;
            }
          }
        });
        if (duplicateIds.length === 0) cancelRepair(target, turnId);
        continue;
      }

      if (operation.desiredType !== wanted) {
        deps.commit(target, fresh => {
          const current = fresh.turnFeedback?.[turnId];
          if (current?.reactionOperation?.opId !== operation.opId) return;
          delete current.reactionOperation;
          current.reactionReconcilePending = true;
        });
        cancelRepair(target, turnId);
        continue;
      }

      if (operation.phase === 'failed') return;
      if (operation.phase === 'blocked') {
        const repair = blockedRepairs.get(key);
        if (repair && !repair.probing) return;
        deps.commit(target, fresh => {
          const current = fresh.turnFeedback?.[turnId];
          if (current?.reactionOperation?.opId === operation.opId) {
            current.reactionOperation = { ...current.reactionOperation, phase: 'add_pending' };
          }
        });
        continue;
      }
      if (!deps.addReactionOnce) return;
      const created = await deps.addReactionOnce(
        target.larkAppId, operation.messageId, operation.desiredType,
      );
      if (created.status === 'gone') {
        clearGone(target, turnId, operation.opId);
        return;
      }
      if (created.status === 'created') {
        deps.commit(target, fresh => {
          const current = fresh.turnFeedback?.[turnId];
          if (current?.reactionOperation?.opId !== operation.opId) return;
          current.reaction = { id: created.id, type: operation.desiredType! };
          delete current.reactionOperation;
          if (desiredReaction(target, current) === operation.desiredType) {
            delete current.reactionReconcilePending;
          }
        });
        cancelRepair(target, turnId);
        continue;
      }
      if (created.status === 'failed' || created.status === 'blocked') {
        deps.commit(target, fresh => {
          const current = fresh.turnFeedback?.[turnId];
          if (current?.reactionOperation?.opId !== operation.opId) return;
          current.reactionOperation = {
            ...current.reactionOperation,
            phase: created.status,
            failureReason: created.reason,
          };
          current.reactionReconcilePending = true;
        });
        if (created.status === 'failed') {
          permanentProbes.add(`${key}:${operation.opId}`);
          prunePersisted(target);
        } else {
          scheduleBlockedRepair(target, turnId, operation.opId);
        }
        return;
      }
      scheduleTransientRepair(target, turnId, operation.opId);
      return;
    }
  }

  function reconcile(target: TurnFeedbackTarget, turnId: string): Promise<void> {
    const key = keyFor(target, turnId);
    const existing = inFlight.get(key);
    if (existing) return existing;
    const running = run(target, turnId).finally(() => {
      if (inFlight.get(key) === running) inFlight.delete(key);
    });
    inFlight.set(key, running);
    return running;
  }

  async function scheduleReactionRepair(
    target: TurnFeedbackTarget,
    turnId: string,
  ): Promise<void> {
    await reconcile(target, turnId);
  }

  async function terminal(
    target: TurnFeedbackTarget,
    turnId: string,
    phase: 'completed' | 'failed',
    observedAtMs = deps.now(),
  ): Promise<void> {
    const result = commitTerminal(target, turnId, phase, observedAtMs);
    if (result === 'conflict' || result === 'missing') return;
    await reconcile(target, turnId);
    prunePersisted(target);
  }

  function commitTerminal(
    target: TurnFeedbackTarget,
    turnId: string,
    phase: 'completed' | 'failed',
    observedAtMs = deps.now(),
  ): 'committed' | 'duplicate' | 'conflict' | 'missing' {
    let result: 'committed' | 'duplicate' | 'conflict' | 'missing' = 'missing';
    deps.commit(target, fresh => {
      const row = fresh.turnFeedback?.[turnId];
      if (!row) return;
      if (terminalPhase(row.phase)) {
        result = row.phase === phase ? 'duplicate' : 'conflict';
        return;
      }
      row.phase = phase;
      row.updatedAt = new Date(Math.max(Date.parse(row.updatedAt), observedAtMs)).toISOString();
      delete row.capacity;
      delete row.capacityClearedAt;
      delete row.attention;
      if (row.reactionOperation || row.reaction?.type !== desiredReaction(target, row)) {
        row.reactionReconcilePending = true;
      }
      result = 'committed';
    });
    return result;
  }

  function commitTerminalReceipt(
    target: TurnFeedbackTarget,
    record: TurnFeedbackTerminalRecord,
  ): 'committed' | 'duplicate' | 'conflict' | 'missing' {
    let result: 'committed' | 'duplicate' | 'conflict' | 'missing' = 'missing';
    deps.commit(target, fresh => {
      const row = fresh.turnFeedback?.[record.turnId];
      if (!row) return;
      const receipt = {
        version: 1 as const, terminalRequestId: record.terminalRequestId,
        workerGeneration: record.workerGeneration,
        ...(record.dispatchAttempt !== undefined ? { dispatchAttempt: record.dispatchAttempt } : {}),
        status: record.status,
        ...(record.completedAtMs !== undefined ? { completedAtMs: record.completedAtMs } : {}),
        ...(record.durationMs !== undefined ? { durationMs: record.durationMs } : {}),
        savedAtMs: record.savedAtMs,
      };
      if (row.terminalReceipt) {
        result = JSON.stringify(row.terminalReceipt) === JSON.stringify(receipt)
          ? 'duplicate' : 'conflict';
        return;
      }
      const phase = record.status === 'completed' ? 'completed' : 'failed';
      if (terminalPhase(row.phase) && row.phase !== phase) { result = 'conflict'; return; }
      row.terminalReceipt = receipt;
      if (!terminalPhase(row.phase)) {
        row.phase = phase;
        row.updatedAt = new Date(Math.max(
          Date.parse(row.updatedAt), record.completedAtMs ?? deps.now(),
        )).toISOString();
        delete row.capacity;
        delete row.capacityClearedAt;
        delete row.attention;
        if (row.reactionOperation || row.reaction?.type !== desiredReaction(target, row)) {
          row.reactionReconcilePending = true;
        }
        result = 'committed';
      } else {
        result = 'duplicate';
      }
    });
    return result;
  }

  // Reserved durable seams for later tasks. Capacity and attention projection
  // remain explicit no-ops; this task owns only reaction and terminal recovery.
  function observeCapacity(_target: TurnFeedbackTarget, _turnId: string, _observation: unknown): void {}
  function observeAttention(_target: TurnFeedbackTarget, _turnId: string, _observation: unknown): void {}
  function disableCapacity(_target: TurnFeedbackTarget): void {}
  async function repairClosedFeedback(target: TurnFeedbackTarget): Promise<void> {
    if (target.session.status !== 'closed' || !target.session.turnFeedback) return;
    deps.commit(target, fresh => {
      for (const row of Object.values(fresh.turnFeedback ?? {})) {
        if (!terminalPhase(row.phase)) {
          row.phase = 'failed';
          row.updatedAt = new Date(Math.max(Date.parse(row.updatedAt), deps.now())).toISOString();
        }
        delete row.capacity;
        delete row.capacityClearedAt;
        delete row.attention;
      }
    });
    for (const turnId of Object.keys(target.session.turnFeedback ?? {})) {
      await reconcile(target, turnId);
    }
    prunePersisted(target);
  }

  async function restore(targets: Iterable<TurnFeedbackTarget>): Promise<void> {
    for (const target of targets) {
      if (!target.session.turnFeedback) continue;
      if (target.session.status === 'closed') {
        await repairClosedFeedback(target);
        continue;
      }
      for (const turnId of Object.keys(target.session.turnFeedback)) {
        await reconcile(target, turnId);
      }
      prunePersisted(target);
    }
  }

  function dispose(target?: TurnFeedbackTarget): void {
    for (const [key, repair] of blockedRepairs) {
      if (target && !key.startsWith(JSON.stringify([target.larkAppId, target.session.sessionId]).slice(0, -1))) continue;
      if (repair.timer) clearTimeout(repair.timer);
      blockedRepairs.delete(key);
    }
    for (const [key, repair] of transientRepairs) {
      if (target && !key.startsWith(JSON.stringify([target.larkAppId, target.session.sessionId]).slice(0, -1))) continue;
      if (repair.timer) clearTimeout(repair.timer);
      transientRepairs.delete(key);
    }
    if (!target) {
      permanentProbes.clear();
    } else {
      const prefix = JSON.stringify([target.larkAppId, target.session.sessionId]).slice(0, -1);
      for (const probe of permanentProbes) {
        if (probe.startsWith(prefix)) permanentProbes.delete(probe);
      }
    }
  }

  return {
    admit, reconcile, scheduleReactionRepair, commitTerminal, commitTerminalReceipt, terminal, observeCapacity, observeAttention, disableCapacity,
    restore, repairClosedFeedback, dispose,
    __testOnly_memoryCounts: () => ({
      inFlight: inFlight.size,
      permanentProbes: permanentProbes.size,
      blockedRepairs: blockedRepairs.size,
      transientRepairs: transientRepairs.size,
    }),
  };
}

function commitFeedback(target: TurnFeedbackTarget, mutate: (fresh: Session) => void): Session {
  const { rows } = sessionStore.mutateOwnedSessionsAtomically(
    [target.session.sessionId],
    fresh => mutate(fresh.get(target.session.sessionId)!),
  );
  const committed = rows.get(target.session.sessionId)!;
  if (committed !== target.session) {
    for (const key of Object.keys(target.session)) {
      delete (target.session as unknown as Record<string, unknown>)[key];
    }
    Object.assign(target.session, structuredClone(committed));
  }
  return target.session;
}

export const turnFeedbackReconciler = createTurnFeedbackReconciler({
  commit: commitFeedback,
  read(target) {
    return sessionStore.getSessionFresh(target.session.sessionId) ?? target.session;
  },
  now: () => Date.now(),
  addReactionOnce: (...args) => addReactionOnce(...args),
  removeReactionDetailed: (...args) => removeReactionDetailed(...args),
  listOwnReactionsDetailed: (...args) => listOwnReactionsDetailed(...args),
  policy(target) {
    const config = getBot(target.larkAppId).config;
    return {
      silent: config.silentTurnReactions === true,
      processing: config.receivedReactionEmoji || 'GoGoGo',
      completed: config.doneReactionEmoji || 'DONE',
      failed: 'ERROR',
      capacityWaiting: 'Coffee',
      capacityStale: 'Coffee',
      needsUser: 'THINKING',
    };
  },
});
