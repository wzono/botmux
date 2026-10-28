import { describe, expect, it } from 'vitest';
import { pruneTurnFeedback } from '../src/services/turn-feedback-retention.js';
import type { PersistedTurnFeedback } from '../src/types.js';
import type { TurnReactionPolicy } from '../src/services/turn-feedback-reaction.js';

const DAY = 86_400_000;
const NOW = Date.parse('2026-10-28T08:00:00.000Z');
const policy: TurnReactionPolicy = { completed: 'DONE', failed: 'ERROR' };

function row(turnId: string, patch: Partial<PersistedTurnFeedback> = {}): PersistedTurnFeedback {
  return {
    version: 1, turnId, phase: 'completed', updatedAt: new Date(NOW).toISOString(),
    reaction: { id: `rid_${turnId}`, type: 'DONE' },
    ...patch,
  };
}

describe('turn feedback retention', () => {
  it('retains active, invalid-time, future, and every unresolved terminal row', () => {
    const records: Record<string, PersistedTurnFeedback> = {
      active: row('active', { phase: 'processing', updatedAt: '2020-01-01T00:00:00.000Z' }),
      invalid: row('invalid', { updatedAt: 'not-a-time' }),
      future: row('future', { updatedAt: new Date(NOW + DAY).toISOString() }),
      intent: row('intent', { reactionIntent: {
        id: 'intent', messageId: 'om_a', desiredType: 'DONE',
        createdAt: new Date(NOW).toISOString(), stage: 'observe', deleteIds: [],
      } }),
      attention: row('attention', { attention: {
        state: 'needs_user', promptNonce: 'n', dispatchAttempt: 1, workerGeneration: 1, openedAtMs: NOW,
      } }),
      capacity: row('capacity', { capacity: {
        state: 'waiting', source: 'pty', startedAtMs: NOW, updatedAtMs: NOW,
      } }),
      reminder: row('reminder', { reminder: { status: 'pending' } }),
      mismatch: row('mismatch', { reaction: { id: 'old', type: 'GoGoGo' } }),
      gone: row('gone', { reaction: undefined, reactionMessageGone: true, updatedAt: new Date(NOW - 8 * DAY).toISOString() }),
    };

    const result = pruneTurnFeedback(records, NOW, policy);

    expect(Object.keys(result).sort()).toEqual([
      'active', 'attention', 'capacity', 'future', 'intent', 'invalid', 'mismatch', 'reminder',
    ]);
  });

  it('keeps the exact newest 512 settled rows younger than seven days from a 10,000-row fixture', () => {
    const records: Record<string, PersistedTurnFeedback> = {};
    for (let index = 0; index < 10_000; index += 1) {
      records[`turn_${index}`] = row(`turn_${index}`, {
        updatedAt: new Date(NOW - index).toISOString(),
      });
    }
    records.old = row('old', { updatedAt: new Date(NOW - 8 * DAY).toISOString() });
    const before = structuredClone(records);

    const result = pruneTurnFeedback(records, NOW, policy);

    expect(Object.keys(result)).toHaveLength(512);
    expect(result.turn_0).toBeDefined();
    expect(result.turn_511).toBeDefined();
    expect(result.turn_512).toBeUndefined();
    expect(result.old).toBeUndefined();
    expect(records).toEqual(before);
  });

  it('uses a separate seven-day newest-128 bucket for permanent and exhausted diagnostics', () => {
    const records: Record<string, PersistedTurnFeedback> = {};
    for (let index = 0; index < 140; index += 1) {
      records[`diagnostic_${index}`] = row(`diagnostic_${index}`, {
        phase: 'failed', reaction: undefined, updatedAt: new Date(NOW - index).toISOString(),
        reactionIntent: {
          id: `intent_${index}`, messageId: `om_${index}`, desiredType: 'ERROR',
          createdAt: new Date(NOW - index).toISOString(),
          stage: index % 2 === 0 ? 'permanent' : 'blocked', deleteIds: [],
          ...(index % 2 === 0
            ? { diagnostic: 'invalid_response' as const }
            : { diagnostic: 'permission_denied' as const, retryExhausted: true as const }),
        },
      });
    }
    records.unresolved = row('unresolved', {
      phase: 'failed', reaction: undefined, reactionIntent: {
        id: 'unresolved', messageId: 'om_unresolved', desiredType: 'ERROR',
        createdAt: new Date(NOW).toISOString(), stage: 'blocked', deleteIds: [],
        diagnostic: 'permission_denied',
      },
    });

    const result = pruneTurnFeedback(records, NOW, policy);

    expect(Object.keys(result).filter(key => key.startsWith('diagnostic_'))).toHaveLength(128);
    expect(result.diagnostic_0).toBeDefined();
    expect(result.diagnostic_127).toBeDefined();
    expect(result.diagnostic_128).toBeUndefined();
    expect(result.unresolved).toBeDefined();
  });
});
