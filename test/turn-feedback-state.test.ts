import { describe, expect, it } from 'vitest';
import {
  reactionForPhase,
  reduceTurnFeedback,
  type TurnFeedbackEvent,
  type TurnFeedbackState,
} from '../src/services/turn-feedback-state.js';

function processing(): TurnFeedbackState {
  return { phase: 'processing', updatedAtMs: 1_000 };
}

function waiting(observedAtMs = 2_000, position?: number): TurnFeedbackEvent {
  return {
    type: 'waiting',
    evidence: {
      kind: 'waiting',
      observedAtMs,
      source: 'pty',
      ...(position === undefined ? {} : { position }),
    },
  };
}

describe('reduceTurnFeedback', () => {
  it.each(['completed', 'failed'] as const)('%s absorbs every later event', terminal => {
    const settled = reduceTurnFeedback(
      reduceTurnFeedback(processing(), waiting(2_000, 41)),
      { type: terminal, observedAtMs: 3_000 },
    );
    const laterEvents: TurnFeedbackEvent[] = [
      waiting(4_000, 20),
      { type: 'stale', observedAtMs: 2_000, nowMs: 62_000 },
      { type: 'cleared', observedAtMs: 4_000 },
      { type: 'needs_user', observedAtMs: 4_000 },
      { type: 'user_resumed', observedAtMs: 4_000 },
      { type: 'progress', observedAtMs: 4_000 },
      { type: 'resume', observedAtMs: 4_000 },
      { type: 'completed', observedAtMs: 4_000 },
      { type: 'failed', observedAtMs: 4_000 },
    ];

    expect(settled).toEqual({ phase: terminal, updatedAtMs: 3_000 });
    for (const event of laterEvents) {
      expect(reduceTurnFeedback(settled, event)).toBe(settled);
    }
  });

  it('keeps needs_user above capacity updates', () => {
    const waitingState = reduceTurnFeedback(processing(), waiting(2_000, 41));
    const asking = reduceTurnFeedback(waitingState, { type: 'needs_user', observedAtMs: 3_000 });
    const capacityUpdated = reduceTurnFeedback(asking, waiting(4_000, 30));
    const capacityStale = reduceTurnFeedback(capacityUpdated, {
      type: 'stale',
      observedAtMs: 4_000,
      nowMs: 64_000,
    });

    expect(asking.phase).toBe('needs_user');
    expect(capacityUpdated).toMatchObject({
      phase: 'needs_user',
      capacity: { state: 'waiting', position: 30, startedAtMs: 2_000 },
    });
    expect(capacityStale).toMatchObject({
      phase: 'needs_user',
      capacity: { state: 'stale', startedAtMs: 2_000 },
    });
  });

  it('user_resumed removes question priority and reveals retained capacity', () => {
    const waitingState = reduceTurnFeedback(processing(), waiting(2_000, 41));
    const asking = reduceTurnFeedback(waitingState, { type: 'needs_user', observedAtMs: 3_000 });
    const resumed = reduceTurnFeedback(asking, { type: 'user_resumed', observedAtMs: 4_000 });

    expect(resumed.phase).toBe('capacity_waiting');
    expect(resumed.capacity).toBe(asking.capacity);
    expect(reduceTurnFeedback(
      { phase: 'needs_user', updatedAtMs: 3_000 },
      { type: 'user_resumed', observedAtMs: 4_000 },
    )).toEqual({ phase: 'processing', updatedAtMs: 4_000 });
  });

  it.each(['progress', 'resume'] as const)('%s clears capacity and question priority', type => {
    const asking = reduceTurnFeedback(
      reduceTurnFeedback(processing(), waiting(2_000, 41)),
      { type: 'needs_user', observedAtMs: 3_000 },
    );
    const resumed = reduceTurnFeedback(asking, { type, observedAtMs: 4_000 });

    expect(resumed).toEqual({
      phase: 'processing',
      updatedAtMs: 4_000,
      capacity: { state: 'cleared', clearedAtMs: 4_000 },
    });
    expect(reduceTurnFeedback(resumed, waiting(3_500, 40))).toBe(resumed);
  });

  it('does not let delayed events reverse stale', () => {
    const waitingState = reduceTurnFeedback(processing(), waiting(2_000, 41));
    const stale = reduceTurnFeedback(waitingState, {
      type: 'stale',
      observedAtMs: 2_000,
      nowMs: 62_000,
    });

    expect(stale).toMatchObject({
      phase: 'capacity_stale',
      updatedAtMs: 62_000,
      capacity: { state: 'stale' },
    });
    expect(reduceTurnFeedback(stale, waiting(3_000, 30))).toBe(stale);
    expect(reduceTurnFeedback(stale, { type: 'cleared', observedAtMs: 3_000 })).toBe(stale);
    expect(reduceTurnFeedback(stale, waiting(63_000, 20))).toMatchObject({
      phase: 'capacity_waiting',
      capacity: { state: 'waiting', position: 20, startedAtMs: 2_000 },
    });
  });

  it('does not mutate the prior state', () => {
    const prior = reduceTurnFeedback(processing(), waiting(2_000, 41));
    const snapshot = structuredClone(prior);

    const next = reduceTurnFeedback(prior, waiting(3_000, 40));

    expect(next).not.toBe(prior);
    expect(next.capacity).not.toBe(prior.capacity);
    expect(prior).toEqual(snapshot);
  });
});

describe('reactionForPhase', () => {
  it.each([
    ['processing', 'GoGoGo'],
    ['capacity_waiting', 'Coffee'],
    ['capacity_stale', 'Coffee'],
    ['needs_user', 'THINKING'],
    ['completed', 'DONE'],
    ['failed', 'ERROR'],
  ] as const)('maps %s to %s', (phase, reaction) => {
    expect(reactionForPhase(phase)).toBe(reaction);
  });
});
