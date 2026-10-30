import { describe, expect, it } from 'vitest';
import {
  desiredReaction,
  planReactionStep,
  reduceReactionReceipt,
  type TurnReactionPolicy,
} from '../src/services/turn-feedback-reaction.js';
import type { PersistedTurnFeedback } from '../src/types.js';

const policy: TurnReactionPolicy = {
  processing: 'GoGoGo',
  capacityWaiting: 'Coffee',
  capacityStale: 'Coffee',
  needsUser: 'THINKING',
  completed: 'DONE',
  failed: 'ERROR',
};

function row(patch: Partial<PersistedTurnFeedback> = {}): PersistedTurnFeedback {
  return {
    version: 1, turnId: 'turn-a', messageId: 'om_a', phase: 'processing',
    updatedAt: '2026-10-28T08:00:00.000Z',
    ...patch,
  };
}

describe('pure turn reaction convergence', () => {
  it('maps feedback phase through policy and respects silent turns', () => {
    expect(desiredReaction(row({ phase: 'capacity_waiting' }), policy)).toBe('Coffee');
    expect(desiredReaction(row({ phase: 'processing', receivedReactionEmoji: 'Get' }), policy)).toBe('Get');
    expect(desiredReaction(row({ reactionSilent: true }), policy)).toBeUndefined();
  });

  it('persists an immutable observe intent before any provider action', () => {
    expect(planReactionStep({ record: row(), policy, newIntentId: 'intent-a', nowIso: '2026-10-28T08:01:00.000Z' }))
      .toEqual({ action: 'persist_intent', intent: {
        id: 'intent-a', messageId: 'om_a', desiredType: 'GoGoGo',
        createdAt: '2026-10-28T08:01:00.000Z', stage: 'observe', deleteIds: [],
      } });
  });

  it('always begins a persisted intent with LIST in a fresh process', () => {
    const record = row({ reactionIntent: {
      id: 'intent-a', messageId: 'om_a', desiredType: 'DONE',
      createdAt: '2026-10-28T08:01:00.000Z', stage: 'create', deleteIds: [],
    } });

    expect(planReactionStep({ record, policy, freshProcess: true }))
      .toEqual({ action: 'list', intentId: 'intent-a', messageId: 'om_a' });
  });

  it('adopts one desired reaction and journals cleanup across emoji types', () => {
    const record = row({ phase: 'completed', reactionIntent: {
      id: 'intent-a', messageId: 'om_a', desiredType: 'DONE',
      createdAt: '2026-10-28T08:01:00.000Z', stage: 'observe', deleteIds: [],
    } });

    expect(reduceReactionReceipt({
      record, policy, intentId: 'intent-a', action: 'list',
      receipt: { kind: 'listed', reactions: [
        { id: 'z-done', type: 'DONE' },
        { id: 'a-done', type: 'DONE' },
        { id: 'coffee', type: 'Coffee' },
      ] },
    })).toEqual({
      reaction: { id: 'a-done', type: 'DONE' },
      intent: expect.objectContaining({
        id: 'intent-a', stage: 'cleanup', adopted: { id: 'a-done', type: 'DONE' },
        deleteIds: ['coffee', 'z-done'],
      }),
    });
  });

  it('deletes every old own reaction before creating a missing desired type', () => {
    const observed = row({ reactionIntent: {
      id: 'intent-a', messageId: 'om_a', desiredType: 'GoGoGo',
      createdAt: '2026-10-28T08:01:00.000Z', stage: 'observe', deleteIds: [],
    } });
    const reduced = reduceReactionReceipt({
      record: observed, policy, intentId: 'intent-a', action: 'list',
      receipt: { kind: 'listed', reactions: [
        { id: 'coffee', type: 'Coffee' }, { id: 'done', type: 'DONE' },
      ] },
    });
    const record = row({ reactionIntent: reduced.intent, reaction: reduced.reaction });

    expect(reduced.intent).toMatchObject({ stage: 'delete', deleteIds: ['coffee', 'done'] });
    expect(planReactionStep({ record, policy })).toEqual({
      action: 'delete', intentId: 'intent-a', messageId: 'om_a', reactionId: 'coffee',
    });
  });

  it('moves to CREATE after the final old reaction is deleted', () => {
    const record = row({ reactionIntent: {
      id: 'intent-a', messageId: 'om_a', desiredType: 'GoGoGo',
      createdAt: '2026-10-28T08:01:00.000Z', stage: 'delete', deleteIds: ['old'],
    } });

    const reduced = reduceReactionReceipt({
      record, policy, intentId: 'intent-a', action: 'delete', receipt: { kind: 'deleted' },
    });

    expect(reduced.intent).toMatchObject({ stage: 'create', deleteIds: [] });
    expect(planReactionStep({ record: row({ reactionIntent: reduced.intent }), policy }))
      .toEqual({ action: 'create', intentId: 'intent-a', messageId: 'om_a', type: 'GoGoGo' });
  });

  it('accounts for an old uncertain intent before converging to the new phase', () => {
    const record = row({ phase: 'completed', reactionIntent: {
      id: 'intent-old', messageId: 'om_a', desiredType: 'GoGoGo',
      createdAt: '2026-10-28T08:01:00.000Z', stage: 'observe', deleteIds: [],
    } });

    const reduced = reduceReactionReceipt({
      record, policy, intentId: 'intent-old', action: 'list',
      receipt: { kind: 'listed', reactions: [{ id: 'old-ack', type: 'GoGoGo' }] },
    });

    expect(reduced.intent).toMatchObject({
      id: 'intent-old', desiredType: 'DONE', stage: 'delete', deleteIds: ['old-ack'],
    });
    expect(reduced.reaction).toBeUndefined();
  });

  it('does not mutate after uncertain LIST and persists blocked/permanent diagnostics', () => {
    const record = row({ reactionIntent: {
      id: 'intent-a', messageId: 'om_a', desiredType: 'GoGoGo',
      createdAt: '2026-10-28T08:01:00.000Z', stage: 'observe', deleteIds: [],
    } });

    expect(reduceReactionReceipt({
      record, policy, intentId: 'intent-a', action: 'list',
      receipt: { kind: 'retryable', reason: 'transport_uncertain' },
    }).intent).toMatchObject({ stage: 'observe', retryClass: 'transient' });
    expect(reduceReactionReceipt({
      record, policy, intentId: 'intent-a', action: 'list',
      receipt: { kind: 'blocked', reason: 'permission_denied' },
    }).intent).toMatchObject({ stage: 'blocked', retryClass: 'blocked', diagnostic: 'permission_denied' });
    expect(reduceReactionReceipt({
      record, policy, intentId: 'intent-a', action: 'list',
      receipt: { kind: 'permanent', reason: 'invalid_response' },
    }).intent).toMatchObject({ stage: 'permanent', diagnostic: 'invalid_response' });
  });

  it('ignores stale receipts and settles message-gone without recreation', () => {
    const record = row({ reactionIntent: {
      id: 'intent-new', messageId: 'om_a', desiredType: 'GoGoGo',
      createdAt: '2026-10-28T08:01:00.000Z', stage: 'observe', deleteIds: [],
    } });
    expect(reduceReactionReceipt({
      record, policy, intentId: 'intent-old', action: 'list',
      receipt: { kind: 'listed', reactions: [] },
    })).toEqual({});
    expect(reduceReactionReceipt({
      record, policy, intentId: 'intent-new', action: 'list', receipt: { kind: 'message_gone' },
    })).toEqual({ intent: undefined, reaction: undefined, messageGone: true });
  });

  it('settles non-Lark message IDs without provider work', () => {
    expect(planReactionStep({ record: row({ messageId: 'comment_123' }), policy }))
      .toEqual({ action: 'settled' });
  });
});
