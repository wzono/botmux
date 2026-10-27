import { describe, expect, it } from 'vitest';
import { pruneTurnFeedback } from '../src/services/turn-feedback-reconciler.js';
import type { PersistedTurnFeedback } from '../src/types.js';

const DAY = 86_400_000;
const NOW = Date.parse('2026-10-27T08:00:00.000Z');

function row(
  turnId: string,
  patch: Partial<PersistedTurnFeedback> = {},
): PersistedTurnFeedback {
  return {
    version: 1,
    turnId,
    phase: 'completed',
    updatedAt: new Date(NOW).toISOString(),
    reaction: { id: `rid_${turnId}`, type: 'DONE' },
    ...patch,
  };
}

const options = {
  desiredReaction: (record: PersistedTurnFeedback) =>
    record.phase === 'completed' ? 'DONE' : record.phase === 'failed' ? 'ERROR' : undefined,
};

describe('turn feedback retention', () => {
  it('retains active, invalid-time, and every terminal row with an unresolved obligation', () => {
    const records: Record<string, PersistedTurnFeedback> = {
      active: row('active', { phase: 'processing', updatedAt: '2020-01-01T00:00:00.000Z' }),
      invalid: row('invalid', { updatedAt: 'not-a-time' }),
      pending: row('pending', { reactionReconcilePending: true }),
      operation: row('operation', { reactionOperation: {
        opId: 'op', messageId: 'om_a', desiredType: 'DONE',
        createdAt: new Date(NOW).toISOString(), phase: 'add_pending',
      } }),
      attention: row('attention', { attention: {
        state: 'needs_user', promptNonce: 'n', dispatchAttempt: 1, workerGeneration: 1, openedAtMs: NOW,
      } }),
      capacity: row('capacity', { capacity: {
        state: 'waiting', source: 'pty', startedAtMs: NOW, updatedAtMs: NOW,
      } }),
      transition: row('transition', { capacityClearedAt: new Date(NOW).toISOString() }),
      sideband: row('sideband', { capacitySidebandCursor: {
        adapter: 'codex', signerKeyId: 'key', signerEpoch: 1, requestId: 'request',
        sequence: 1, observedAtMs: NOW,
      } }),
      binding: row('binding', { capacityBinding: {
        adapter: 'codex', nativeTurnId: 'native', dispatchAttempt: 1, workerGeneration: 1,
      } }),
      reminder: row('reminder', { reminder: { status: 'pending' } }),
      mismatch: row('mismatch', { reaction: { id: 'rid_mismatch', type: 'GoGoGo' } }),
      gone: row('gone', { reaction: undefined, reactionMessageGone: true, updatedAt: '2020-01-01T00:00:00.000Z' }),
    };

    const result = pruneTurnFeedback(records, NOW + 8 * DAY, options);

    expect(Object.keys(result).sort()).toEqual([
      'active', 'attention', 'binding', 'capacity', 'invalid', 'mismatch',
      'operation', 'pending', 'reminder', 'sideband', 'transition',
    ]);
    expect(records.gone).toBeDefined();
  });

  it('keeps only the newest 512 settled terminal rows within seven days without mutating input', () => {
    const records: Record<string, PersistedTurnFeedback> = {};
    for (let index = 0; index < 10_000; index++) {
      records[`turn_${index}`] = row(`turn_${index}`, {
        updatedAt: new Date(NOW - index).toISOString(),
      });
    }
    records.old = row('old', { updatedAt: new Date(NOW - 8 * DAY).toISOString() });
    const before = structuredClone(records);

    const result = pruneTurnFeedback(records, NOW, options);

    expect(Object.keys(result)).toHaveLength(512);
    expect(result.turn_0).toBeDefined();
    expect(result.turn_511).toBeDefined();
    expect(result.turn_512).toBeUndefined();
    expect(result.old).toBeUndefined();
    expect(records).toEqual(before);
  });

  it('uses a separate 128-row quarantine only for durable permanent or exhausted diagnostics', () => {
    const records: Record<string, PersistedTurnFeedback> = {};
    for (let index = 0; index < 140; index++) {
      records[`failed_${index}`] = row(`failed_${index}`, {
        phase: 'failed',
        reaction: undefined,
        reactionReconcilePending: true,
        updatedAt: new Date(NOW - index).toISOString(),
        reactionOperation: {
          opId: `op_${index}`, messageId: `om_${index}`, desiredType: 'ERROR',
          createdAt: new Date(NOW - index).toISOString(),
          phase: index % 2 === 0 ? 'failed' : 'blocked',
          ...(index % 2 === 0
            ? { failureReason: 'invalid-emoji' as const }
            : { failureReason: 'permission-denied' as const, retryExhausted: true as const }),
        },
      });
    }
    records.uncertain = row('uncertain', {
      phase: 'failed', reaction: undefined, reactionReconcilePending: true,
      reactionOperation: {
        opId: 'uncertain', messageId: 'om_uncertain', desiredType: 'ERROR',
        createdAt: new Date(NOW).toISOString(), phase: 'add_pending',
      },
    });
    records.blocked = row('blocked', {
      phase: 'failed', reaction: undefined, reactionReconcilePending: true,
      reactionOperation: {
        opId: 'blocked', messageId: 'om_blocked', desiredType: 'ERROR',
        createdAt: new Date(NOW).toISOString(), phase: 'blocked', failureReason: 'permission-denied',
      },
    });

    const result = pruneTurnFeedback(records, NOW, options);

    expect(Object.keys(result).filter(key => key.startsWith('failed_'))).toHaveLength(128);
    expect(result.failed_0).toBeDefined();
    expect(result.failed_127).toBeDefined();
    expect(result.failed_128).toBeUndefined();
    expect(result.uncertain).toBeDefined();
    expect(result.blocked).toBeDefined();
  });
});
