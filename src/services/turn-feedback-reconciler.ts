import type { Session } from '../types.js';

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

function requesterSnapshot(session: Session, turnId: string): {
  requesterOpenId?: string;
  requesterIsBot?: boolean;
} {
  const replyTarget = session.replyTargets?.[turnId];
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

export function createTurnFeedbackReconciler(deps: TurnFeedbackDeps) {
  function admit(target: TurnFeedbackTarget, input: TurnFeedbackAdmission): void {
    deps.commit(target, fresh => {
      const records = fresh.turnFeedback ??= {};
      const existing = records[input.turnId];
      const requester = requesterSnapshot(fresh, input.turnId);
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
