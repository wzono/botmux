import { createHash } from 'node:crypto';
import type { PersistedTurnFeedback, Session } from '../types.js';
import type { TurnFeedbackTarget } from './turn-feedback-reconciler.js';

export interface CapacityReminderDeps {
  read(target: TurnFeedbackTarget): Session;
  commit(target: TurnFeedbackTarget, mutate: (session: Session) => void): void;
  send(target: TurnFeedbackTarget, row: PersistedTurnFeedback, uuid: string): Promise<string>;
  patch(target: TurnFeedbackTarget, row: PersistedTurnFeedback, messageId: string): Promise<void>;
  now(): number;
  thresholds(target: TurnFeedbackTarget): { interactiveMs: number; backgroundMs: number };
}

export function createCapacityWaitReminder(deps: CapacityReminderDeps) {
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const inFlight = new Set<string>();
  const closing = new Set<string>();
  const keyFor = (target: TurnFeedbackTarget, turnId: string) =>
    JSON.stringify([target.larkAppId, target.session.sessionId, turnId]);

  function cancel(key: string): void {
    const timer = timers.get(key);
    if (timer) clearTimeout(timer);
    timers.delete(key);
  }

  async function closePublished(target: TurnFeedbackTarget, turnId: string): Promise<void> {
    const key = keyFor(target, turnId);
    if (inFlight.has(key)) return;
    if (closing.has(key)) return;
    const row = deps.read(target).turnFeedback?.[turnId];
    const messageId = row?.reminder?.messageId;
    if (!row || !messageId || row.reminder?.closed) return;
    closing.add(key);
    try {
      await deps.patch(target, row, messageId);
      deps.commit(target, fresh => {
        const current = fresh.turnFeedback?.[turnId];
        if (current?.reminder?.messageId === messageId) current.reminder.closed = true;
      });
    } finally {
      closing.delete(key);
    }
  }

  async function fire(target: TurnFeedbackTarget, turnId: string): Promise<void> {
    const key = keyFor(target, turnId);
    timers.delete(key);
    if (inFlight.has(key)) return;
    const session = deps.read(target);
    const row = session.turnFeedback?.[turnId];
    if (!row
      || (row.phase !== 'capacity_waiting' && row.phase !== 'capacity_stale')
      || (row.capacity?.state !== 'waiting' && row.capacity?.state !== 'stale')) {
      void closePublished(target, turnId);
      return;
    }
    if (row.reminderSilent || row.requesterIsBot !== false || !row.requesterOpenId) return;
    const episodeKey = String(row.capacity.startedAtMs);
    if (row.reminder?.episodeKey === episodeKey
      && (row.reminder.messageId || row.reminder.status === 'ambiguous')) return;
    const uuid = `capacity-${createHash('sha256').update(`${key}:${episodeKey}`).digest('hex').slice(0, 40)}`;
    deps.commit(target, fresh => {
      const current = fresh.turnFeedback?.[turnId];
      if ((current?.capacity?.state === 'waiting' || current?.capacity?.state === 'stale')
        && String(current.capacity.startedAtMs) === episodeKey) {
        current.reminder = {
          episodeKey, uuid, status: 'pending', attemptedAt: new Date(deps.now()).toISOString(),
        };
      }
    });
    const persisted = deps.read(target).turnFeedback?.[turnId]?.reminder;
    if (persisted?.uuid !== uuid || persisted.status !== 'pending') return;
    inFlight.add(key);
    try {
      const messageId = await deps.send(target, row, uuid);
      deps.commit(target, fresh => {
        const current = fresh.turnFeedback?.[turnId];
        if (current?.reminder?.uuid === uuid) {
          current.reminder = {
            ...current.reminder, messageId, status: 'sent', sentAt: new Date(deps.now()).toISOString(),
          };
        }
      });
    } catch {
      deps.commit(target, fresh => {
        const current = fresh.turnFeedback?.[turnId];
        if (current?.reminder?.uuid === uuid) current.reminder.status = 'ambiguous';
      });
    } finally {
      inFlight.delete(key);
    }
  }

  function sync(target: TurnFeedbackTarget, turnId: string): void {
    const key = keyFor(target, turnId);
    cancel(key);
    if (inFlight.has(key)) return;
    const session = deps.read(target);
    const row = session.turnFeedback?.[turnId];
    if (!row
      || (row.phase !== 'capacity_waiting' && row.phase !== 'capacity_stale')
      || (row.capacity?.state !== 'waiting' && row.capacity?.state !== 'stale')) {
      void closePublished(target, turnId);
      return;
    }
    if (row.reminderSilent || row.requesterIsBot !== false || !row.requesterOpenId) return;
    const episodeKey = String(row.capacity.startedAtMs);
    if (row.reminder?.episodeKey === episodeKey
      && (row.reminder.messageId || row.reminder.status === 'ambiguous')) return;
    const thresholds = deps.thresholds(target);
    const threshold = row.background ? thresholds.backgroundMs : thresholds.interactiveMs;
    const delay = Math.max(0, row.capacity.startedAtMs + threshold - deps.now());
    const timer = setTimeout(() => { void fire(target, turnId); }, delay);
    timer.unref?.();
    timers.set(key, timer);
  }

  function dispose(): void {
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
  }

  return { sync, dispose };
}
