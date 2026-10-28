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
  const patch = vi.fn(async () => {});
  const commit = vi.fn((_target: unknown, mutate: (session: Session) => void) => mutate(session));
  const reminder = createCapacityWaitReminder({
    read: () => session, commit, send, patch, now: () => now,
    thresholds: () => ({ interactiveMs: 120_000, backgroundMs: 600_000 }),
  });
  return { target, row, session, send, patch, commit, reminder, setNow: (value: number) => { now = value; } };
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
      (row: PersistedTurnFeedback) => { row.reminderSilent = true; },
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

  it('persists one stale-episode intent before sending and does not replay it', async () => {
    const h = harness();
    h.row.phase = 'capacity_stale';
    h.row.capacity = { state: 'stale', startedAtMs: START, lastObservedAtMs: START, staleAtMs: START + 60_000 };
    h.reminder.sync(h.target, 'turn-a'); h.setNow(START + 120_000);

    await vi.advanceTimersByTimeAsync(120_000);
    h.reminder.sync(h.target, 'turn-a');
    await vi.advanceTimersByTimeAsync(120_000);

    expect(h.send).toHaveBeenCalledTimes(1);
    expect(h.row.reminder).toMatchObject({ status: 'sent', messageId: 'om_reminder' });
  });

  it('resumes a persisted pending reminder intent after restart', async () => {
    const h = harness();
    h.row.phase = 'capacity_stale';
    h.row.capacity = { state: 'stale', startedAtMs: START, lastObservedAtMs: START, staleAtMs: START + 60_000 };
    h.row.reminder = {
      episodeKey: String(START), uuid: 'capacity-persisted', status: 'pending',
      attemptedAt: new Date(START).toISOString(),
    };
    h.reminder.sync(h.target, 'turn-a'); h.setNow(START + 120_000);

    await vi.advanceTimersByTimeAsync(120_000);

    expect(h.send).toHaveBeenCalledTimes(1);
    expect(h.row.reminder).toMatchObject({ status: 'sent', messageId: 'om_reminder' });
  });

  it('keeps one provider send in flight for an episode', async () => {
    const h = harness();
    let release!: () => void;
    let entered!: () => void;
    const sendEntered = new Promise<void>(resolve => { entered = resolve; });
    h.send.mockImplementation(async () => {
      entered();
      await new Promise<void>(resolve => { release = resolve; });
      return 'om_reminder';
    });
    h.reminder.sync(h.target, 'turn-a'); h.setNow(START + 120_000);
    await vi.advanceTimersByTimeAsync(120_000);
    await sendEntered;

    h.reminder.sync(h.target, 'turn-a');
    await vi.advanceTimersByTimeAsync(120_000);

    expect(h.send).toHaveBeenCalledTimes(1);
    release();
    await vi.runAllTimersAsync();
  });

  it('allows a newer episode to proceed while an older episode receipt is in flight', async () => {
    const h = harness();
    let release!: () => void;
    let entered!: () => void;
    const firstEntered = new Promise<void>(resolve => { entered = resolve; });
    h.send.mockImplementationOnce(async () => {
      entered();
      await new Promise<void>(resolve => { release = resolve; });
      return 'om_old';
    }).mockResolvedValueOnce('om_new');
    h.reminder.sync(h.target, 'turn-a'); h.setNow(START + 120_000);
    await vi.advanceTimersByTimeAsync(120_000);
    await firstEntered;
    h.row.capacity = { state: 'waiting', source: 'pty', startedAtMs: START + 1, updatedAtMs: START + 1 };
    h.setNow(START + 120_001);

    h.reminder.sync(h.target, 'turn-a');
    release();
    await vi.runAllTimersAsync();

    expect(h.send).toHaveBeenCalledTimes(2);
    expect(h.row.reminder).toMatchObject({ episodeKey: String(START + 1), messageId: 'om_new' });
  });

  it('closes a late work card after the turn becomes terminal during send', async () => {
    const h = harness();
    let release!: () => void;
    let entered!: () => void;
    const sendEntered = new Promise<void>(resolve => { entered = resolve; });
    h.send.mockImplementation(async () => {
      entered();
      await new Promise<void>(resolve => { release = resolve; });
      return 'om_late_work_card';
    });
    h.reminder.sync(h.target, 'turn-a');
    h.setNow(START + 120_000);
    await vi.advanceTimersByTimeAsync(120_000);
    await sendEntered;

    h.row.phase = 'completed';
    delete h.row.capacity;
    h.reminder.sync(h.target, 'turn-a');
    release();
    await vi.runAllTimersAsync();

    expect(h.send).toHaveBeenCalledTimes(1);
    expect(h.patch).toHaveBeenCalledTimes(1);
    expect(h.patch).toHaveBeenCalledWith(h.target, h.row, 'om_late_work_card');
    expect(h.row.reminder).toMatchObject({ messageId: 'om_late_work_card', closed: true });
  });

  it('patches the same work card and records closure when the episode clears', async () => {
    const h = harness();
    h.row.reminder = {
      episodeKey: String(START), uuid: 'capacity-fixed', status: 'sent',
      messageId: 'om_work_card', sentAt: new Date(START).toISOString(),
    };
    h.row.phase = 'processing';
    h.row.capacity = { state: 'cleared', clearedAtMs: START + 1 };

    h.reminder.sync(h.target, 'turn-a');
    await vi.waitFor(() => expect(h.patch).toHaveBeenCalledWith(
      h.target, h.row, 'om_work_card',
    ));

    expect(h.send).not.toHaveBeenCalled();
    expect(h.row.reminder).toMatchObject({ messageId: 'om_work_card', closed: true });
  });
});
