import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createCapacityWaitTracker,
  extractTraexLiveCapacityStatus,
} from '../src/services/worker-capacity-wait.js';

const queued = readFileSync(
  join(process.cwd(), 'test/fixtures/capacity-wait/traex-current.txt'),
  'utf8',
);

describe('authoritative TraeX capacity evidence', () => {
  it('extracts only a live current-footer queue and its optional position', () => {
    expect(extractTraexLiveCapacityStatus(queued)).toEqual({ state: 'waiting', position: 1590 });
    expect(extractTraexLiveCapacityStatus('◆ Queued for capacity (51s • esc to interrupt)\nContext 100% left'))
      .toEqual({ state: 'waiting' });
  });

  it.each([
    'The status line says Queued for capacity right now',
    'Queued for capacity',
    `${queued}\n${'\n'.repeat(13)}❯ Ready`,
    '◆ Working (2s • esc to interrupt)\nContext 99% left',
    '◆ Queued for capacity (10s • esc to interrupt)\nQueued for next turn\nContext 65% left',
  ])('rejects prose, scrollback, progress, and parked-next-turn evidence', screen => {
    expect(extractTraexLiveCapacityStatus(screen)).toBeNull();
  });

  it('binds observations to exact capture identity and emits only edges/position updates', () => {
    const tracker = createCapacityWaitTracker();
    const identity = { sessionId: 'session-a', turnId: 'turn-a', dispatchAttempt: 2, revision: 9 };

    expect(tracker.observe(identity, identity, queued, 100)).toEqual({
      type: 'waiting', identity, position: 1590, observedAtMs: 100,
    });
    expect(tracker.observe(identity, identity, queued, 101)).toBeNull();
    expect(tracker.observe(identity, { ...identity, revision: 10 }, queued, 102)).toBeNull();
    expect(tracker.observe(identity, identity, '◆ Working… (2s • esc to interrupt)\nContext 99% left', 103))
      .toEqual({ type: 'clear', identity, observedAtMs: 103 });
    expect(tracker.observe(identity, identity, '', 104)).toBeNull();
  });

  it('does not clear a live wait from old progress far above the current footer', () => {
    const tracker = createCapacityWaitTracker();
    const identity = { sessionId: 'session-a', turnId: 'turn-a', dispatchAttempt: 2, revision: 9 };
    expect(tracker.observe(identity, identity, queued, 100)?.type).toBe('waiting');
    const oldProgress = `◆ Working… (2s • esc to interrupt)\n${Array(14).fill('old output').join('\n')}\n❯ Ready`;

    expect(tracker.observe(identity, identity, oldProgress, 101)).toBeNull();
  });
});
