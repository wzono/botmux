import type { FrozenSessionReplyContext, ReplyTargetEntry, Session } from '../types.js';
import { cronPinnedTurnIds, pruneReplyTargets } from '../core/reply-target.js';
import { isDeepStrictEqual } from 'node:util';

export interface TurnFeedbackTarget {
  session: Session;
  larkAppId: string;
}

export interface TurnFeedbackDeps {
  /** Mutate and commit the fresh owned Session row before publishing it in memory. */
  commit(target: TurnFeedbackTarget, mutate: (fresh: Session) => void): Session;
  now(): number;
}

export interface TurnFeedbackAdmission {
  turnId: string;
  messageId?: string;
  receivedReactionEmoji?: string;
  silent?: boolean;
  background?: boolean;
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

function freezeExactTurnRouting(session: LiveRoutingSnapshot, turnId: string): ExactTurnRoutingSnapshot {
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
  ]);
  return [...turnIds].filter(turnId => turnRootIds(session, turnId).has(rootMessageId));
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
    const liveAt = live.replyTargets?.[turnId]?.updatedAt;
    const durableAt = fresh.replyTargets?.[turnId]?.updatedAt;
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
    const admittedOwnsAlias = admittedRoots.has(rootMessageId)
      && owners.includes(admittedTurnId);
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
  function admit(target: TurnFeedbackTarget, input: TurnFeedbackAdmission): Session {
    const liveRouting = freezeLiveRouting(target.session);
    const routing = freezeExactTurnRouting(liveRouting, input.turnId);
    return deps.commit(target, fresh => {
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
      existing.requesterOpenId ??= requester.requesterOpenId;
      existing.requesterIsBot ??= requester.requesterIsBot;
      existing.receivedReactionEmoji ??= input.receivedReactionEmoji;
      existing.silent ??= input.silent;
      existing.background ??= input.background;
    });
  }

  // Reserved durable seams for later tasks. Admission is the only transition
  // implemented here; these explicit no-ops cannot publish partial behavior.
  function observeCapacity(_target: TurnFeedbackTarget, _turnId: string, _observation: unknown): void {}
  function observeAttention(_target: TurnFeedbackTarget, _turnId: string, _observation: unknown): void {}
  function terminal(_target: TurnFeedbackTarget, _turnId: string, _phase: 'completed' | 'failed'): void {}
  function disableCapacity(_target: TurnFeedbackTarget): void {}
  function restore(_targets: Iterable<TurnFeedbackTarget>): void {}

  return { admit, observeCapacity, observeAttention, terminal, disableCapacity, restore };
}
