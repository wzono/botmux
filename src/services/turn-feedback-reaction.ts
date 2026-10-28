import type { PersistedTurnFeedback } from '../types.js';
import type {
  OwnReaction,
  ReactionCreateReceipt,
  ReactionDeleteReceipt,
  ReactionListReceipt,
} from '../im/lark/reaction-provider.js';
import { reactionForPhase } from './turn-feedback-state.js';

export type PersistedReactionIntent = NonNullable<PersistedTurnFeedback['reactionIntent']>;

export interface TurnReactionPolicy {
  silent?: boolean;
  processing?: string;
  capacityWaiting?: string;
  capacityStale?: string;
  needsUser?: string;
  completed?: string;
  failed?: string;
}

export function desiredReaction(
  record: PersistedTurnFeedback,
  policy: TurnReactionPolicy,
): string | undefined {
  if (policy.silent || record.silent || record.reactionMessageGone) return undefined;
  if (record.phase === 'processing' && record.receivedReactionEmoji) {
    return record.receivedReactionEmoji;
  }
  return ({
    processing: policy.processing,
    capacity_waiting: policy.capacityWaiting,
    capacity_stale: policy.capacityStale,
    needs_user: policy.needsUser,
    completed: policy.completed,
    failed: policy.failed,
  }[record.phase]) ?? reactionForPhase(record.phase);
}

export type ReactionPlan =
  | { action: 'settled' }
  | { action: 'persist_intent'; intent: PersistedReactionIntent }
  | { action: 'list'; intentId: string; messageId: string }
  | { action: 'delete'; intentId: string; messageId: string; reactionId: string }
  | { action: 'create'; intentId: string; messageId: string; type: string };

export interface ReactionPlanInput {
  record: PersistedTurnFeedback;
  policy: TurnReactionPolicy;
  newIntentId?: string;
  nowIso?: string;
  freshProcess?: boolean;
}

export function planReactionStep(input: ReactionPlanInput): ReactionPlan {
  const { record, policy } = input;
  if (!record.messageId?.startsWith('om_') || record.reactionMessageGone) {
    return { action: 'settled' };
  }
  const wanted = desiredReaction(record, policy);
  const intent = record.reactionIntent;
  if (!intent) {
    if (record.reaction?.type === wanted || (!record.reaction && wanted === undefined)) {
      return { action: 'settled' };
    }
    if (!input.newIntentId || !input.nowIso) return { action: 'settled' };
    return {
      action: 'persist_intent',
      intent: {
        id: input.newIntentId, messageId: record.messageId,
        ...(wanted ? { desiredType: wanted } : {}),
        createdAt: input.nowIso, stage: 'observe', deleteIds: [],
      },
    };
  }
  if (input.freshProcess) {
    return { action: 'list', intentId: intent.id, messageId: intent.messageId };
  }
  if (intent.stage === 'observe' || intent.stage === 'blocked' || intent.stage === 'permanent') {
    return { action: 'list', intentId: intent.id, messageId: intent.messageId };
  }
  if (intent.stage === 'delete' || intent.stage === 'cleanup') {
    const reactionId = intent.deleteIds[0];
    if (reactionId) {
      return { action: 'delete', intentId: intent.id, messageId: intent.messageId, reactionId };
    }
    if (intent.adopted) return { action: 'settled' };
    if (intent.desiredType) {
      return { action: 'create', intentId: intent.id, messageId: intent.messageId, type: intent.desiredType };
    }
    return { action: 'settled' };
  }
  if (intent.stage === 'create' && intent.desiredType) {
    return { action: 'create', intentId: intent.id, messageId: intent.messageId, type: intent.desiredType };
  }
  return { action: 'settled' };
}

type ProviderReceipt = ReactionListReceipt | ReactionCreateReceipt | ReactionDeleteReceipt;

export interface ReactionReceiptInput {
  record: PersistedTurnFeedback;
  policy: TurnReactionPolicy;
  intentId: string;
  action: 'list' | 'create' | 'delete';
  receipt: ProviderReceipt;
}

export interface ReactionPlanResult {
  intent?: PersistedReactionIntent;
  reaction?: OwnReaction;
  messageGone?: true;
}

function failureResult(
  intent: PersistedReactionIntent,
  receipt: Exclude<ProviderReceipt, { kind: 'listed' | 'created' | 'deleted' | 'already_absent' | 'message_gone' }>,
): ReactionPlanResult {
  if (receipt.kind === 'retryable') {
    return { intent: { ...intent, retryClass: 'transient' } };
  }
  if (receipt.kind === 'blocked') {
    return { intent: {
      ...intent, stage: 'blocked', retryClass: 'blocked', diagnostic: receipt.reason,
    } };
  }
  return { intent: { ...intent, stage: 'permanent', diagnostic: receipt.reason } };
}

export function reduceReactionReceipt(input: ReactionReceiptInput): ReactionPlanResult {
  const intent = input.record.reactionIntent;
  if (!intent || intent.id !== input.intentId) return {};
  const receipt = input.receipt;
  if (receipt.kind === 'message_gone') {
    return { intent: undefined, reaction: undefined, messageGone: true };
  }
  if (receipt.kind === 'retryable' || receipt.kind === 'blocked' || receipt.kind === 'permanent') {
    return failureResult(intent, receipt);
  }
  if (input.action === 'list' && receipt.kind === 'listed') {
    const currentWanted = desiredReaction(input.record, input.policy);
    if (currentWanted !== intent.desiredType) {
      return {
        reaction: undefined,
        intent: {
          ...intent,
          ...(currentWanted ? { desiredType: currentWanted } : { desiredType: undefined }),
          stage: receipt.reactions.length > 0 ? 'delete' : currentWanted ? 'create' : 'observe',
          adopted: undefined,
          deleteIds: receipt.reactions.map(reaction => reaction.id).sort(),
          retryClass: undefined,
          diagnostic: undefined,
        },
      };
    }
    const wanted = intent.desiredType;
    const matches = receipt.reactions
      .filter(reaction => reaction.type === wanted)
      .sort((left, right) => left.id.localeCompare(right.id));
    const adopted = matches[0];
    const deleteIds = receipt.reactions
      .filter(reaction => reaction.id !== adopted?.id)
      .map(reaction => reaction.id)
      .sort();
    if (adopted) {
      return {
        reaction: adopted,
        intent: deleteIds.length > 0
          ? { ...intent, stage: 'cleanup', adopted, deleteIds, retryClass: undefined, diagnostic: undefined }
          : undefined,
      };
    }
    if (deleteIds.length > 0) {
      return { intent: {
        ...intent, stage: 'delete', deleteIds, retryClass: undefined, diagnostic: undefined, adopted: undefined,
      } };
    }
    return wanted
      ? { intent: { ...intent, stage: 'create', deleteIds: [], retryClass: undefined, diagnostic: undefined } }
      : { intent: undefined, reaction: undefined };
  }
  if (input.action === 'create' && receipt.kind === 'created') {
    return { reaction: receipt.reaction, intent: undefined };
  }
  if (input.action === 'delete' && (receipt.kind === 'deleted' || receipt.kind === 'already_absent')) {
    const deleteIds = intent.deleteIds.slice(1);
    return {
      reaction: input.record.reaction?.id === intent.deleteIds[0] ? undefined : input.record.reaction,
      intent: {
        ...intent,
        stage: deleteIds.length > 0
          ? intent.adopted ? 'cleanup' : 'delete'
          : intent.adopted ? 'cleanup' : intent.desiredType ? 'create' : 'observe',
        deleteIds,
      },
    };
  }
  return {};
}
