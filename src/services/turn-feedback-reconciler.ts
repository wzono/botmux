import { randomUUID } from 'node:crypto';
import type { FrozenSessionReplyContext, PersistedTurnFeedback, ReplyTargetEntry, Session } from '../types.js';
import { cronPinnedTurnIds, pruneReplyTargets } from '../core/reply-target.js';
import { isDeepStrictEqual } from 'node:util';
import {
  createReactionOnce,
  deleteReactionOnce,
  listOwnReactions,
  type ReactionCreateReceipt,
  type ReactionDeleteReceipt,
  type ReactionListReceipt,
} from '../im/lark/reaction-provider.js';
import {
  planReactionStep,
  reduceReactionReceipt,
  type ReactionPlanResult,
  type TurnReactionPolicy,
} from './turn-feedback-reaction.js';
import { pruneTurnFeedback } from './turn-feedback-retention.js';
import { reduceTurnFeedback } from './turn-feedback-state.js';

export interface TurnFeedbackTarget {
  session: Session;
  larkAppId: string;
}

export interface TurnFeedbackDeps {
  /** Mutate and commit the fresh owned Session row before publishing it in memory. */
  commit(target: TurnFeedbackTarget, mutate: (fresh: Session) => void): Session;
  read?(target: TurnFeedbackTarget): Session;
  now(): number;
  randomId?(): string;
  policy?(target: TurnFeedbackTarget): TurnReactionPolicy;
  listOwnReactions?(appId: string, messageId: string): Promise<ReactionListReceipt>;
  createReactionOnce?(appId: string, messageId: string, type: string): Promise<ReactionCreateReceipt>;
  deleteReactionOnce?(appId: string, messageId: string, reactionId: string): Promise<ReactionDeleteReceipt>;
}

export interface TurnFeedbackAdmission {
  turnId: string;
  messageId?: string;
  receivedReactionEmoji?: string;
  reactionSilent?: boolean;
  reminderSilent?: boolean;
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
  const listProvider = deps.listOwnReactions ?? listOwnReactions;
  const createProvider = deps.createReactionOnce ?? createReactionOnce;
  const deleteProvider = deps.deleteReactionOnce ?? deleteReactionOnce;
  const inFlight = new Map<string, Promise<void>>();
  const repairs = new Map<string, {
    intentId: string;
    attempt: number;
    kind: 'transient' | 'blocked';
    timer?: ReturnType<typeof setTimeout>;
  }>();

  const keyFor = (target: TurnFeedbackTarget, turnId: string) =>
    JSON.stringify([target.larkAppId, target.session.sessionId, turnId]);

  function readRow(target: TurnFeedbackTarget, turnId: string): PersistedTurnFeedback | undefined {
    const fresh = deps.read?.(target) ?? target.session;
    if (fresh !== target.session) target.session.turnFeedback = fresh.turnFeedback;
    return fresh.turnFeedback?.[turnId];
  }

  function policyFor(target: TurnFeedbackTarget): TurnReactionPolicy {
    return deps.policy?.(target) ?? {};
  }

  function applyResult(
    target: TurnFeedbackTarget,
    turnId: string,
    intentId: string,
    result: ReactionPlanResult,
  ): void {
    deps.commit(target, fresh => {
      const record = fresh.turnFeedback?.[turnId];
      if (!record || record.reactionIntent?.id !== intentId) return;
      if (result.messageGone) record.reactionMessageGone = true;
      if ('reaction' in result) record.reaction = result.reaction;
      if ('intent' in result) record.reactionIntent = result.intent;
    });
  }

  function cancelRepair(target: TurnFeedbackTarget, turnId: string): void {
    const key = keyFor(target, turnId);
    const repair = repairs.get(key);
    if (repair?.timer) clearTimeout(repair.timer);
    repairs.delete(key);
  }

  function scheduleNextRepair(
    target: TurnFeedbackTarget,
    turnId: string,
    intentId: string,
    kind: 'transient' | 'blocked',
  ): void {
    const key = keyFor(target, turnId);
    let repair = repairs.get(key);
    if (!repair || repair.intentId !== intentId || repair.kind !== kind) {
      if (repair?.timer) clearTimeout(repair.timer);
      repair = { intentId, attempt: 0, kind };
      repairs.set(key, repair);
    }
    if (repair.timer) return;
    const schedule = kind === 'transient'
      ? [1_000, 5_000, 15_000]
      : [300_000, 1_800_000, 7_200_000];
    const delay = schedule[repair.attempt++];
    if (delay === undefined) {
      if (kind === 'blocked') {
        deps.commit(target, fresh => {
          const intent = fresh.turnFeedback?.[turnId]?.reactionIntent;
          if (intent?.id === intentId && intent.stage === 'blocked') intent.retryExhausted = true;
        });
      }
      repairs.delete(key);
      return;
    }
    const captured = repair;
    captured.timer = setTimeout(() => {
      captured.timer = undefined;
      if (repairs.get(key) !== captured) return;
      if (readRow(target, turnId)?.reactionIntent?.id !== intentId) {
        repairs.delete(key);
        return;
      }
      void reconcile(target, turnId, true).finally(() => {
        const intent = readRow(target, turnId)?.reactionIntent;
        if (repairs.get(key) !== captured || intent?.id !== intentId) return;
        if (intent.retryClass === kind) scheduleNextRepair(target, turnId, intentId, kind);
        else cancelRepair(target, turnId);
      });
    }, delay);
    captured.timer.unref?.();
  }

  async function run(target: TurnFeedbackTarget, turnId: string, freshProcess = false): Promise<void> {
    let forceList = freshProcess;
    for (;;) {
      const record = readRow(target, turnId);
      if (!record) return;
      const plan = planReactionStep({
        record, policy: policyFor(target),
        newIntentId: deps.randomId?.() ?? randomUUID(),
        nowIso: new Date(deps.now()).toISOString(),
        freshProcess: forceList,
      });
      forceList = false;
      if (plan.action === 'settled') { cancelRepair(target, turnId); return; }
      if (plan.action === 'persist_intent') {
        deps.commit(target, fresh => {
          const current = fresh.turnFeedback?.[turnId];
          if (!current || current.reactionIntent || current.reactionMessageGone) return;
          current.reactionIntent = plan.intent;
        });
        continue;
      }
      const current = readRow(target, turnId);
      if (!current?.reactionIntent || current.reactionIntent.id !== plan.intentId) continue;
      const receipt = plan.action === 'list'
        ? await listProvider(target.larkAppId, plan.messageId)
        : plan.action === 'create'
          ? await createProvider(target.larkAppId, plan.messageId, plan.type)
          : await deleteProvider(target.larkAppId, plan.messageId, plan.reactionId);
      const result = reduceReactionReceipt({
        record: current, policy: policyFor(target), intentId: plan.intentId,
        action: plan.action, receipt,
      });
      applyResult(target, turnId, plan.intentId, result);
      const next = readRow(target, turnId)?.reactionIntent;
      if (!next) { cancelRepair(target, turnId); return; }
      if (next.retryClass) {
        scheduleNextRepair(target, turnId, next.id, next.retryClass);
        return;
      }
    }
  }

  function reconcile(
    target: TurnFeedbackTarget,
    turnId: string,
    freshProcess = false,
  ): Promise<void> {
    const key = keyFor(target, turnId);
    const existing = inFlight.get(key);
    if (existing) return existing;
    const promise = run(target, turnId, freshProcess).finally(() => {
      if (inFlight.get(key) === promise) inFlight.delete(key);
    });
    inFlight.set(key, promise);
    return promise;
  }

  async function scheduleReactionRepair(target: TurnFeedbackTarget, turnId: string): Promise<void> {
    await reconcile(target, turnId, true);
  }

  function admit(target: TurnFeedbackTarget, input: TurnFeedbackAdmission): Session {
    const liveRouting = freezeLiveRouting(target.session);
    const routing = freezeExactTurnRouting(
      liveRouting,
      input.turnId,
      input.ownedReplyAliasRoots,
    );
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
          ...(input.reactionSilent === undefined ? {} : { reactionSilent: input.reactionSilent }),
          ...(input.reminderSilent === undefined ? {} : { reminderSilent: input.reminderSilent }),
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
      existing.reactionSilent ??= input.reactionSilent;
      existing.reminderSilent ??= input.reminderSilent;
      existing.background ??= input.background;
    });
  }

  function observeCapacity(
    target: TurnFeedbackTarget,
    turnId: string,
    observation: { state: 'waiting' | 'clear'; position?: number; observedAtMs: number },
  ): boolean {
    let changed = false;
    deps.commit(target, fresh => {
      const record = fresh.turnFeedback?.[turnId];
      if (!record) return;
      const next = reduceTurnFeedback({
        phase: record.phase, updatedAtMs: Date.parse(record.updatedAt), capacity: record.capacity,
      }, observation.state === 'waiting'
        ? { type: 'waiting', evidence: {
            kind: 'waiting', source: 'pty', observedAtMs: observation.observedAtMs,
            ...(observation.position !== undefined ? { position: observation.position } : {}),
          } }
        : { type: 'cleared', observedAtMs: observation.observedAtMs });
      if (next.phase === record.phase && next.capacity === record.capacity) return;
      record.phase = next.phase;
      record.updatedAt = new Date(next.updatedAtMs).toISOString();
      record.capacity = next.capacity;
      const plan = planReactionStep({
        record, policy: policyFor(target),
        newIntentId: deps.randomId?.() ?? randomUUID(),
        nowIso: new Date(deps.now()).toISOString(),
      });
      if (plan.action === 'persist_intent') record.reactionIntent = plan.intent;
      changed = true;
    });
    return changed;
  }
  function markCapacityStale(
    target: TurnFeedbackTarget,
    turnId: string,
    observedAtMs: number,
    nowMs: number,
  ): boolean {
    let changed = false;
    deps.commit(target, fresh => {
      const record = fresh.turnFeedback?.[turnId];
      if (!record) return;
      const next = reduceTurnFeedback({
        phase: record.phase, updatedAtMs: Date.parse(record.updatedAt), capacity: record.capacity,
      }, { type: 'stale', observedAtMs, nowMs });
      if (next.phase === record.phase && next.capacity === record.capacity) return;
      record.phase = next.phase;
      record.updatedAt = new Date(next.updatedAtMs).toISOString();
      record.capacity = next.capacity;
      changed = true;
    });
    return changed;
  }
  function observeAttention(_target: TurnFeedbackTarget, _turnId: string, _observation: unknown): void {}
  function disableCapacity(_target: TurnFeedbackTarget): void {}
  function terminal(
    target: TurnFeedbackTarget,
    turnId: string,
    phase: 'completed' | 'failed',
    observedAtMs = deps.now(),
  ): boolean {
    let changed = false;
    deps.commit(target, fresh => {
      const record = fresh.turnFeedback?.[turnId];
      if (!record || record.phase === 'completed' || record.phase === 'failed') return;
      record.phase = phase;
      record.updatedAt = new Date(Math.max(Date.parse(record.updatedAt), observedAtMs)).toISOString();
      const desired = planReactionStep({
        record, policy: policyFor(target),
        newIntentId: deps.randomId?.() ?? randomUUID(),
        nowIso: new Date(deps.now()).toISOString(),
      });
      if (desired.action === 'persist_intent') record.reactionIntent = desired.intent;
      changed = true;
      fresh.turnFeedback = pruneTurnFeedback(
        fresh.turnFeedback ?? {}, deps.now(), policyFor(target),
      );
    });
    return changed;
  }
  async function restore(targets: Iterable<TurnFeedbackTarget>): Promise<void> {
    for (const target of targets) {
      for (const record of Object.values(target.session.turnFeedback ?? {})) {
        if (!record.reactionIntent) continue;
        await scheduleReactionRepair(target, record.turnId);
      }
    }
  }

  function dispose(target?: TurnFeedbackTarget): void {
    const prefix = target
      ? JSON.stringify([target.larkAppId, target.session.sessionId]).slice(0, -1)
      : undefined;
    for (const [key, repair] of repairs) {
      if (prefix && !key.startsWith(prefix)) continue;
      if (repair.timer) clearTimeout(repair.timer);
      repairs.delete(key);
    }
  }

  return {
    admit, observeCapacity, markCapacityStale, observeAttention, terminal, disableCapacity, restore,
    reconcile, scheduleReactionRepair, dispose,
  };
}
