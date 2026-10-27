import { describe, expect, it } from 'vitest';
import {
  reduceCapacityWaitPhase,
  type CapacityWaitEvidence,
  type CapacityWaitPhase,
} from '../src/services/capacity-wait-evidence.js';

function waiting(observedAtMs: number, position?: number): CapacityWaitEvidence {
  return {
    kind: 'waiting',
    observedAtMs,
    source: 'pty',
    ...(position === undefined ? {} : { position }),
  };
}

describe('reduceCapacityWaitPhase', () => {
  it('keeps the first start time while newer observations update position', () => {
    const first = reduceCapacityWaitPhase(undefined, {
      type: 'waiting',
      evidence: waiting(1_000, 282),
    });

    expect(first).toEqual({
      state: 'waiting',
      position: 282,
      startedAtMs: 1_000,
      updatedAtMs: 1_000,
      source: 'pty',
    });
    expect(reduceCapacityWaitPhase(first, {
      type: 'waiting',
      evidence: { ...waiting(2_000, 260), source: 'structured-event' },
    })).toEqual({
      state: 'waiting',
      position: 260,
      startedAtMs: 1_000,
      updatedAtMs: 2_000,
      source: 'structured-event',
    });
  });

  it('marks only the exact observation stale at 60 seconds and hides position', () => {
    const current = reduceCapacityWaitPhase(undefined, {
      type: 'waiting',
      evidence: waiting(2_000, 41),
    });

    expect(reduceCapacityWaitPhase(current, {
      type: 'stale',
      observedAtMs: 2_000,
      nowMs: 61_999,
    })).toBe(current);
    expect(reduceCapacityWaitPhase(current, {
      type: 'stale',
      observedAtMs: 1_000,
      nowMs: 62_000,
    })).toBe(current);
    expect(reduceCapacityWaitPhase(current, {
      type: 'stale',
      observedAtMs: 2_000,
      nowMs: 62_000,
    })).toEqual({
      state: 'stale',
      startedAtMs: 2_000,
      updatedAtMs: 2_000,
      source: 'pty',
    });
  });

  it('ignores exact and older delayed replays', () => {
    const current = reduceCapacityWaitPhase(undefined, {
      type: 'waiting',
      evidence: waiting(2_000, 41),
    });
    const stale = reduceCapacityWaitPhase(current, {
      type: 'stale',
      observedAtMs: 2_000,
      nowMs: 62_000,
    });

    expect(reduceCapacityWaitPhase(current, {
      type: 'waiting',
      evidence: waiting(2_000, 99),
    })).toBe(current);
    expect(reduceCapacityWaitPhase(stale, {
      type: 'waiting',
      evidence: waiting(2_000, 99),
    })).toBe(stale);
    expect(reduceCapacityWaitPhase(stale, {
      type: 'waiting',
      evidence: waiting(62_001, 20),
    })).toEqual({
      state: 'waiting',
      position: 20,
      startedAtMs: 2_000,
      updatedAtMs: 62_001,
      source: 'pty',
    });
  });

  it('makes clear monotonic while allowing a later wait to start a new episode', () => {
    const current = reduceCapacityWaitPhase(undefined, {
      type: 'waiting',
      evidence: waiting(2_000, 41),
    });
    const cleared = reduceCapacityWaitPhase(current, { type: 'cleared', observedAtMs: 3_000 });

    expect(cleared).toEqual({ state: 'cleared', clearedAtMs: 3_000 });
    expect(reduceCapacityWaitPhase(cleared, {
      type: 'waiting',
      evidence: waiting(3_000, 40),
    })).toBe(cleared);
    expect(reduceCapacityWaitPhase(cleared, { type: 'cleared', observedAtMs: 2_500 })).toBe(cleared);
    expect(reduceCapacityWaitPhase(cleared, {
      type: 'waiting',
      evidence: waiting(4_000, 39),
    })).toMatchObject({ state: 'waiting', startedAtMs: 4_000, position: 39 });
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    'omits invalid or unsafe position %s from normalized state',
    position => {
      expect(reduceCapacityWaitPhase(undefined, {
        type: 'waiting',
        evidence: waiting(1_000, position),
      })).toEqual({
        state: 'waiting',
        startedAtMs: 1_000,
        updatedAtMs: 1_000,
        source: 'pty',
      });
    },
  );

  it('does not mutate evidence or prior phase', () => {
    const evidence = waiting(1_000, 41);
    const evidenceSnapshot = structuredClone(evidence);
    const prior: CapacityWaitPhase = {
      state: 'waiting',
      position: 41,
      startedAtMs: 500,
      updatedAtMs: 500,
      source: 'pty',
    };
    const priorSnapshot = structuredClone(prior);

    const next = reduceCapacityWaitPhase(prior, { type: 'waiting', evidence });

    expect(next).not.toBe(prior);
    expect(evidence).toEqual(evidenceSnapshot);
    expect(prior).toEqual(priorSnapshot);
  });
});
