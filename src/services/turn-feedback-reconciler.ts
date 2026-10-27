import type { FrozenSessionReplyContext, ReplyTargetEntry, Session } from '../types.js';
import { cronPinnedTurnIds, pruneReplyTargets } from '../core/reply-target.js';

export interface TurnFeedbackTarget {
  session: Session;
  larkAppId: string;
}

export interface TurnFeedbackDeps {
  /** Mutate and commit the fresh owned Session row before publishing it in memory. */
  commit(target: TurnFeedbackTarget, mutate: (fresh: Session) => void): void;
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

function freezeExactTurnRouting(session: Session, turnId: string): ExactTurnRoutingSnapshot {
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

function applyExactTurnRouting(
  fresh: Session,
  turnId: string,
  snapshot: ExactTurnRoutingSnapshot,
): void {
  const durableQuoteOwnerAt = quoteOwnerUpdatedAt(fresh);
  const incomingAt = snapshot.currentReplyTarget?.updatedAt ?? snapshot.replyTarget?.updatedAt;
  if (snapshot.replyTarget) {
    const replyTargets = fresh.replyTargets ??= {};
    const existing = replyTargets[turnId];
    if (!existing || existing.updatedAt <= snapshot.replyTarget.updatedAt) {
      replyTargets[turnId] = snapshot.replyTarget;
      fresh.replyTargetsPrunedThrough = pruneReplyTargets(
        replyTargets,
        fresh.replyTargetsPrunedThrough,
        cronPinnedTurnIds(fresh.cronTaskReplyAnchors),
      );
    }
  }
  if (snapshot.replyContext) {
    const contexts = fresh.turnReplyContexts ??= {};
    if (!contexts[turnId]) {
      contexts[turnId] = snapshot.replyContext;
      const overflow = Object.keys(contexts).length - 256;
      if (overflow > 0) {
        for (const staleTurnId of Object.keys(contexts).slice(0, overflow)) delete contexts[staleTurnId];
      }
    }
  }
  if (snapshot.docCommentTarget) {
    const targets = fresh.docCommentTargets ??= {};
    targets[turnId] ??= snapshot.docCommentTarget;
  }
  for (const alias of snapshot.replyThreadAliases) {
    const aliases = fresh.replyThreadAliases ??= {};
    aliases[alias.rootMessageId] = mergeReplyThreadAlias(aliases[alias.rootMessageId], alias.value);
  }
  if (snapshot.currentReplyTarget
    && (!fresh.currentReplyTarget
      || fresh.currentReplyTarget.turnId === turnId
      || fresh.currentReplyTarget.updatedAt <= snapshot.currentReplyTarget.updatedAt)) {
    fresh.currentReplyTarget = snapshot.currentReplyTarget;
  }
  if (snapshot.quoteTarget
    && (fresh.quoteTargetId === undefined
      || fresh.quoteTargetId === snapshot.quoteTarget.id
      || (incomingAt !== undefined
        && durableQuoteOwnerAt !== undefined
        && durableQuoteOwnerAt <= incomingAt))) {
    fresh.quoteTargetId = snapshot.quoteTarget.id;
    fresh.quoteTargetSenderOpenId = snapshot.quoteTarget.senderOpenId;
    fresh.quoteTargetSenderIsBot = snapshot.quoteTarget.senderIsBot;
  }
}

export function createTurnFeedbackReconciler(deps: TurnFeedbackDeps) {
  function admit(target: TurnFeedbackTarget, input: TurnFeedbackAdmission): void {
    const routing = freezeExactTurnRouting(target.session, input.turnId);
    const requester = requesterSnapshot(routing.replyTarget);
    deps.commit(target, fresh => {
      applyExactTurnRouting(fresh, input.turnId, routing);
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
