import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createCapacityWaitReminder } from '../src/services/capacity-wait-reminder.js';
import type { PersistedTurnFeedback, Session } from '../src/types.js';

const START = 1_000;

function harness(background = false) {
  let now = START;
  const row: PersistedTurnFeedback = {
    version: 1, turnId: 'turn-a', messageId: 'om_a', requesterOpenId: 'ou_human', requesterIsBot: false,
    phase: 'capacity_waiting', updatedAt: new Date(START).toISOString(), background,
    capacity: { state: 'waiting', source: 'pty', startedAtMs: START, updatedAtMs: START, position: 4 },
  };
  const session = { sessionId: 'session-a', status: 'active', turnFeedback: { 'turn-a': row } } as Session;
  const target = { session, larkAppId: 'app-a' };
  const send = vi.fn(async () => 'om_reminder');
  const commit = vi.fn((mutate: (session: Session) => void) => mutate(session));
  const reminder = createCapacityWaitReminder({
    read: () => session, commit, send, now: () => now,
    thresholds: { interactiveMs: 120_000, backgroundMs: 600_000 },
  });
  return { target, row, session, send, commit, reminder, setNow: (value: number) => { now = value; } };
}

describe('capacity wait reminder', () => {
  beforeEach(() => vi.useFakeTimers());

  it.each([false, true])('fires once at the %s background threshold', async background => {
    const h = harness(background);
    h.reminder.sync(h.target, 'turn-a');
    const threshold = background ? 600_000 : 120_000;
    h.setNow(START + threshold);
    await vi.advanceTimersByTimeAsync(threshold);
    expect(h.send).toHaveBeenCalledTimes(1);
    expect(h.row.reminder).toMatchObject({ status: 'sent', messageId: 'om_reminder' });
    await vi.advanceTimersByTimeAsync(threshold);
    expect(h.send).toHaveBeenCalledTimes(1);
  });

  it('does not notify a bot, silent turn, or cleared episode', async () => {
    for (const mutate of [
      (row: PersistedTurnFeedback) => { row.requesterIsBot = true; },
      (row: PersistedTurnFeedback) => { row.silent = true; },
      (row: PersistedTurnFeedback) => { row.phase = 'processing'; row.capacity = undefined; },
    ]) {
      const h = harness(); mutate(h.row); h.reminder.sync(h.target, 'turn-a');
      h.setNow(START + 700_000); await vi.advanceTimersByTimeAsync(700_000);
      expect(h.send).not.toHaveBeenCalled(); h.reminder.dispose();
    }
  });

  it('persists pending intent before send and marks uncertainty without blind replay', async () => {
    const h = harness();
    h.send.mockRejectedValue(new Error('transport uncertain'));
    h.reminder.sync(h.target, 'turn-a'); h.setNow(START + 120_000);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(h.commit).toHaveBeenCalled();
    expect(h.row.reminder).toMatchObject({ status: 'ambiguous' });
    await vi.advanceTimersByTimeAsync(600_000);
    expect(h.send).toHaveBeenCalledTimes(1);
  });
});
