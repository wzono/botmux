import { describe, expect, it, vi } from 'vitest';
import { createCapacityRolloutWatcher } from '../src/services/capacity-rollout-watcher.js';

describe('capacity rollout policy watcher', () => {
  it('retries an unchanged policy snapshot until reconciliation succeeds', async () => {
    vi.useFakeTimers();
    try {
      let attempts = 0;
      const watcher = createCapacityRolloutWatcher({
        snapshot: () => '{"phase":"off"}',
        reconcile: async () => {
          attempts += 1;
          if (attempts === 1) throw new Error('transient store lock');
        },
        warn: vi.fn(),
      });
      watcher.start(250);

      await vi.advanceTimersByTimeAsync(500);

      expect(attempts).toBe(2);
      watcher.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
