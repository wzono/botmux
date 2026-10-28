import { describe, expect, it, vi } from 'vitest';
import {
  createCapacityAskFeedbackLifecycle,
  ownsCapacityAskFeedback,
} from '../src/services/capacity-ask-feedback.js';

const currentOrigin = {
  ownsSession: true,
  currentWorkerGeneration: 3,
  liveWorkerGeneration: 3,
  currentTurnId: 'turn-new',
  claimedTurnId: 'turn-new',
  claimedDispatchAttempt: 2,
  dispatchHighWater: { turnId: 'turn-new', dispatchAttempt: 2 },
  managedTurnOrigin: { turnId: 'turn-new', dispatchAttempt: 2 },
};

function harness(origin = currentOrigin) {
  const observe = vi.fn();
  const resume = vi.fn();
  const onTransitionError = vi.fn();
  const lifecycle = createCapacityAskFeedbackLifecycle({
    owns: () => ownsCapacityAskFeedback(origin),
    observe,
    resume,
    onTransitionError,
  });
  return { lifecycle, observe, resume, onTransitionError };
}

describe('capacity Ask feedback ownership', () => {
  it('accepts the exact current turn and attempt', () => {
    expect(ownsCapacityAskFeedback(currentOrigin)).toBe(true);
  });

  it('rejects an Ask from an older turn even when its attempt number is valid there', () => {
    expect(ownsCapacityAskFeedback({
      ...currentOrigin,
      claimedTurnId: 'turn-old',
      claimedDispatchAttempt: 1,
      managedTurnOrigin: { turnId: 'turn-old', dispatchAttempt: 1 },
    })).toBe(false);
  });

  it('rejects an older attempt of the current turn', () => {
    expect(ownsCapacityAskFeedback({
      ...currentOrigin,
      claimedDispatchAttempt: 1,
    })).toBe(false);
  });
});

describe('capacity Ask feedback lifecycle', () => {
  it('keeps a delivered permanent Ask in needs_user until acknowledgement', async () => {
    const h = harness();

    await expect(h.lifecycle.pending(async () => ({ kind: 'pending' as const })))
      .resolves.toEqual({ kind: 'pending' });

    expect(h.observe).toHaveBeenCalledTimes(1);
    expect(h.resume).not.toHaveBeenCalled();
  });

  it('resumes a settled permanent Ask when its result is acknowledged', () => {
    const h = harness();
    const answer = { kind: 'answered' as const };

    expect(h.lifecycle.acknowledge(() => answer)).toBe(answer);

    expect(h.observe).not.toHaveBeenCalled();
    expect(h.resume).toHaveBeenCalledTimes(1);
  });

  it('does not resume an acknowledged result owned by an older turn', () => {
    const h = harness({
      ...currentOrigin,
      claimedTurnId: 'turn-old',
      claimedDispatchAttempt: 1,
      managedTurnOrigin: { turnId: 'turn-old', dispatchAttempt: 1 },
    });

    expect(h.lifecycle.acknowledge(() => ({ kind: 'answered' as const })))
      .toEqual({ kind: 'answered' });

    expect(h.resume).not.toHaveBeenCalled();
  });

  it('does not resume when worker generation changes while the Ask is waiting', async () => {
    let live = { ...currentOrigin, currentWorkerGeneration: 3, liveWorkerGeneration: 3 };
    let release!: () => void;
    const resume = vi.fn();
    const lifecycle = createCapacityAskFeedbackLifecycle({
      owns: () => ownsCapacityAskFeedback(live),
      observe: vi.fn(),
      resume,
      onTransitionError: vi.fn(),
    });

    const waiting = lifecycle.settled(async () => {
      await new Promise<void>(resolve => { release = resolve; });
      return { kind: 'answered' as const };
    });
    live = { ...live, liveWorkerGeneration: 4 };
    release();
    await waiting;

    expect(resume).not.toHaveBeenCalled();
  });

  it('retains needs_user when an acknowledgement has no settled result', () => {
    const h = harness();

    expect(h.lifecycle.acknowledge(() => undefined)).toBeUndefined();

    expect(h.resume).not.toHaveBeenCalled();
  });

  it('resumes when permanent Ask delivery fails', async () => {
    const h = harness();

    await expect(h.lifecycle.pending(async () => { throw new Error('delivery failed'); }))
      .rejects.toThrow('delivery failed');

    expect(h.observe).toHaveBeenCalledTimes(1);
    expect(h.resume).toHaveBeenCalledTimes(1);
  });

  it('resumes when ordinary Ask registration fails', async () => {
    const h = harness();

    await expect(h.lifecycle.settled(async () => { throw new Error('registration failed'); }))
      .rejects.toThrow('registration failed');

    expect(h.observe).toHaveBeenCalledTimes(1);
    expect(h.resume).toHaveBeenCalledTimes(1);
  });
});
