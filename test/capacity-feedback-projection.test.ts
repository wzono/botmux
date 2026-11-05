import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createCapacityFeedbackProjection } from '../src/services/capacity-feedback-projection.js';
import type { DaemonSession } from '../src/core/types.js';

function harness() {
  let now = 1_000;
  const session: any = {
    sessionId: 'session-a', status: 'active', turnFeedback: {
      turn: {
        version: 1, turnId: 'turn', phase: 'capacity_waiting', updatedAt: new Date(now).toISOString(),
        capacity: { state: 'waiting', source: 'pty', startedAtMs: now, updatedAtMs: now, position: 4 },
      },
    },
  };
  const ds = { session, larkAppId: 'app-a', currentTurnId: 'turn' } as DaemonSession;
  const patch = vi.fn();
  const reminderSync = vi.fn();
  const projection = createCapacityFeedbackProjection({
    read: (target, turnId) => target.session.turnFeedback?.[turnId]?.capacity,
    markStale: target => {
      const row = target.session.turnFeedback!.turn!;
      row.phase = 'capacity_stale';
      row.capacity = { state: 'stale', source: 'pty', startedAtMs: 1_000, updatedAtMs: 1_000 };
      return true;
    },
    patch, reminderSync, now: () => now, trailingMs: 15_000, staleMs: 60_000,
  });
  return { ds, session, patch, reminderSync, projection, setNow: (value: number) => { now = value; } };
}

describe('capacity feedback projection scheduler', () => {
  beforeEach(() => vi.useFakeTimers());

  it('patches state edges immediately and position-only updates on the 15s trailing edge', async () => {
    const h = harness();
    h.projection.sync(h.ds, 'turn');
    expect(h.patch).toHaveBeenCalledTimes(1);

    h.session.turnFeedback.turn.capacity.position = 3;
    h.setNow(2_000);
    h.projection.sync(h.ds, 'turn');
    expect(h.patch).toHaveBeenCalledTimes(1);
    h.setNow(16_000);
    await vi.advanceTimersByTimeAsync(14_000);
    expect(h.patch).toHaveBeenCalledTimes(2);

    h.session.turnFeedback.turn.phase = 'processing';
    h.session.turnFeedback.turn.capacity = { state: 'cleared', clearedAtMs: 16_001 };
    h.projection.sync(h.ds, 'turn');
    expect(h.patch).toHaveBeenCalledTimes(3);
  });

  it('marks an unchanged position stale after 60s and restores waiting timers', async () => {
    const h = harness();
    h.projection.restore([h.ds]);
    expect(h.patch).toHaveBeenCalledTimes(1);
    h.setNow(61_000);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.session.turnFeedback.turn.phase).toBe('capacity_stale');
    expect(h.patch).toHaveBeenCalledTimes(2);
    expect(h.reminderSync).toHaveBeenCalled();
  });
});
